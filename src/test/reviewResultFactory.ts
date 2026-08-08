import type { MemoRecord, ReviewResult } from "../types";

/** Test-only fixture. No runtime analysis code imports this module. */
export function makeReviewResult(memo: MemoRecord, overrides: Partial<ReviewResult> = {}): ReviewResult {
  const generatedAt = "2026-08-08T00:00:00.000Z";
  return {
    memoId: memo.id,
    generatedAt,
    corpusId: "test-corpus",
    corpusChecksum: "a".repeat(64),
    modelPolicy: "Test fixture only",
    provider: {
      source: "agent-workflow",
      label: "Test agent workflow",
      model: "test-model",
      live: true,
      message: "Test fixture",
      checkedAt: generatedAt
    },
    jurisdiction: {
      outcome: "ear-likely",
      summary: "Test fixture jurisdiction",
      rationale: "Test fixture rationale",
      sourceChunkIds: ["test-source"]
    },
    recommended: {
      eccn: "TEST-CANDIDATE",
      label: "Test candidate",
      confidence: 0.5,
      risk: "medium",
      summary: "Test fixture recommendation",
      sourceChunkIds: ["test-source"]
    },
    alternatives: [],
    findings: [],
    infoRequests: [],
    agents: [],
    id: `analysis-${memo.id}`,
    memoRevision: memo.revision ?? 1,
    inputHash: memo.contentHash,
    workflowVersion: "test-workflow/1",
    ...overrides
  };
}
