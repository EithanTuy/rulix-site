import { describe, expect, it } from "vitest";
import { reviewFixtures } from "../test/reviewFixtures";
import type { AuditEvent } from "../types";
import { makeReviewResult } from "../test/reviewResultFactory";
import { createHash } from "node:crypto";
import { buildReviewReport } from "./report";

describe("review report export", () => {
  it("includes reviewer decisions, audit events, and official citations", () => {
    const memo = reviewFixtures[0];
    const exactText = "9A001 controls the specified test radio criteria.";
    const citation = {
      sourceId: "ccl:9A001",
      locator: "Supplement No. 1 to Part 774, ECCN 9A001",
      sourceDate: "2026-07-30",
      contentHash: createHash("sha256").update(exactText).digest("hex"),
      exactText
    };
    const result = makeReviewResult(memo, {
      workflowId: "analysis-run-test",
      workflowVersion: "rulix.agent-workflow/1",
      candidateResearch: {
        schemaVersion: "rulix.candidate-research/v1",
        searchSummary: "Approved-corpus search completed.",
        orderOfReviewApplied: "Applied Supplement No. 4 order of review.",
        ear99SearchComplete: true,
        candidates: [{
          id: "candidate-9a001",
          classification: "9A001",
          label: "Test radio candidate",
          scope: "commodity",
          inclusionReason: "The exact entry is plausibly relevant.",
          factualQuestions: [],
          regulatoryCitations: [citation]
        }]
      },
      workflowInvocations: [{
        role: "candidate-research",
        invocationId: "invocation-test",
        model: "test-model",
        promptVersion: "rulix.agent-workflow/1/candidate-research/1",
        inputArtifactIds: ["evidence-test"],
        inputArtifactHashes: ["a".repeat(64)],
        outputArtifactId: "account/run/candidate-research.json",
        outputArtifactHash: "b".repeat(64),
        status: "completed",
        attempt: 1,
        providerCallCount: 2
      }]
    });
    const auditEvents: AuditEvent[] = [
      {
        id: "audit-test",
        memoId: memo.id,
        at: "2026-06-14T04:00:00.000Z",
        actor: "Reviewer JW",
        action: "Reviewer decision: accept",
        detail: "Accepted after evidence review.",
        severity: "info"
      }
    ];

    const report = buildReviewReport(
      memo,
      result,
      {
        action: "accept",
        notes: "Accepted after human review.",
        signedBy: "Reviewer JW",
        signedAt: "2026-06-14T04:01:00.000Z"
      },
      auditEvents
    );

    expect(report).toContain("Action: accept");
    expect(report).toContain("## Reproducibility Bindings");
    expect(report).toContain(`Exact memo revision: ${result.memoRevision ?? memo.revision ?? "unknown"}`);
    expect(report).toContain("Reviewer decision: accept");
    expect(report).toContain("Workflow run ID: analysis-run-test");
    expect(report).toContain("## Agent Invocation Ledger");
    expect(report).toContain("Supplement No. 1 to Part 774, ECCN 9A001");
    expect(report).toContain(exactText);
  });
});
