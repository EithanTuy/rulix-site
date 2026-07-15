import { describe, expect, it, vi } from "vitest";
import { collectOutreachPages } from "./outreachPagination";

describe("bounded outreach enumeration", () => {
  it("crosses every page without truncating a collection larger than 1,000 records", async () => {
    const values = Array.from({ length: 1_025 }, (_, index) => `lead-${index}`);
    const readPage = vi.fn(async ({ limit, cursor }: { limit: number; cursor?: string }) => {
      const offset = cursor ? Number(cursor) : 0;
      const items = values.slice(offset, offset + limit);
      const next = offset + items.length;
      return { items, ...(next < values.length ? { nextCursor: String(next) } : {}) };
    });
    await expect(collectOutreachPages({ readPage, maximum: 1_100, collection: "leads" }))
      .resolves.toEqual(values);
    expect(readPage).toHaveBeenCalledTimes(21);
    expect(readPage.mock.calls.every(([query]) => query.limit === 50)).toBe(true);
  });

  it("fails explicitly instead of silently truncating at the bulk cap", async () => {
    const readPage = async ({ cursor }: { limit: number; cursor?: string }) => {
      const offset = cursor ? Number(cursor) : 0;
      return {
        items: Array.from({ length: 50 }, (_, index) => offset + index),
        nextCursor: String(offset + 50)
      };
    };
    await expect(collectOutreachPages({ readPage, maximum: 1_000, collection: "leads" }))
      .rejects.toMatchObject({ status: 422, code: "outreach_bulk_limit_exceeded" });
  });

  it("rejects a stalled continuation cursor", async () => {
    const readPage = vi.fn(async ({ cursor }: { limit: number; cursor?: string }) => ({
      items: [cursor ?? "first"],
      nextCursor: "same"
    }));
    await expect(collectOutreachPages({ readPage, maximum: 10, collection: "jobs" }))
      .rejects.toMatchObject({ status: 500, code: "outreach_cursor_stalled" });
  });
});
