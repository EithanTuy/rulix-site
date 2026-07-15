import type { UsageEvent } from "../src/types";

export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
  cacheWritePer1M: number;
}

// Conservative Amazon Bedrock $/1M-token admission rates (USD, global
// endpoints), verified against AWS pricing on 2026-07-14. The Opus/default
// rows intentionally use the highest current Anthropic global standard and
// one-hour cache-write rates so an unknown/new model cannot weaken a spend cap.
// Source: https://aws.amazon.com/bedrock/pricing/
// Override at runtime with RULIX_BEDROCK_PRICES, a JSON map keyed by
// model family ("haiku" | "sonnet" | "opus" | "default"), e.g.
//   RULIX_BEDROCK_PRICES='{"haiku":{"inputPer1M":1,"outputPer1M":5,"cacheReadPer1M":0.1,"cacheWritePer1M":1.25}}'
const DEFAULT_PRICES: Readonly<Record<string, Readonly<ModelPrice>>> = Object.freeze({
  haiku: { inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.1, cacheWritePer1M: 1.25 },
  sonnet: { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  opus: { inputPer1M: 6, outputPer1M: 30, cacheReadPer1M: 0.6, cacheWritePer1M: 12 },
  default: { inputPer1M: 6, outputPer1M: 30, cacheReadPer1M: 0.6, cacheWritePer1M: 12 }
});

const PRICE_FAMILIES = new Set(["haiku", "sonnet", "opus", "default"]);
const PRICE_FIELDS = ["inputPer1M", "outputPer1M", "cacheReadPer1M", "cacheWritePer1M"] as const;

export class BedrockPricingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BedrockPricingConfigurationError";
  }
}

export function readBedrockPrices(raw = process.env.RULIX_BEDROCK_PRICES): Record<string, ModelPrice> {
  const table = Object.fromEntries(
    Object.entries(DEFAULT_PRICES).map(([family, price]) => [family, { ...price }])
  ) as Record<string, ModelPrice>;
  const normalized = raw?.trim();
  if (!normalized) return table;

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new BedrockPricingConfigurationError("RULIX_BEDROCK_PRICES must be valid JSON.");
  }
  if (!isPlainRecord(parsed) || Object.keys(parsed).length === 0) {
    throw new BedrockPricingConfigurationError(
      "RULIX_BEDROCK_PRICES must be a non-empty object keyed by model family."
    );
  }

  for (const [rawFamily, rawPrice] of Object.entries(parsed)) {
    const family = rawFamily.toLowerCase();
    if (!PRICE_FAMILIES.has(family)) {
      throw new BedrockPricingConfigurationError(`Unknown Bedrock price family: ${rawFamily}.`);
    }
    if (!isPlainRecord(rawPrice)) {
      throw new BedrockPricingConfigurationError(`Bedrock price family ${family} must be an object.`);
    }
    const unknown = Object.keys(rawPrice).filter(
      (field) => !PRICE_FIELDS.includes(field as (typeof PRICE_FIELDS)[number])
    );
    const missing = PRICE_FIELDS.filter((field) => !Object.prototype.hasOwnProperty.call(rawPrice, field));
    if (unknown.length || missing.length) {
      throw new BedrockPricingConfigurationError(
        `Bedrock price family ${family} must define exactly: ${PRICE_FIELDS.join(", ")}.`
      );
    }
    const price = Object.fromEntries(
      PRICE_FIELDS.map((field) => {
        const value = rawPrice[field];
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
          throw new BedrockPricingConfigurationError(
            `Bedrock price ${family}.${field} must be a finite number greater than zero.`
          );
        }
        return [field, value];
      })
    ) as unknown as ModelPrice;
    table[family] = price;
  }
  return table;
}

// Only models whose current rates are explicitly represented receive a lower
// family rate. Unknown, older extended-access, or future IDs use the
// conservative default rather than inheriting a possibly stale family price.
export function priceFamily(model: string): string {
  const normalized = model.toLowerCase();
  if (normalized.includes("claude-haiku-4-5")) return "haiku";
  if (normalized.includes("claude-sonnet-4-6") || normalized.includes("claude-sonnet-5")) {
    return "sonnet";
  }
  if (normalized.includes("claude-opus-4-6") || normalized.includes("claude-opus-4-8")) {
    return "opus";
  }
  return "default";
}

export function modelPrice(
  model: string,
  table: Readonly<Record<string, ModelPrice>> = readBedrockPrices()
): ModelPrice {
  return table[priceFamily(model)] ?? table.default;
}

type CostInput = Pick<
  UsageEvent,
  "model" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
>;

export function usageCostUsd(
  event: CostInput,
  table: Readonly<Record<string, ModelPrice>> = readBedrockPrices()
): number {
  const p = modelPrice(event.model, table);
  return (
    (event.inputTokens / 1_000_000) * p.inputPer1M +
    (event.outputTokens / 1_000_000) * p.outputPer1M +
    (event.cacheReadTokens / 1_000_000) * p.cacheReadPer1M +
    (event.cacheWriteTokens / 1_000_000) * p.cacheWritePer1M
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
