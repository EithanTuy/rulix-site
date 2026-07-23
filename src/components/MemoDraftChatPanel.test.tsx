import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { MemoDraftChatPanel } from "./MemoDraftChatPanel";
import { sendMemoBuildChat, type MemoBuildDraft } from "../lib/apiClient";
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
  vi.mocked(sendMemoBuildChat).mockClear();
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
  onCreateAndAnalyze = vi.fn(async () => undefined),
  initialSessions = []
}: {
  onCreateMemo: (draft: MemoBuildDraft) => Promise<string | void>;
  onCreateAndAnalyze?: (draft: MemoBuildDraft) => Promise<string | void>;
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
          onPrepareSessionForAi={async (session) => session}
          userRole="export-control-officer"
        />
      )}
    </>
  );
}

describe("MemoDraftChatPanel", () => {
  it("persists chat state and writes a non-empty memo draft", async () => {
    const onCreateMemo = vi.fn(async (draft: MemoBuildDraft) => {
      expect(draft.memoText).toBeTruthy();
      return "review-1";
    });
    render(<ControlledBuilder onCreateMemo={onCreateMemo} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message Rulix AI" }), {
      target: { value: "Draft from the TSL-580-C-E datasheet." }
    });
    fireEvent.click(screen.getByLabelText("Approve and send"));

    await screen.findByText("Your memo draft is ready.");
    expect(screen.getByRole("article", { name: "Generated memo draft" })).toHaveTextContent("TSL-580-C-E tunable source");
    expect(screen.getByText("Recent")).toBeInTheDocument();
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
    const onCreateMemo = vi.fn(async () => undefined);
    render(<ControlledBuilder onCreateMemo={onCreateMemo} />);

    fireEvent.click(screen.getByRole("button", { name: /open an example/i }));
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(expect.stringContaining("ECCN Self-Classification Draft Memo")));
    expect(screen.getByText("Memo copied.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /download \.md/i }));
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Markdown downloaded.")).toBeInTheDocument();
  });

  it("sends a draft into create-and-analyze without treating analysis as default", async () => {
    const onCreateMemo = vi.fn(async () => undefined);
    const onCreateAndAnalyze = vi.fn(async (draft: MemoBuildDraft) => {
      expect(draft.memoText).toBeTruthy();
      return "review-2";
    });
    render(<ControlledBuilder onCreateMemo={onCreateMemo} onCreateAndAnalyze={onCreateAndAnalyze} />);

    fireEvent.click(screen.getByRole("button", { name: /open an example/i }));
    fireEvent.click(screen.getByRole("button", { name: /add & analyze/i }));

    expect(onCreateMemo).not.toHaveBeenCalled();
    await waitFor(() => expect(onCreateAndAnalyze).toHaveBeenCalledTimes(1));
    const analyzedDraft = onCreateAndAnalyze.mock.calls[0]?.[0];
    expect(analyzedDraft?.source).toBe("sample");
  });

  it("loads review context into the quick-start prompt", () => {
    const session: MemoBuilderSession = {
      id: "builder-review-context",
      title: "Improve Laser Memo",
      dataClass: "proprietary",
      messages: [],
      updatedAt: "2026-06-27T12:00:00.000Z",
      starterPrompt: "Improve this memo using finding context.",
      contextMemoId: "memo-1"
    };
    render(<ControlledBuilder onCreateMemo={vi.fn(async () => undefined)} initialSessions={[session]} />);

    expect(screen.getByText("Review context is ready. Use it to improve the current memo without losing its source trail.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^use context$/i }));
    expect(screen.getByRole("textbox", { name: "Message Rulix AI" })).toHaveValue("Improve this memo using finding context.");
  });

  it("keeps the generated draft when review creation fails", async () => {
    const onCreateMemo = vi.fn(async () => {
      throw new Error("Review creation failed safely.");
    });
    render(<ControlledBuilder onCreateMemo={onCreateMemo} />);

    fireEvent.click(screen.getByRole("button", { name: /open an example/i }));
    const draft = screen.getByRole("article", { name: "Generated memo draft" });
    fireEvent.click(screen.getByRole("button", { name: /add to reviews/i }));

    expect(await screen.findByText("Review creation failed safely.")).toBeInTheDocument();
    expect(draft).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add to reviews/i })).toBeEnabled();
  });

  it("keeps the explicit Ctrl+Enter approval gesture", async () => {
    render(<ControlledBuilder onCreateMemo={vi.fn(async () => undefined)} />);
    const composer = screen.getByRole("textbox", { name: "Message Rulix AI" });

    fireEvent.change(composer, { target: { value: "Draft a memo for this RF amplifier." } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(sendMemoBuildChat).not.toHaveBeenCalled();

    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(sendMemoBuildChat).toHaveBeenCalledTimes(1));
  });
});
