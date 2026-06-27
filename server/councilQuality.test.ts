// @vitest-environment node

import { describe, expect, it } from "vitest";
import { analyzeMemo, verifyCitations } from "../src/lib/eccnReview";
import { reviewFixtures } from "../src/test/reviewFixtures";
import type { MemoRecord, ReviewResult } from "../src/types";
import {
  COUNCIL_AGENT_ROLES,
  mergeCouncilPayload,
  type AiCouncilPayload
} from "./councilQuality";

describe("council quality normalization", () => {
  it("drops AI findings that do not cite the official corpus", () => {
    const memo = fixture("fixture-camera-2026-0412");
    const result = merge(memo, {
      findings: [
        {
          id: "unsupported-ai-blocker",
          status: "missing",
          title: "Unsupported blocker",
          claim: "The reviewer must request broad legal approval.",
          rationale: "This blocker has no valid source chunk.",
          sourceChunkIds: ["chunk-does-not-exist"],
          agent: "risk-reviewer",
          severity: "escalate"
        }
      ]
    });

    expect(result.findings.some((finding) => finding.id === "unsupported-ai-blocker")).toBe(false);
    expect(verifyCitations(result)).toEqual([]);
  });

  it("restores every council role when the model omits agents", () => {
    const memo = fixture("fixture-cryo-2026-0417");
    const result = merge(memo, {
      agents: [
        {
          role: "memo-parser",
          label: "Memo Parser",
          status: "complete",
          summary: "Parsed the memo."
        }
      ]
    });

    expect(result.agents.map((agent) => agent.role).sort()).toEqual([...COUNCIL_AGENT_ROLES].sort());
  });

  it("blocks unsupported family jumps even when the model has a valid citation", () => {
    const memo = fixture("fixture-quantum-2026-0409");
    const local = analyzeMemo(memo);
    const result = merge(memo, {
      recommended: {
        eccn: "6A005 review",
        label: "Laser system candidate",
        confidence: 0.96,
        risk: "high",
        summary: "Treat RF control pulses as laser pulse evidence.",
        sourceChunkIds: ["chunk-6a005-laser"]
      }
    });

    expect(result.recommended.eccn).toBe(local.recommended.eccn);
    expect(result.recommended.label).toContain("electronics");
  });

  it("caps high confidence when a recommendation has no valid corpus support", () => {
    const memo = fixture("fixture-cryo-2026-0417");
    const result = merge(memo, {
      recommended: {
        eccn: "3A001.a.5",
        label: "Cryogenic equipment candidate",
        confidence: 4.5,
        risk: "low",
        summary: "The item appears controlled based on cryogenic performance.",
        sourceChunkIds: ["not-a-corpus-chunk"]
      }
    });

    expect(result.recommended.eccn).toBe("3A001.a.5");
    expect(result.recommended.confidence).toBeLessThanOrEqual(0.55);
  });

  it("preserves deterministic missing and conflict guardrails", () => {
    const memo = fixture("fixture-camera-2026-0412");
    const result = merge(memo, {
      findings: [
        {
          id: "ai-positive-camera-evidence",
          status: "strong",
          title: "Camera frame-rate evidence",
          claim: "Frame rate and resolution are stated.",
          rationale: "The memo supports Category 6 camera review.",
          sourceChunkIds: ["chunk-6a003-camera"],
          agent: "evidence-mapper",
          severity: "info"
        }
      ]
    });

    expect(result.findings.some((finding) =>
      finding.status === "missing" && finding.title.includes("Camera sensor parameters")
    )).toBe(true);
  });

  it("downgrades generic procedural blockers for low-risk EAR99 memos", () => {
    const memo = fixture("fixture-vac-2026-0401");
    const result = merge(memo, {
      findings: [
        {
          id: "generic-legal-review",
          status: "missing",
          title: "Generic legal review",
          claim: "Request a general legal approval before signoff.",
          rationale: "The memo would benefit from another procedural review.",
          sourceChunkIds: ["chunk-eccn-method"],
          agent: "risk-reviewer",
          severity: "escalate"
        }
      ]
    });

    expect(result.findings.find((finding) => finding.id === "generic-legal-review")?.status).toBe("weak");
    expect(result.findings.some((finding) => finding.status === "missing" || finding.status === "conflict")).toBe(false);
  });
});

function fixture(id: string) {
  const memo = reviewFixtures.find((candidate) => candidate.id === id);
  if (!memo) throw new Error(`Missing fixture ${id}`);
  return memo;
}

function merge(memo: MemoRecord, payload: AiCouncilPayload): ReviewResult {
  return mergeCouncilPayload(memo, analyzeMemo(memo), payload, {
    providerLabel: "Claude Haiku council via Bedrock",
    depth: "standard"
  });
}
