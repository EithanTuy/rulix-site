import { describe, expect, it } from "vitest";
import {
  MEMO_CHAT_CHARACTER_LIMIT,
  normalizeMemoChatMessage,
  truncateUnicodeCharacters,
  unicodeCharacterLength
} from "./aiLimits";

describe("memo-chat Unicode boundary", () => {
  it("counts astral characters once and accepts exactly 8,000", () => {
    const exact = "😀".repeat(MEMO_CHAT_CHARACTER_LIMIT);
    expect(exact.length).toBe(MEMO_CHAT_CHARACTER_LIMIT * 2);
    expect(unicodeCharacterLength(exact)).toBe(MEMO_CHAT_CHARACTER_LIMIT);
    expect(normalizeMemoChatMessage(exact)).toBe(exact);
  });

  it("rejects or truncates the 8,001st Unicode character without splitting it", () => {
    const overflow = "😀".repeat(MEMO_CHAT_CHARACTER_LIMIT + 1);
    expect(normalizeMemoChatMessage(overflow)).toBeUndefined();
    const truncated = truncateUnicodeCharacters(overflow, MEMO_CHAT_CHARACTER_LIMIT);
    expect(unicodeCharacterLength(truncated)).toBe(MEMO_CHAT_CHARACTER_LIMIT);
    expect(truncated.endsWith("😀")).toBe(true);
  });
});
