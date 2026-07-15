import { describe, expect, it } from "vitest";
import { reviewFixtures } from "../test/reviewFixtures";
import { analyzeMemo } from "./eccnReview";
import { createAuditEvent, deriveReviewStatus, summarizeReadiness } from "./reviewLifecycle";

describe("review lifecycle", () => {
  it("blocks memo signoff when missing or conflicting evidence exists", () => {
    const result = analyzeMemo(reviewFixtures[0]);

    expect(deriveReviewStatus(result)).toBe("conflict");
    expect(summarizeReadiness(result).blockers).toBeGreaterThan(0);
  });

  it("lets a human decision control the stored review status", () => {
    const result = analyzeMemo(reviewFixtures[0]);

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

  it("uses collision-resistant server-safe UUIDs for audit idempotency keys", () => {
    const ids = Array.from({ length: 256 }, () =>
      createAuditEvent("memo-1", "Memo edited", "A reviewable field changed.").id
    );

    expect(new Set(ids)).toHaveLength(ids.length);
    expect(ids.every((id) =>
      /^audit-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    )).toBe(true);
  });
});
