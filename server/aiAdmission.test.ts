// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AI_ADMISSION_CONFIG,
  createAiDispatchAdmissionHook,
  readAiAdmissionConfig
} from "./aiAdmission";
import {
  AiEgressPolicyError,
  dispatchAuthorizedAiRequest,
  type AiDispatchAdmissionHook,
  type AiDispatchMetadata,
  type AiProviderClient
} from "./aiEgressGateway";
import {
  DynamoAccountStore,
  LocalAccountStore,
  type AiAdmissionLimits,
  type AiUsageReservationRequest
} from "./store";

const ENV_NAMES = [
  "RULIX_AI_MAX_CONCURRENT",
  "RULIX_AI_REQUESTS_PER_MINUTE",
  "RULIX_AI_TOKENS_PER_DAY",
  "RULIX_AI_SPEND_USD_PER_DAY",
  "RULIX_AI_MAX_TOKENS_PER_CALL",
  "RULIX_AI_MAX_COST_USD_PER_CALL",
  "RULIX_AI_LEASE_SECONDS",
  "RULIX_APPROVED_PROVIDER",
  "RULIX_APPROVED_REGION"
] as const;

const originalEnvironment = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));

describe("atomic AI workload admission", () => {
  beforeEach(() => {
    for (const name of ENV_NAMES) delete process.env[name];
    process.env.RULIX_APPROVED_PROVIDER = "anthropic-direct";
    process.env.RULIX_APPROVED_REGION = "global";
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      const value = originalEnvironment.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("admits exactly four of five concurrent gateway calls and never invokes the denied provider", async () => {
    expect(readAiAdmissionConfig()).toEqual(DEFAULT_AI_ADMISSION_CONFIG);
    const store = new LocalAccountStore({ persist: false });
    let sequence = 0;
    const hook = createAiDispatchAdmissionHook({
      store,
      reservationId: () => `gateway-${sequence += 1}`
    });
    let providerCalls = 0;
    let fourProvidersReached!: () => void;
    let releaseProviders!: () => void;
    const reached = new Promise<void>((resolve) => { fourProvidersReached = resolve; });
    const gate = new Promise<void>((resolve) => { releaseProviders = resolve; });
    const client: AiProviderClient = {
      messages: {
        create: async () => {
          providerCalls += 1;
          if (providerCalls === 4) fourProvidersReached();
          await gate;
          return {
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 12, output_tokens: 4 }
          };
        }
      }
    };
    const body = { max_tokens: 100, messages: [{ role: "user", content: "Classify this public item." }] };
    const dispatch = authorizedDispatch("concurrency-account", body, hook, client);

    const settled = Promise.allSettled(Array.from({ length: 5 }, dispatch));
    await reached;
    expect(providerCalls).toBe(4);
    releaseProviders();
    const results = await settled;

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status).toBe("rejected");
    if (rejection?.status === "rejected") {
      expect(rejection.reason).toMatchObject({ code: "ai_workload_limit_exceeded", status: 429 });
    }
    expect(providerCalls).toBe(4);
  });

  it("enforces minute, daily token, daily spend, and per-call caps", async () => {
    const now = Date.UTC(2026, 6, 14, 12);

    const minuteHook = createAiDispatchAdmissionHook({
      store: new LocalAccountStore({ persist: false }),
      now: () => now,
      reservationId: sequenceIds("minute"),
      limits: generous({ requestsPerMinute: 2 })
    });
    await settleSuccess(await acquire(minuteHook, metadata()));
    await settleSuccess(await acquire(minuteHook, metadata()));
    await expectPolicyStatus(minuteHook(metadata()), 429);

    const tokenHook = createAiDispatchAdmissionHook({
      store: new LocalAccountStore({ persist: false }),
      now: () => now,
      reservationId: sequenceIds("tokens"),
      limits: generous({ tokensPerDay: 100, maxTokensPerCall: 1_000 })
    });
    await (await acquire(tokenHook, metadata({ estimatedInputTokens: 40, maxOutputTokens: 10 }))).settle({
      status: "succeeded",
      usage: { input_tokens: 20, output_tokens: 10 }
    });
    await acquire(tokenHook, metadata({ estimatedInputTokens: 60, maxOutputTokens: 10 }));
    await expectPolicyStatus(tokenHook(metadata({ estimatedInputTokens: 1, maxOutputTokens: 0 })), 429);

    const spendHook = createAiDispatchAdmissionHook({
      store: new LocalAccountStore({ persist: false }),
      now: () => now,
      reservationId: sequenceIds("spend"),
      limits: generous({ spendUsdPerDay: 1, maxCostUsdPerCall: 10 })
    });
    await settleSuccess(await acquire(
      spendHook,
      metadata({ estimatedInputTokens: 50_000, maxOutputTokens: 0, model: "claude-sonnet-4-6" })
    ));
    await expectPolicyStatus(
      spendHook(metadata({ estimatedInputTokens: 20_000, maxOutputTokens: 0, model: "claude-sonnet-4-6" })),
      429
    );

    const callTokenHook = createAiDispatchAdmissionHook({
      store: new LocalAccountStore({ persist: false }),
      now: () => now,
      limits: generous({ maxTokensPerCall: 100 })
    });
    await expectPolicyStatus(
      callTokenHook(metadata({ estimatedInputTokens: 101, maxOutputTokens: 0, payloadBytes: 40 })),
      429
    );

    const callCostHook = createAiDispatchAdmissionHook({
      store: new LocalAccountStore({ persist: false }),
      now: () => now,
      limits: generous({ maxCostUsdPerCall: 0.01 })
    });
    await expectPolicyStatus(
      callCostHook(metadata({ estimatedInputTokens: 1_000, maxOutputTokens: 0, model: "claude-sonnet-4-6" })),
      429
    );
  });

  it.each([
    ["PDF", "document", "application/pdf"],
    ["DOCX", "document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["image", "image", "image/png"]
  ])("admits a valid near-limit %s without charging base64 transport as tokens", async (_label, type, mediaType) => {
    const store = new LocalAccountStore({ persist: false });
    const hook = createAiDispatchAdmissionHook({ store });
    let providerCalls = 0;
    const client: AiProviderClient = {
      messages: {
        create: async () => {
          providerCalls += 1;
          return {
            content: [{ type: "text", text: "extracted" }],
            usage: { input_tokens: 20_000, output_tokens: 500 }
          };
        }
      }
    };
    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: 4_200,
      messages: [{
        role: "user",
        content: [{
          type,
          source: {
            type: "base64",
            media_type: mediaType,
            data: Buffer.alloc(Math.floor(4.5 * 1024 * 1024), 0x41).toString("base64")
          }
        }]
      }]
    };

    await authorizedDispatch("near-limit-binary", body, hook, client)();

    expect(providerCalls).toBe(1);
  });

  it("reconciles success, releases known pre-provider failure, retains unknown failure, and recovers expired leases", async () => {
    let now = Date.UTC(2026, 6, 14, 12);
    const hook = createAiDispatchAdmissionHook({
      store: new LocalAccountStore({ persist: false }),
      now: () => now,
      reservationId: sequenceIds("lifecycle"),
      limits: generous({ maxConcurrentLeases: 1, tokensPerDay: 1_000, leaseDurationMs: 1_000 })
    });

    const first = await acquire(hook, metadata({ estimatedInputTokens: 100, maxOutputTokens: 0 }));
    await expectPolicyStatus(hook(metadata({ estimatedInputTokens: 1, maxOutputTokens: 0 })), 429);
    await first.settle({ status: "succeeded", usage: { input_tokens: 10, output_tokens: 0 } });

    const released = await acquire(hook, metadata({ estimatedInputTokens: 990, maxOutputTokens: 0 }));
    await released.settle({
      status: "failed",
      error: new AiEgressPolicyError("ai_provider_unavailable", "Provider was not constructed.", 503)
    });

    const retained = await acquire(hook, metadata({ estimatedInputTokens: 990, maxOutputTokens: 0 }));
    await retained.settle({ status: "failed", error: new Error("Provider outcome unknown") });
    await expectPolicyStatus(hook(metadata({ estimatedInputTokens: 1, maxOutputTokens: 0 })), 429);

    now += 1_001;
    const recovered = await acquire(hook, metadata({ estimatedInputTokens: 0, maxOutputTokens: 0, payloadBytes: 0 }));
    await recovered.settle({ status: "failed", error: new AiEgressPolicyError("ai_provider_unavailable", "", 503) });
    await expectPolicyStatus(hook(metadata({ estimatedInputTokens: 1, maxOutputTokens: 0 })), 429);
  });

  it("keeps provider success on settlement failure but fails closed before dispatch when reservation is unavailable", async () => {
    let providerCalls = 0;
    const client: AiProviderClient = {
      messages: {
        create: async () => {
          providerCalls += 1;
          return { content: [{ type: "text", text: "completed" }], usage: { input_tokens: 2, output_tokens: 1 } };
        }
      }
    };
    const settlementFailureHook = createAiDispatchAdmissionHook({
      store: {
        reserveAiUsage: async (request) => ({
          ok: true as const,
          reservationId: request.reservationId,
          leaseExpiresAtMs: request.leaseExpiresAtMs,
          reservedTokens: request.estimatedTokens,
          reservedCostUsd: request.estimatedCostUsd
        }),
        settleAiUsage: async () => { throw new Error("storage unavailable after dispatch"); }
      }
    });
    const body = { max_tokens: 10, messages: [{ role: "user", content: "test" }] };

    await expect(authorizedDispatch("settlement-failure", body, settlementFailureHook, client)())
      .resolves.toMatchObject({ content: [{ text: "completed" }] });
    expect(providerCalls).toBe(1);

    const reservationFailureHook = createAiDispatchAdmissionHook({
      store: {
        reserveAiUsage: async () => { throw new Error("storage unavailable before dispatch"); },
        settleAiUsage: async () => "missing" as const
      }
    });
    await expectPolicyStatus(authorizedDispatch("reservation-failure", body, reservationFailureHook, client)(), 503);
    expect(providerCalls).toBe(1);
  });

  it("fails configuration closed for explicit invalid overrides and environment values", () => {
    expect(() => readAiAdmissionConfig({ maxConcurrentLeases: 0 })).toThrowError(
      expect.objectContaining({ code: "ai_admission_configuration_invalid", status: 503 })
    );
    expect(() => readAiAdmissionConfig({ requestsPerMinute: 1.5 })).toThrowError(
      expect.objectContaining({ code: "ai_admission_configuration_invalid", status: 503 })
    );
    process.env.RULIX_AI_TOKENS_PER_DAY = "not-a-number";
    expect(() => readAiAdmissionConfig()).toThrowError(
      expect.objectContaining({ code: "ai_admission_configuration_invalid", status: 503 })
    );
    process.env.RULIX_AI_TOKENS_PER_DAY = "1000000001";
    expect(() => readAiAdmissionConfig()).toThrowError(
      expect.objectContaining({ code: "ai_admission_configuration_invalid", status: 503 })
    );
  });

  it("persists local admission state across store restarts", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "rulix-ai-admission-"));
    const filePath = path.join(directory, "store.json");
    try {
      const first = new LocalAccountStore({ filePath, persist: true });
      expect((await first.reserveAiUsage(reservation("persisted-1", { maxConcurrentLeases: 1 }))).ok).toBe(true);

      const restarted = new LocalAccountStore({ filePath, persist: true });
      expect(await restarted.reserveAiUsage(reservation("persisted-2", { maxConcurrentLeases: 1 })))
        .toMatchObject({ ok: false, reason: "concurrency" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses strongly consistent Dynamo CAS so five stale readers still commit only four leases", async () => {
    const client = new AdmissionCasDynamoClient(5);
    const store = new DynamoAccountStore("auth", "accounts", {
      client: client as unknown as DynamoDBDocumentClient
    });
    const requests = Array.from({ length: 5 }, (_, index) =>
      store.reserveAiUsage(reservation(`dynamo-${index + 1}`, { maxConcurrentLeases: 4 }))
    );
    const results = await Promise.all(requests);

    expect(results.filter((result) => result.ok)).toHaveLength(4);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ ok: false, reason: "concurrency" })
    ]);
    expect(client.state().leases).toHaveLength(4);
    expect(client.state().version).toBe(4);
    expect(client.conditionalFailures).toBeGreaterThanOrEqual(4);
    expect(client.consistentReads.length).toBeGreaterThanOrEqual(5);
    expect(client.consistentReads.every(Boolean)).toBe(true);
  });
});

function authorizedDispatch(
  accountId: string,
  body: unknown,
  hook: AiDispatchAdmissionHook,
  client: AiProviderClient
) {
  const lane = { provider: "anthropic-direct" as const, region: "global" as const, model: "claude-sonnet-4-6" };
  const providerBody = body && typeof body === "object" && !Array.isArray(body)
    ? { ...body, model: lane.model }
    : body;
  return () => dispatchAuthorizedAiRequest({
    accountId,
    dataClass: "proprietary",
    payload: providerBody,
    purpose: "council",
    approvalId: "admission-approval",
    dispatchId: `admission-${accountId}`,
    subject: {
      kind: "review",
      id: "admission-review",
      revision: 1,
      version: 1,
      contentHash: "d".repeat(64)
    }
  }, lane, providerBody, undefined, client, hook, async () => ({
    replayed: false,
    markProviderStarted: async () => undefined,
    settle: async () => undefined
  }));
}

function metadata(overrides: Partial<AiDispatchMetadata> = {}): AiDispatchMetadata {
  return {
    accountId: "account-1",
    callType: "council",
    estimatedInputTokens: 10,
    maxOutputTokens: 10,
    model: "claude-sonnet-4-6",
    payloadBytes: 40,
    provider: "amazon-bedrock",
    region: "us-east-1",
    ...overrides
  };
}

function generous(overrides: Partial<Parameters<typeof readAiAdmissionConfig>[0]> = {}) {
  return {
    maxConcurrentLeases: 100,
    requestsPerMinute: 1_000,
    tokensPerDay: 10_000_000,
    spendUsdPerDay: 10_000,
    maxTokensPerCall: 1_000_000,
    maxCostUsdPerCall: 1_000,
    leaseDurationMs: 240_000,
    ...overrides
  };
}

function sequenceIds(prefix: string) {
  let value = 0;
  return () => `${prefix}-${value += 1}`;
}

async function acquire(hook: AiDispatchAdmissionHook, value: AiDispatchMetadata) {
  const lease = await hook(value);
  expect(lease).toBeDefined();
  return lease!;
}

async function settleSuccess(lease: Awaited<ReturnType<AiDispatchAdmissionHook>>) {
  await lease?.settle({ status: "succeeded", usage: undefined });
}

async function expectPolicyStatus(promise: Promise<unknown> | unknown, status: number) {
  try {
    await promise;
    throw new Error(`Expected AiEgressPolicyError ${status}, but the operation succeeded.`);
  } catch (error) {
    expect(error).toBeInstanceOf(AiEgressPolicyError);
    expect((error as AiEgressPolicyError).status).toBe(status);
  }
}

function reservation(
  reservationId: string,
  limitOverrides: Partial<AiAdmissionLimits> = {}
): AiUsageReservationRequest {
  const nowMs = Date.UTC(2026, 6, 14, 12);
  return {
    accountId: "dynamo-account",
    reservationId,
    nowMs,
    leaseExpiresAtMs: nowMs + 240_000,
    estimatedTokens: 100,
    estimatedCostUsd: 0.01,
    limits: {
      maxConcurrentLeases: 4,
      requestsPerMinute: 60,
      tokensPerDay: 5_000_000,
      spendUsdPerDay: 50,
      maxTokensPerCall: 200_000,
      maxCostUsdPerCall: 5,
      ...limitOverrides
    }
  };
}

class AdmissionCasDynamoClient {
  private item: Record<string, any> | undefined;
  private arrivals = 0;
  private releaseReads!: () => void;
  private readonly readGate = new Promise<void>((resolve) => { this.releaseReads = resolve; });
  private barrierActive = true;
  readonly consistentReads: boolean[] = [];
  conditionalFailures = 0;

  constructor(private readonly participants: number) {}

  async send(command: { constructor: { name: string }; input: Record<string, any> }) {
    if (command.constructor.name === "GetCommand") {
      this.consistentReads.push(command.input.ConsistentRead === true);
      const response = { Item: clone(this.item) };
      if (this.barrierActive) {
        this.arrivals += 1;
        if (this.arrivals === this.participants) {
          this.barrierActive = false;
          this.releaseReads();
        }
        await this.readGate;
      }
      return response;
    }
    if (command.constructor.name === "PutCommand") {
      const expected = command.input.ExpressionAttributeValues?.[":expectedVersion"];
      const exists = this.item !== undefined;
      const conditionPasses = expected === undefined
        ? !exists
        : exists && this.item?.record?.version === expected;
      if (!conditionPasses) {
        this.conditionalFailures += 1;
        const error = new Error("conditional conflict");
        error.name = "ConditionalCheckFailedException";
        throw error;
      }
      this.item = clone(command.input.Item);
      return {};
    }
    throw new Error(`Unsupported command ${command.constructor.name}`);
  }

  state() {
    return clone(this.item?.record);
  }
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
