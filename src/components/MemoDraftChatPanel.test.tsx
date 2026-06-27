import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
        qualityChecks: ["Includes executive summary", "Includes verification checklist"],
        missingFacts: ["Confirm wavelength tuning range"],
        sourceNotes: ["Drafted from supplied datasheet context"],
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

const clipboardWrite = vi.fn();
const anchorClick = vi.fn();
const originalCreateElement = document.createElement.bind(document);

beforeEach(() => {
  clipboardWrite.mockReset();
  anchorClick.mockReset();
  Object.assign(navigator, {
    clipboard: {
      writeText: clipboardWrite.mockResolvedValue(undefined)
    }
  });
  URL.createObjectURL = vi.fn(() => "blob:test-memo") as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
    const element = originalCreateElement(tagName);
    if (tagName.toLowerCase() === "a") {
      element.click = anchorClick;
    }
    return element;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function ControlledBuilder({
  onCreateMemo,
  onCreateAndAnalyze = vi.fn(),
  initialSessions = []
}: {
  onCreateMemo: (draft: MemoBuildDraft) => string | void;
  onCreateAndAnalyze?: (draft: MemoBuildDraft) => string | void;
  initialSessions?: MemoBuilderSession[];
}) {
  const [sessions, setSessions] = useState<MemoBuilderSession[]>(initialSessions);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(initialSessions[0]?.id);
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
          onCreateAndAnalyze={onCreateAndAnalyze}
        />
      )}
    </>
  );
}

describe("MemoDraftChatPanel", () => {
  it("persists chat state and writes a non-empty memo draft", async () => {
    const onCreateMemo = vi.fn((draft: MemoBuildDraft) => {
      expect(draft.memoText).toBeTruthy();
      return "review-1";
    });
    render(<ControlledBuilder onCreateMemo={onCreateMemo} />);

    fireEvent.change(screen.getByPlaceholderText("Attach a datasheet or describe the item to classify..."), {
      target: { value: "Draft from the TSL-580-C-E datasheet." }
    });
    fireEvent.click(screen.getByLabelText("Send"));

    await screen.findByText("Your memo draft is ready.");
    expect(screen.getByRole("article", { name: "Generated memo draft" })).toHaveTextContent("TSL-580-C-E tunable source");
    expect(screen.getByText("Saved chats")).toBeInTheDocument();
    expect(screen.getByText("Draft ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add to reviews/i })).toBeInTheDocument();

    fireEvent.click(screen.getByText("Toggle builder"));
    fireEvent.click(screen.getByText("Toggle builder"));
    expect(screen.getByText("Draft from the TSL-580-C-E datasheet.")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Generated memo draft" })).toHaveTextContent("TSL-580-C-E tunable source");

    fireEvent.click(screen.getByRole("button", { name: /add to reviews/i }));
    await waitFor(() => expect(onCreateMemo).toHaveBeenCalledTimes(1));
    const createdDraft = onCreateMemo.mock.calls[0]?.[0];
    expect(createdDraft?.memoText).toContain("TSL-580-C-E tunable source");
  });

  it("copies and downloads the full generated markdown", async () => {
    const onCreateMemo = vi.fn();
    render(<ControlledBuilder onCreateMemo={onCreateMemo} />);

    fireEvent.click(screen.getByRole("button", { name: /create sample memo/i }));
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(expect.stringContaining("ECCN Self-Classification Draft Memo")));
    expect(screen.getByText("Memo copied.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /download \.md/i }));
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Markdown downloaded.")).toBeInTheDocument();
  });

  it("sends a draft into create-and-analyze without treating analysis as default", async () => {
    const onCreateMemo = vi.fn();
    const onCreateAndAnalyze = vi.fn((draft: MemoBuildDraft) => {
      expect(draft.memoText).toBeTruthy();
      return "review-2";
    });
    render(<ControlledBuilder onCreateMemo={onCreateMemo} onCreateAndAnalyze={onCreateAndAnalyze} />);

    fireEvent.click(screen.getByRole("button", { name: /create sample memo/i }));
    fireEvent.click(screen.getByRole("button", { name: /add & analyze/i }));

    expect(onCreateMemo).not.toHaveBeenCalled();
    expect(onCreateAndAnalyze).toHaveBeenCalledTimes(1);
    const analyzedDraft = onCreateAndAnalyze.mock.calls[0]?.[0];
    expect(analyzedDraft?.source).toBe("sample");
  });

  it("loads review context into the quick-start prompt", () => {
    const session: MemoBuilderSession = {
      id: "builder-review-context",
      title: "Improve Laser Memo",
      messages: [],
      updatedAt: "2026-06-27T12:00:00.000Z",
      starterPrompt: "Improve this memo using finding context.",
      contextMemoId: "memo-1"
    };
    render(<ControlledBuilder onCreateMemo={vi.fn()} initialSessions={[session]} />);

    expect(screen.getByText("Review context is loaded. Use it to draft an improved memo or ask Sonnet for a focused rewrite.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^use context$/i }));
    expect(screen.getByPlaceholderText("Attach a datasheet or describe the item to classify...")).toHaveValue("Improve this memo using finding context.");
  });
});
