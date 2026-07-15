/**
 * Memo chat uses a Unicode code-point limit instead of JavaScript UTF-16
 * length, so astral characters such as emoji count once at every boundary.
 * The byte ceiling leaves room for 8,000 four-byte characters plus the small
 * JSON command envelope.
 */
export const MEMO_CHAT_CHARACTER_LIMIT = 8_000;
export const MEMO_CHAT_REQUEST_MAX_BYTES = 48 * 1024;
export const MEMO_CHAT_TEXT_MAX_BYTES = MEMO_CHAT_CHARACTER_LIMIT * 4;

export function unicodeCharacterLength(value: string) {
  return Array.from(value).length;
}

export function truncateUnicodeCharacters(value: string, maximum: number) {
  if (value.length <= maximum) return value;
  return Array.from(value).slice(0, maximum).join("");
}

export function normalizeMemoChatMessage(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  const length = unicodeCharacterLength(normalized);
  return length >= 1 && length <= MEMO_CHAT_CHARACTER_LIMIT ? normalized : undefined;
}
