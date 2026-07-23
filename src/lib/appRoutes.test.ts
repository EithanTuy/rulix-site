import { describe, expect, it } from "vitest";
import { appRouteHash, normalizeAppHash, parseAppHash } from "./appRoutes";

describe("appRoutes", () => {
  it("uses Work as the canonical signed-in entry", () => {
    expect(parseAppHash("#/work")).toEqual({ view: "work" });
    expect(parseAppHash("#/home")).toEqual({ view: "work" });
    expect(parseAppHash("#/reviews")).toEqual({ view: "work" });
    expect(parseAppHash("")).toEqual({ view: "work" });
  });

  it("maps every legacy review section to a stage and optional drawer", () => {
    expect(parseAppHash("#/reviews/paste-20260622/memo")).toEqual({
      view: "work", memoId: "paste-20260622", stage: "prepare"
    });
    expect(parseAppHash("#/reviews/upload-20260622/overview")).toEqual({
      view: "work", memoId: "upload-20260622", stage: "review"
    });
    expect(parseAppHash("#/reviews/ai-draft-20260622/analysis")).toEqual({
      view: "work", memoId: "ai-draft-20260622", stage: "review"
    });
    expect(parseAppHash("#/reviews/paste-1/conversation")).toEqual({
      view: "work", memoId: "paste-1", stage: "review", panel: "chat"
    });
    expect(parseAppHash("#/reviews/paste-1/activity")).toEqual({
      view: "work", memoId: "paste-1", stage: "review", panel: "activity"
    });
  });

  it("parses and serializes canonical stages, panels, and encoded IDs", () => {
    expect(parseAppHash("#/reviews/paste-a%2Fb/decide?panel=activity")).toEqual({
      view: "work", memoId: "paste-a/b", stage: "decide", panel: "activity"
    });
    expect(appRouteHash({ view: "work", memoId: "paste-a/b", stage: "prepare" }))
      .toBe("#/reviews/paste-a%2Fb/prepare");
    expect(appRouteHash({ view: "work", memoId: "review-1", stage: "review", panel: "comments" }))
      .toBe("#/reviews/review-1/review?panel=comments");
  });

  it("normalizes saved legacy routes without a data migration", () => {
    expect(normalizeAppHash("#/home")).toBe("#/work");
    expect(normalizeAppHash("#/reviews/paste-1/analysis")).toBe("#/reviews/paste-1/review");
    expect(normalizeAppHash("#/reviews/paste-1/conversation")).toBe("#/reviews/paste-1/review?panel=chat");
    expect(normalizeAppHash("#/not-a-route")).toBe("#/work");
  });

  it("keeps Memo Builder sessions stable", () => {
    expect(parseAppHash("#/memo-builder/builder-123")).toEqual({
      view: "memo-builder",
      sessionId: "builder-123"
    });
  });
});
