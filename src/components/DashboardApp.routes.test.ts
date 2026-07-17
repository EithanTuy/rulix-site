import { describe, expect, it } from "vitest";
import { parseDashboardHash } from "./DashboardApp";

describe("dashboard workspace routes", () => {
  it("parses stable Operations routes", () => {
    expect(parseDashboardHash("#operations/overview")).toEqual({ workspace: "operations", tab: "overview" });
    expect(parseDashboardHash("#operations/invitations")).toEqual({ workspace: "operations", tab: "invites" });
    expect(parseDashboardHash("#operations/settings")).toEqual({ workspace: "operations", tab: "settings" });
  });

  it("parses stable Growth routes and the renamed lead review path", () => {
    expect(parseDashboardHash("#growth/overview")).toEqual({ workspace: "growth", tab: "growth-overview" });
    expect(parseDashboardHash("#growth/lead-review")).toEqual({ workspace: "growth", tab: "lead-review" });
    expect(parseDashboardHash("#growth/jobs?status=running")).toEqual({ workspace: "growth", tab: "jobs" });
  });

  it("falls back inside the requested workspace", () => {
    expect(parseDashboardHash("#growth/not-a-view")).toEqual({ workspace: "growth", tab: "growth-overview" });
    expect(parseDashboardHash("")).toEqual({ workspace: "operations", tab: "overview" });
  });
});
