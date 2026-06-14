import type { AuditEvent, MemoRecord, ReviewResult, ReviewerDecision, ReviewStatus } from "../types";

export function deriveReviewStatus(
  result: ReviewResult,
  decision?: ReviewerDecision
): ReviewStatus {
  if (decision?.action === "accept") return "signed-off";
  if (decision?.action === "override") return "conflict";
  if (decision?.action === "request-info") return "needs-info";
  if (result.findings.some((finding) => finding.status === "conflict")) return "conflict";
  if (result.findings.some((finding) => finding.status === "missing" || finding.status === "weak")) {
    return "needs-info";
  }
  return "ready";
}

export function createAuditEvent(
  memoId: string,
  action: string,
  detail: string,
  severity: AuditEvent["severity"] = "info",
  actor = "Reviewer JW"
): AuditEvent {
  return {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    memoId,
    at: new Date().toISOString(),
    actor,
    action,
    detail,
    severity
  };
}

export function seedAuditEvents(memos: MemoRecord[]): AuditEvent[] {
  return memos.map((memo, index) => ({
    id: `seed-audit-${memo.id}`,
    memoId: memo.id,
    at: new Date(Date.UTC(2026, 4, 14 - index, 14, 30)).toISOString(),
    actor: memo.owner,
    action: "Seed review imported",
    detail: `${memo.title} loaded with ${memo.attachments.length} attachment${memo.attachments.length === 1 ? "" : "s"}.`,
    severity: memo.status === "conflict" ? "escalate" : memo.status === "needs-info" ? "review" : "info"
  }));
}

export function summarizeReadiness(result: ReviewResult) {
  const counts = result.findings.reduce(
    (acc, finding) => {
      acc[finding.status] += 1;
      return acc;
    },
    { strong: 0, weak: 0, missing: 0, conflict: 0 }
  );

  const blockers = counts.conflict + counts.missing;
  return {
    counts,
    blockers,
    label: blockers > 0 ? "Blocked" : counts.weak > 0 ? "Needs reviewer notes" : "Ready for signoff"
  };
}
