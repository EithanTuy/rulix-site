import { describe, expect, it } from "vitest";
import { sampleMemos } from "../data/sampleMemos";
import type { AuditEvent } from "../types";
import { analyzeMemo } from "./eccnReview";
import { buildReviewReport } from "./report";

describe("review report export", () => {
  it("includes reviewer decisions, audit events, and official citations", () => {
    const memo = sampleMemos[0];
    const result = analyzeMemo(memo);
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
    expect(report).toContain("Reviewer decision: accept");
    expect(report).toContain("Official Corpus");
    expect(report).toContain("15 CFR");
  });
});
