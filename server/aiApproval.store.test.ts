// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AiApprovalPolicyBinding,
  AiApprovalSubjectBinding,
  MemoRecord
} from "../src/types";
import { hashMemoContent } from "./domain/hashes";
import { hashAiApprovalChatHistory, hashAiApprovalPayload } from "./domain/aiApproval";
import {
  LocalAccountStore,
  type CreateAiApprovalRequestCommand
} from "./store";

const ACCOUNT = "user-requester";
const OFFICER = { id: "user-officer", role: "export-control-officer" as const };
const REQUESTER = { id: ACCOUNT, role: "reviewer" as const };
const POLICY: AiApprovalPolicyBinding = {
  version: "policy-v1",
  mode: "approved",
  provider: "amazon-bedrock",
  clientRegion: "us-east-1",
  model: "anthropic.claude-3-5-sonnet"
};

describe("AI approval store security invariants", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    process.env.RULIX_AI_APPROVAL_PREVIEW_ACTIVE_KEY_ID = "test-v1";
    process.env.RULIX_AI_APPROVAL_PREVIEW_KEYS_JSON = JSON.stringify({
      "test-v1": Buffer.alloc(32, 7).toString("base64url")
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.RULIX_AI_APPROVAL_PREVIEW_ACTIVE_KEY_ID;
    delete process.env.RULIX_AI_APPROVAL_PREVIEW_KEYS_JSON;
  });

  it("creates an immutable cross-account request and atomically issues a target-account approval", async () => {
    const { store, subject } = await reviewStore();
    const command = councilRequest(subject, "request-one");
    const created = await store.createAiApprovalRequest(ACCOUNT, command);
    const retried = await store.createAiApprovalRequest(ACCOUNT, command);
    const crossDeviceDuplicate = await store.createAiApprovalRequest(ACCOUNT, {
      ...command,
      requestId: "request-one-other-device"
    });

    expect(retried.request.id).toBe(created.request.id);
    expect(crossDeviceDuplicate.request.id).toBe(created.request.id);
    await expect(store.createAiApprovalRequest(ACCOUNT, {
      ...command,
      payloadHash: hashAiApprovalPayload({ changed: true })
    })).rejects.toMatchObject({ code: "ai_approval_request_idempotency_conflict" });

    const approved = await store.approveAiApprovalRequest(created.request.id, {
      requestId: "decision-one",
      decidedBy: OFFICER
    });
    expect(approved.status).toBe("approved");
    expect(approved.approval?.approval.accountId).toBe(ACCOUNT);
    expect(approved.approval?.current).toBe(true);
    expect(approved.approval?.approval.payloadHash).toBe(command.payloadHash);
    expect(approved.approval?.approval.providerRequestHashes).toEqual(command.providerRequestHashes);

    const delayed = await store.approveAiApprovalRequest(created.request.id, {
      requestId: "decision-one",
      decidedBy: OFFICER
    });
    expect(delayed.approval?.approval.id).toBe(approved.approval?.approval.id);
    await expect(store.approveAiApprovalRequest(created.request.id, {
      requestId: "different-decision",
      decidedBy: OFFICER
    })).rejects.toMatchObject({ code: "ai_approval_request_decided" });

    const recreated = await store.createAiApprovalRequest(ACCOUNT, {
      ...command,
      requestId: "request-after-terminal"
    });
    expect(recreated.request.id).not.toBe(created.request.id);
  });

  it("encrypts exact memo-chat content, reveals it only in officer detail, and deletes it on decision", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "rulix-ai-preview-"));
    const filePath = path.join(directory, "store.json");
    try {
      const { store, subject } = await reviewStore(new LocalAccountStore({ filePath, persist: true }));
      const pending = "Please compare this exact prospective chat content.";
      const command: CreateAiApprovalRequestCommand = {
        requestId: "chat-request",
        requestedBy: REQUESTER,
        purpose: "memo-chat",
        subject,
        payloadHash: hashAiApprovalPayload({ reviewId: subject.id, pending }),
        providerRequestHashes: [hashAiApprovalPayload({ model: POLICY.model, pending })],
        dataClass: "proprietary",
        policy: POLICY,
        context: {
          kind: "memo-chat",
          pendingMessageHash: hashAiApprovalPayload(pending),
          historyHash: hashAiApprovalChatHistory([])
        },
        pendingContent: { kind: "memo-chat", text: pending }
      };
      const created = await store.createAiApprovalRequest(ACCOUNT, command);
      expect(readFileSync(filePath, "utf8")).not.toContain(pending);
      expect(JSON.stringify(await store.getAiApprovalRequest(ACCOUNT, created.request.id))).not.toContain(pending);
      const officerDetail = await store.getTenantAiApprovalRequest(OFFICER, created.request.id);
      expect(officerDetail?.pendingContent?.text).toBe(pending);

      await store.approveAiApprovalRequest(created.request.id, {
        requestId: "chat-decision",
        decidedBy: OFFICER
      });
      expect((await store.getTenantAiApprovalRequest(OFFICER, created.request.id))?.pendingContent).toBeUndefined();
      expect(readFileSync(filePath, "utf8")).not.toContain(pending);
      expect(JSON.parse(readFileSync(filePath, "utf8")).aiApprovalRequestPreviews).toEqual({});
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts exactly 8,000 Unicode chat characters and rejects the 8,001st", async () => {
    const { store, subject } = await reviewStore();
    const exact = "😀".repeat(8_000);
    const command = (pending: string, requestId: string): CreateAiApprovalRequestCommand => ({
      requestId,
      requestedBy: REQUESTER,
      purpose: "memo-chat",
      subject,
      payloadHash: hashAiApprovalPayload({ subject, pending }),
      providerRequestHashes: [hashAiApprovalPayload({ model: POLICY.model, pending })],
      dataClass: "proprietary",
      policy: POLICY,
      context: {
        kind: "memo-chat",
        pendingMessageHash: hashAiApprovalPayload(pending),
        historyHash: hashAiApprovalChatHistory([])
      },
      pendingContent: { kind: "memo-chat", text: pending }
    });

    const accepted = await store.createAiApprovalRequest(ACCOUNT, command(exact, "unicode-exact"));
    expect((await store.getTenantAiApprovalRequest(OFFICER, accepted.request.id))?.pendingContent?.text)
      .toBe(exact);
    await expect(store.createAiApprovalRequest(
      ACCOUNT,
      command(`${exact}😀`, "unicode-overflow")
    )).rejects.toMatchObject({ code: "ai_approval_request_preview_required" });
  });

  it("fails closed for absent, mismatched, tampered, or unconfigured prospective chat content", async () => {
    const { store, subject } = await reviewStore();
    const pending = "Exact content";
    const base: CreateAiApprovalRequestCommand = {
      requestId: "chat-missing",
      requestedBy: REQUESTER,
      purpose: "memo-chat",
      subject,
      payloadHash: hashAiApprovalPayload({ pending }),
      providerRequestHashes: [hashAiApprovalPayload({ model: POLICY.model, pending })],
      dataClass: "proprietary",
      policy: POLICY,
      context: {
        kind: "memo-chat",
        pendingMessageHash: hashAiApprovalPayload(pending),
        historyHash: hashAiApprovalChatHistory([])
      }
    };
    await expect(store.createAiApprovalRequest(ACCOUNT, base)).rejects.toMatchObject({
      code: "ai_approval_request_preview_required"
    });
    await expect(store.createAiApprovalRequest(ACCOUNT, {
      ...base,
      requestId: "chat-mismatch",
      pendingContent: { kind: "memo-chat", text: "Different" }
    })).rejects.toMatchObject({ code: "ai_approval_binding_mismatch" });
    delete process.env.RULIX_AI_APPROVAL_PREVIEW_KEYS_JSON;
    await expect(store.createAiApprovalRequest(ACCOUNT, {
      ...base,
      requestId: "chat-unconfigured",
      pendingContent: { kind: "memo-chat", text: pending }
    })).rejects.toMatchObject({ code: "ai_approval_request_preview_unconfigured" });
  });

  it("rejects officer approval after the exact review subject changes", async () => {
    const { store, subject, memo } = await reviewStore();
    const created = await store.createAiApprovalRequest(ACCOUNT, councilRequest(subject, "stale-request"));
    await store.updateReview(ACCOUNT, {
      ...memo,
      memoText: `${memo.memoText}\nChanged after queueing.`,
      updatedAt: "2026-07-15T12:01:00.000Z",
      revision: (memo.revision ?? 1) + 1,
      version: (memo.version ?? memo.revision ?? 1) + 1
    });
    await expect(store.approveAiApprovalRequest(created.request.id, {
      requestId: "stale-decision",
      decidedBy: OFFICER
    })).rejects.toMatchObject({ code: "ai_approval_stale_subject" });
  });

  it("rejects memo-chat approval when server-owned history changes after queueing", async () => {
    const { store, subject } = await reviewStore();
    const pending = "Prospective question";
    const created = await store.createAiApprovalRequest(ACCOUNT, {
      requestId: "chat-history-request",
      requestedBy: REQUESTER,
      purpose: "memo-chat",
      subject,
      payloadHash: hashAiApprovalPayload({ subject, pending, history: [] }),
      providerRequestHashes: [hashAiApprovalPayload({ model: POLICY.model, pending, history: [] })],
      dataClass: "proprietary",
      policy: POLICY,
      context: {
        kind: "memo-chat",
        pendingMessageHash: hashAiApprovalPayload(pending),
        historyHash: hashAiApprovalChatHistory([])
      },
      pendingContent: { kind: "memo-chat", text: pending }
    });
    await store.appendChatMessages(ACCOUNT, subject.id, [{
      id: "message-after-request",
      memoId: subject.id,
      role: "assistant",
      text: "New server-owned history.",
      createdAt: "2026-07-15T12:00:01.000Z"
    }]);
    await expect(store.approveAiApprovalRequest(created.request.id, {
      requestId: "chat-history-decision",
      decidedBy: OFFICER
    })).rejects.toMatchObject({ code: "ai_approval_stale_subject" });
  });

  it("derives queued revocation target server-side and blocks reserve-to-start races", async () => {
    const { store, subject } = await reviewStore();
    const command = councilRequest(subject, "revoke-request");
    const queued = await store.createAiApprovalRequest(ACCOUNT, command);
    const approved = await store.approveAiApprovalRequest(queued.request.id, {
      requestId: "approve-revoke-request",
      decidedBy: OFFICER
    });
    const approvalId = approved.approval?.approval.id as string;
    const nowMs = Date.now();
    const reservation = await store.reserveAiDispatch({
      accountId: ACCOUNT,
      approvalId,
      dispatchId: "dispatch-revoke-race",
      purpose: "council",
      subject,
      payloadHash: command.payloadHash,
      providerRequestHash: command.providerRequestHashes[0],
      dataClass: "proprietary",
      policy: POLICY,
      nowMs
    });
    await store.revokeAiApprovalRequestApproval(queued.request.id, {
      requestId: "revoke-command",
      revokedBy: OFFICER,
      reason: "Content must not leave the tenant."
    });
    await expect(store.transitionAiDispatch({
      accountId: ACCOUNT,
      dispatchId: "dispatch-revoke-race",
      requestHash: reservation.requestHash,
      reservationToken: reservation.reservationToken,
      transition: "mark-started",
      nowMs: nowMs + 1
    })).rejects.toMatchObject({ code: expect.stringMatching(/ai_approval_(revoked|superseded)/) });
  });

  it("fences an expired reservation owner after deterministic reclaim", async () => {
    const { store, subject } = await reviewStore();
    const command = councilRequest(subject, "fence-request");
    const queued = await store.createAiApprovalRequest(ACCOUNT, command);
    const approved = await store.approveAiApprovalRequest(queued.request.id, {
      requestId: "fence-decision",
      decidedBy: OFFICER
    });
    const base = {
      accountId: ACCOUNT,
      approvalId: approved.approval?.approval.id,
      dispatchId: "fenced-dispatch",
      purpose: "council" as const,
      subject,
      payloadHash: command.payloadHash,
      providerRequestHash: command.providerRequestHashes[0],
      dataClass: "proprietary" as const,
      policy: POLICY
    };
    const first = await store.reserveAiDispatch({ ...base, nowMs: Date.now() });
    const reclaimedAt = Date.now() + 2 * 60 * 1_000 + 1_000;
    const second = await store.reserveAiDispatch({ ...base, nowMs: reclaimedAt });
    expect(second.replayed).toBe(false);
    expect(second.reservationToken).not.toBe(first.reservationToken);
    await expect(store.transitionAiDispatch({
      accountId: ACCOUNT,
      dispatchId: base.dispatchId,
      requestHash: first.requestHash,
      reservationToken: first.reservationToken,
      transition: "mark-started",
      nowMs: reclaimedAt + 1
    })).rejects.toMatchObject({ code: "ai_dispatch_fenced" });
    await expect(store.transitionAiDispatch({
      accountId: ACCOUNT,
      dispatchId: base.dispatchId,
      requestHash: second.requestHash,
      reservationToken: second.reservationToken,
      transition: "mark-started",
      nowMs: reclaimedAt + 1
    })).resolves.toBeUndefined();
  });

  it.each([
    ["missing approval identity", (receipt: Record<string, unknown>) => { delete receipt.approvalId; }],
    ["flipped authorization kind", (receipt: Record<string, unknown>) => {
      receipt.authorizationKind = "trusted-workflow";
      delete receipt.approvalId;
      delete receipt.subject;
      receipt.trustedWorkflow = "outreach-writer";
      receipt.trustedSubjectId = "lead-security";
    }],
    ["unknown status", (receipt: Record<string, unknown>) => { receipt.status = "completed-ish"; }],
    ["canonical request-hash drift", (receipt: Record<string, unknown>) => {
      receipt.requestHash = "0".repeat(64);
    }]
  ])("fails closed when a persisted dispatch receipt has %s", async (_label, corrupt) => {
    const { store, reservationRequest } = await approvedChatDispatch(`corrupt-${_label.replaceAll(" ", "-")}`);
    await store.reserveAiDispatch(reservationRequest);
    const dispatches = (store as unknown as { aiDispatches: Map<string, Record<string, unknown>> }).aiDispatches;
    const [key, stored] = [...dispatches.entries()][0]!;
    const corrupted = structuredClone(stored);
    corrupt(corrupted);
    dispatches.set(key, corrupted);

    await expect(store.reserveAiDispatch({
      ...reservationRequest,
      nowMs: reservationRequest.nowMs + 1
    })).rejects.toMatchObject({ status: 503, code: "ai_dispatch_state_invalid" });
  });

  it("rejects a terminal memo-chat receipt whose provider-start claim fields were removed", async () => {
    const { store, subject, reservationRequest } = await approvedChatDispatch("missing-chat-claim");
    const reservation = await store.reserveAiDispatch(reservationRequest);
    await store.transitionAiDispatch({
      accountId: ACCOUNT,
      dispatchId: reservationRequest.dispatchId,
      requestHash: reservation.requestHash,
      reservationToken: reservation.reservationToken,
      transition: "mark-started",
      nowMs: reservationRequest.nowMs + 1
    });
    await store.transitionAiDispatch({
      accountId: ACCOUNT,
      dispatchId: reservationRequest.dispatchId,
      requestHash: reservation.requestHash,
      reservationToken: reservation.reservationToken,
      transition: "settle-failed",
      nowMs: reservationRequest.nowMs + 2
    });
    const dispatches = (store as unknown as { aiDispatches: Map<string, Record<string, unknown>> }).aiDispatches;
    const [key, stored] = [...dispatches.entries()][0]!;
    const corrupted = structuredClone(stored);
    delete corrupted.memoChatClaimedAt;
    delete corrupted.memoChatClaimExpiresAtEpoch;
    dispatches.set(key, corrupted);

    await expect(store.appendBoundChat(ACCOUNT, subject.id, {
      expectedVersion: subject.version,
      expectedRevision: subject.revision!,
      expectedHash: subject.contentHash,
      aiDispatchId: reservationRequest.dispatchId,
      messages: [{
        id: "chat-corrupt-fallback",
        memoId: subject.id,
        role: "assistant",
        text: "Fallback must not append from corrupt dispatch state.",
        createdAt: "2026-07-15T12:00:01.000Z"
      }]
    })).rejects.toMatchObject({ status: 503, code: "ai_dispatch_state_invalid" });
  });

  it("allows exactly one provider-start claim across distinct approvals for the same chat history", async () => {
    const { store, subject } = await reviewStore();
    const first = await createChatApproval(store, subject, "claim-first");
    const firstReservation = await store.reserveAiDispatch(first.reservationRequest);
    const second = await createChatApproval(store, subject, "claim-second");
    const secondReservation = await store.reserveAiDispatch(second.reservationRequest);

    const outcomes = await Promise.allSettled([
      store.transitionAiDispatch({
        accountId: ACCOUNT,
        dispatchId: first.reservationRequest.dispatchId,
        requestHash: firstReservation.requestHash,
        reservationToken: firstReservation.reservationToken,
        transition: "mark-started",
        nowMs: Date.now() + 1
      }),
      store.transitionAiDispatch({
        accountId: ACCOUNT,
        dispatchId: second.reservationRequest.dispatchId,
        requestHash: secondReservation.requestHash,
        reservationToken: secondReservation.reservationToken,
        transition: "mark-started",
        nowMs: Date.now() + 1
      })
    ]);

    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const denied = outcomes.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(denied.reason).toMatchObject({
      code: expect.stringMatching(/ai_(approval_superseded|dispatch_fenced)/)
    });
  });

  it("consumes a successful provider claim on append and fences an approval for the old history", async () => {
    const { store, subject } = await reviewStore();
    const first = await createChatApproval(store, subject, "append-winner");
    const firstReservation = await store.reserveAiDispatch(first.reservationRequest);
    await store.transitionAiDispatch({
      accountId: ACCOUNT,
      dispatchId: first.reservationRequest.dispatchId,
      requestHash: firstReservation.requestHash,
      reservationToken: firstReservation.reservationToken,
      transition: "mark-started",
      nowMs: Date.now() + 1
    });
    const stale = await createChatApproval(store, subject, "stale-after-append");
    await store.transitionAiDispatch({
      accountId: ACCOUNT,
      dispatchId: first.reservationRequest.dispatchId,
      requestHash: firstReservation.requestHash,
      reservationToken: firstReservation.reservationToken,
      transition: "settle-succeeded",
      nowMs: Date.now() + 2
    });
    await expect(store.appendBoundChat(ACCOUNT, subject.id, {
      expectedVersion: subject.version,
      expectedRevision: subject.revision!,
      expectedHash: subject.contentHash,
      aiDispatchId: first.reservationRequest.dispatchId,
      messages: [{
        id: "chat-append-winner",
        memoId: subject.id,
        role: "assistant",
        text: "Exact provider response.",
        createdAt: "2026-07-15T12:00:01.000Z"
      }]
    })).resolves.toMatchObject({ messages: [expect.objectContaining({ id: "chat-append-winner" })] });

    await expect(store.reserveAiDispatch(stale.reservationRequest)).rejects.toMatchObject({
      code: "ai_dispatch_fenced"
    });
  });

  it("appends a failed-provider fallback only while the exact approved history remains current", async () => {
    const { store, subject, reservationRequest } = await approvedChatDispatch("provider-fallback");
    const reservation = await store.reserveAiDispatch(reservationRequest);
    await store.transitionAiDispatch({
      accountId: ACCOUNT,
      dispatchId: reservationRequest.dispatchId,
      requestHash: reservation.requestHash,
      reservationToken: reservation.reservationToken,
      transition: "mark-started",
      nowMs: Date.now() + 1
    });
    await store.transitionAiDispatch({
      accountId: ACCOUNT,
      dispatchId: reservationRequest.dispatchId,
      requestHash: reservation.requestHash,
      reservationToken: reservation.reservationToken,
      transition: "settle-failed",
      nowMs: Date.now() + 2
    });
    await expect(store.appendBoundChat(ACCOUNT, subject.id, {
      expectedVersion: subject.version,
      expectedRevision: subject.revision!,
      expectedHash: subject.contentHash,
      aiDispatchId: reservationRequest.dispatchId,
      messages: [{
        id: "chat-provider-fallback",
        memoId: subject.id,
        role: "assistant",
        text: "Bound local fallback.",
        createdAt: "2026-07-15T12:00:01.000Z"
      }]
    })).resolves.toMatchObject({ messages: [expect.objectContaining({ id: "chat-provider-fallback" })] });
  });

  it("bounds unique pending-request growth per account even when request IDs vary", async () => {
    const { store, subject } = await reviewStore();
    for (let index = 0; index < 25; index += 1) {
      await store.createAiApprovalRequest(ACCOUNT, councilRequest(subject, `quota-${index}`, `unique-${index}`));
    }
    await expect(store.createAiApprovalRequest(ACCOUNT, councilRequest(subject, "quota-overflow", "unique-overflow")))
      .rejects.toMatchObject({ status: 429, code: "ai_approval_request_capacity" });
  });

  it("keeps requester and tenant listings scoped, metadata-only, filtered, and bounded", async () => {
    const { store, subject } = await reviewStore();
    const first = await store.createAiApprovalRequest(ACCOUNT, councilRequest(subject, "list-one", "first"));
    await store.createAiApprovalRequest(ACCOUNT, councilRequest(subject, "list-two", "second"));
    await store.rejectAiApprovalRequest(first.request.id, {
      requestId: "reject-list-one",
      decidedBy: OFFICER,
      reason: "Classification needs correction."
    });
    const pending = await store.listAiApprovalRequests(ACCOUNT, { limit: 1, status: "pending" });
    expect(pending.items).toHaveLength(1);
    expect(JSON.stringify(pending.items)).not.toContain("payloadHash");
    expect(JSON.stringify(pending.items)).not.toContain("providerRequestHashes");
    await expect(store.listTenantAiApprovalRequests(REQUESTER, { limit: 10 }))
      .rejects.toMatchObject({ code: "ai_approval_role_required" });
    expect((await store.listTenantAiApprovalRequests(OFFICER, { limit: 10 })).items).toHaveLength(2);
  });
});

async function reviewStore(store = new LocalAccountStore({ persist: false })) {
  const memo: MemoRecord = {
    id: "memo-security",
    title: "Exact AI approval test",
    itemFamily: "Signal-processing equipment",
    owner: "Reviewer",
    updatedAt: "2026-07-15T12:00:00.000Z",
    documentCode: "SEC-1",
    status: "ready",
    memoText: "Exact review content for authorization.",
    attachments: [],
    dataClass: "proprietary",
    sourcePath: "self-classification",
    manufacturer: "Example",
    intendedUse: "Laboratory testing",
    revision: 1,
    version: 1
  };
  await store.upsertReview(ACCOUNT, memo);
  const stored = await store.findReview(ACCOUNT, memo.id) as MemoRecord;
  const subject: AiApprovalSubjectBinding = {
    kind: "review",
    id: stored.id,
    revision: stored.revision ?? 1,
    version: stored.version ?? stored.revision ?? 1,
    contentHash: stored.contentHash ?? hashMemoContent(stored)
  };
  return { store, subject, memo: stored };
}

async function approvedChatDispatch(suffix: string) {
  const { store, subject } = await reviewStore();
  const approval = await createChatApproval(store, subject, suffix);
  return { store, subject, ...approval };
}

async function createChatApproval(
  store: LocalAccountStore,
  subject: AiApprovalSubjectBinding,
  suffix: string
) {
  const pending = `Exact memo-chat turn ${suffix}`;
  const payloadHash = hashAiApprovalPayload({ subject, pending });
  const providerRequestHash = hashAiApprovalPayload({ model: POLICY.model, pending });
  const approval = await store.createAiApproval(ACCOUNT, {
    requestId: `approval-${suffix}`,
    purpose: "memo-chat",
    subject,
    payloadHash,
    providerRequestHashes: [providerRequestHash],
    dataClass: "proprietary",
    policy: POLICY,
    memoChatHistoryHash: hashAiApprovalChatHistory([]),
    approvedBy: OFFICER,
    dispatchLimit: 1
  });
  return {
    approval,
    reservationRequest: {
      accountId: ACCOUNT,
      approvalId: approval.id,
      dispatchId: `dispatch-${suffix}`,
      purpose: "memo-chat" as const,
      subject,
      payloadHash,
      providerRequestHash,
      dataClass: "proprietary" as const,
      policy: POLICY,
      nowMs: Date.now()
    }
  };
}

function councilRequest(
  subject: AiApprovalSubjectBinding,
  requestId: string,
  semanticSalt?: string
): CreateAiApprovalRequestCommand {
  const payload = { reviewId: subject.id, revision: subject.revision, depth: "standard", semanticSalt };
  const body = { model: POLICY.model, max_tokens: 512, messages: [{ role: "user", content: payload }] };
  return {
    requestId,
    requestedBy: REQUESTER,
    purpose: "council",
    subject,
    payloadHash: hashAiApprovalPayload(payload),
    providerRequestHashes: [hashAiApprovalPayload(body)],
    dataClass: "proprietary",
    policy: POLICY,
    context: { kind: "council", depth: "standard" }
  };
}
