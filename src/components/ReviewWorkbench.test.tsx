import { render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoRecord, ReviewResult, UserProfile } from "../types";
import { ReviewWorkbench } from "./ReviewWorkbench";

vi.mock("../lib/apiClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/apiClient")>();
  return {
    ...actual,
    listReviewComments: vi.fn(() => new Promise(() => undefined)),
    createReviewComment: vi.fn(),
    resolveReviewComment: vi.fn()
  };
});

const user: UserProfile = {
  id: "officer-1",
  email: "officer@example.com",
  name: "Aisha Patel",
  role: "export-control-officer",
  createdAt: "2026-01-01T00:00:00.000Z"
};

const memo: MemoRecord = {
  id: "review-1",
  title: "Industrial servo controller",
  itemFamily: "Industrial controls",
  owner: user.name,
  ownerId: user.id,
  updatedAt: "2026-07-22T12:00:00.000Z",
  createdAt: "2026-07-20T12:00:00.000Z",
  documentCode: "REV-2026-0158",
  status: "conflict",
  lifecycleStage: "in-review",
  priority: "high",
  memoText: "Servo controller memo content.",
  attachments: ["servo-datasheet.pdf"],
  dataClass: "proprietary",
  sourcePath: "self-classification",
  revision: 2,
  contentHash: "current-content-hash"
};

const result: ReviewResult = {
  memoId: memo.id,
  id: "analysis-1",
  generatedAt: "2026-07-22T11:00:00.000Z",
  corpusId: "corpus-1",
  modelPolicy: "human-review-required",
  provider: {
    source: "bedrock",
    label: "Claude via Bedrock",
    model: "claude-sonnet",
    live: true,
    message: "Live",
    checkedAt: "2026-07-22T11:00:00.000Z"
  },
  jurisdiction: {
    outcome: "ear-likely",
    summary: "EAR jurisdiction likely.",
    rationale: "Commercial industrial controller.",
    sourceChunkIds: []
  },
  recommended: {
    eccn: "3A999",
    label: "Specific processing equipment",
    confidence: 0.72,
    risk: "medium",
    summary: "The current evidence supports 3A999, subject to the missing encryption detail.",
    sourceChunkIds: []
  },
  alternatives: [],
  findings: [{
    id: "finding-blocker",
    status: "missing",
    title: "Encryption functionality not documented",
    claim: "Encryption capability is unknown.",
    rationale: "The current memo omits the network security implementation.",
    sourceChunkIds: [],
    agent: "risk-reviewer",
    severity: "escalate"
  }],
  infoRequests: ["Provide the encryption implementation."],
  agents: [],
  memoRevision: 2,
  inputHash: memo.contentHash
};

describe("ReviewWorkbench stages", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["prepare", "Confirm the review package"],
    ["review", "Review the current revision"],
    ["decide", "Record the human decision"]
  ] as const)("renders unique %s content with one main, one H1, and aria-current", (stage, heading) => {
    const { container } = renderWorkbench({ stage });
    const stageLabel = stage === "decide" ? "Decide & Export" : stage;
    expect(screen.getByRole("heading", { name: memo.title, level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(`^\\d\\s*${stageLabel}$`, "i") })).toHaveAttribute("aria-current", "step");
    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
  });

  it("keeps the Review primary action discoverable and binds approval to the exact revision", () => {
    renderWorkbench({ stage: "review" });
    expect(screen.getByRole("button", { name: /approve & run ai review/i })).toBeInTheDocument();
    expect(screen.getByText(/revision 2 · standard · hash current-co/i)).toBeInTheDocument();
    expect(screen.getAllByText("Encryption functionality not documented")).toHaveLength(2);
  });

  it("shows a persistent export blocker linked to the unresolved finding", () => {
    renderWorkbench({ stage: "decide" });
    const blocker = screen.getByRole("status");
    expect(within(blocker).getByText("Export is blocked")).toBeInTheDocument();
    expect(within(blocker).getByRole("button", { name: /encryption functionality not documented/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /export signed result/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /accept & sign/i })).toBeDisabled();
  });

  it("disables all stage-changing mutations while the memo draft is dirty", () => {
    renderWorkbench({ stage: "review", memoDraftDirty: true });
    expect(screen.getByText("Unsaved memo edits")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve & run ai review/i })).toBeDisabled();
  });
});

function renderWorkbench(overrides: Partial<ComponentProps<typeof ReviewWorkbench>> = {}) {
  return render(
    <ReviewWorkbench
      memo={memo}
      result={result}
      auditEvents={[]}
      user={user}
      members={[user]}
      stage="review"
      analysisStatus="live"
      analysisMessage="Authoritative analysis loaded."
      analysisMode="standard"
      backendNotice="Live AI is available."
      liveAnalysisAvailable
      approvalBusy={false}
      memoEditor={<section aria-label="Memo editor">Memo editor</section>}
      memoDraftDirty={false}
      chatMessages={[]}
      chatHasMore={false}
      auditHasMore={false}
      onFindingSelect={vi.fn()}
      onStageChange={vi.fn()}
      onBack={vi.fn()}
      onRunAnalysis={vi.fn()}
      onAnalysisModeChange={vi.fn()}
      onRevokeCouncilApproval={vi.fn()}
      onExport={vi.fn()}
      onOpenMemoBuilder={vi.fn()}
      onUpdateMetadata={vi.fn()}
      onDecision={vi.fn()}
      onSendChat={vi.fn().mockResolvedValue("sent")}
      onApplyChatSuggestion={vi.fn()}
      onLoadMoreChat={vi.fn()}
      onLoadMoreAudit={vi.fn()}
      {...overrides}
    />
  );
}
