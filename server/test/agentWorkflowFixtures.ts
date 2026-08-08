import { createHash } from "node:crypto";
import type {
  AgentInvocationRecord,
  AnalysisRun,
  CaseEvidence,
  MemoRecord,
  RegulatoryCitation,
  ReviewResult
} from "../../src/types";
import type { AgentRegulatoryCorpus, RegulatoryToolRecord } from "../agentTools";
import type { AiProviderClient, AiProviderResponseBlock } from "../aiEgressGateway";
import type { AccountStore, AnalysisTransitionResult } from "../store";

export const TEST_MEMO_TEXT = "Model ZX-1 radio supports 2.4 GHz operation.";
export const TEST_MEMO: MemoRecord = {
  id: "review-agent-workflow-test",
  title: "ZX-1 radio classification memo",
  documentCode: "TEST-ZX1",
  itemFamily: "Radio",
  memoText: TEST_MEMO_TEXT,
  contentHash: sha256(TEST_MEMO_TEXT),
  dataClass: "proprietary",
  owner: "Fixture Reviewer",
  status: "needs-info",
  attachments: [],
  version: 1,
  revision: 1,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z"
};

export const TEST_SOURCE: RegulatoryToolRecord = {
  id: "ccl:9A001",
  sourceId: "ccl:9A001",
  title: "9A001 test entry",
  locator: "Supplement No. 1 to Part 774, ECCN 9A001",
  sourceDate: "2026-07-30",
  contentHash: sha256("9A001 controls the specified test radio criteria."),
  text: "9A001 controls the specified test radio criteria.",
  url: "https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-774",
  approvalStatus: "approved"
};

export const TEST_CITATION: RegulatoryCitation = {
  sourceId: TEST_SOURCE.sourceId,
  locator: TEST_SOURCE.locator,
  sourceDate: TEST_SOURCE.sourceDate,
  contentHash: TEST_SOURCE.contentHash,
  exactText: TEST_SOURCE.text
};

export class TestRegulatoryCorpus implements AgentRegulatoryCorpus {
  status(): ReturnType<AgentRegulatoryCorpus["status"]> {
    return {
      available: true,
      structurallyValid: true,
      snapshotId: "test-approved-corpus-2026-07-30",
      checksum: "c".repeat(64),
      consequentialUseAllowed: true,
      stale: false,
      reviewStatus: "verified",
      currentThrough: "2026-08-08",
      parserVersion: "test-parser/1",
      corpusBuildVersion: "test-build/1",
      missingSourceIds: [],
      errors: [],
    };
  }

  search() {
    return [structuredClone(TEST_SOURCE)];
  }

  read(sourceId: string) {
    return sourceId === TEST_SOURCE.sourceId ? structuredClone(TEST_SOURCE) : undefined;
  }

  followCrossReferences() {
    return [];
  }
}

export class TestAnalysisStore {
  run?: AnalysisRun;
  memo = structuredClone(TEST_MEMO);
  result?: ReviewResult;

  async getAnalysisRun(_accountId: string, runId: string) {
    return this.run?.id === runId ? structuredClone(this.run) : undefined;
  }

  async upsertAnalysisRun(_accountId: string, run: AnalysisRun, expectedUpdatedAt?: string) {
    if (this.run && expectedUpdatedAt !== undefined && this.run.updatedAt !== expectedUpdatedAt) {
      throw new Error(`optimistic run conflict: expected ${expectedUpdatedAt}, found ${this.run.updatedAt}`);
    }
    this.run = structuredClone(run);
  }

  async findReview(_accountId: string, memoId: string) {
    return memoId === this.memo.id ? structuredClone(this.memo) : undefined;
  }

  async setAnalysisResult(_accountId: string, memo: MemoRecord, result: ReviewResult): Promise<AnalysisTransitionResult> {
    const stored = { ...structuredClone(result), resultHash: sha256(JSON.stringify(result)) };
    this.result = stored;
    return {
      review: structuredClone(memo),
      result: stored,
      decisionInvalidated: false,
      auditEvents: []
    };
  }

  asAccountStore() {
    return this as unknown as AccountStore;
  }
}

export function testEvidence(memo = TEST_MEMO): CaseEvidence {
  return {
    schemaVersion: "rulix.case-evidence/v1",
    memoId: memo.id,
    memoRevision: memo.revision ?? 1,
    memoHash: memo.contentHash!,
    item: {
      name: "ZX-1 radio",
      model: "ZX-1",
      components: ["radio"],
      software: [],
      firmware: [],
      technology: ["2.4 GHz operation"],
      statedUses: []
    },
    evidence: [{
      id: "evidence-radio",
      documentId: `memo:${memo.id}`,
      documentTitle: memo.title,
      evidenceKind: "documented-fact",
      subject: "operating frequency",
      value: "2.4",
      units: "GHz",
      excerpt: memo.memoText,
      location: { kind: "character-range", start: 0, end: memo.memoText.length, label: `characters 0-${memo.memoText.length}` },
      contentHash: sha256(memo.memoText)
    }],
    conflicts: [],
    missingOrUnreadableRegions: []
  };
}

export interface TestWorkflowProviderOptions {
  candidateCount?: number;
  candidateDelayMs?: number;
  failRole?: string;
  malformedRole?: string;
  transformOutput?: (role: string, input: Record<string, unknown>, output: unknown) => unknown;
}

export function createWorkflowProvider(options: TestWorkflowProviderOptions = {}) {
  const roles: string[] = [];
  const inputs: Array<{ role: string; input: Record<string, unknown> }> = [];
  let activeCandidates = 0;
  let maximumActiveCandidates = 0;
  const candidateCount = options.candidateCount ?? 5;
  const client: AiProviderClient = {
    messages: {
      create: async (rawBody) => {
        const body = rawBody as Record<string, unknown>;
        const role = /Bounded role: ([a-z-]+)/.exec(String(body.system))?.[1] ?? "unknown";
        roles.push(role);
        const messages = body.messages as Array<{ role: string; content: unknown }>;
        const input = JSON.parse(String(messages[0]?.content ?? "{}")) as Record<string, unknown>;
        inputs.push({ role, input: structuredClone(input) });
        if (role === "candidate-research" && messages.length === 1) {
          return response([{ type: "tool_use", id: "tool-search", name: "search_regulatory_corpus", input: { query: "9A001 radio" } }]);
        }
        if (role === options.failRole) throw new Error(`Synthetic ${role} provider failure.`);
        if (role === "candidate-analysis") {
          activeCandidates += 1;
          maximumActiveCandidates = Math.max(maximumActiveCandidates, activeCandidates);
          await new Promise((resolve) => setTimeout(resolve, options.candidateDelayMs ?? 8));
          activeCandidates -= 1;
        }
        const tool = (body.tools as Array<{ name: string }>).find((item) => item.name.startsWith("record_"));
        if (!tool) throw new Error(`Missing output tool for ${role}.`);
        if (role === options.malformedRole) {
          return response([{ type: "tool_use", id: `output-${roles.length}`, name: tool.name, input: {} }]);
        }
        const defaultOutput = outputForRole(role, input, candidateCount);
        const output = options.transformOutput?.(role, input, structuredClone(defaultOutput)) ?? defaultOutput;
        return response([{ type: "tool_use", id: `output-${roles.length}`, name: tool.name, input: output as Record<string, unknown> }]);
      }
    }
  };
  return { client, roles, inputs, maximumActiveCandidates: () => maximumActiveCandidates };
}

function outputForRole(role: string, input: Record<string, unknown>, candidateCount: number) {
  if (role === "intake-evidence") {
    const inputMemo = input.memo as MemoRecord;
    return testEvidence({ ...TEST_MEMO, ...inputMemo });
  }
  if (role === "jurisdiction") return {
    outcome: "ear-likely",
    summary: "The supplied record supports EAR screening.",
    rationale: "The evidence does not establish an exclusive other-agency jurisdiction.",
    sourceChunkIds: [],
    evidenceIds: ["evidence-radio"],
    uncertainty: "Origin and specially-designed facts require human confirmation."
  };
  if (role === "candidate-research") return {
    schemaVersion: "rulix.candidate-research/v1",
    searchSummary: "The agent searched the approved CCL source and retained bounded plausible candidates.",
    orderOfReviewApplied: "Category, product group, entry text, notes, and EAR99 only after enumerated candidates.",
    candidates: Array.from({ length: candidateCount }, (_, index) => ({
      id: `candidate-${index + 1}`,
      classification: index === 0 ? "9A001" : `9A001-alt-${index}`,
      label: `Bounded candidate ${index + 1}`,
      scope: "commodity",
      inclusionReason: "The exact entry text is plausibly relevant to the documented radio fact.",
      factualQuestions: ["Does the product meet every technical threshold in the cited entry?"],
      regulatoryCitations: [TEST_CITATION]
    })),
    ear99SearchComplete: true
  };
  if (role === "candidate-analysis") {
    const candidate = input.candidate as Record<string, unknown>;
    return {
      schemaVersion: "rulix.candidate-analysis/v1",
      candidateId: candidate.id,
      classification: candidate.classification,
      outcome: candidate.id === "candidate-1" ? "supported" : "unresolved",
      summary: "The agent evaluated this candidate independently against the evidence ledger.",
      criteria: [{
        id: `${candidate.id}-criterion-1`,
        locator: TEST_CITATION.locator,
        criterion: "Specified radio criteria",
        disposition: candidate.id === "candidate-1" ? "supported" : "unresolved",
        explanation: "The memo documents a radio and frequency, while other thresholds remain subject to human verification.",
        evidenceIds: ["evidence-radio"],
        regulatoryCitations: [TEST_CITATION],
        missingInformationQuestions: ["Confirm the remaining technical thresholds."]
      }],
      exclusionsAndNotes: [],
      missingInformationQuestions: ["Confirm the remaining technical thresholds."]
    };
  }
  if (role === "adversarial-challenge") return {
    schemaVersion: "rulix.adversarial-challenge/v1",
    summary: "The challenge found no additional candidate within the approved search bound.",
    concreteDefectFound: false,
    challenges: [],
    additionalCandidates: [],
    inconsistentFactUses: []
  };
  if (role === "citation-verification") {
    const claims = input.claims as Array<{ id: string }>;
    return {
      schemaVersion: "rulix.citation-audit/v1",
      passed: true,
      summary: "All supplied claims were checked against their bound evidence and exact citations.",
      claims: claims.map((claim) => ({ claimId: claim.id, status: "verified", explanation: "Bound evidence supports the stated claim.", citationIds: [TEST_CITATION.sourceId] }))
    };
  }
  if (role === "synthesis") return {
    schemaVersion: "rulix.synthesis/v1",
    outcome: "classification-recommendation",
    jurisdiction: (input.jurisdiction as object),
    recommended: {
      eccn: "9A001",
      label: "AI candidate requiring human verification",
      risk: "medium",
      summary: "9A001 is the best-supported candidate in the bounded workflow.",
      supportingFacts: ["The memo documents radio operation."],
      weakeningFacts: [],
      unresolvedFacts: ["Remaining technical thresholds require confirmation."],
      rankingChangeFacts: ["A threshold mismatch may change the leading candidate."],
      sourceChunkIds: [TEST_CITATION.sourceId]
    },
    alternatives: [],
    findings: [{
      id: "finding-thresholds",
      status: "missing",
      title: "Confirm technical thresholds",
      claim: "Some enumerated thresholds are not established by the memo.",
      rationale: "The isolated candidate analyses preserved this missing information.",
      sourceChunkIds: [TEST_CITATION.sourceId],
      agent: "synthesis",
      severity: "review",
      remediationKind: "missing-fact"
    }],
    infoRequests: ["Confirm the remaining technical thresholds."],
    formatChecks: [{ key: "human-signoff", label: "Qualified human signoff required", pass: true }],
    confidenceExplanation: "Support is partial because specified thresholds remain unknown; this is not a calibrated probability.",
    evidenceAssessment: {
      level: "partial",
      summary: "The documented radio fact supports a candidate but not every element.",
      materialGaps: ["Remaining technical thresholds"],
      nonMaterialGaps: [],
      verifiedDispositiveFacts: ["The memo documents 2.4 GHz radio operation."],
      supportingSourceIds: [TEST_CITATION.sourceId]
    },
    decisionReadiness: {
      status: "blocked",
      summary: "A qualified reviewer must resolve the missing technical thresholds.",
      blockerFindingIds: ["finding-thresholds"]
    }
  };
  if (role === "report-writing") return {
    schemaVersion: "rulix.report-writing/v1",
    narrative: "The bounded workflow recommends 9A001 for qualified human review while preserving the unresolved technical thresholds."
  };
  throw new Error(`Unsupported test agent role ${role}.`);
}

function response(content: AiProviderResponseBlock[]) {
  return {
    content,
    usage: { input_tokens: 120, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  };
}

export function invocationRoles(invocations: AgentInvocationRecord[]) {
  return invocations.map((invocation) => invocation.role);
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
