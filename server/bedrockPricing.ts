import type { UsageEvent } from "../src/types";

export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
  cacheWritePer1M: number;
}

// Default Amazon Bedrock $/1M-token rates (USD, global endpoints). These are a
// best-effort default — verify against current AWS Bedrock pricing for your
// region and override at runtime with RULIX_BEDROCK_PRICES, a JSON map keyed by
// model family ("haiku" | "sonnet" | "opus" | "default"), e.g.
//   RULIX_BEDROCK_PRICES='{"haiku":{"inputPer1M":1,"outputPer1M":5}}'
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  haiku: { inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.1, cacheWritePer1M: 1.25 },
  sonnet: { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  opus: { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  default: { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 }
};

function prices(): Record<string, ModelPrice> {
  const table: Record<string, ModelPrice> = { ...DEFAULT_PRICES };
  const raw = process.env.RULIX_BEDROCK_PRICES?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, Partial<ModelPrice>>;
      for (const [key, value] of Object.entries(parsed)) {
        const family = key.toLowerCase();
        table[family] = { ...(table[family] ?? DEFAULT_PRICES.default), ...value };
      }
    } catch {
      // Malformed override is ignored; defaults stand.
    }
  }
  return table;
}

// Normalize a Bedrock model id (e.g. "global.anthropic.claude-haiku-4-5-...")
// to a price family. Mirrors providerLabel() in bedrockCouncil.ts.
export function priceFamily(model: string): string {
  const normalized = model.toLowerCase();
  if (normalized.includes("haiku")) return "haiku";
  if (normalized.includes("sonnet")) return "sonnet";
  if (normalized.includes("opus")) return "opus";
  return "default";
}

export function modelPrice(model: string): ModelPrice {
  const table = prices();
  return table[priceFamily(model)] ?? table.default;
}

type CostInput = Pick<
  UsageEvent,
  "model" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
>;

export function usageCostUsd(event: CostInput): number {
  const p = modelPrice(event.model);
  return (
    (event.inputTokens / 1_000_000) * p.inputPer1M +
    (event.outputTokens / 1_000_000) * p.outputPer1M +
    (event.cacheReadTokens / 1_000_000) * p.cacheReadPer1M +
    (event.cacheWriteTokens / 1_000_000) * p.cacheWritePer1M
  );
}
