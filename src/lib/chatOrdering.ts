import type { MemoChatMessage } from "../types";

export function mergeChatPage(current: MemoChatMessage[], incoming: MemoChatMessage[]) {
  const seen = new Set<string>();
  return [...current, ...incoming].filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  }).sort(compareChatMessages);
}

export function compareChatMessages(left: MemoChatMessage, right: MemoChatMessage) {
  const byTime = left.createdAt.localeCompare(right.createdAt);
  if (byTime !== 0) return byTime;
  if (left.sequence !== undefined && right.sequence !== undefined && left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  return left.id.localeCompare(right.id);
}
