// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BEDROCK_MODEL,
  DEFAULT_DEEP_BEDROCK_MODEL,
  councilModelForDepth,
  getBedrockRuntime
} from "./bedrockCouncil";

const originalEnabled = process.env.BEDROCK_ENABLED;
const originalModel = process.env.BEDROCK_MODEL;
const originalDeepModel = process.env.BEDROCK_DEEP_MODEL;

afterEach(() => {
  restore("BEDROCK_ENABLED", originalEnabled);
  restore("BEDROCK_MODEL", originalModel);
  restore("BEDROCK_DEEP_MODEL", originalDeepModel);
});

describe("Bedrock model routing", () => {
  it("uses Haiku for standard reviews and Sonnet for deep reviews", () => {
    delete process.env.BEDROCK_MODEL;
    delete process.env.BEDROCK_DEEP_MODEL;
    const runtime = getBedrockRuntime();

    expect(councilModelForDepth("standard", runtime)).toBe(DEFAULT_BEDROCK_MODEL);
    expect(councilModelForDepth("deep", runtime)).toBe(DEFAULT_DEEP_BEDROCK_MODEL);
    expect(runtime.deepModel).toContain("sonnet");
  });

  it("allows independent server-side overrides", () => {
    process.env.BEDROCK_MODEL = "global.anthropic.claude-haiku-custom";
    process.env.BEDROCK_DEEP_MODEL = "global.anthropic.claude-sonnet-custom";
    const runtime = getBedrockRuntime();

    expect(councilModelForDepth("standard", runtime)).toContain("haiku-custom");
    expect(councilModelForDepth("deep", runtime)).toContain("sonnet-custom");
  });
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
