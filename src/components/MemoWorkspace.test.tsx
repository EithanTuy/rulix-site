import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { AnalysisPanel } from "./AnalysisPanel";
import { MemoWorkspace } from "./MemoWorkspace";
import { ReviewList } from "./ReviewList";
import type { MemoRecord, ReviewResult } from "../types";

const baseMemo: MemoRecord = {
  id: "memo-1",
  title: "Laser Memo",
  itemFamily: "Laser source",
  owner: "Reviewer",
  updatedAt: "2026-06-26",
  documentCode: "LAS-1",
  status: "ready",
  attachments: [],
  dataClass: "proprietary",
  sourcePath: "self-classification",
  memoText: "The laser has pulse energy of 10 mJ. The memo omits end-use restrictions."
};

const secondMemo: MemoRecord = {
  ...baseMemo,
  id: "memo-2",
  title: "Cryostat Memo",
  documentCode: "CRYO-1",
  memoText: "The cryostat reaches 1.2 K for fundamental research."
};

const findingStart = baseMemo.memoText.indexOf("pulse energy");
const reviewResult: ReviewResult = {
  memoId: baseMemo.id,
  generatedAt: "2026-06-26T12:00:00.000Z",
  corpusId: "official-corpus-2026-06-seed",
  modelPolicy: "test",
  provider: {
    source: "local-rules",
    label: "Deterministic",
    model: "rules",
    live: false,
    message: "Rules result",
    checkedAt: "2026-06-26T12:00:00.000Z"
  },
  jurisdiction: {
    outcome: "ear-likely",
    summary: "EAR path likely",
    rationale: "No ITAR markers in the fixture.",
    sourceChunkIds: ["chunk-ear-subject"]
  },
  recommended: {
    eccn: "6A005",
    label: "Laser source",
    confidence: 0.72,
    risk: "medium",
    summary: "Laser characteristics need review.",
    sourceChunkIds: ["chunk-ear-subject"]
  },
  alternatives: [],
  findings: [
    {
      id: "finding-1",
      status: "weak",
      title: "Pulse energy needs support",
      claim: "pulse energy of 10 mJ",
      rationale: "The memo states pulse energy but lacks a supporting source.",
      excerpt: "pulse energy of 10 mJ",
      start: findingStart,
      end: findingStart + "pulse energy".length,
      sourceChunkIds: ["chunk-ear-subject"],
      agent: "evidence-mapper",
      severity: "review"
    }
  ],
  infoRequests: ["Provide source support for pulse energy."],
  agents: []
};

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("MemoWorkspace", () => {
  it("edits, compares, and saves draft text with a shared diff preview", () => {
    const onMemoTextChange = vi.fn();
    const onDirtyChange = vi.fn();
    render(
      <MemoWorkspace
        memo={baseMemo}
        result={reviewResult}
        analysisLocked={false}
        onMemoTextChange={onMemoTextChange}
        onArchiveMemo={vi.fn()}
        onCreatePublicDraft={vi.fn()}
        onDirtyChange={onDirtyChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByLabelText("Memo text editor"), {
      target: { value: `${baseMemo.memoText}\nAdded license rationale.` }
    });

    expect(screen.getByText("Unsaved edits")).toBeInTheDocument();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: /compare/i }));

    expect(screen.getByLabelText("Draft memo changes")).toHaveTextContent("Added license rationale.");

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(onMemoTextChange).toHaveBeenCalledWith(baseMemo.id, `${baseMemo.memoText}\nAdded license rationale.`);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("discards local draft text without saving it", () => {
    const onMemoTextChange = vi.fn();
    render(
      <MemoWorkspace
        memo={baseMemo}
        analysisLocked={false}
        onMemoTextChange={onMemoTextChange}
        onArchiveMemo={vi.fn()}
        onCreatePublicDraft={vi.fn()}
        onDirtyChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByLabelText("Memo text editor"), {
      target: { value: "Changed locally" }
    });
    fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));

    expect(screen.getByLabelText("Memo text editor")).toHaveValue(baseMemo.memoText);
    expect(onMemoTextChange).not.toHaveBeenCalled();
  });

  it("shows selected saved evidence next to the editor and respects analysis lock", () => {
    const { rerender } = render(
      <MemoWorkspace
        memo={baseMemo}
        result={reviewResult}
        selectedFindingId="finding-1"
        analysisLocked={false}
        onMemoTextChange={vi.fn()}
        onArchiveMemo={vi.fn()}
        onCreatePublicDraft={vi.fn()}
        onDirtyChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /edit/i }));

    expect(screen.getByText("Saved evidence")).toBeInTheDocument();
    expect(screen.getByText("The memo states pulse energy but lacks a supporting source.")).toBeInTheDocument();

    rerender(
      <MemoWorkspace
        memo={baseMemo}
        result={reviewResult}
        selectedFindingId="finding-1"
        analysisLocked
        onMemoTextChange={vi.fn()}
        onArchiveMemo={vi.fn()}
        onCreatePublicDraft={vi.fn()}
        onDirtyChange={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /edit/i })).toBeDisabled();
  });
});

describe("document editing dirty guard", () => {
  it("blocks memo switching and analysis while draft edits are unsaved", () => {
    const runAnalysis = vi.fn();
    render(<DocumentGuardHarness onRunAnalysis={runAnalysis} />);

    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    fireEvent.change(screen.getByLabelText("Memo text editor"), {
      target: { value: `${baseMemo.memoText}\nUnsaved note.` }
    });
    fireEvent.click(screen.getByRole("button", { name: /cryostat memo/i }));

    expect(screen.getByTestId("guard-notice")).toHaveTextContent("Save or discard memo edits before switching memos.");
    expect(screen.getByRole("heading", { name: "Laser Memo" })).toBeInTheDocument();

    expect(screen.getByRole("button", { name: /run ai analysis/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    fireEvent.click(screen.getByRole("button", { name: /cryostat memo/i }));

    expect(screen.getByRole("heading", { name: "Cryostat Memo" })).toBeInTheDocument();
    expect(runAnalysis).not.toHaveBeenCalled();
  });
});

function DocumentGuardHarness({ onRunAnalysis }: { onRunAnalysis: () => void }) {
  const [selectedMemoId, setSelectedMemoId] = useState(baseMemo.id);
  const [memoDraftDirty, setMemoDraftDirty] = useState(false);
  const [notice, setNotice] = useState("Saved to account");
  const memos = [baseMemo, secondMemo];
  const selectedMemo = memos.find((memo) => memo.id === selectedMemoId)!;

  const selectMemo = (memoId: string) => {
    if (memoDraftDirty) {
      setNotice("Save or discard memo edits before switching memos.");
      return;
    }
    setSelectedMemoId(memoId);
  };

  return (
    <div>
      <div data-testid="guard-notice">{notice}</div>
      <ReviewList
        memos={memos}
        selectedMemoId={selectedMemoId}
        search=""
        corpusLabel="Fixture corpus"
        onSearch={vi.fn()}
        onSelect={selectMemo}
        onFile={async () => undefined}
        onPasteMemo={vi.fn()}
      />
      <MemoWorkspace
        memo={selectedMemo}
        result={selectedMemo.id === baseMemo.id ? reviewResult : undefined}
        analysisLocked={false}
        onMemoTextChange={vi.fn()}
        onArchiveMemo={vi.fn()}
        onCreatePublicDraft={vi.fn()}
        onDirtyChange={setMemoDraftDirty}
      />
      <AnalysisPanel
        memo={selectedMemo}
        analysisState={{
          status: "unanalyzed",
          message: "Waiting for analysis."
        }}
        analysisMode="standard"
        onAnalysisModeChange={vi.fn()}
        backendNotice="Backend ready"
        liveAnalysisAvailable={true}
        onRunAnalysis={onRunAnalysis}
        auditEvents={[]}
        chatMessages={[]}
        analysisLocked={false}
        memoDraftDirty={memoDraftDirty}
        onDecision={vi.fn()}
        onSendChat={async () => undefined}
        onApplyChatSuggestion={vi.fn()}
        onFindingSelect={vi.fn()}
      />
    </div>
  );
}
