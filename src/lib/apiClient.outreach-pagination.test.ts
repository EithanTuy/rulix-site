import { afterEach, describe, expect, it, vi } from "vitest";
import { getOutreachPage, getOutreachWorkspace } from "./apiClient";

afterEach(() => vi.unstubAllGlobals());

describe("outreach pagination client", () => {
  it("requests a bounded initial workspace", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ leads: [] }));
    vi.stubGlobal("fetch", fetch);
    await getOutreachWorkspace(undefined, 500);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("/api/admin/outreach?limit=50");
  });

  it("preserves an opaque signed cursor only in the collection continuation URL", async () => {
    const cursor = "active.opaque_payload.signature";
    const fetch = vi.fn().mockResolvedValue(json({ items: [] }));
    vi.stubGlobal("fetch", fetch);
    await getOutreachPage("lead-rows", { limit: 25, cursor });
    const url = String(fetch.mock.calls[0]?.[0]);
    expect(url).toBe(`/api/admin/outreach/pages/lead-rows?limit=25&cursor=${cursor}`);
  });
});

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
