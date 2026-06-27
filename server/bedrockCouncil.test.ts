// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewFixtures } from "../src/test/reviewFixtures";
import {
  DEFAULT_BEDROCK_MODEL,
  DEFAULT_DEEP_BEDROCK_MODEL,
  type CouncilProviderClient,
  councilModelForDepth,
  getBedrockRuntime,
  runCouncilAnalysis
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

  it("runs a mocked standard provider response through the live council path", async () => {
    process.env.BEDROCK_ENABLED = "true";
    delete process.env.BEDROCK_MODEL;
    delete process.env.BEDROCK_DEEP_MODEL;
    const { client, create } = mockCouncilClient({
      recommended: {
        eccn: "3A001.a.5",
        label: "Cryogenic equipment candidate",
        confidence: 0.91,
        risk: "medium",
        summary: "The memo includes cryogenic performance evidence.",
        sourceChunkIds: ["chunk-3a001-cryogenic"]
      },
      findings: [
        {
          id: "ai-cryogenic-evidence",
          status: "strong",
          title: "Cryogenic performance evidence",
          claim: "The item reaches 1.2 K and lists cooling capacity.",
          rationale: "The cited corpus chunk supports Category 3 review.",
          sourceChunkIds: ["chunk-3a001-cryogenic"],
          agent: "evidence-mapper",
          severity: "info"
        }
      ],
      infoRequests: []
    });
    const onUsage = vi.fn();

    const result = await runCouncilAnalysis(reviewFixtures[0], {
      depth: "standard",
      providerClient: client,
      onUsage
    });
    const body = create.mock.calls[0][0] as { model: string; system: string };

    expect(body.model).toBe(DEFAULT_BEDROCK_MODEL);
    expect(body.system).toContain("Role rubrics");
    expect(result.provider.source).toBe("bedrock");
    expect(result.provider.model).toBe(DEFAULT_BEDROCK_MODEL);
    expect(result.agents).toHaveLength(7);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      model: DEFAULT_BEDROCK_MODEL,
      callType: "council",
      inputTokens: 100,
      outputTokens: 40
    }));
  });

  it("routes deep mocked analysis to Sonnet and keeps deterministic blockers", async () => {
    process.env.BEDROCK_ENABLED = "true";
    delete process.env.BEDROCK_MODEL;
    delete process.env.BEDROCK_DEEP_MODEL;
    const cameraMemo = reviewFixtures.find((memo) => memo.id === "fixture-camera-2026-0412")!;
    const { client, create } = mockCouncilClient({
      recommended: {
        eccn: "6A003 review",
        label: "High-speed camera candidate",
        confidence: 0.88,
        risk: "medium",
        summary: "The memo includes camera frame-rate evidence.",
        sourceChunkIds: ["chunk-6a003-camera"]
      },
      findings: [
        {
          id: "ai-camera-positive-evidence",
          status: "strong",
          title: "Camera evidence",
          claim: "The frame rate and resolution are stated.",
          rationale: "The cited corpus chunk supports Category 6 camera review.",
          sourceChunkIds: ["chunk-6a003-camera"],
          agent: "evidence-mapper",
          severity: "info"
        }
      ],
      agents: []
    });

    const result = await runCouncilAnalysis(cameraMemo, {
      depth: "deep",
      maxTokens: 3600,
      providerClient: client
    });
    const body = create.mock.calls[0][0] as { model: string; max_tokens: number };

    expect(body.model).toBe(DEFAULT_DEEP_BEDROCK_MODEL);
    expect(body.max_tokens).toBe(3600);
    expect(result.provider.depth).toBe("deep");
    expect(result.provider.model).toBe(DEFAULT_DEEP_BEDROCK_MODEL);
    expect(result.findings.some((finding) =>
      finding.status === "missing" && finding.title.includes("Camera sensor parameters")
    )).toBe(true);
  });
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function mockCouncilClient(input: unknown) {
  const create = vi.fn(async (_body: unknown, _options?: unknown) => ({
    content: [
      {
        type: "tool_use",
        name: "record_eccn_review",
        input
      }
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 40,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 2
    }
  }));
  const client: CouncilProviderClient = {
    messages: { create }
  };
  return { client, create };
}
