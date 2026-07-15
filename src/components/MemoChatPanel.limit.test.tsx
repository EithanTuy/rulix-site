// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { reviewFixtures } from "../test/reviewFixtures";
import { MemoChatPanel } from "./MemoChatPanel";

describe("MemoChatPanel message boundary", () => {
  it("retains exactly 8,000 Unicode characters and never splits the final emoji", async () => {
    const onSendChat = vi.fn(async (_memoId: string, _message: string) => "queued" as const);
    render(
      <MemoChatPanel
        memo={reviewFixtures[0]}
        chatMessages={[]}
        analysisLocked={false}
        memoDraftDirty={false}
        onSendChat={onSendChat}
        onApplyChatSuggestion={async () => undefined}
        hasMore={false}
        onLoadMore={async () => undefined}
        userRole="reviewer"
      />
    );

    const input = screen.getByPlaceholderText("Ask about or revise this memo...") as HTMLTextAreaElement;
    const overflow = "😀".repeat(8_001);
    fireEvent.change(input, { target: { value: overflow } });
    expect(Array.from(input.value)).toHaveLength(8_000);
    expect(input.value.endsWith("😀")).toBe(true);
    expect(screen.getByText("8,000 / 8,000 characters")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Request Approval" }));
    await waitFor(() => expect(onSendChat).toHaveBeenCalledTimes(1));
    expect(Array.from(onSendChat.mock.calls[0][1])).toHaveLength(8_000);
  });
});
