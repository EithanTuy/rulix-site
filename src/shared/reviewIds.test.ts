import { describe, expect, it } from "vitest";
import { isReviewId, reviewIdPrefix } from "./reviewIds";

describe("review IDs", () => {
  it.each([
    ["review-17ef6aad-0b75-4278-bcad-4ea7ac6c9e27", "review-"],
    ["paste-1782080000000", "paste-"],
    ["upload-1782080000000", "upload-"],
    ["ai-draft-1782080000000", "ai-draft-"]
  ])("accepts the durable current and migrated ID %s", (id, prefix) => {
    expect(isReviewId(id)).toBe(true);
    expect(reviewIdPrefix(id)).toBe(prefix);
  });

  it.each([
    "review-",
    "memo-legacy",
    "review-with spaces",
    "../review-unsafe",
    `review-${"x".repeat(122)}`,
    ""
  ])("rejects the invalid ID %s", (id) => {
    expect(isReviewId(id)).toBe(false);
  });
});
