import { fireEvent, render, screen } from "@testing-library/react";
import { FolderOpen } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";

function renderMenu(onClose = vi.fn()) {
  render(
    <ContextMenu
      open
      x={120}
      y={120}
      label="Review actions"
      onClose={onClose}
      actions={[{
        id: "open",
        label: "Open review",
        icon: FolderOpen,
        shortcut: "⌘ L",
        onSelect: vi.fn()
      }]}
    />
  );
  return onClose;
}

describe("ContextMenu", () => {
  it("renders platform-aware shortcuts", () => {
    renderMenu();
    expect(screen.getByText("Ctrl K")).toBeInTheDocument();
    expect(screen.getByText("Ctrl L")).toBeInTheDocument();
  });

  it.each(["resize", "wheel", "touchmove", "hashchange"])("closes on %s", (eventName) => {
    const onClose = renderMenu();
    fireEvent(window, new Event(eventName));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
