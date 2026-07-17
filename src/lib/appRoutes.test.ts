import { describe, expect, it } from "vitest";
import { appRouteHash, parseAppHash } from "./appRoutes";

describe("appRoutes", () => {
  it("parses stable task-first routes", () => {
    expect(parseAppHash("#/home")).toEqual({ view: "home" });
    expect(parseAppHash("#/reviews/paste-20260622/analysis")).toEqual({
      view: "reviews",
      memoId: "paste-20260622",
      section: "analysis"
    });
    expect(parseAppHash("#/memo-builder/builder-123")).toEqual({
      view: "memo-builder",
      sessionId: "builder-123"
    });
  });

  it("falls back safely and serializes encoded IDs", () => {
    expect(parseAppHash("#/not-a-route")).toEqual({ view: "home" });
    expect(appRouteHash({ view: "reviews", memoId: "paste-a/b", section: "memo" }))
      .toBe("#/reviews/paste-a%2Fb/memo");
  });
});
