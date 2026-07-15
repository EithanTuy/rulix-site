// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewFixtures } from "../src/test/reviewFixtures";
import {
  DEFAULT_BEDROCK_MODEL,
  DEFAULT_DEEP_BEDROCK_MODEL,
  type CouncilProviderClient,
  councilModelForDepth,
  createLocalPublicMemoTemplate,
  getBedrockRuntime,
  runCouncilAnalysis,
  runMemoBuildChat,
  runMemoChatWithHaiku
} from "./bedrockCouncil";
import { setAiDispatchAdmissionHook, setAiDispatchAuthorizationHook } from "./aiEgressGateway";

const originalEnv = { ...process.env };

afterEach(() => {
  setAiDispatchAdmissionHook(undefined);
  setAiDispatchAuthorizationHook(undefined);
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
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

  it("fails closed instead of returning local deterministic analysis when Bedrock is disabled", async () => {
    delete process.env.BEDROCK_ENABLED;

    await expect(runCouncilAnalysis(reviewFixtures[0])).rejects.toThrow(
      "Live AI analysis is not configured. No deterministic analysis was recorded."
    );
  });

  it("runs a mocked standard provider response through the live council path", async () => {
    enableApprovedBedrock();
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
      onUsage,
      egress: testEgress()
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
    enableApprovedBedrock();
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
      providerClient: client,
      egress: testEgress()
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

  it("does not call the council provider when a caller label is below the server floor", async () => {
    enableApprovedBedrock();
    process.env.RULIX_AI_DATA_CLASS = "cui";
    process.env.RULIX_CONTROLLED_DATA_MODE = "approved";
    const { client, create } = mockCouncilClient({});

    await expect(runCouncilAnalysis(reviewFixtures[0], {
      providerClient: client,
      egress: { accountId: "test-account", dataClass: "public", dispatchId: "denied-council" }
    })).rejects.toMatchObject({ code: "ai_data_class_below_floor" });
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps denied chat and builder egress at zero calls and public templates local-only", async () => {
    enableApprovedBedrock();
    process.env.RULIX_AI_DATA_CLASS = "cui";
    process.env.RULIX_CONTROLLED_DATA_MODE = "approved";
    const chat = mockCouncilClient({});
    const builder = mockCouncilClient({});
    const draft = mockCouncilClient({});

    await expect(runMemoChatWithHaiku(
      reviewFixtures[0],
      "Explain the evidence",
      [],
      { providerClient: chat.client, egress: { accountId: "account", dataClass: "public", dispatchId: "denied-chat" } }
    )).rejects.toMatchObject({ code: "ai_data_class_below_floor" });
    await expect(runMemoBuildChat(
      [{ role: "user", content: "Build a memo" }],
      { providerClient: builder.client, egress: { accountId: "account", dataClass: "public", dispatchId: "denied-builder" } }
    )).rejects.toMatchObject({ code: "ai_data_class_below_floor" });
    const localDraft = await createLocalPublicMemoTemplate(
      "RLX-200 controller",
      { providerClient: draft.client, egress: { accountId: "account", dataClass: "public", dispatchId: "local-draft" } }
    );

    expect(chat.create).not.toHaveBeenCalled();
    expect(builder.create).not.toHaveBeenCalled();
    expect(draft.create).not.toHaveBeenCalled();
    expect(localDraft.provider).toMatchObject({ configured: false, live: false, model: "local-template" });
  });

  it("rechecks the current region before stored memo chat dispatch", async () => {
    enableApprovedBedrock();
    process.env.RULIX_APPROVED_REGION = "us-west-2";
    const { client, create } = mockCouncilClient({});

    await expect(runMemoChatWithHaiku(
      reviewFixtures[0],
      "Explain the evidence",
      [],
      { providerClient: client, egress: testEgress() }
    )).rejects.toMatchObject({ code: "ai_egress_lane_mismatch" });
    expect(create).not.toHaveBeenCalled();
  });

  it("fails closed instead of returning fallback analysis when the provider errors", async () => {
    enableApprovedBedrock();
    const create = vi.fn(async (_body: unknown, _options?: unknown) => {
      throw new Error("provider timeout");
    });
    const client: CouncilProviderClient = {
      messages: { create }
    };

    await expect(runCouncilAnalysis(reviewFixtures[0], {
      providerClient: client,
      egress: testEgress()
    })).rejects.toThrow(
      "Live AI analysis failed (provider timeout). No deterministic analysis was recorded."
    );
  });
});

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

function enableApprovedBedrock() {
  process.env.BEDROCK_ENABLED = "true";
  process.env.AWS_REGION = "us-east-1";
  process.env.RULIX_APPROVED_PROVIDER = "amazon-bedrock";
  process.env.RULIX_APPROVED_REGION = "us-east-1";
  process.env.RULIX_AI_DATA_CLASS = "proprietary";
  setAiDispatchAdmissionHook(async () => ({ settle: async () => undefined }));
  setAiDispatchAuthorizationHook(async () => ({
    replayed: false,
    markProviderStarted: async () => undefined,
    settle: async () => undefined
  }));
}

function testEgress() {
  return {
    accountId: "test-account",
    dataClass: "proprietary" as const,
    approvalId: "approval-test",
    dispatchId: "dispatch-test",
    subject: {
      kind: "review" as const,
      id: "review-test",
      revision: 1,
      version: 1,
      contentHash: "b".repeat(64)
    }
  };
}
