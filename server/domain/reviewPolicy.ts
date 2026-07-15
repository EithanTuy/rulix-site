import type {
  DataClass,
  EvidenceFinding,
  ReviewerDecision
} from "../../src/types";

export interface ReviewDataPolicy {
  allowedDataClasses: readonly DataClass[];
  aiAllowedDataClasses?: readonly DataClass[];
}

export const DEFAULT_REVIEW_DATA_POLICY: ReviewDataPolicy = Object.freeze({
  allowedDataClasses: Object.freeze(["public", "proprietary"] as DataClass[]),
  aiAllowedDataClasses: Object.freeze(["public", "proprietary"] as DataClass[])
});

export type DataPolicyOperation = "store" | "analyze";

export interface RevisionBinding {
  id: string;
  version: number;
  contentHash: string;
}

export interface RevisionCommand {
  baseRevisionId: string;
  expectedVersion: number;
  nextContentHash: string;
}

export type AnalysisRunStatus = "queued" | "running" | "completed" | "failed" | "stale";

export interface AnalysisDecisionBinding {
  id: string;
  revisionId: string;
  contentHash: string;
  status: AnalysisRunStatus;
  live: boolean;
  findings: ReadonlyArray<Pick<EvidenceFinding, "status">>;
}

export interface DecisionCommand {
  action: ReviewerDecision["action"];
  notes: string;
  analysisRunId?: string;
}

export type ReviewPolicyCode =
  | "data_class_not_allowed"
  | "stale_revision"
  | "revision_base_mismatch"
  | "revision_content_unchanged"
  | "invalid_content_hash"
  | "decision_notes_required"
  | "analysis_required"
  | "analysis_binding_mismatch"
  | "analysis_not_complete"
  | "analysis_not_live"
  | "decision_blocked";

export interface ReviewPolicyViolation {
  code: ReviewPolicyCode;
  message: string;
  status: 409 | 422;
}

export class ReviewPolicyError extends Error {
  constructor(readonly violation: ReviewPolicyViolation) {
    super(violation.message);
    this.name = "ReviewPolicyError";
  }

  get code(): ReviewPolicyCode {
    return this.violation.code;
  }

  get status(): 409 | 422 {
    return this.violation.status;
  }
}

export function isDataClassAllowed(
  dataClass: DataClass,
  policy: ReviewDataPolicy = DEFAULT_REVIEW_DATA_POLICY,
  operation: DataPolicyOperation = "store"
): boolean {
  if (!policy.allowedDataClasses.includes(dataClass)) return false;
  if (operation === "store") return true;
  return (policy.aiAllowedDataClasses ?? policy.allowedDataClasses).includes(dataClass);
}

export function assertDataClassAllowed(
  dataClass: DataClass,
  policy: ReviewDataPolicy = DEFAULT_REVIEW_DATA_POLICY,
  operation: DataPolicyOperation = "store"
): void {
  if (!isDataClassAllowed(dataClass, policy, operation)) {
    throw new ReviewPolicyError({
      code: "data_class_not_allowed",
      message: `${dataClass} data is not approved for ${operation} in this organization.`,
      status: 422
    });
  }
}

export function revisionPolicyViolations(
  current: RevisionBinding,
  command: RevisionCommand
): ReviewPolicyViolation[] {
  const violations: ReviewPolicyViolation[] = [];

  if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion !== current.version) {
    violations.push({
      code: "stale_revision",
      message: "The review changed after this edit began. Reload the current revision before saving.",
      status: 409
    });
  }
  if (command.baseRevisionId !== current.id) {
    violations.push({
      code: "revision_base_mismatch",
      message: "The proposed revision is not based on the current memo revision.",
      status: 409
    });
  }
  if (!isSha256(command.nextContentHash)) {
    violations.push({
      code: "invalid_content_hash",
      message: "The proposed revision must include a valid SHA-256 content hash.",
      status: 422
    });
  } else if (command.nextContentHash === current.contentHash) {
    violations.push({
      code: "revision_content_unchanged",
      message: "The proposed revision does not change the reviewable memo content.",
      status: 409
    });
  }

  return violations;
}

export function assertRevisionTransition(
  current: RevisionBinding,
  command: RevisionCommand
): void {
  const [violation] = revisionPolicyViolations(current, command);
  if (violation) throw new ReviewPolicyError(violation);
}

export function decisionPolicyViolations(
  command: DecisionCommand,
  currentRevision: RevisionBinding,
  analysis?: AnalysisDecisionBinding
): ReviewPolicyViolation[] {
  const violations: ReviewPolicyViolation[] = [];

  if (!command.notes.trim()) {
    violations.push({
      code: "decision_notes_required",
      message: "A reviewer decision requires explanatory notes.",
      status: 422
    });
  }

  // Requesting information is intentionally available before analysis exists.
  if (command.action === "request-info") return violations;

  if (!analysis) {
    violations.push({
      code: "analysis_required",
      message: "A current completed analysis is required before this decision.",
      status: 409
    });
    return violations;
  }

  if (
    !command.analysisRunId ||
    command.analysisRunId !== analysis.id ||
    analysis.revisionId !== currentRevision.id ||
    analysis.contentHash !== currentRevision.contentHash
  ) {
    violations.push({
      code: "analysis_binding_mismatch",
      message: "The decision is not bound to the current memo revision and analysis run.",
      status: 409
    });
  }
  if (analysis.status !== "completed") {
    violations.push({
      code: "analysis_not_complete",
      message: "The bound analysis run has not completed successfully.",
      status: 409
    });
  }
  if (!analysis.live) {
    violations.push({
      code: "analysis_not_live",
      message: "A live provider analysis is required for an authoritative decision.",
      status: 409
    });
  }
  if (command.action === "accept" && hasBlockingFindings(analysis.findings)) {
    violations.push({
      code: "decision_blocked",
      message: "Missing or conflicting evidence must be resolved or explicitly overridden.",
      status: 409
    });
  }

  return violations;
}

export function assertDecisionAllowed(
  command: DecisionCommand,
  currentRevision: RevisionBinding,
  analysis?: AnalysisDecisionBinding
): void {
  const [violation] = decisionPolicyViolations(command, currentRevision, analysis);
  if (violation) throw new ReviewPolicyError(violation);
}

export function hasBlockingFindings(
  findings: ReadonlyArray<Pick<EvidenceFinding, "status">>
): boolean {
  return findings.some((finding) => finding.status === "missing" || finding.status === "conflict");
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}
