// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryAnalysisArtifactStore } from "./analysisArtifactStore";
import { AgentToolRuntime } from "./agentTools";
import { AgentOutputValidationError, validateAgentOutput } from "./agentOutputValidation";
import {
  AGENT_WORKFLOW_MAX_CALLS,
  AGENT_WORKFLOW_MAX_TOKENS,
  runIntakeEvidenceAgent,
  type AgentWorkflowProviderContext
} from "./agentWorkflow";
import {
  issueTrustedAiWorkflowGrant,
  setAiDispatchAdmissionHook,
  setAiDispatchAuthorizationHook,
  type AiProviderClient
} from "./aiEgressGateway";
import {
  TEST_CITATION,
  TEST_MEMO,
  TestRegulatoryCorpus,
  sha256,
  testEvidence
} from "./test/agentWorkflowFixtures";
import type { AgentToolName } from "../src/types";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.BEDROCK_ENABLED = "true";
  process.env.AWS_REGION = "us-east-1";
  process.env.RULIX_APPROVED_PROVIDER = "amazon-bedrock";
  process.env.RULIX_APPROVED_REGION = "us-east-1";
  process.env.RULIX_AI_DATA_CLASS = "proprietary";
  setAiDispatchAuthorizationHook(async () => ({
    replayed: false,
    markProviderStarted: async () => undefined,
    settle: async () => undefined
  }));
  setAiDispatchAdmissionHook(async () => ({ settle: async () => undefined }));
});

afterEach(() => {
  setAiDispatchAdmissionHook(undefined);
  setAiDispatchAuthorizationHook(undefined);
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("agent workflow structural guardrails", () => {
  it("rejects evidence hashes and regulatory quotations that are not bound to exact tool bytes", () => {
    const evidence = testEvidence();
    evidence.evidence[0]!.contentHash = "f".repeat(64);
    expect(() => validateAgentOutput("intake-evidence", evidence, {
      memoText: TEST_MEMO.memoText,
      memoId: TEST_MEMO.id,
      memoRevision: 1,
      memoHash: TEST_MEMO.contentHash!
    })).toThrow(/content hash does not match/i);

    const research = {
      schemaVersion: "rulix.candidate-research/v1",
      searchSummary: "Bounded approved-corpus search.",
      orderOfReviewApplied: "Order of review applied.",
      candidates: [{
        id: "candidate-1",
        classification: "9A001",
        label: "Test candidate",
        scope: "commodity",
        inclusionReason: "Plausible from the exact entry.",
        factualQuestions: [],
        regulatoryCitations: [{ ...TEST_CITATION, exactText: "Invented shortened quotation." }]
      }],
      ear99SearchComplete: true
    };
    expect(() => validateAgentOutput("candidate-research", research, {
      memoText: "",
      memoId: TEST_MEMO.id,
      memoRevision: 1,
      memoHash: TEST_MEMO.contentHash!,
      allowedSourceIds: new Set([TEST_CITATION.sourceId]),
      regulatorySources: [TEST_CITATION]
    })).toThrow(/not an exact result returned by an approved corpus tool/i);
  });

  it("permits only one structural repair pass and reauthorizes immediately before both model calls", async () => {
    const authorizeCall = vi.fn(async () => undefined);
    const create = vi.fn<AiProviderClient["messages"]["create"]>(async (rawBody) => {
      const body = rawBody as { tools: Array<{ name: string }> };
      const outputTool = body.tools.find((tool) => tool.name === "record_intake_evidence")!;
      const output = testEvidence();
      if (create.mock.calls.length === 1) output.evidence[0]!.contentHash = sha256("not the excerpt");
      return {
        content: [{ type: "tool_use", name: outputTool.name, input: output }],
        usage: { input_tokens: 10, output_tokens: 10 }
      };
    });
    const context = workflowContext({ messages: { create } }, authorizeCall);

    const completed = await runIntakeEvidenceAgent(context);

    expect(completed.value).toEqual(testEvidence());
    expect(completed.invocation.attempt).toBe(2);
    expect(completed.invocation.providerCallCount).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(authorizeCall).toHaveBeenCalledTimes(2);
  });

  it("keeps immutable artifacts tenant-bound and case-document tools isolated", async () => {
    const store = new InMemoryAnalysisArtifactStore();
    const artifact = await store.put("account-a", "run-a", "intake-evidence", testEvidence());
    await expect(store.get("account-b", artifact.ref)).rejects.toThrow(/account binding mismatch/i);
    expect(await store.get("account-a", artifact.ref)).toEqual(testEvidence());

    const allowedTools = new Set<AgentToolName>([
      "search_case_documents",
      "read_case_excerpt",
      "read_agent_artifact"
    ]);
    const accountARuntime = new AgentToolRuntime({
      accountId: "account-a",
      memo: structuredClone(TEST_MEMO),
      allowedTools,
      corpus: new TestRegulatoryCorpus(),
      artifacts: new Map([[artifact.ref, testEvidence()]])
    });
    const search = accountARuntime.execute("search-a", "search_case_documents", { query: "radio" });
    const excerptId = (search.result as Array<{ id: string }>)[0]!.id;
    const accountBRuntime = new AgentToolRuntime({
      accountId: "account-b",
      memo: { ...structuredClone(TEST_MEMO), id: "review-account-b" },
      allowedTools,
      corpus: new TestRegulatoryCorpus(),
      artifacts: new Map()
    });

    expect(() => accountBRuntime.execute("read-cross-case", "read_case_excerpt", { excerptId }))
      .toThrow(/not found in this case scope/i);
    expect(() => accountBRuntime.execute("read-cross-tenant", "read_agent_artifact", { artifactId: artifact.ref }))
      .toThrow(/not found in this workflow scope/i);
  });
});

function workflowContext(
  providerClient: AiProviderClient,
  authorizeCall: () => Promise<void>
): AgentWorkflowProviderContext {
  return {
    accountId: "account-test",
    dataClass: "proprietary",
    runId: "run-test",
    memo: structuredClone(TEST_MEMO),
    trustedWorkflowGrant: issueTrustedAiWorkflowGrant("agent-workflow", "account-test:run-test"),
    corpus: new TestRegulatoryCorpus(),
    artifacts: new Map(),
    providerClient,
    budget: {
      maximumCalls: AGENT_WORKFLOW_MAX_CALLS,
      maximumTokens: AGENT_WORKFLOW_MAX_TOKENS,
      callsUsed: 0,
      tokensUsed: 0
    },
    authorizeCall
  };
}
