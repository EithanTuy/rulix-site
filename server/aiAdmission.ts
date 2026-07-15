import { randomUUID } from "node:crypto";
import {
  modelPrice,
  readBedrockPrices,
  usageCostUsd,
  type ModelPrice
} from "./bedrockPricing";
import {
  AiEgressPolicyError,
  type AiDispatchAdmissionHook,
  type AiDispatchMetadata,
  type AiDispatchSettlement
} from "./aiEgressGateway";
import type { AccountStore, AiAdmissionLimits } from "./store";

export interface AiAdmissionConfig extends AiAdmissionLimits {
  leaseDurationMs: number;
}

export const DEFAULT_AI_ADMISSION_CONFIG: Readonly<AiAdmissionConfig> = Object.freeze({
  maxConcurrentLeases: 4,
  requestsPerMinute: 60,
  tokensPerDay: 5_000_000,
  spendUsdPerDay: 50,
  maxTokensPerCall: 200_000,
  maxCostUsdPerCall: 5,
  leaseDurationMs: 240_000
});

export interface AiAdmissionHookOptions {
  store: Pick<AccountStore, "reserveAiUsage" | "settleAiUsage">;
  now?: () => number;
  reservationId?: () => string;
  limits?: Partial<AiAdmissionConfig>;
}

export function createAiDispatchAdmissionHook(options: AiAdmissionHookOptions): AiDispatchAdmissionHook {
  const now = options.now ?? Date.now;
  const reservationId = options.reservationId ?? (() => `ai-${randomUUID()}`);
  const config = readAiAdmissionConfig(options.limits);
  // Parse once while the application is starting. A malformed or zero-price
  // override must prevent provider use instead of silently disabling spend caps.
  const pricing = readBedrockPrices();

  return async (metadata) => {
    const reservedTokens = estimatedDispatchTokens(metadata);
    const reservedCostUsd = estimateDispatchCostUpperBound(metadata, pricing);
    const requestedAtMs = now();
    const id = reservationId();
    let admission;
    try {
      admission = await options.store.reserveAiUsage({
        accountId: metadata.accountId,
        reservationId: id,
        nowMs: requestedAtMs,
        leaseExpiresAtMs: requestedAtMs + config.leaseDurationMs,
        estimatedTokens: reservedTokens,
        estimatedCostUsd: reservedCostUsd,
        limits: config
      });
    } catch (error) {
      throw admissionUnavailable(error);
    }
    if (!admission.ok) {
      throw admissionDenied(admission.reason, admission.retryAfterMs);
    }

    let settled = false;
    return {
      settle: async (result) => {
        if (settled) return;
        settled = true;
        const settlement = settlementForResult(
          metadata,
          result,
          admission.reservedTokens,
          admission.reservedCostUsd,
          pricing
        );
        try {
          await options.store.settleAiUsage({
            accountId: metadata.accountId,
            reservationId: admission.reservationId,
            nowMs: now(),
            ...settlement
          });
        } catch {
          // Admission already reserved the conservative upper bound. Retain it
          // and let the lease expire instead of turning a completed provider
          // call into a retryable response that could duplicate spend.
        }
      }
    };
  };
}

export function readAiAdmissionConfig(overrides: Partial<AiAdmissionConfig> = {}): AiAdmissionConfig {
  return {
    maxConcurrentLeases: boundedInteger(
      overrides.maxConcurrentLeases,
      "RULIX_AI_MAX_CONCURRENT",
      DEFAULT_AI_ADMISSION_CONFIG.maxConcurrentLeases,
      1,
      1_000
    ),
    requestsPerMinute: boundedInteger(
      overrides.requestsPerMinute,
      "RULIX_AI_REQUESTS_PER_MINUTE",
      DEFAULT_AI_ADMISSION_CONFIG.requestsPerMinute,
      1,
      100_000
    ),
    tokensPerDay: boundedInteger(
      overrides.tokensPerDay,
      "RULIX_AI_TOKENS_PER_DAY",
      DEFAULT_AI_ADMISSION_CONFIG.tokensPerDay,
      1,
      1_000_000_000
    ),
    spendUsdPerDay: boundedNumber(
      overrides.spendUsdPerDay,
      "RULIX_AI_SPEND_USD_PER_DAY",
      DEFAULT_AI_ADMISSION_CONFIG.spendUsdPerDay,
      0.01,
      100_000
    ),
    maxTokensPerCall: boundedInteger(
      overrides.maxTokensPerCall,
      "RULIX_AI_MAX_TOKENS_PER_CALL",
      DEFAULT_AI_ADMISSION_CONFIG.maxTokensPerCall,
      1,
      10_000_000
    ),
    maxCostUsdPerCall: boundedNumber(
      overrides.maxCostUsdPerCall,
      "RULIX_AI_MAX_COST_USD_PER_CALL",
      DEFAULT_AI_ADMISSION_CONFIG.maxCostUsdPerCall,
      0.01,
      10_000
    ),
    leaseDurationMs: boundedInteger(
      overrides.leaseDurationMs === undefined ? undefined : overrides.leaseDurationMs / 1_000,
      "RULIX_AI_LEASE_SECONDS",
      DEFAULT_AI_ADMISSION_CONFIG.leaseDurationMs / 1_000,
      1,
      3_600
    ) * 1_000
  };
}

export function estimatedDispatchTokens(metadata: AiDispatchMetadata) {
  // Input estimation is content-aware at the gateway. In particular, binary
  // document/image base64 transport bytes are not provider tokens. Request
  // bytes remain independently bounded by WAF, Express, and intake limits.
  const input = safeTokenCount(metadata.estimatedInputTokens);
  const output = safeTokenCount(metadata.maxOutputTokens);
  return Math.min(Number.MAX_SAFE_INTEGER, input + output);
}

export function estimateDispatchCostUpperBound(
  metadata: AiDispatchMetadata,
  pricing: Readonly<Record<string, ModelPrice>> = readBedrockPrices()
) {
  const price = modelPrice(metadata.model, pricing);
  const highestTokenRate = Math.max(
    price.inputPer1M,
    price.outputPer1M,
    price.cacheReadPer1M,
    price.cacheWritePer1M
  );
  return (estimatedDispatchTokens(metadata) / 1_000_000) * highestTokenRate;
}

function settlementForResult(
  metadata: AiDispatchMetadata,
  result: AiDispatchSettlement,
  reservedTokens: number,
  reservedCostUsd: number,
  pricing: Readonly<Record<string, ModelPrice>>
) {
  if (result.status === "failed") {
    return isKnownNoProviderDispatch(result.error)
      ? { disposition: "release" as const, actualTokens: 0, actualCostUsd: 0 }
      : { disposition: "retain" as const };
  }

  const actual = parseAnthropicUsage(result.usage);
  if (!actual) {
    return {
      disposition: "settle" as const,
      actualTokens: reservedTokens,
      actualCostUsd: reservedCostUsd
    };
  }
  return {
    disposition: "settle" as const,
    actualTokens: actual.inputTokens + actual.outputTokens + actual.cacheReadTokens + actual.cacheWriteTokens,
    actualCostUsd: usageCostUsd({ model: metadata.model, ...actual }, pricing)
  };
}

function parseAnthropicUsage(usage: unknown) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const record = usage as Record<string, unknown>;
  const keys = [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens"
  ] as const;
  if (!keys.some((key) => typeof record[key] === "number" && Number.isFinite(record[key]))) {
    return undefined;
  }
  return {
    inputTokens: usageToken(record.input_tokens),
    outputTokens: usageToken(record.output_tokens),
    cacheReadTokens: usageToken(record.cache_read_input_tokens),
    cacheWriteTokens: usageToken(record.cache_creation_input_tokens)
  };
}

function isKnownNoProviderDispatch(error: unknown) {
  return error instanceof AiEgressPolicyError && (
    error.code === "ai_provider_unavailable" || error.code === "ai_provider_not_started"
  );
}

function admissionDenied(reason: string, retryAfterMs?: number) {
  const retry = retryAfterMs
    ? ` Retry after approximately ${Math.max(1, Math.ceil(retryAfterMs / 1_000))} seconds.`
    : "";
  return new AiEgressPolicyError(
    "ai_workload_limit_exceeded",
    `This account's AI workload limit was reached (${reason}).${retry}`,
    429
  );
}

function admissionUnavailable(error: unknown) {
  void error;
  return new AiEgressPolicyError(
    "ai_admission_unavailable",
    "AI dispatch is disabled because workload admission is unavailable.",
    503
  );
}

function safeTokenCount(value: number) {
  return Number.isFinite(value) && value > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(value))
    : 0;
}

function usageToken(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function boundedInteger(
  override: number | undefined,
  envName: string,
  fallback: number,
  minimum: number,
  maximum: number
) {
  const value = boundedNumber(override, envName, fallback, minimum, maximum);
  if (!Number.isSafeInteger(value)) {
    throw new AiEgressPolicyError(
      "ai_admission_configuration_invalid",
      `${envName} must be a whole number between ${minimum} and ${maximum}.`,
      503
    );
  }
  return value;
}

function boundedNumber(
  override: number | undefined,
  envName: string,
  fallback: number,
  minimum: number,
  maximum: number
) {
  const rawEnvValue = process.env[envName];
  if (override === undefined && rawEnvValue === undefined) return fallback;
  const candidate = override ?? Number(rawEnvValue?.trim());
  if (!Number.isFinite(candidate) || candidate < minimum || candidate > maximum) {
    throw new AiEgressPolicyError(
      "ai_admission_configuration_invalid",
      `${envName} must be a finite value between ${minimum} and ${maximum}.`,
      503
    );
  }
  return candidate;
}
