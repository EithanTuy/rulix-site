import { randomUUID } from "node:crypto";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type {
  AdversarialChallengeResult,
  AgentInvocationRecord,
  AgentToolName,
  AnalysisRun,
  AnalysisRunMode,
  AnalysisRunStageRecord,
  AuditEvent,
  CandidateAnalysisResult,
  CandidateResearchResult,
  CaseEvidence,
  CitationAuditResult,
  DataClass,
  JurisdictionFinding,
  MemoRecord,
  OrganizationPolicy,
  ReviewResult
} from "../src/types";
import type { UsageSample } from "./bedrockCouncil";
import { hashAiApprovalPayload } from "./domain/aiApproval";
import { hashMemoContent } from "./domain/hashes";
import { AiEgressPolicyError, currentAiApprovalPolicy, issueTrustedAiWorkflowGrant, resolveBedrockLane, type AiProviderClient } from "./aiEgressGateway";
import type { AnalysisArtifactStore } from "./analysisArtifactStore";
import { GeneratedRegulatoryCorpus, type AgentRegulatoryCorpus } from "./agentTools";
import {
  AGENT_WORKFLOW_CANDIDATE_CONCURRENCY,
  AGENT_WORKFLOW_MAX_CALLS,
  AGENT_WORKFLOW_MAX_CHALLENGE_ROUNDS,
  AGENT_WORKFLOW_MAX_TOKENS,
  AGENT_WORKFLOW_MODEL,
  AGENT_WORKFLOW_VERSION,
  claimsForCitationAudit,
  runAdversarialChallengeAgent,
  runCandidateAnalysisAgent,
  runCandidateResearchAgent,
  runCitationVerificationAgent,
  runIntakeEvidenceAgent,
  runJurisdictionAgent,
  runReportWritingAgent,
  runSynthesisAgent,
  workflowToolNames,
  AgentInvocationError,
  type AgentStageResult,
  type AgentWorkflowProviderContext,
  type WorkflowBudgetCounter
} from "./agentWorkflow";
import type { ReportWritingAgentOutput, SynthesisAgentOutput } from "./agentOutputValidation";
import type { AccountStore } from "./store";

export interface AnalysisRunQueueEvent {
  source: "rulix.analysis-worker";
  schemaVersion: 1;
  accountId: string;
  runId: string;
}

export interface AnalysisRunQueue {
  enqueue(event: AnalysisRunQueueEvent): Promise<void>;
}

export class SqsAnalysisRunQueue implements AnalysisRunQueue {
  constructor(
    private readonly queueUrl: string,
    private readonly client: SQSClient = new SQSClient({})
  ) {
    if (!queueUrl.trim()) throw new Error("Analysis queue URL is required.");
  }

  async enqueue(event: AnalysisRunQueueEvent) {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(event)
    }));
  }
}

export class InProcessAnalysisRunQueue implements AnalysisRunQueue {
  constructor(private readonly handler: (event: AnalysisRunQueueEvent) => Promise<void>) {}

  async enqueue(event: AnalysisRunQueueEvent) {
    setTimeout(() => void this.handler(event), 0);
  }
}

export function agentWorkflowApprovalExpectation(
  memo: MemoRecord,
  mode: AnalysisRunMode,
  dataClass: DataClass,
  organizationPolicy?: OrganizationPolicy,
  corpus: AgentRegulatoryCorpus = new GeneratedRegulatoryCorpus()
) {
  const memoRevision = memo.revision ?? 1;
  const memoHash = memo.contentHash ?? hashMemoContent(memo);
  const corpusStatus = corpus.status();
  const maximumChallengeRounds = mode === "heavy" ? AGENT_WORKFLOW_MAX_CHALLENGE_ROUNDS : 1;
  const permittedTools = workflowToolNames();
  const lane = resolveBedrockLane(AGENT_WORKFLOW_MODEL);
  if (!lane) throw new AiEgressPolicyError("ai_provider_unavailable", "The approved agent-workflow provider is not configured.", 503);
  const policy = currentAiApprovalPolicy(lane, dataClass);
  const workflow = {
    workflowVersion: AGENT_WORKFLOW_VERSION,
    corpusId: corpusStatus.snapshotId,
    corpusChecksum: corpusStatus.checksum,
    models: [AGENT_WORKFLOW_MODEL],
    maximumCalls: AGENT_WORKFLOW_MAX_CALLS,
    maximumTokens: AGENT_WORKFLOW_MAX_TOKENS,
    permittedTools
  };
  const payload = {
    schemaVersion: "rulix.agent-workflow-approval/v1",
    workflowVersion: AGENT_WORKFLOW_VERSION,
    mode,
    memoId: memo.id,
    memoRevision,
    memoHash,
    corpusSnapshotId: corpusStatus.snapshotId,
    corpusChecksum: corpusStatus.checksum,
    policyHash: workflowPolicyHash(dataClass, organizationPolicy, permittedTools),
    stageBudget: stageGraph().length,
    dataClass,
    models: workflow.models,
    maximumCalls: workflow.maximumCalls,
    maximumTokens: workflow.maximumTokens,
    maximumChallengeRounds,
    candidateConcurrency: AGENT_WORKFLOW_CANDIDATE_CONCURRENCY,
    permittedTools
  };
  return {
    subject: {
      kind: "review" as const,
      id: memo.id,
      version: memo.version ?? 1,
      revision: memoRevision,
      contentHash: memoHash
    },
    policy,
    workflow,
    payloadHash: hashAiApprovalPayload(payload),
    providerRequestHashes: [hashAiApprovalPayload({
      schemaVersion: "rulix.agent-workflow-grant-envelope/v1",
      workflow,
      payloadHash: hashAiApprovalPayload(payload)
    })],
    payload
  };
}

export function createAnalysisRun({
  memo,
  mode,
  approvalId,
  requestId,
  dataClass: authorizedDataClass,
  organizationPolicy,
  previousResult,
  corpus = new GeneratedRegulatoryCorpus(),
  now = new Date()
}: {
  memo: MemoRecord;
  mode: AnalysisRunMode;
  approvalId: string;
  requestId: string;
  dataClass?: DataClass;
  organizationPolicy?: OrganizationPolicy;
  previousResult?: ReviewResult;
  corpus?: AgentRegulatoryCorpus;
  now?: Date;
}): AnalysisRun {
  const timestamp = now.toISOString();
  const dataClass = authorizedDataClass ?? memo.dataClass ?? "proprietary";
  const expectation = agentWorkflowApprovalExpectation(memo, mode, dataClass, organizationPolicy, corpus);
  const memoRevision = expectation.subject.revision!;
  const memoHash = expectation.subject.contentHash;
  const stages = stageGraph().map((stage): AnalysisRunStageRecord => ({
    stage,
    status: "pending",
    attempt: 0,
    parentMemoHash: memoHash,
    parentStageHashes: []
  }));
  return {
    schemaVersion: "rulix.agent-workflow-run/v1",
    id: `analysis-run-${randomUUID()}`,
    requestId,
    memoId: memo.id,
    mode,
    status: "queued",
    stage: "queued",
    progress: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    previousResultId: previousResult?.id,
    invocations: [],
    artifactHashes: {},
    callBudget: { maximum: expectation.workflow.maximumCalls, used: 0 },
    tokenBudget: { maximum: expectation.workflow.maximumTokens, used: 0 },
    challengeRound: 0,
    bindings: {
      memoRevision,
      memoHash,
      workflowVersion: expectation.workflow.workflowVersion,
      models: expectation.workflow.models,
      corpusSnapshotId: expectation.workflow.corpusId,
      corpusChecksum: expectation.workflow.corpusChecksum,
      retrievalPolicyHash: expectation.payload.policyHash,
      stageBudget: stages.length,
      dataClass,
      approvalId,
      permittedTools: expectation.workflow.permittedTools,
      maximumChallengeRounds: expectation.payload.maximumChallengeRounds,
      candidateConcurrency: expectation.payload.candidateConcurrency
    },
    stages
  };
}

export function agentWorkflowEnabled() {
  return true;
}

export function agentWorkflowStageBudget() {
  return stageGraph().length;
}

export function recordAnalysisRunAuditEvent(
  store: AccountStore,
  accountId: string,
  event: AuditEvent
) {
  return store.appendAuditEvent(accountId, event);
}

export interface AnalysisRunProcessorDependencies {
  store: AccountStore;
  artifactStore: AnalysisArtifactStore;
  providerClient?: AiProviderClient;
  regulatoryCorpus?: AgentRegulatoryCorpus;
  organizationPolicy?: (accountId: string) => Promise<OrganizationPolicy | undefined>;
  verifyApproval?: (accountId: string, run: AnalysisRun, memo: MemoRecord) => Promise<boolean>;
  onUsage?: (sample: UsageSample) => void;
  now?: () => Date;
}

export async function processAnalysisRun(
  event: AnalysisRunQueueEvent,
  dependencies: AnalysisRunProcessorDependencies
) {
  if (event.source !== "rulix.analysis-worker" || event.schemaVersion !== 1) {
    throw new Error("Unsupported analysis worker event.");
  }
  let run = await dependencies.store.getAnalysisRun(event.accountId, event.runId);
  if (!run) throw new Error(`Analysis run ${event.runId} was not found.`);
  if (terminal(run)) return run;
  if (run.schemaVersion !== "rulix.agent-workflow-run/v1") {
    return updateTerminal(dependencies, event.accountId, run, "failed", "This queued record predates the agent workflow and cannot be executed.");
  }
  if (run.cancelRequestedAt) {
    return updateTerminal(dependencies, event.accountId, run, "cancelled", "Analysis was cancelled before the next agent invocation.");
  }
  const memo = await dependencies.store.findReview(event.accountId, run.memoId);
  if (!memo) return updateTerminal(dependencies, event.accountId, run, "stale", "Review no longer exists.");
  if (!memoMatchesRun(memo, run)) return updateTerminal(dependencies, event.accountId, run, "stale", "Review changed before analysis started.");
  const policy = await dependencies.organizationPolicy?.(event.accountId);
  if (workflowPolicyHash(run.bindings.dataClass, policy, run.bindings.permittedTools) !== run.bindings.retrievalPolicyHash) {
    return updateTerminal(dependencies, event.accountId, run, "stale", "The approved workflow data-handling policy changed before analysis started.");
  }
  const corpus = dependencies.regulatoryCorpus ?? new GeneratedRegulatoryCorpus();
  const corpusStatus = corpus.status();
  if (run.bindings.corpusSnapshotId !== corpusStatus.snapshotId || run.bindings.corpusChecksum !== corpusStatus.checksum) {
    return updateTerminal(dependencies, event.accountId, run, "stale", "The bound regulatory corpus changed before analysis started.");
  }
  if (!corpusStatus.consequentialUseAllowed) {
    return updateTerminal(
      dependencies,
      event.accountId,
      run,
      "failed",
      `The exact regulatory corpus is not approved for consequential analysis${corpusStatus.errors.length ? `: ${corpusStatus.errors.join(" ")}` : "."}`.slice(0, 1000)
    );
  }
  if (!(await approvalIsCurrent(dependencies, event.accountId, run, memo))) {
    return updateTerminal(dependencies, event.accountId, run, "failed", "The exact workflow approval is missing, expired, revoked, superseded, or no longer matches this run.");
  }

  const budget: WorkflowBudgetCounter = {
    maximumCalls: run.callBudget.maximum,
    maximumTokens: run.tokenBudget.maximum,
    callsUsed: run.callBudget.used,
    tokensUsed: run.tokenBudget.used
  };
  const artifacts = new Map<string, unknown>();
  const context: AgentWorkflowProviderContext = {
    accountId: event.accountId,
    dataClass: run.bindings.dataClass,
    runId: run.id,
    memo: { ...memo, revision: run.bindings.memoRevision, contentHash: run.bindings.memoHash },
    trustedWorkflowGrant: issueTrustedAiWorkflowGrant("agent-workflow", `${event.accountId}:${run.id}`),
    corpus,
    artifacts,
    providerClient: dependencies.providerClient,
    onUsage: dependencies.onUsage,
    budget,
    authorizeCall: async () => {
      const latestRun = await dependencies.store.getAnalysisRun(event.accountId, event.runId);
      const latestMemo = await dependencies.store.findReview(event.accountId, run!.memoId);
      if (!latestRun || !latestMemo || latestRun.cancelRequestedAt || !memoMatchesRun(latestMemo, latestRun)) {
        throw staleRunError("The run or exact memo revision changed before an agent invocation.");
      }
      if (!(await approvalIsCurrent(dependencies, event.accountId, latestRun, latestMemo))) {
        throw new Error("The exact workflow approval is no longer current.");
      }
      const latestCorpus = corpus.status();
      if (!latestCorpus.consequentialUseAllowed || latestCorpus.snapshotId !== latestRun.bindings.corpusSnapshotId || latestCorpus.checksum !== latestRun.bindings.corpusChecksum) {
        throw new Error("The bound regulatory corpus is no longer approved for consequential analysis.");
      }
    }
  };

  try {
    run = await ensureRunning(dependencies, event.accountId, run);

    const evidenceStage = await executeProviderStage<CaseEvidence>(dependencies, event.accountId, run, "intake-evidence", context, () => runIntakeEvidenceAgent(context));
    run = evidenceStage.run;
    const evidence = evidenceStage.value;

    await assertContinuable(dependencies, event.accountId, run, memo);
    const jurisdictionStage = await executeProviderStage<JurisdictionFinding>(dependencies, event.accountId, run, "jurisdiction", context, () =>
      runJurisdictionAgent(evidence, artifactRef(run!, "intake-evidence"), context));
    run = jurisdictionStage.run;
    const jurisdiction = jurisdictionStage.value;

    await assertContinuable(dependencies, event.accountId, run, memo);
    const researchStage = await executeProviderStage<CandidateResearchResult>(dependencies, event.accountId, run, "candidate-research", context, () =>
      runCandidateResearchAgent(evidence, jurisdiction, {
        evidence: artifactRef(run!, "intake-evidence"),
        jurisdiction: artifactRef(run!, "jurisdiction")
      }, context));
    run = researchStage.run;
    let research = researchStage.value;
    if (!research.candidates.length) throw new Error("Candidate research completed without a candidate; the workflow cannot synthesize from an empty search.");

    await assertContinuable(dependencies, event.accountId, run, memo);
    const analysesStage = await executeCandidateAnalysisStage(dependencies, event.accountId, run, context, evidence, research);
    run = analysesStage.run;
    let analyses = analysesStage.value;

    await assertContinuable(dependencies, event.accountId, run, memo);
    const challengeStage = await executeChallengeStage(dependencies, event.accountId, run, context, evidence, jurisdiction, research, analyses);
    run = challengeStage.run;
    research = challengeStage.research;
    analyses = challengeStage.analyses;
    const challenge = challengeStage.value;

    await assertContinuable(dependencies, event.accountId, run, memo);
    const claims = claimsForCitationAudit({ jurisdiction, research, analyses, challenge });
    const auditStage = await executeProviderStage<CitationAuditResult>(dependencies, event.accountId, run, "citation-verification", context, () =>
      runCitationVerificationAgent({
        evidence, jurisdiction, research, analyses, challenge, claims,
        artifactIds: completedArtifactRefs(run!)
      }, context));
    run = auditStage.run;
    const citationAudit = auditStage.value;

    await assertContinuable(dependencies, event.accountId, run, memo);
    const synthesisStage = await executeProviderStage<SynthesisAgentOutput>(dependencies, event.accountId, run, "synthesis", context, () =>
      runSynthesisAgent({
        evidence, jurisdiction, research, analyses, challenge, citationAudit,
        artifactIds: completedArtifactRefs(run!)
      }, context));
    run = synthesisStage.run;
    const synthesis = synthesisStage.value;

    await assertContinuable(dependencies, event.accountId, run, memo);
    const reportStage = await executeProviderStage<ReportWritingAgentOutput>(dependencies, event.accountId, run, "report-writing", context, () =>
      runReportWritingAgent(synthesis, artifactRef(run!, "synthesis"), context));
    run = reportStage.run;

    await assertContinuable(dependencies, event.accountId, run, memo);
    const cachedPublication = await cachedStage<ReviewResult>(dependencies, event.accountId, run, "publishing", context.artifacts);
    if (cachedPublication) return completePublishedRun(dependencies, event.accountId, run, cachedPublication);
    run = await beginStage(dependencies, event.accountId, run, "publishing");
    const generatedAt = timestamp(dependencies);
    const result: ReviewResult = {
      memoId: memo.id,
      generatedAt,
      corpusId: run.bindings.corpusSnapshotId,
      corpusChecksum: run.bindings.corpusChecksum,
      modelPolicy: "Independent bounded AI agents; qualified human export-control signoff required.",
      provider: {
        source: "agent-workflow",
        label: "Durable multi-agent analysis",
        model: run.bindings.models.join(", "),
        depth: run.mode === "heavy" ? "deep" : "standard",
        live: true,
        message: "All required agent roles completed against the exact approved corpus and memo revision. This is an AI recommendation, not a legal determination.",
        checkedAt: generatedAt
      },
      jurisdiction: synthesis.jurisdiction,
      recommended: synthesis.recommended,
      alternatives: synthesis.alternatives,
      findings: synthesis.findings,
      infoRequests: synthesis.infoRequests,
      formatChecks: synthesis.formatChecks,
      confidenceExplanation: synthesis.confidenceExplanation,
      outcome: synthesis.outcome,
      evidenceAssessment: synthesis.evidenceAssessment,
      decisionReadiness: synthesis.decisionReadiness,
      caseEvidence: evidence,
      candidateResearch: research,
      candidateAnalyses: analyses,
      adversarialChallenge: challenge,
      citationAudit,
      workflowId: run.id,
      workflowVersion: run.bindings.workflowVersion,
      workflowInvocations: structuredClone(run.invocations),
      agents: agentsFromInvocations(run.invocations),
      reportNarrative: reportStage.value.narrative,
      id: `analysis-${run.id}`,
      memoRevision: run.bindings.memoRevision,
      inputHash: run.bindings.memoHash,
      promptVersion: run.bindings.workflowVersion,
      createdBy: "agent-workflow"
    };
    const transition = await dependencies.store.setAnalysisResult(event.accountId, memo, result);
    const publication = await dependencies.artifactStore.put(event.accountId, run.id, "publishing", transition.result);
    run.artifactHashes[publication.ref] = publication.hash;
    context.artifacts.set(publication.ref, transition.result);
    run = await completeStage(dependencies, event.accountId, run, "publishing", publication.hash, publication.ref);
    return completePublishedRun(dependencies, event.accountId, run, transition.result);
  } catch (error) {
    const current = await dependencies.store.getAnalysisRun(event.accountId, event.runId) ?? run;
    if ((error as { code?: string })?.code === "stale_analysis_run") {
      return updateTerminal(dependencies, event.accountId, current, "stale", error instanceof Error ? error.message : "The run became stale.");
    }
    if (current.cancelRequestedAt) {
      return updateTerminal(dependencies, event.accountId, current, "cancelled", "Analysis was cancelled between agent invocations.");
    }
    if (!memoMatchesRun(await dependencies.store.findReview(event.accountId, current.memoId), current)) {
      return updateTerminal(dependencies, event.accountId, current, "stale", "Review changed while analysis was running.");
    }
    const runningStage = current.stages.find((stage) => stage.status === "running");
    if (isRetryableInfrastructureFailure(error) && runningStage && runningStage.attempt < 3) {
      runningStage.error = `Retryable infrastructure failure; the worker will resume from durable artifacts (attempt ${runningStage.attempt} of 3).`;
      await checkpointRun(dependencies, event.accountId, current);
      throw error;
    }
    return updateTerminal(
      dependencies,
      event.accountId,
      current,
      "failed",
      error instanceof Error ? error.message.slice(0, 1000) : "Analysis failed."
    );
  }
}

function isRetryableInfrastructureFailure(error: unknown) {
  if (error instanceof AgentInvocationError || error instanceof AiEgressPolicyError) return false;
  const value = error as { code?: unknown; name?: unknown; $metadata?: { httpStatusCode?: number } };
  const code = typeof value?.code === "string" ? value.code.toUpperCase() : "";
  const name = typeof value?.name === "string" ? value.name.toUpperCase() : "";
  const status = value?.$metadata?.httpStatusCode;
  return ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "THROTTLINGEXCEPTION", "REQUESTTIMEOUT"].includes(code)
    || name.includes("TIMEOUT")
    || name.includes("THROTTL")
    || (typeof status === "number" && (status === 429 || status >= 500));
}

async function executeCandidateAnalysisStage(
  dependencies: AnalysisRunProcessorDependencies,
  accountId: string,
  run: AnalysisRun,
  context: AgentWorkflowProviderContext,
  evidence: CaseEvidence,
  research: CandidateResearchResult
) {
  const cached = await cachedStage<CandidateAnalysisResult[]>(dependencies, accountId, run, "candidate-analysis", context.artifacts);
  if (cached) return { run, value: cached };
  run = await beginStage(dependencies, accountId, run, "candidate-analysis");
  try {
    const recovered = new Map<string, CandidateAnalysisResult>();
    for (const candidate of research.candidates) {
      const invocation = [...run.invocations].reverse().find((item) =>
        item.role === "candidate-analysis"
        && item.candidateId === candidate.id
        && item.status === "completed"
        && item.outputArtifactId
      );
      if (!invocation?.outputArtifactId) continue;
      const value = await dependencies.artifactStore.get<CandidateAnalysisResult>(accountId, invocation.outputArtifactId);
      if (value?.candidateId === candidate.id) {
        recovered.set(candidate.id, value);
        context.artifacts.set(invocation.outputArtifactId, value);
      }
    }
    const pendingCandidates = research.candidates.filter((candidate) => !recovered.has(candidate.id));
    const results = await mapBounded(pendingCandidates, run.bindings.candidateConcurrency, (candidate) =>
      runCandidateAnalysisAgent(evidence, candidate, {
        evidence: artifactRef(run, "intake-evidence"),
        candidateResearch: artifactRef(run, "candidate-research")
      }, context));
    for (const result of results) await persistInvocationArtifact(dependencies, accountId, run, context, result, `candidate-analysis-${result.value.candidateId}`);
    const completedNow = new Map(results.map((result) => [result.value.candidateId, result.value]));
    const values = research.candidates.map((candidate) => recovered.get(candidate.id) ?? completedNow.get(candidate.id)!);
    const artifact = await dependencies.artifactStore.put(accountId, run.id, "candidate-analysis", values);
    run.artifactHashes[artifact.ref] = artifact.hash;
    context.artifacts.set(artifact.ref, values);
    syncBudget(run, context.budget);
    run = await completeStage(dependencies, accountId, run, "candidate-analysis", artifact.hash, artifact.ref, combinedProviderBodyHash(results));
    return { run, value: values };
  } catch (error) {
    await recordInvocationFailure(dependencies, accountId, run, context, error);
    throw error;
  }
}

async function executeChallengeStage(
  dependencies: AnalysisRunProcessorDependencies,
  accountId: string,
  run: AnalysisRun,
  context: AgentWorkflowProviderContext,
  evidence: CaseEvidence,
  jurisdiction: JurisdictionFinding,
  initialResearch: CandidateResearchResult,
  initialAnalyses: CandidateAnalysisResult[]
) {
  const cached = await cachedStage<{ challenge: AdversarialChallengeResult; research: CandidateResearchResult; analyses: CandidateAnalysisResult[] }>(
    dependencies, accountId, run, "adversarial-challenge", context.artifacts
  );
  if (cached) return { run, value: cached.challenge, research: cached.research, analyses: cached.analyses };
  run = await beginStage(dependencies, accountId, run, "adversarial-challenge");
  let research = structuredClone(initialResearch);
  let analyses = structuredClone(initialAnalyses);
  let challenge: AdversarialChallengeResult | undefined;
  const recoveredChallengeInvocation = [...run.invocations].reverse().find((item) =>
    item.role === "adversarial-challenge" && item.status === "completed" && item.outputArtifactId
  );
  if (recoveredChallengeInvocation?.outputArtifactId) {
    challenge = await dependencies.artifactStore.get<AdversarialChallengeResult>(accountId, recoveredChallengeInvocation.outputArtifactId);
    if (challenge) context.artifacts.set(recoveredChallengeInvocation.outputArtifactId, challenge);
  }
  try {
    for (let round = run.challengeRound; (!challenge || challenge.additionalCandidates.length > 0) && round < run.bindings.maximumChallengeRounds; round += 1) {
      const challengeResult = await runAdversarialChallengeAgent({
        evidence, jurisdiction, research, analyses, artifactIds: completedArtifactRefs(run)
      }, context);
      await persistInvocationArtifact(dependencies, accountId, run, context, challengeResult, `adversarial-challenge-round-${round + 1}`);
      challenge = challengeResult.value;
      run.challengeRound = round + 1;
      const knownIds = new Set(research.candidates.map((candidate) => candidate.id));
      const added = challenge.additionalCandidates.filter((candidate) => !knownIds.has(candidate.id));
      if (!added.length) break;
      if (round + 1 >= run.bindings.maximumChallengeRounds) {
        throw new Error("The adversarial agent found additional plausible candidates at the approved challenge bound. The run is unresolved and was not published.");
      }
      research = { ...research, candidates: [...research.candidates, ...added] };
      const newAnalyses = await mapBounded(added, run.bindings.candidateConcurrency, (candidate) =>
        runCandidateAnalysisAgent(evidence, candidate, {
          evidence: artifactRef(run, "intake-evidence"),
          candidateResearch: artifactRef(run, "candidate-research")
        }, context));
      for (const result of newAnalyses) await persistInvocationArtifact(dependencies, accountId, run, context, result, `candidate-analysis-round-${round + 2}-${result.value.candidateId}`);
      analyses = [...analyses, ...newAnalyses.map((result) => result.value)];
      syncBudget(run, context.budget);
      await checkpointRun(dependencies, accountId, run);
    }
    if (!challenge) throw new Error("The required adversarial agent did not complete.");
    const value = { challenge, research, analyses };
    const artifact = await dependencies.artifactStore.put(accountId, run.id, "adversarial-challenge", value);
    run.artifactHashes[artifact.ref] = artifact.hash;
    context.artifacts.set(artifact.ref, value);
    syncBudget(run, context.budget);
    run = await completeStage(dependencies, accountId, run, "adversarial-challenge", artifact.hash, artifact.ref);
    return { run, value: challenge, research, analyses };
  } catch (error) {
    await recordInvocationFailure(dependencies, accountId, run, context, error);
    throw error;
  }
}

async function executeProviderStage<T extends CaseEvidence | JurisdictionFinding | CandidateResearchResult | CitationAuditResult | SynthesisAgentOutput | ReportWritingAgentOutput>(
  dependencies: AnalysisRunProcessorDependencies,
  accountId: string,
  run: AnalysisRun,
  stage: AnalysisRunStageRecord["stage"],
  context: AgentWorkflowProviderContext,
  execute: () => Promise<AgentStageResult<T>>
) {
  const cached = await cachedStage<T>(dependencies, accountId, run, stage, context.artifacts);
  if (cached) return { run, value: cached };
  run = await beginStage(dependencies, accountId, run, stage);
  try {
    const output = await execute();
    const artifact = await persistInvocationArtifact(dependencies, accountId, run, context, output, stage);
    if (artifact.hash !== output.outputHash) throw new Error(`${stage} artifact hash changed before persistence.`);
    syncBudget(run, context.budget);
    run = await completeStage(dependencies, accountId, run, stage, output.outputHash, artifact.ref, output.providerBodyHash);
    return { run, value: output.value };
  } catch (error) {
    await recordInvocationFailure(dependencies, accountId, run, context, error);
    throw error;
  }
}

async function persistInvocationArtifact<T>(
  dependencies: AnalysisRunProcessorDependencies,
  accountId: string,
  run: AnalysisRun,
  context: AgentWorkflowProviderContext,
  output: AgentStageResult<T & (CaseEvidence | JurisdictionFinding | CandidateResearchResult | CandidateAnalysisResult | AdversarialChallengeResult | CitationAuditResult | SynthesisAgentOutput | ReportWritingAgentOutput)>,
  artifactLabel: string
) {
  const artifact = await dependencies.artifactStore.put(accountId, run.id, artifactLabel, output.value);
  run.invocations.push({ ...output.invocation, outputArtifactId: artifact.ref, outputArtifactHash: artifact.hash });
  run.artifactHashes[artifact.ref] = artifact.hash;
  context.artifacts.set(artifact.ref, output.value);
  syncBudget(run, context.budget);
  await checkpointRun(dependencies, accountId, run);
  return artifact;
}

async function recordInvocationFailure(
  dependencies: AnalysisRunProcessorDependencies,
  accountId: string,
  run: AnalysisRun,
  context: AgentWorkflowProviderContext,
  error: unknown
) {
  if (!(error instanceof AgentInvocationError)) return;
  if (!run.invocations.some((item) => item.invocationId === error.invocation.invocationId)) {
    run.invocations.push(error.invocation);
    syncBudget(run, context.budget);
    await checkpointRun(dependencies, accountId, run);
  }
}

async function checkpointRun(
  dependencies: AnalysisRunProcessorDependencies,
  accountId: string,
  run: AnalysisRun
) {
  const previousUpdatedAt = run.updatedAt;
  run.updatedAt = timestamp(dependencies, previousUpdatedAt);
  await dependencies.store.upsertAnalysisRun(accountId, run, previousUpdatedAt);
}

async function cachedStage<T>(
  dependencies: AnalysisRunProcessorDependencies,
  accountId: string,
  run: AnalysisRun,
  stage: AnalysisRunStageRecord["stage"],
  artifacts?: Map<string, unknown>
) {
  const record = run.stages.find((candidate) => candidate.stage === stage);
  if (record?.status !== "completed" || !record.artifactRef) return undefined;
  const value = await dependencies.artifactStore.get<T>(accountId, record.artifactRef);
  if (value === undefined) throw new Error(`Completed ${stage} artifact is unavailable.`);
  artifacts?.set(record.artifactRef, value);
  return value;
}

async function approvalIsCurrent(
  dependencies: AnalysisRunProcessorDependencies,
  accountId: string,
  run: AnalysisRun,
  memo: MemoRecord
) {
  if (dependencies.verifyApproval) return dependencies.verifyApproval(accountId, run, memo);
  const status = await dependencies.store.getCurrentAiApproval(accountId, {
    purpose: "agent-workflow",
    subjectKind: "review",
    subjectId: memo.id
  });
  if (!status?.current || status.approval.id !== run.bindings.approvalId) return false;
  const approval = status.approval;
  const expectation = agentWorkflowApprovalExpectation(
    memo,
    run.mode,
    run.bindings.dataClass,
    await dependencies.organizationPolicy?.(accountId),
    dependencies.regulatoryCorpus ?? new GeneratedRegulatoryCorpus()
  );
  return approval.purpose === "agent-workflow"
    && approval.subject.kind === "review"
    && approval.subject.id === memo.id
    && approval.subject.version === expectation.subject.version
    && approval.subject.revision === run.bindings.memoRevision
    && approval.subject.contentHash === run.bindings.memoHash
    && approval.dataClass === run.bindings.dataClass
    && approval.payloadHash === expectation.payloadHash
    && approval.providerRequestHashes.length === 1
    && approval.providerRequestHashes[0] === expectation.providerRequestHashes[0]
    && approval.policy.model === AGENT_WORKFLOW_MODEL
    && approval.workflow?.workflowVersion === run.bindings.workflowVersion
    && approval.workflow.corpusId === run.bindings.corpusSnapshotId
    && approval.workflow.corpusChecksum === run.bindings.corpusChecksum
    && equalStrings(approval.workflow.models, run.bindings.models)
    && approval.workflow.maximumCalls === run.callBudget.maximum
    && approval.workflow.maximumTokens === run.tokenBudget.maximum
    && equalStrings(approval.workflow.permittedTools, run.bindings.permittedTools);
}

async function beginStage(
  dependencies: AnalysisRunProcessorDependencies,
  accountId: string,
  run: AnalysisRun,
  stage: AnalysisRunStageRecord["stage"]
) {
  const previousUpdatedAt = run.updatedAt;
  const record = requireStage(run, stage);
  record.status = "running";
  record.attempt += 1;
  record.startedAt = timestamp(dependencies, run.updatedAt);
  record.parentStageHashes = completedOutputHashes(run);
  run.status = "running";
  run.stage = stage;
  run.updatedAt = record.startedAt;
  run.progress = stageProgress(run, stage, false);
  return persistRun(dependencies, accountId, run, previousUpdatedAt);
}

async function completeStage(
  dependencies: AnalysisRunProcessorDependencies,
  accountId: string,
  run: AnalysisRun,
  stage: AnalysisRunStageRecord["stage"],
  outputHash: string,
  artifactRef: string,
  providerBodyHash?: string
) {
  const previousUpdatedAt = run.updatedAt;
  const record = requireStageRecord(run, stage);
  record.status = "completed";
  record.completedAt = timestamp(dependencies, run.updatedAt);
  record.outputHash = outputHash;
  record.artifactRef = artifactRef;
  if (providerBodyHash) record.providerBodyHash = providerBodyHash;
  run.updatedAt = record.completedAt;
  run.progress = stageProgress(run, stage, true);
  return persistRun(dependencies, accountId, run, previousUpdatedAt);
}

async function ensureRunning(dependencies: AnalysisRunProcessorDependencies, accountId: string, run: AnalysisRun) {
  if (run.status === "running") return run;
  const previousUpdatedAt = run.updatedAt;
  run.status = "running";
  run.startedAt ??= timestamp(dependencies, run.updatedAt);
  run.updatedAt = run.startedAt;
  return persistRun(dependencies, accountId, run, previousUpdatedAt);
}

async function completePublishedRun(
  dependencies: AnalysisRunProcessorDependencies,
  accountId: string,
  run: AnalysisRun,
  result: ReviewResult
) {
  const previousUpdatedAt = run.updatedAt;
  run.status = "completed";
  run.stage = "completed";
  run.progress = 100;
  run.completedAt = timestamp(dependencies, run.updatedAt);
  run.updatedAt = run.completedAt;
  run.resultId = result.id;
  return persistRun(dependencies, accountId, run, previousUpdatedAt);
}

async function assertContinuable(
  dependencies: AnalysisRunProcessorDependencies,
  accountId: string,
  run: AnalysisRun,
  expectedMemo: MemoRecord
) {
  const [latestRun, latestMemo] = await Promise.all([
    dependencies.store.getAnalysisRun(accountId, run.id),
    dependencies.store.findReview(accountId, run.memoId)
  ]);
  if (!latestRun) throw staleRunError("Analysis run disappeared.");
  if (latestRun.cancelRequestedAt) throw new Error("Analysis cancellation requested.");
  if (!memoMatchesRun(latestMemo, latestRun) || !memoMatchesRun(expectedMemo, latestRun)) {
    throw staleRunError("Review changed while analysis was running.");
  }
  if (!(await approvalIsCurrent(dependencies, accountId, latestRun, latestMemo!))) {
    throw new Error("The exact workflow approval is no longer current.");
  }
}

async function persistRun(
  dependencies: AnalysisRunProcessorDependencies,
  accountId: string,
  run: AnalysisRun,
  expectedUpdatedAt?: string
) {
  await dependencies.store.upsertAnalysisRun(accountId, run, expectedUpdatedAt);
  return structuredClone(run);
}

async function updateTerminal(
  dependencies: AnalysisRunProcessorDependencies,
  accountId: string,
  run: AnalysisRun,
  status: "failed" | "cancelled" | "stale",
  error: string
) {
  if (terminal(run)) return run;
  const previousUpdatedAt = run.updatedAt;
  const currentStage = run.stages.find((stage) => stage.status === "running");
  if (currentStage) {
    currentStage.status = status === "cancelled" ? "cancelled" : status === "stale" ? "stale" : "failed";
    currentStage.error = error;
    currentStage.completedAt = timestamp(dependencies, run.updatedAt);
  }
  run.status = status;
  run.stage = status;
  run.error = error;
  run.completedAt = timestamp(dependencies, currentStage?.completedAt ?? run.updatedAt);
  run.updatedAt = run.completedAt;
  return persistRun(dependencies, accountId, run, previousUpdatedAt);
}

function requireStage(run: AnalysisRun, stage: AnalysisRunStageRecord["stage"]) {
  const record = requireStageRecord(run, stage);
  const predecessorIncomplete = run.stages.slice(0, run.stages.indexOf(record)).some((candidate) => candidate.status !== "completed");
  if (predecessorIncomplete) throw new Error(`Stage ${stage} cannot run before its predecessors complete.`);
  if (record.status === "completed") throw new Error(`Stage ${stage} already completed successfully.`);
  return record;
}

function requireStageRecord(run: AnalysisRun, stage: AnalysisRunStageRecord["stage"]) {
  const record = run.stages.find((candidate) => candidate.stage === stage);
  if (!record) throw new Error(`Stage ${stage} is not admitted by this run's approved graph.`);
  return record;
}

function artifactRef(run: AnalysisRun, stage: AnalysisRunStageRecord["stage"]) {
  const ref = requireStageRecord(run, stage).artifactRef;
  if (!ref) throw new Error(`The ${stage} artifact is unavailable.`);
  return ref;
}

function completedArtifactRefs(run: AnalysisRun) {
  return run.stages.flatMap((stage) => stage.status === "completed" && stage.artifactRef ? [stage.artifactRef] : []);
}

function completedOutputHashes(run: AnalysisRun) {
  return run.stages.flatMap((stage) => stage.status === "completed" && stage.outputHash ? [stage.outputHash] : []);
}

function stageGraph(): AnalysisRunStageRecord["stage"][] {
  return [
    "intake-evidence",
    "jurisdiction",
    "candidate-research",
    "candidate-analysis",
    "adversarial-challenge",
    "citation-verification",
    "synthesis",
    "report-writing",
    "publishing"
  ];
}

function stageProgress(run: AnalysisRun, stage: AnalysisRunStageRecord["stage"], completed: boolean) {
  const index = run.stages.findIndex((candidate) => candidate.stage === stage);
  return Math.round(((index + (completed ? 1 : 0.25)) / run.stages.length) * 100);
}

function memoMatchesRun(memo: MemoRecord | undefined, run: AnalysisRun) {
  if (!memo) return false;
  return (memo.revision ?? 1) === run.bindings.memoRevision
    && (memo.contentHash ?? hashMemoContent(memo)) === run.bindings.memoHash;
}

function terminal(run: AnalysisRun) {
  return run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "stale";
}

function syncBudget(run: AnalysisRun, budget: WorkflowBudgetCounter) {
  run.callBudget.used = budget.callsUsed;
  run.tokenBudget.used = budget.tokensUsed;
}

function agentsFromInvocations(invocations: AgentInvocationRecord[]) {
  return invocations.map((invocation) => ({
    role: invocation.role,
    label: invocation.candidateId ? `${invocation.role}: ${invocation.candidateId}` : invocation.role,
    status: invocation.status === "completed" ? "complete" as const : invocation.status === "failed" ? "failed" as const : "blocked" as const,
    summary: invocation.status === "completed" ? "Independent agent artifact completed." : "Agent invocation did not complete.",
    invocationId: invocation.invocationId,
    model: invocation.model,
    promptVersion: invocation.promptVersion,
    attempt: invocation.attempt,
    latencyMs: invocation.latencyMs,
    inputTokens: invocation.usage?.inputTokens,
    outputTokens: invocation.usage?.outputTokens,
    outputArtifactId: invocation.outputArtifactId
  }));
}

function workflowPolicyHash(dataClass: DataClass, policy: OrganizationPolicy | undefined, tools: AgentToolName[]) {
  return hashAiApprovalPayload({
    schemaVersion: "rulix.agent-workflow-policy/v1",
    dataClass,
    organizationPolicy: policy ?? null,
    permittedTools: tools
  });
}

function equalStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function combinedProviderBodyHash(results: Array<{ providerBodyHash: string }>) {
  return hashAiApprovalPayload(results.map((result) => result.providerBodyHash));
}

async function mapBounded<T, R>(values: T[], concurrency: number, execute: (value: T, index: number) => Promise<R>) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, values.length)) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await execute(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function staleRunError(message: string) {
  return Object.assign(new Error(message), { code: "stale_analysis_run" });
}

function timestamp(dependencies: AnalysisRunProcessorDependencies, after?: string) {
  const value = (dependencies.now ?? (() => new Date()))().toISOString();
  if (!after || value > after) return value;
  return new Date(Date.parse(after) + 1).toISOString();
}
