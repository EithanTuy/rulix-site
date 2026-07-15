// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { createAiDispatchAdmissionHook } from "./aiAdmission";
import {
  BedrockPricingConfigurationError,
  modelPrice,
  readBedrockPrices,
  usageCostUsd
} from "./bedrockPricing";

const originalOverride = process.env.RULIX_BEDROCK_PRICES;

afterEach(() => {
  if (originalOverride === undefined) delete process.env.RULIX_BEDROCK_PRICES;
  else process.env.RULIX_BEDROCK_PRICES = originalOverride;
});

describe("Bedrock pricing configuration", () => {
  it("uses positive conservative defaults when no override is supplied", () => {
    const prices = readBedrockPrices("");
    for (const family of ["haiku", "sonnet", "opus", "default"]) {
      expect(Object.values(prices[family]).every((value) => value > 0)).toBe(true);
    }
    expect(usageCostUsd({
      model: "global.anthropic.claude-haiku-4-5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    }, prices)).toBe(6);
    expect(modelPrice("future-anthropic-model", prices)).toEqual({
      inputPer1M: 6,
      outputPer1M: 30,
      cacheReadPer1M: 0.6,
      cacheWritePer1M: 12
    });
    expect(modelPrice("global.anthropic.claude-opus-4-8", prices)).toEqual(
      modelPrice("future-anthropic-model", prices)
    );
  });

  it("accepts a complete positive family override", () => {
    const prices = readBedrockPrices(JSON.stringify({
      haiku: {
        inputPer1M: 2,
        outputPer1M: 8,
        cacheReadPer1M: 0.2,
        cacheWritePer1M: 2.5
      }
    }));
    expect(modelPrice("global.anthropic.claude-haiku-4-5-20251001-v1:0", prices)).toEqual({
      inputPer1M: 2,
      outputPer1M: 8,
      cacheReadPer1M: 0.2,
      cacheWritePer1M: 2.5
    });
    expect(modelPrice("future-anthropic-haiku", prices)).toEqual(prices.default);
  });

  it.each([
    ["malformed JSON", "{"],
    ["an array", "[]"],
    ["an empty object", "{}"],
    ["an unknown family", JSON.stringify({ typo: fullPrice(1) })],
    ["a partial family", JSON.stringify({ haiku: { inputPer1M: 1 } })],
    ["an extra field", JSON.stringify({ haiku: { ...fullPrice(1), currency: "USD" } })],
    ["a zero rate", JSON.stringify({ haiku: { ...fullPrice(1), outputPer1M: 0 } })],
    ["a negative rate", JSON.stringify({ haiku: { ...fullPrice(1), cacheReadPer1M: -1 } })],
    ["a string rate", JSON.stringify({ haiku: { ...fullPrice(1), inputPer1M: "1" } })]
  ])("rejects %s", (_label, raw) => {
    expect(() => readBedrockPrices(raw)).toThrow(BedrockPricingConfigurationError);
  });

  it("fails admission construction before any provider dispatch when pricing is invalid", () => {
    process.env.RULIX_BEDROCK_PRICES = JSON.stringify({ default: fullPrice(0) });
    expect(() => createAiDispatchAdmissionHook({
      store: {
        reserveAiUsage: async () => { throw new Error("must not run"); },
        settleAiUsage: async () => { throw new Error("must not run"); }
      }
    })).toThrow(BedrockPricingConfigurationError);
  });
});

function fullPrice(value: number) {
  return {
    inputPer1M: value,
    outputPer1M: value,
    cacheReadPer1M: value,
    cacheWritePer1M: value
  };
}
