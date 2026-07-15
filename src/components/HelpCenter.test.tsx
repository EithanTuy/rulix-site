// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HelpCenter } from "./HelpCenter";

describe("Rulix help center", () => {
  it("explains the exact officer approval workflow and closes with Escape", () => {
    const onClose = vi.fn();
    render(
      <HelpCenter
        open
        userRole="export-control-officer"
        onClose={onClose}
        onNewReview={vi.fn()}
        onMemoBuilder={vi.fn()}
      />
    );
    expect(screen.getByRole("dialog", { name: /from memo to defensible decision/i })).toBeTruthy();
    expect(screen.getByText(/you can approve the exact current content/i)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /close rulix guide/i }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("routes a reviewer to Memo Builder after closing the guide", () => {
    const onClose = vi.fn();
    const onMemoBuilder = vi.fn();
    render(
      <HelpCenter
        open
        userRole="reviewer"
        onClose={onClose}
        onNewReview={vi.fn()}
        onMemoBuilder={onMemoBuilder}
      />
    );
    expect(screen.getByText(/request officer approval for the exact current content/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /open memo builder/i }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onMemoBuilder).toHaveBeenCalledOnce();
  });

  it("restores the opener after parent rerenders while the guide is open", () => {
    const opener = document.createElement("button");
    opener.textContent = "Open guide";
    document.body.append(opener);
    opener.focus();
    const props = {
      open: true,
      userRole: "reviewer" as const,
      onClose: vi.fn(),
      onNewReview: vi.fn(),
      onMemoBuilder: vi.fn()
    };
    const view = render(<HelpCenter {...props} />);
    view.rerender(<HelpCenter {...props} onClose={vi.fn()} />);
    view.rerender(<HelpCenter {...props} open={false} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(opener);
    view.unmount();
    opener.remove();
  });
});
