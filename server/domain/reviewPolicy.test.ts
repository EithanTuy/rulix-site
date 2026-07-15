// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_DATA_POLICY,
  ReviewPolicyError,
  assertDataClassAllowed,
  assertDecisionAllowed,
  assertRevisionTransition,
  decisionPolicyViolations,
  isDataClassAllowed,
  revisionPolicyViolations,
  type AnalysisDecisionBinding,
  type RevisionBinding
} from "./reviewPolicy";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("review data policy", () => {
  it("allows public and proprietary data by default and denies controlled classes", () => {
    expect(isDataClassAllowed("public")).toBe(true);
    expect(isDataClassAllowed("proprietary", DEFAULT_REVIEW_DATA_POLICY, "analyze")).toBe(true);
    expect(isDataClassAllowed("export-controlled")).toBe(false);
    expect(isDataClassAllowed("itar-risk", DEFAULT_REVIEW_DATA_POLICY, "analyze")).toBe(false);
    expect(() => assertDataClassAllowed("cui")).toThrow(ReviewPolicyError);
  });

  it("keeps storage approval separate from AI processing approval", () => {
    const policy = {
      allowedDataClasses: ["public", "proprietary", "export-controlled"] as const,
      aiAllowedDataClasses: ["public", "proprietary"] as const
    };
    expect(isDataClassAllowed("export-controlled", policy, "store")).toBe(true);
    expect(isDataClassAllowed("export-controlled", policy, "analyze")).toBe(false);
  });
});

describe("revision invariants", () => {
  const current: RevisionBinding = { id: "revision-2", version: 2, contentHash: HASH_A };

  it("accepts a revision based on the current version with changed hashed content", () => {
    expect(() => assertRevisionTransition(current, {
      baseRevisionId: "revision-2",
      expectedVersion: 2,
      nextContentHash: HASH_B
    })).not.toThrow();
  });

  it("rejects stale, mismatched, unchanged, and malformed transitions", () => {
    expect(revisionPolicyViolations(current, {
      baseRevisionId: "revision-1",
      expectedVersion: 1,
      nextContentHash: "not-a-hash"
    }).map(({ code }) => code)).toEqual([
      "stale_revision",
      "revision_base_mismatch",
      "invalid_content_hash"
    ]);
    expect(revisionPolicyViolations(current, {
      baseRevisionId: current.id,
      expectedVersion: current.version,
      nextContentHash: current.contentHash
    }).map(({ code }) => code)).toEqual(["revision_content_unchanged"]);
  });
});

describe("decision invariants", () => {
  const revision: RevisionBinding = { id: "revision-3", version: 3, contentHash: HASH_A };
  const analysis: AnalysisDecisionBinding = {
    id: "analysis-3",
    revisionId: revision.id,
    contentHash: revision.contentHash,
    status: "completed",
    live: true,
    findings: [{ status: "strong" }, { status: "weak" }]
  };

  it("allows a reasoned accept only when bound to the current completed live analysis", () => {
    expect(() => assertDecisionAllowed({
      action: "accept",
      notes: "Reviewed the cited thresholds and recorded the remaining weak note.",
      analysisRunId: analysis.id
    }, revision, analysis)).not.toThrow();
  });

  it("allows requesting information before analysis while still requiring notes", () => {
    expect(decisionPolicyViolations({
      action: "request-info",
      notes: "Confirm the configured maximum frequency."
    }, revision)).toEqual([]);
    expect(decisionPolicyViolations({ action: "request-info", notes: "" }, revision)
      .map(({ code }) => code)).toEqual(["decision_notes_required"]);
  });

  it("rejects stale, incomplete, non-live, or missing analysis bindings", () => {
    expect(decisionPolicyViolations({
      action: "accept",
      notes: "Reviewed.",
      analysisRunId: "another-run"
    }, revision, { ...analysis, revisionId: "revision-2", status: "running", live: false })
      .map(({ code }) => code)).toEqual([
      "analysis_binding_mismatch",
      "analysis_not_complete",
      "analysis_not_live"
    ]);
    expect(decisionPolicyViolations({ action: "accept", notes: "Reviewed." }, revision)
      .map(({ code }) => code)).toEqual(["analysis_required"]);
  });

  it("blocks acceptance on missing/conflicting evidence but permits an explicit override path", () => {
    const blocked = { ...analysis, findings: [{ status: "missing" as const }] };
    expect(decisionPolicyViolations({
      action: "accept",
      notes: "Accept anyway.",
      analysisRunId: blocked.id
    }, revision, blocked).map(({ code }) => code)).toContain("decision_blocked");
    expect(decisionPolicyViolations({
      action: "override",
      notes: "Authorized exception with documented rationale.",
      analysisRunId: blocked.id
    }, revision, blocked)).toEqual([]);
  });
});
