import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { officialCorpus } from "../data/corpus";
import { reviewFixtures } from "../test/reviewFixtures";
import type {
  AiApprovalRequestListItem,
  AiApprovalRequestStatus,
  AiApprovalRequestRecord
} from "../types";
import { resetAiRequestIdsForTests, setCsrfToken } from "../lib/apiClient";
import { AdminConsole } from "./AdminConsole";

const hash = "a".repeat(64);
const requestRecord: AiApprovalRequestRecord = {
  schemaVersion: "rulix.ai-approval-request/v1",
  id: `air-${"1".repeat(40)}`,
  requestId: "11111111-1111-4111-8111-111111111111",
  commandHash: hash,
  dedupeHash: "e".repeat(64),
  tenantId: "tenant-1",
  targetAccountId: "reviewer-1",
  requestedBy: { id: "reviewer-1", role: "reviewer" },
  purpose: "memo-chat",
  subject: {
    kind: "review",
    id: reviewFixtures[0].id,
    version: reviewFixtures[0].version!,
    revision: reviewFixtures[0].revision!,
    contentHash: reviewFixtures[0].contentHash!
  },
  payloadHash: hash,
  providerRequestHashes: ["b".repeat(64)],
  dataClass: "proprietary",
  policy: {
    version: "rulix-ai-egress/v1",
    mode: "approved",
    provider: "amazon-bedrock",
    clientRegion: "us-east-1",
    model: "global.anthropic.claude-haiku-4-5-20251001-v1:0"
  },
  context: {
    kind: "memo-chat",
    pendingMessageHash: "c".repeat(64),
    historyHash: "d".repeat(64)
  },
  createdAt: "2026-07-14T00:00:00.000Z",
  expiresAt: "2026-07-15T00:00:00.000Z",
  validUntilEpoch: 1_784_073_600,
  expiresAtEpoch: 1_791_763_200
};

const pendingStatus: AiApprovalRequestStatus = {
  request: requestRecord,
  status: "pending"
};

const listItem: AiApprovalRequestListItem = {
  id: requestRecord.id,
  targetAccountId: requestRecord.targetAccountId,
  requestedBy: requestRecord.requestedBy,
  purpose: requestRecord.purpose,
  subject: requestRecord.subject,
  dataClass: requestRecord.dataClass,
  policy: requestRecord.policy,
  context: requestRecord.context,
  status: "pending",
  createdAt: requestRecord.createdAt,
  expiresAt: requestRecord.expiresAt
};

beforeEach(() => {
  setCsrfToken("csrf-test");
  resetAiRequestIdsForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAiRequestIdsForTests();
});

describe("AI approval Controls queue", () => {
  it("shows exact officer-only pending content and sends a binding-free approve command", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/admin/ai-approval-requests?") && (!init?.method || init.method === "GET")) {
        return json({ items: [listItem] });
      }
      if (url === `/api/admin/ai-approval-requests/${requestRecord.id}`) {
        return json({
          approvalRequest: pendingStatus,
          pendingContent: { kind: "memo-chat", text: "Explain the exact ECCN evidence gap." },
          inspection: {
            kind: "memo-chat",
            current: true,
            memo: reviewFixtures[0],
            history: [],
            pendingMessage: "Explain the exact ECCN evidence gap.",
            providerRequest: {
              model: requestRecord.policy.model,
              messages: [{
                role: "user",
                content: JSON.stringify({
                  itemFamily: "hidden-cryogenic-controller",
                  attachments: ["hidden-specification.pdf"]
                })
              }]
            },
            providerRequestHash: requestRecord.providerRequestHashes[0]
          }
        });
      }
      if (url === `/api/admin/ai-approval-requests/${requestRecord.id}/approve`) {
        return json({
          ...pendingStatus,
          status: "approved",
          decision: {
            schemaVersion: "rulix.ai-approval-request-decision/v1",
            requestId: requestRecord.id,
            targetAccountId: requestRecord.targetAccountId,
            decisionRequestId: "22222222-2222-4222-8222-222222222222",
            commandHash: hash,
            decision: "approved",
            decidedBy: { id: "officer-1", role: "export-control-officer" },
            decidedAt: "2026-07-14T00:01:00.000Z",
            approvalId: `aia-${"2".repeat(40)}`,
            expiresAtEpoch: 1_791_763_200
          }
        });
      }
      throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderConsole("export-control-officer");
    expect(await screen.findByText("Exact pending message")).toBeInTheDocument();
    expect(screen.getByText("Explain the exact ECCN evidence gap.")).toBeInTheDocument();
    expect(screen.getByText(/Exact provider request/)).toHaveTextContent(requestRecord.providerRequestHashes[0]);
    expect(screen.getByText((content) => content.includes("hidden-specification.pdf"))).toBeInTheDocument();
    const approve = screen.getByRole("button", { name: /Approve one dispatch/i });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/ai-approval-requests/${requestRecord.id}/approve`,
      expect.objectContaining({ method: "POST" })
    ));
    const approveCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/approve"));
    const body = JSON.parse(String(approveCall?.[1]?.body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["requestId"]);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Headers(approveCall?.[1]?.headers).get("x-amz-content-sha256")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("disables blind approval for stale content and appends deduplicated queue pages", async () => {
    const second = { ...listItem, id: `air-${"3".repeat(40)}`, purpose: "council" as const };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("cursor=next-page")) return json({ items: [listItem, second] });
      if (url.startsWith("/api/admin/ai-approval-requests?")) {
        return json({ items: [listItem], nextCursor: "next-page" });
      }
      if (url === `/api/admin/ai-approval-requests/${requestRecord.id}`) {
        return json({
          approvalRequest: pendingStatus,
          inspection: {
            kind: "memo-chat",
            current: false,
            memo: reviewFixtures[0],
            history: [],
            unavailableReason: "Chat history changed."
          }
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderConsole("export-control-officer");
    const approve = await screen.findByRole("button", { name: /Approve one dispatch/i });
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Load more requests" }));
    expect(await screen.findByText("Council analysis")).toBeInTheDocument();
    expect(document.querySelectorAll(".ai-approval-request-row")).toHaveLength(2);
  });

  it("never applies request A's inspection to request B while B detail is loading", async () => {
    const requestB = {
      ...requestRecord,
      id: `air-${"4".repeat(40)}`,
      requestId: "44444444-4444-4444-8444-444444444444",
      purpose: "council" as const,
      context: { kind: "council" as const, depth: "standard" as const }
    };
    const statusB: AiApprovalRequestStatus = { request: requestB, status: "pending" };
    const itemB: AiApprovalRequestListItem = {
      ...listItem,
      id: requestB.id,
      purpose: "council",
      context: requestB.context
    };
    let resolveB!: (response: Response) => void;
    const pendingB = new Promise<Response>((resolve) => { resolveB = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/ai-approval-requests?")) return json({ items: [listItem, itemB] });
      if (url === `/api/admin/ai-approval-requests/${requestRecord.id}`) {
        return json({
          approvalRequest: pendingStatus,
          inspection: {
            kind: "memo-chat",
            current: true,
            memo: reviewFixtures[0],
            history: [],
            pendingMessage: "Exact A"
          }
        });
      }
      if (url === `/api/admin/ai-approval-requests/${requestB.id}`) return pendingB;
      if (url.endsWith("/approve")) return json(statusB);
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderConsole("export-control-officer");
    const oldApprove = await screen.findByRole("button", { name: /Approve one dispatch/i });
    fireEvent.click(screen.getByRole("button", { name: /Council analysis/i }));
    expect(await screen.findByText("Loading exact request content…")).toBeInTheDocument();
    fireEvent.click(oldApprove);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(`${requestB.id}/approve`))).toBe(false);

    resolveB(json({
      approvalRequest: statusB,
      inspection: {
        kind: "council",
        current: true,
        depth: "standard",
        memo: reviewFixtures[0]
      }
    }));
    expect(await screen.findByRole("button", { name: /Approve one dispatch/i })).toBeEnabled();
  });
});

function renderConsole(role: "export-control-officer" | "reviewer") {
  return render(
    <AdminConsole
      view="controls"
      memos={[]}
      decisions={{}}
      auditEvents={[]}
      reviewResults={{}}
      corpus={officialCorpus}
      userRole={role}
      onSelectMemo={() => undefined}
    />
  );
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
