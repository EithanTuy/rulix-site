import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { MemoDraftChatPanel } from "./MemoDraftChatPanel";
import type { MemoBuildDraft } from "../lib/apiClient";
import type { MemoBuilderSession } from "../types";

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient");
  return {
    ...actual,
    sendMemoBuildChat: vi.fn(async () => ({
      reply: "Your memo draft is ready.",
      draft: {
        title: "TSL-580-C-E ECCN memo",
        itemFamily: "Laser source",
        manufacturer: "Test Manufacturer",
        intendedUse: "Research evaluation",
        dataClass: "proprietary",
        memoText: [
          "## Executive summary",
          "This draft covers the TSL-580-C-E tunable source for reviewer screening before any final classification decision.",
          "## Item and source documents reviewed",
          "The record identifies a TSL-580-C-E tunable source and uses the supplied datasheet context as the working source.",
          "## Item description",
          "TSL-580-C-E tunable source. The item should be reviewed as optical or photonics equipment until the reviewer confirms final operating parameters.",
          "## Technical specifications relevant to ECCN screening",
          "- Confirm wavelength tuning range, optical output power, pulse characteristics, linewidth, and any modulation capability.",
          "- Confirm whether software, firmware, or technical data is included.",
          "## Proposed classification/review path",
          "Begin with Category 6 optical equipment review and document whether any CCL entry applies before considering EAR99.",
          "## Verification checklist",
          "- Confirm manufacturer classification if available.",
          "- Confirm all performance parameters from the final datasheet.",
          "- Confirm intended end use and end user."
        ].join("\n\n")
      }
    }))
  };
});

function ControlledBuilder({ onCreateMemo }: { onCreateMemo: (draft: MemoBuildDraft) => void }) {
  const [sessions, setSessions] = useState<MemoBuilderSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  const [visible, setVisible] = useState(true);

  return (
    <>
      <button type="button" onClick={() => setVisible((value) => !value)}>
        Toggle builder
      </button>
      {visible && (
        <MemoDraftChatPanel
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSessionsChange={setSessions}
          onActiveSessionChange={setActiveSessionId}
          onCreateMemo={onCreateMemo}
          onCreateAndAnalyze={() => undefined}
        />
      )}
    </>
  );
}

describe("MemoDraftChatPanel", () => {
  it("persists chat state and writes a non-empty memo draft", async () => {
    const onCreateMemo = vi.fn();
    render(<ControlledBuilder onCreateMemo={onCreateMemo} />);

    fireEvent.change(screen.getByPlaceholderText("Attach a datasheet or describe the item to classify..."), {
      target: { value: "Draft from the TSL-580-C-E datasheet." }
    });
    fireEvent.click(screen.getByLabelText("Send"));

    await screen.findByText("Your memo draft is ready.");
    expect(screen.getByText(/TSL-580-C-E tunable source/)).toBeInTheDocument();
    expect(screen.getByText("Saved chats")).toBeInTheDocument();
    expect(screen.getByText("Draft ready")).toBeInTheDocument();
    expect(screen.getByText("ECCN draft ready. Add it to the review queue to review, edit, and run council analysis.")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Toggle builder"));
    fireEvent.click(screen.getByText("Toggle builder"));
    expect(screen.getByText("Draft from the TSL-580-C-E datasheet.")).toBeInTheDocument();
    expect(screen.getByText(/TSL-580-C-E tunable source/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Add ECCN draft to review queue"));
    await waitFor(() => expect(onCreateMemo).toHaveBeenCalledTimes(1));
    expect(onCreateMemo.mock.calls[0][0].memoText).toContain("TSL-580-C-E tunable source");
  });
});
