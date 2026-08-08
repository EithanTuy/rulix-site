// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryAnalysisArtifactStore } from "./analysisArtifactStore";
import {
  createAnalysisRun,
  processAnalysisRun,
  type AnalysisRunQueueEvent
} from "./analysisRuns";
import {
  setAiDispatchAdmissionHook,
  setAiDispatchAuthorizationHook
} from "./aiEgressGateway";
import {
  TEST_MEMO,
  TEST_CITATION,
  TestAnalysisStore,
  TestRegulatoryCorpus,
  createWorkflowProvider,
  invocationRoles
} from "./test/agentWorkflowFixtures";

const ORIGINAL_ENV = { ...process.env };
const EVENT_ACCOUNT = "account-agent-workflow-test";

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

describe("durable multi-agent analysis runs", () => {
  it("executes independent required agents, bounds candidate concurrency, persists artifacts, and publishes only after verification", async () => {
    const corpus = new TestRegulatoryCorpus();
    const store = new TestAnalysisStore();
    store.run = createAnalysisRun({
      memo: TEST_MEMO,
      mode: "heavy",
      approvalId: "approval-test",
      requestId: "00000000-0000-4000-8000-000000000001",
      dataClass: "proprietary",
      corpus,
      now: new Date("2026-08-08T00:00:00.000Z")
    });
    const artifacts = new InMemoryAnalysisArtifactStore();
    const provider = createWorkflowProvider({ candidateCount: 5, candidateDelayMs: 12 });

    const completed = await processAnalysisRun(event(store.run.id), {
      store: store.asAccountStore(),
      artifactStore: artifacts,
      providerClient: provider.client,
      regulatoryCorpus: corpus,
      verifyApproval: async () => true
    });

    expect(completed.status).toBe("completed");
    expect(completed.progress).toBe(100);
    expect(completed.stages.every((stage) => stage.status === "completed")).toBe(true);
    expect(completed.callBudget.used).toBeGreaterThan(8);
    expect(completed.callBudget.used).toBeLessThanOrEqual(completed.callBudget.maximum);
    expect(completed.tokenBudget.used).toBeLessThanOrEqual(completed.tokenBudget.maximum);
    expect(provider.maximumActiveCandidates()).toBeGreaterThan(1);
    expect(provider.maximumActiveCandidates()).toBeLessThanOrEqual(completed.bindings.candidateConcurrency);

    const roles = invocationRoles(completed.invocations);
    expect(roles).toEqual(expect.arrayContaining([
      "intake-evidence",
      "jurisdiction",
      "candidate-research",
      "candidate-analysis",
      "adversarial-challenge",
      "citation-verification",
      "synthesis",
      "report-writing"
    ]));
    expect(roles.filter((role) => role === "candidate-analysis")).toHaveLength(5);
    expect(new Set(completed.invocations.map((invocation) => invocation.invocationId)).size).toBe(completed.invocations.length);
    expect(completed.invocations.every((invocation) => invocation.outputArtifactHash && invocation.status === "completed")).toBe(true);
    expect(Object.keys(completed.artifactHashes).every((ref) => ref.startsWith(`${EVENT_ACCOUNT}/`))).toBe(true);

    expect(store.result?.provider.source).toBe("agent-workflow");
    expect(store.result?.workflowId).toBe(completed.id);
    expect(store.result?.candidateResearch?.candidates).toHaveLength(5);
    expect(store.result?.candidateAnalyses).toHaveLength(5);
    expect(store.result?.adversarialChallenge).toBeDefined();
    expect(store.result?.citationAudit?.passed).toBe(true);
    expect(store.result?.reportNarrative).toContain("bounded workflow recommends");
    expect(store.result?.workflowInvocations).toHaveLength(completed.invocations.length);
  });

  it("stops before a provider call when approval is revoked at the immediate pre-call check", async () => {
    const corpus = new TestRegulatoryCorpus();
    const store = preparedStore(corpus);
    const provider = createWorkflowProvider();
    let approvalChecks = 0;

    const failed = await processAnalysisRun(event(store.run!.id), {
      store: store.asAccountStore(),
      artifactStore: new InMemoryAnalysisArtifactStore(),
      providerClient: provider.client,
      regulatoryCorpus: corpus,
      verifyApproval: async () => ++approvalChecks === 1
    });

    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/approval is no longer current/i);
    expect(provider.roles).toHaveLength(0);
    expect(store.result).toBeUndefined();
  });

  it("resumes from completed candidate artifacts after a transient aggregate-storage failure", async () => {
    const corpus = new TestRegulatoryCorpus();
    const store = preparedStore(corpus);
    const provider = createWorkflowProvider({ candidateCount: 5 });
    const durableArtifacts = new InMemoryAnalysisArtifactStore();
    let failAggregateOnce = true;
    const artifactStore = {
      put: async <T>(accountId: string, runId: string, stage: string, value: T) => {
        if (stage === "candidate-analysis" && failAggregateOnce) {
          failAggregateOnce = false;
          throw Object.assign(new Error("Synthetic S3 timeout"), { code: "ETIMEDOUT" });
        }
        return durableArtifacts.put(accountId, runId, stage, value);
      },
      get: <T>(accountId: string, ref: string) => durableArtifacts.get<T>(accountId, ref)
    };

    await expect(processAnalysisRun(event(store.run!.id), {
      store: store.asAccountStore(),
      artifactStore,
      providerClient: provider.client,
      regulatoryCorpus: corpus,
      verifyApproval: async () => true
    })).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(store.run?.status).toBe("running");
    expect(store.run?.stages.find((stage) => stage.stage === "candidate-analysis")).toMatchObject({
      status: "running",
      attempt: 1
    });
    expect(store.run?.invocations.filter((invocation) => invocation.role === "candidate-analysis")).toHaveLength(5);

    const completed = await processAnalysisRun(event(store.run!.id), {
      store: store.asAccountStore(),
      artifactStore,
      providerClient: provider.client,
      regulatoryCorpus: corpus,
      verifyApproval: async () => true
    });
    expect(completed.status).toBe("completed");
    expect(completed.stages.find((stage) => stage.stage === "candidate-analysis")?.attempt).toBe(2);
    expect(provider.roles.filter((role) => role === "candidate-analysis")).toHaveLength(5);
  });

  it("fails closed without model use for cancellation, memo drift, and an unapproved corpus", async () => {
    const approvedCorpus = new TestRegulatoryCorpus();

    const cancelledStore = preparedStore(approvedCorpus);
    cancelledStore.run!.cancelRequestedAt = "2026-08-08T00:00:01.000Z";
    const cancelledProvider = createWorkflowProvider();
    const cancelled = await processAnalysisRun(event(cancelledStore.run!.id), {
      store: cancelledStore.asAccountStore(),
      artifactStore: new InMemoryAnalysisArtifactStore(),
      providerClient: cancelledProvider.client,
      regulatoryCorpus: approvedCorpus,
      verifyApproval: async () => true
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelledProvider.roles).toHaveLength(0);

    const staleStore = preparedStore(approvedCorpus);
    staleStore.memo.memoText += " changed";
    staleStore.memo.contentHash = "d".repeat(64);
    const staleProvider = createWorkflowProvider();
    const stale = await processAnalysisRun(event(staleStore.run!.id), {
      store: staleStore.asAccountStore(),
      artifactStore: new InMemoryAnalysisArtifactStore(),
      providerClient: staleProvider.client,
      regulatoryCorpus: approvedCorpus,
      verifyApproval: async () => true
    });
    expect(stale.status).toBe("stale");
    expect(staleProvider.roles).toHaveLength(0);

    const blockedCorpus = new TestRegulatoryCorpus();
    blockedCorpus.status = () => ({
      ...approvedCorpus.status(),
      consequentialUseAllowed: false,
      errors: ["Corpus approval is pending."]
    });
    const blockedStore = preparedStore(blockedCorpus);
    const blockedProvider = createWorkflowProvider();
    const blocked = await processAnalysisRun(event(blockedStore.run!.id), {
      store: blockedStore.asAccountStore(),
      artifactStore: new InMemoryAnalysisArtifactStore(),
      providerClient: blockedProvider.client,
      regulatoryCorpus: blockedCorpus,
      verifyApproval: async () => true
    });
    expect(blocked.status).toBe("failed");
    expect(blocked.error).toContain("not approved");
    expect(blockedProvider.roles).toHaveLength(0);
  });

  it("analyzes a challenger-discovered candidate before synthesis", async () => {
    const corpus = new TestRegulatoryCorpus();
    const store = preparedStore(corpus, "heavy");
    const provider = createWorkflowProvider({
      candidateCount: 1,
      transformOutput: (role, input, output) => {
        if (role !== "adversarial-challenge") return output;
        const candidateCount = ((input.research as { candidates?: unknown[] } | undefined)?.candidates ?? []).length;
        if (candidateCount !== 1) return output;
        return {
          ...(output as Record<string, unknown>),
          summary: "The challenger found a concrete additional family that requires isolated analysis.",
          concreteDefectFound: true,
          additionalCandidates: [{
            id: "candidate-challenger-6a003",
            classification: "6A003",
            label: "Challenger-discovered imaging candidate",
            scope: "commodity",
            inclusionReason: "The adversarial agent identified a plausible alternative in the exact approved source set.",
            factualQuestions: ["Does the item meet the cited imaging criteria?"],
            regulatoryCitations: [TEST_CITATION]
          }]
        };
      }
    });

    const completed = await processAnalysisRun(event(store.run!.id), {
      store: store.asAccountStore(),
      artifactStore: new InMemoryAnalysisArtifactStore(),
      providerClient: provider.client,
      regulatoryCorpus: corpus,
      verifyApproval: async () => true
    });

    expect(completed.status).toBe("completed");
    expect(provider.roles.filter((role) => role === "adversarial-challenge")).toHaveLength(2);
    expect(provider.roles.filter((role) => role === "candidate-analysis")).toHaveLength(2);
    expect(store.result?.candidateResearch?.candidates.map((candidate) => candidate.id))
      .toContain("candidate-challenger-6a003");
    expect(store.result?.candidateAnalyses?.map((analysis) => analysis.candidateId))
      .toContain("candidate-challenger-6a003");
  });

  it("publishes the AI-selected family, risk, confidence explanation, and unresolved facts without a local semantic rewrite", async () => {
    const corpus = new TestRegulatoryCorpus();
    const store = preparedStore(corpus);
    const provider = createWorkflowProvider({
      candidateCount: 1,
      transformOutput: (role, _input, output) => {
        const value = output as Record<string, any>;
        if (role === "candidate-research") {
          value.candidates[0].classification = "6A003";
          value.candidates[0].label = "Model-selected imaging family";
        }
        if (role === "candidate-analysis") {
          value.classification = "6A003";
          value.outcome = "unresolved";
          value.criteria[0].disposition = "unresolved";
        }
        if (role === "synthesis") {
          value.recommended.eccn = "6A003";
          value.recommended.label = "Model-selected imaging family";
          value.recommended.risk = "high";
          value.recommended.summary = "The AI selected a different family despite radio terms in the memo.";
          value.confidenceExplanation = "The model selected strong support wording while explicitly preserving one unresolved technical fact.";
        }
        return value;
      }
    });

    const completed = await processAnalysisRun(event(store.run!.id), {
      store: store.asAccountStore(),
      artifactStore: new InMemoryAnalysisArtifactStore(),
      providerClient: provider.client,
      regulatoryCorpus: corpus,
      verifyApproval: async () => true
    });

    expect(completed.status).toBe("completed");
    expect(store.result?.recommended).toMatchObject({
      eccn: "6A003",
      risk: "high",
      summary: "The AI selected a different family despite radio terms in the memo."
    });
    expect(store.result?.confidenceExplanation)
      .toBe("The model selected strong support wording while explicitly preserving one unresolved technical fact.");
    expect(store.result?.candidateAnalyses?.[0]).toMatchObject({
      classification: "6A003",
      outcome: "unresolved"
    });
    expect(store.result?.candidateAnalyses?.[0]?.criteria[0]?.disposition).toBe("unresolved");

    const synthesisInput = [...provider.inputs].reverse().find((entry) => entry.role === "synthesis")?.input;
    expect(synthesisInput).toBeDefined();
    expect(Object.keys(synthesisInput ?? {}).sort()).toEqual([
      "analyses", "artifactIds", "challenge", "citationAudit", "evidence", "jurisdiction", "research"
    ]);
    expect(JSON.stringify(synthesisInput)).not.toMatch(/deterministicBaseline|localResult|local-rule/i);
  });

  it("fails the workflow after the single repair pass returns malformed output", async () => {
    const corpus = new TestRegulatoryCorpus();
    const store = preparedStore(corpus);
    const provider = createWorkflowProvider({ malformedRole: "intake-evidence" });

    const failed = await processAnalysisRun(event(store.run!.id), {
      store: store.asAccountStore(),
      artifactStore: new InMemoryAnalysisArtifactStore(),
      providerClient: provider.client,
      regulatoryCorpus: corpus,
      verifyApproval: async () => true
    });

    expect(failed.status).toBe("failed");
    expect(provider.roles).toEqual(["intake-evidence", "intake-evidence"]);
    expect(failed.invocations).toHaveLength(1);
    expect(failed.invocations[0]).toMatchObject({ role: "intake-evidence", status: "failed", attempt: 2 });
    expect(provider.roles).not.toContain("synthesis");
    expect(store.result).toBeUndefined();
  });

  it("prevents synthesis and publication when a required provider role fails", async () => {
    const corpus = new TestRegulatoryCorpus();
    const store = preparedStore(corpus);
    const provider = createWorkflowProvider({ failRole: "jurisdiction" });

    const failed = await processAnalysisRun(event(store.run!.id), {
      store: store.asAccountStore(),
      artifactStore: new InMemoryAnalysisArtifactStore(),
      providerClient: provider.client,
      regulatoryCorpus: corpus,
      verifyApproval: async () => true
    });

    expect(failed.status).toBe("failed");
    expect(provider.roles).toEqual(["intake-evidence", "jurisdiction"]);
    expect(provider.roles).not.toContain("synthesis");
    expect(provider.roles).not.toContain("report-writing");
    expect(store.result).toBeUndefined();
  });

  it("creates no run or classification when the approved provider lane is unavailable", () => {
    process.env.BEDROCK_ENABLED = "false";
    const store = new TestAnalysisStore();

    expect(() => createAnalysisRun({
      memo: TEST_MEMO,
      mode: "quick",
      approvalId: "approval-test",
      requestId: "00000000-0000-4000-8000-000000000003",
      dataClass: "proprietary",
      corpus: new TestRegulatoryCorpus()
    })).toThrow(/provider is not configured/i);
    expect(store.run).toBeUndefined();
    expect(store.result).toBeUndefined();
  });
});

function preparedStore(corpus: TestRegulatoryCorpus, mode: "quick" | "heavy" = "quick") {
  const store = new TestAnalysisStore();
  store.run = createAnalysisRun({
    memo: TEST_MEMO,
    mode,
    approvalId: "approval-test",
    requestId: "00000000-0000-4000-8000-000000000002",
    dataClass: "proprietary",
    corpus,
    now: new Date("2026-08-08T00:00:00.000Z")
  });
  return store;
}

function event(runId: string): AnalysisRunQueueEvent {
  return { source: "rulix.analysis-worker", schemaVersion: 1, accountId: EVENT_ACCOUNT, runId };
}
