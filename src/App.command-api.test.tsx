import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoRecord, UserProfile } from "./types";

const api = vi.hoisted(() => ({
  acceptInvite: vi.fn(),
  analyzeMemoWithBackend: vi.fn(),
  approveCouncilAnalysis: vi.fn(),
  applyMemoChatSuggestion: vi.fn(),
  completePasswordReset: vi.fn(),
  createReviewComment: vi.fn(),
  createReview: vi.fn(),
  deleteMemoBuilderSession: vi.fn(),
  getBackendHealth: vi.fn(),
  getCouncilApproval: vi.fn(),
  getCurrentUser: vi.fn(),
  getReviewDetail: vi.fn(),
  listMemoBuilderSessions: vi.fn(),
  listNotifications: vi.fn(),
  listReviewComments: vi.fn(),
  listReviewAuditEvents: vi.fn(),
  listReviewChatMessages: vi.fn(),
  listReviews: vi.fn(),
  listTenantMembers: vi.fn(),
  loadWorkspacePreferences: vi.fn(),
  recordReviewDecision: vi.fn(),
  requestCouncilApproval: vi.fn(),
  requestMemoChatApproval: vi.fn(),
  requestPasswordReset: vi.fn(),
  resolveReviewComment: vi.fn(),
  revokeAiApproval: vi.fn(),
  sendMemoChat: vi.fn(),
  setReviewArchived: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  updateReviewMemo: vi.fn(),
  updateReviewMetadata: vi.fn(),
  updateWorkspacePreferences: vi.fn(),
  upsertMemoBuilderSession: vi.fn(),
  validateInvite: vi.fn(),
  validatePasswordReset: vi.fn()
}));

vi.mock("./lib/apiClient", () => ({
  ANALYSIS_MODE_CONFIG: {
    standard: { label: "Full AI Council", depth: "standard", cost: "Haiku", description: "Standard" },
    deep: { label: "Deep Council Pass", depth: "deep", cost: "Sonnet", description: "Deep" }
  },
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  ...api,
  sanitizeMemoBuilderSessionForStorage: (session: unknown) => session
}));

import { App } from "./App";

const user: UserProfile = {
  id: "user-rendered-command-api",
  email: "rendered@example.com",
  name: "Rendered Reviewer",
  role: "reviewer",
  createdAt: "2026-07-14T00:00:00.000Z"
};

const primary = review("review-rendered-primary", "RLX primary review", "a");
const secondary = review("review-rendered-secondary", "RLX second-page review", "b");

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  for (const mock of Object.values(api)) mock.mockReset();
  api.getCurrentUser.mockResolvedValue({ user, csrfToken: "csrf-rendered" });
  api.getBackendHealth.mockResolvedValue({
    ok: true,
    service: "rulix-eccn-api",
    phase: "phase-2-mvp",
    time: "2026-07-14T00:00:00.000Z",
    provider: { configured: false }
  });
  api.getCouncilApproval.mockResolvedValue(undefined);
  api.loadWorkspacePreferences.mockResolvedValue({ version: 0, selectedMemoId: primary.id });
  api.listMemoBuilderSessions.mockResolvedValue({ items: [] });
  api.listNotifications.mockResolvedValue({ items: [] });
  api.listReviewComments.mockResolvedValue({ items: [] });
  api.listTenantMembers.mockResolvedValue({ items: [user] });
  api.listReviewAuditEvents.mockResolvedValue({ items: [] });
  api.listReviewChatMessages.mockResolvedValue({ items: [] });
  api.getReviewDetail.mockResolvedValue({ review: primary });
  api.listReviews.mockImplementation(async (query: { cursor?: string }) => query.cursor
    ? { items: [summary(secondary)] }
    : { items: [summary(primary)], nextCursor: "page-two" });
  api.updateWorkspacePreferences.mockResolvedValue({ version: 1, selectedMemoId: primary.id });
});

describe("rendered paged command workspace", () => {
  it("loads summary pages on demand and fetches detail only for the selected review", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /reviews/i }));
    expect(await screen.findByRole("button", { name: /load more reviews/i })).toBeEnabled();
    expect(await screen.findByText(primary.title)).toBeInTheDocument();
    expect(api.getReviewDetail).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /load more reviews/i }));

    expect(await screen.findByText(secondary.title)).toBeInTheDocument();
    expect(api.listReviews).toHaveBeenCalledWith({ limit: 25, state: "active" }, expect.any(AbortSignal));
    expect(api.listReviews).toHaveBeenCalledWith({ limit: 30, cursor: "page-two", state: "active", sort: "updated-desc" });
    expect(api.getReviewDetail).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /load more reviews/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(primary.title).closest("button")!);
    expect(await screen.findByRole("heading", { name: primary.title, level: 1 })).toBeInTheDocument();
    expect(api.getReviewDetail).toHaveBeenCalledWith(primary.id);
  });

  it("shows an honest loading state while targeted detail, audit, and chat reads are pending", async () => {
    let resolveDetail!: (value: { review: MemoRecord }) => void;
    api.getReviewDetail.mockReturnValue(new Promise((resolve) => {
      resolveDetail = resolve;
    }));
    window.history.replaceState(null, "", `/#/reviews/${primary.id}/overview`);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Loading review details" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No memos yet" })).not.toBeInTheDocument();

    resolveDetail({ review: primary });
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Loading review details" })).not.toBeInTheDocument();
    });
    // The rendered memo body may repeat its Markdown title at a lower heading
    // level. Assert the workspace title specifically so the query is stable.
    expect(screen.getByRole("heading", { name: primary.title, level: 1 })).toBeInTheDocument();
  });

  it("restores and validates a migrated review even when it is not on the first summary page", async () => {
    const migrated = review("paste-1782080000000", "Migrated pasted review", "c");
    api.loadWorkspacePreferences.mockResolvedValue({ version: 4, selectedMemoId: migrated.id });
    api.getReviewDetail.mockImplementation(async (memoId: string) => ({
      review: memoId === migrated.id ? migrated : primary
    }));
    window.history.replaceState(null, "", `/#/reviews/${migrated.id}/overview`);

    render(<App />);

    expect(await screen.findByRole("heading", { name: migrated.title, level: 1 })).toBeInTheDocument();
    expect(api.getReviewDetail).toHaveBeenCalledWith(migrated.id);
    await waitFor(() => expect(api.updateWorkspacePreferences).not.toHaveBeenCalled(), { timeout: 700 });
  });

  it("removes a deleted restored review, selects the next summary, and repairs preferences once", async () => {
    const deletedId = "upload-1782080000000";
    const { ApiError } = await import("./lib/apiClient");
    api.loadWorkspacePreferences.mockResolvedValue({ version: 7, selectedMemoId: deletedId });
    api.getReviewDetail.mockImplementation(async (memoId: string) => {
      if (memoId === deletedId) throw new ApiError(404, "Review not found", "review_not_found");
      return { review: primary };
    });
    api.updateWorkspacePreferences.mockResolvedValue({ version: 8, selectedMemoId: primary.id });
    window.history.replaceState(null, "", `/#/reviews/${deletedId}/overview`);

    render(<App />);

    expect(await screen.findByRole("heading", { name: primary.title, level: 1 })).toBeInTheDocument();
    expect(await screen.findByText(/that review no longer exists/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(api.updateWorkspacePreferences).toHaveBeenCalledWith(7, {
        selectedMemoId: primary.id,
        activeMemoBuilderSessionId: null
      });
    });
    expect(api.updateWorkspacePreferences).toHaveBeenCalledTimes(1);
  });

  it("keeps retryable service failures selected and succeeds when the reviewer retries", async () => {
    const { ApiError } = await import("./lib/apiClient");
    api.getReviewDetail.mockRejectedValueOnce(new ApiError(503, "Service unavailable", "service_unavailable"));
    window.history.replaceState(null, "", `/#/reviews/${primary.id}/overview`);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Review details unavailable" })).toBeInTheDocument();
    expect((await screen.findAllByText(/temporarily unavailable/i)).length).toBeGreaterThan(0);
    api.getReviewDetail.mockResolvedValue({ review: primary });
    fireEvent.click(screen.getByRole("button", { name: /retry loading review/i }));

    expect(await screen.findByRole("heading", { name: primary.title, level: 1 })).toBeInTheDocument();
  });
});

function review(id: string, title: string, hashChar: string): MemoRecord {
  return {
    id,
    title,
    itemFamily: "Cryogenic controller",
    owner: "Rendered Reviewer",
    updatedAt: "2026-07-14",
    documentCode: id.toUpperCase(),
    status: "draft",
    memoText: `# ${title}\n\nBounded memo body.`,
    attachments: [],
    dataClass: "proprietary",
    sourcePath: "self-classification",
    manufacturer: "Rulix Test Instruments",
    intendedUse: "Research laboratory",
    version: 1,
    revision: 1,
    contentHash: hashChar.repeat(64)
  };
}

function summary(memo: MemoRecord) {
  const { memoText: _memoText, attachments: _attachments, ...value } = memo;
  return value;
}
