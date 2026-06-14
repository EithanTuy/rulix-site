import { describe, expect, it } from "vitest";
import { sampleMemos } from "../data/sampleMemos";
import { analyzeMemo } from "./eccnReview";
import { deriveReviewStatus, summarizeReadiness } from "./reviewLifecycle";

describe("review lifecycle", () => {
  it("blocks memo signoff when missing or conflicting evidence exists", () => {
    const result = analyzeMemo(sampleMemos[0]);

    expect(deriveReviewStatus(result)).toBe("conflict");
    expect(summarizeReadiness(result).blockers).toBeGreaterThan(0);
  });

  it("lets a human decision control the stored review status", () => {
    const result = analyzeMemo(sampleMemos[0]);

    expect(
      deriveReviewStatus(result, {
        action: "accept",
        notes: "Human reviewer accepts with documented basis."
      })
    ).toBe("signed-off");
    expect(
      deriveReviewStatus(result, {
        action: "request-info",
        notes: "Need vendor values."
      })
    ).toBe("needs-info");
  });
});
