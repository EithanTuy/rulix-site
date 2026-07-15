import { StoreError, type CursorPage } from "./store";

export const OUTREACH_PAGE_SIZE = 50;
export const OUTREACH_BULK_SCAN_CAP = 5_000;
export const OUTREACH_BULK_ITEM_CAP = 1_000;
export const OUTREACH_LEAD_SEARCH_INPUT_CAP = 1_000;

/**
 * Enumerates a cursor collection for a deliberate server-side bulk action.
 * Browser reads stay page-at-a-time; bulk work may cross pages only under an
 * explicit cap so growth can never become a silent truncation or unbounded
 * account-table read.
 */
export async function collectOutreachPages<T>(input: {
  readPage: (query: { limit: number; cursor?: string }) => Promise<CursorPage<T>>;
  maximum: number;
  collection: string;
}) {
  const items: T[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await input.readPage({
      limit: OUTREACH_PAGE_SIZE,
      ...(cursor ? { cursor } : {})
    });
    if (!Array.isArray(page.items) || page.items.length > OUTREACH_PAGE_SIZE) {
      throw new StoreError(500, `The ${input.collection} page violated its storage bound.`, "outreach_page_invalid");
    }
    if (items.length + page.items.length > input.maximum) {
      throw new StoreError(
        422,
        `The ${input.collection} operation exceeds the explicit ${input.maximum}-item safety cap. Narrow the operation or archive old records first.`,
        "outreach_bulk_limit_exceeded"
      );
    }
    items.push(...page.items);
    const next = page.nextCursor;
    if (next) {
      if (next === cursor || seen.has(next)) {
        throw new StoreError(500, `The ${input.collection} cursor did not advance.`, "outreach_cursor_stalled");
      }
      seen.add(next);
    }
    cursor = next;
  } while (cursor);
  return items;
}
