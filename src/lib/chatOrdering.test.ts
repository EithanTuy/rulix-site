import { describe, expect, it } from "vitest";
import type { MemoChatMessage } from "../types";
import { mergeChatPage } from "./chatOrdering";

describe("chat ordering", () => {
  it("renders tied timestamps by authoritative sequence instead of random IDs", () => {
    const at = "2026-07-14T12:00:00.000Z";
    const messages: MemoChatMessage[] = [
      { id: "00000000-random-assistant", memoId: "memo", role: "assistant", text: "answer", createdAt: at, sequence: 11 },
      { id: "ffffffff-random-user", memoId: "memo", role: "user", text: "question", createdAt: at, sequence: 10 }
    ];
    expect(mergeChatPage([], messages).map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("merges newest-first pages into chronological sequence without duplicates", () => {
    const at = "2026-07-14T12:00:00.000Z";
    const message = (sequence: number): MemoChatMessage => ({
      id: `random-${["z", "a", "q", "b"][sequence]}`,
      memoId: "memo",
      role: sequence % 2 ? "assistant" : "user",
      text: String(sequence),
      createdAt: at,
      sequence
    });
    const merged = mergeChatPage([message(3), message(2)], [message(2), message(1), message(0)]);
    expect(merged.map((entry) => entry.sequence)).toEqual([0, 1, 2, 3]);
  });
});
