// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { AccountReviewState, AuditEvent, MemoBuilderSession, MemoRecord, MemoRevision } from "../src/types";
import { hashAiApprovalChatHistory } from "./domain/aiApproval";
import { hashMemoContent } from "./domain/hashes";
import {
  InMemoryWorkspaceContentStore,
  WORKSPACE_BUILDER_SESSION_MAX_BYTES,
  WorkspaceConflictError,
  WorkspaceValidationError,
  stableCanonicalJson,
  workspacePk,
  workspaceSk,
  type PutWorkspaceContentInput,
  type WorkspaceContentRef,
  type WorkspaceContentStore,
  type WorkspaceItem,
  type WorkspaceMetaItem
} from "./workspaceV2";
import {
  NormalizedWorkspaceAccountAdapter,
  type WorkspaceStateTransitions
} from "./workspaceV2AccountAdapter";

class FakeWorkspaceRepository {
  readonly tableName = "workspace";
  readonly tenantId = "tenant";
  readonly items = new Map<string, WorkspaceItem>();
  holdMetaPut = false;
  beforeNextTransaction?: () => void;
  private releaseMetaPut?: () => void;
  private reachedMetaPut?: () => void;
  readonly metaPutReached = new Promise<void>((resolve) => { this.reachedMetaPut = resolve; });

  constructor() {
    const at = "2026-07-14T12:00:00.000Z";
    this.items.set(workspaceSk.meta(), {
      pk: workspacePk(this.tenantId, "user"),
      sk: workspaceSk.meta(),
      schemaVersion: 2,
      entityType: "META",
      entityVersion: 1,
      migrationStatus: "complete",
      builderSessionCount: 0,
      createdAt: at,
      updatedAt: at
    } satisfies WorkspaceMetaItem);
  }

  async requireMigrated() {
    return structuredClone(this.items.get(workspaceSk.meta()) as WorkspaceMetaItem);
  }

  async getMeta() {
    return structuredClone(this.items.get(workspaceSk.meta()) as WorkspaceMetaItem);
  }

  async getItem<T extends WorkspaceItem>(_userId: string, sk: string) {
    const item = this.items.get(sk);
    return item ? structuredClone(item) as T : undefined;
  }

  async queryPage<T extends WorkspaceItem>(input: {
    limit: number;
    cursor?: string;
    forward?: boolean;
    indexPk?: string;
    prefix: string;
  }) {
    const rows = [...this.items.values()]
      .filter((item) => input.indexPk
        ? item.gsi1pk === input.indexPk && String(item.gsi1sk ?? "").startsWith(input.prefix)
        : item.sk.startsWith(input.prefix))
      .sort((left, right) => String(left.gsi1sk ?? left.sk).localeCompare(String(right.gsi1sk ?? right.sk)));
    if (input.forward === false) rows.reverse();
    const start = input.cursor ? Number(input.cursor) : 0;
    const items = rows.slice(start, start + input.limit) as T[];
    const next = start + items.length;
    return { items: structuredClone(items), ...(next < rows.length ? { nextCursor: String(next) } : {}) };
  }

  outboxPut(userId: string, event: AuditEvent) {
    return {
      Put: {
        TableName: this.tableName,
        Item: {
          pk: workspacePk(this.tenantId, userId),
          sk: workspaceSk.audit(event.memoId, event.at, event.id),
          schemaVersion: "rulix.audit-outbox/v1",
          entityType: "AU",
          auditEvent: event,
          createdAt: event.at,
          updatedAt: event.at
        }
      }
    };
  }

  async transact(transactions: Array<Record<string, unknown>>) {
    const beforeTransaction = this.beforeNextTransaction;
    this.beforeNextTransaction = undefined;
    beforeTransaction?.();
    const metaPut = transactions.find((entry) => {
      const put = entry.Put as { Item?: WorkspaceItem } | undefined;
      return put?.Item?.sk === workspaceSk.meta();
    });
    if (metaPut && this.holdMetaPut) {
      this.reachedMetaPut?.();
      await new Promise<void>((resolve) => { this.releaseMetaPut = resolve; });
    }

    for (const entry of transactions) {
      const condition = entry.ConditionCheck as {
        Key?: { sk?: string };
        ConditionExpression?: string;
        ExpressionAttributeValues?: Record<string, unknown>;
      } | undefined;
      if (condition?.Key?.sk) {
        assertFakeWorkspaceCondition(
          this.items.get(condition.Key.sk),
          condition.ConditionExpression ?? "",
          condition.ExpressionAttributeValues ?? {}
        );
      }
      const put = entry.Put as {
        Item?: WorkspaceItem;
        ConditionExpression?: string;
        ExpressionAttributeValues?: Record<string, unknown>;
      } | undefined;
      if (put?.Item) {
        const existing = this.items.get(put.Item.sk);
        if ((put.ConditionExpression?.includes("attribute_not_exists(#pk)") ||
            put.ConditionExpression?.includes("attribute_not_exists(#sk)")) && existing) {
          throw new WorkspaceConflictError("Workspace version changed.");
        }
        const expected = put.ExpressionAttributeValues?.[":expectedVersion"];
        if (expected !== undefined && existing?.entityVersion !== expected) {
          throw new WorkspaceConflictError("Workspace version changed.");
        }
        assertFakeWorkspaceCondition(
          existing,
          put.ConditionExpression ?? "",
          put.ExpressionAttributeValues ?? {}
        );
      }
      const update = entry.Update as {
        Key?: { sk?: string };
        ConditionExpression?: string;
        ExpressionAttributeValues?: Record<string, unknown>;
      } | undefined;
      if (update?.Key?.sk) {
        assertFakeWorkspaceCondition(
          this.items.get(update.Key.sk),
          update.ConditionExpression ?? "",
          update.ExpressionAttributeValues ?? {}
        );
      }
      const deletion = entry.Delete as {
        Key?: { sk?: string };
        ConditionExpression?: string;
        ExpressionAttributeValues?: Record<string, unknown>;
      } | undefined;
      if (deletion?.Key?.sk) {
        assertFakeWorkspaceCondition(
          this.items.get(deletion.Key.sk),
          deletion.ConditionExpression ?? "",
          deletion.ExpressionAttributeValues ?? {}
        );
      }
    }

    for (const entry of transactions) {
      const put = entry.Put as { Item?: WorkspaceItem } | undefined;
      if (put?.Item) this.items.set(put.Item.sk, structuredClone(put.Item));
      const update = entry.Update as {
        Key?: { sk?: string };
        ExpressionAttributeValues?: Record<string, number>;
        UpdateExpression?: string;
      } | undefined;
      if (update?.Key?.sk === workspaceSk.meta()) {
        const meta = this.items.get(workspaceSk.meta()) as WorkspaceMetaItem;
        const delta = update.ExpressionAttributeValues?.[":delta"] ?? 0;
        meta.builderSessionCount = (meta.builderSessionCount ?? 0) + delta;
        if (update.UpdateExpression?.includes("#entityVersion")) {
          meta.entityVersion += update.ExpressionAttributeValues?.[":one"] ?? 0;
        }
        meta.updatedAt = String((update.ExpressionAttributeValues as Record<string, unknown>)?.[":updatedAt"]);
      } else if (update?.Key?.sk) {
        const existing = this.items.get(update.Key.sk);
        if (!existing) throw new WorkspaceConflictError("Workspace item is missing.");
        const next = structuredClone(existing) as WorkspaceItem & {
          aiDispatchClaim?: Record<string, unknown>;
        };
        const values = update.ExpressionAttributeValues as Record<string, unknown> | undefined;
        if (update.UpdateExpression?.includes("SET #aiDispatchClaim")) {
          next.aiDispatchClaim = structuredClone(values?.[":claim"] as Record<string, unknown>);
        }
        if (update.UpdateExpression?.includes("REMOVE #aiDispatchClaim")) {
          delete next.aiDispatchClaim;
        }
        if (values?.[":updatedAt"] !== undefined) next.updatedAt = String(values[":updatedAt"]);
        this.items.set(update.Key.sk, next);
      }
      const deletion = entry.Delete as { Key?: { sk?: string } } | undefined;
      if (deletion?.Key?.sk) this.items.delete(deletion.Key.sk);
    }
  }

  releaseHeldMetaPut() {
    this.holdMetaPut = false;
    this.releaseMetaPut?.();
  }
}

function assertFakeWorkspaceCondition(
  existing: (WorkspaceItem & { aiDispatchClaim?: Record<string, unknown>; nextSequence?: number;
    historyHash?: string; historySchemaVersion?: string }) | undefined,
  expression: string,
  values: Record<string, unknown>
) {
  const fail = () => { throw new WorkspaceConflictError("Workspace condition changed."); };
  if (expression.includes("attribute_not_exists(#pk)") && existing) fail();
  if (values[":expectedVersion"] !== undefined && existing?.entityVersion !== values[":expectedVersion"]) fail();
  if (values[":version"] !== undefined && existing?.entityVersion !== values[":version"]) fail();
  if (values[":nextSequence"] !== undefined && existing?.nextSequence !== values[":nextSequence"]) fail();
  if (values[":historyHash"] !== undefined && existing?.historyHash !== values[":historyHash"]) fail();
  if (values[":historySchemaVersion"] !== undefined &&
      existing?.historySchemaVersion !== values[":historySchemaVersion"]) fail();
  const claim = existing?.aiDispatchClaim;
  if (expression.includes("#aiDispatchClaim.#dispatchId") && (
      !claim || claim.dispatchId !== values[":dispatchId"] ||
      claim.requestHash !== values[":requestHash"] ||
      claim.reservationToken !== values[":reservationToken"])) fail();
  if (expression.includes("attribute_not_exists(#aiDispatchClaim)")) {
    const allowsExpired = expression.includes("#aiDispatchClaim.#expiresAtEpoch <= :nowEpoch");
    if (claim && (!allowsExpired || Number(claim.expiresAtEpoch) > Number(values[":nowEpoch"]))) fail();
  }
  if (expression.includes("#aiDispatchClaim.#expiresAtEpoch > :nowEpoch") &&
      (!claim || Number(claim.expiresAtEpoch) <= Number(values[":nowEpoch"]))) fail();
}

/**
 * Forces the request that physically creates an immutable object to lose the
 * DynamoDB transaction to a request that reuses that same object version. This
 * is the race that makes online "cleanup after transaction failure" unsafe:
 * the losing creator must not delete content already committed by the winner.
 */
class CreatorDelayedContentStore implements WorkspaceContentStore {
  private readonly base = new InMemoryWorkspaceContentStore();
  private callCount = 0;
  private releaseCreator?: () => void;
  private creatorStored?: () => void;
  readonly creatorStoredPromise = new Promise<void>((resolve) => { this.creatorStored = resolve; });

  async putImmutable(input: PutWorkspaceContentInput): Promise<WorkspaceContentRef> {
    const ref = await this.base.putImmutable(input);
    this.callCount += 1;
    if (this.callCount === 1) {
      this.creatorStored?.();
      await new Promise<void>((resolve) => { this.releaseCreator = resolve; });
    }
    return ref;
  }

  get(
    ref: WorkspaceContentRef,
    maxLogicalBytes: number,
    scope: Pick<PutWorkspaceContentInput, "tenantId" | "userId" | "entity">
  ) {
    return this.base.get(ref, maxLogicalBytes, scope);
  }

  release() {
    this.releaseCreator?.();
  }
}

function sampleMemo(): MemoRecord {
  const memo: MemoRecord = {
    id: "memo-1",
    title: "Navigation controller",
    itemFamily: "Avionics",
    owner: "Reviewer",
    updatedAt: "2026-07-14T12:00:00.000Z",
    createdAt: "2026-07-14T12:00:00.000Z",
    documentCode: "DOC-1",
    status: "draft",
    memoText: "Controlled navigation component.",
    attachments: [],
    dataClass: "export-controlled",
    revision: 1,
    version: 1,
    createdBy: "user"
  };
  return { ...memo, contentHash: hashMemoContent(memo) };
}

function transitions(): WorkspaceStateTransitions {
  const unused = () => { throw new Error("unused transition"); };
  return {
    create(state, _userId, command) {
      const review = structuredClone(command.memo);
      const revision: MemoRevision = {
        id: `${review.id}-r1`,
        memoId: review.id,
        revision: 1,
        contentHash: review.contentHash ?? hashMemoContent(review),
        memoText: review.memoText,
        title: review.title,
        itemFamily: review.itemFamily,
        manufacturer: review.manufacturer,
        intendedUse: review.intendedUse,
        dataClass: review.dataClass ?? "proprietary",
        sourcePath: review.sourcePath ?? "unknown",
        createdAt: review.createdAt ?? review.updatedAt,
        createdBy: review.createdBy ?? "user",
        reason: "created"
      };
      state.memos = [review];
      state.memoRevisions = { [review.id]: [revision] };
      return { review, auditEvents: [command.auditEvent], replayed: false };
    },
    updateMemo: unused,
    archive: unused,
    appendChat(state, memoId, command) {
      state.chatMessages[memoId] = [...(state.chatMessages[memoId] ?? []), ...command.messages];
      return { review: state.memos[0]!, messages: state.chatMessages[memoId], auditEvents: [] };
    },
    applySuggestion: unused,
    analysis: unused,
    decision: unused
  } as WorkspaceStateTransitions;
}

function auditEvent(): AuditEvent {
  return {
    id: "audit-1",
    memoId: "memo-1",
    at: "2026-07-14T12:00:00.000Z",
    actor: "Reviewer",
    actorId: "user",
    organizationId: "org-1",
    action: "memo.created",
    detail: "Created",
    severity: "info",
    metadata: {
      actorType: "user",
      source: "authenticated-api",
      outcome: "succeeded",
      subjectType: "review",
      subjectId: "memo-1"
    }
  };
}

function paddedSession(id: string, targetBytes: number): MemoBuilderSession {
  const session: MemoBuilderSession = {
    id,
    title: "Large bounded session",
    dataClass: "proprietary",
    messages: [{ role: "user", content: "hello" }],
    updatedAt: "2026-07-14T12:00:00.000Z",
    pendingAttachments: [{
      id: "attachment-1",
      name: "context.txt",
      content: "",
      status: "ready",
      detail: "Parsed"
    }]
  };
  const baseBytes = Buffer.byteLength(stableCanonicalJson(session), "utf8");
  session.pendingAttachments![0]!.content = "x".repeat(Math.max(0, targetBytes - baseBytes));
  return session;
}

async function seedReview(
  repository: FakeWorkspaceRepository,
  content: InMemoryWorkspaceContentStore
) {
  const review = sampleMemo();
  const ref = await content.putImmutable({
    tenantId: repository.tenantId,
    userId: "user",
    entity: "memo-revision",
    id: `${review.id}/1`,
    body: review.memoText,
    mimeType: "text/plain; charset=utf-8",
    maxBytes: 512 * 1024
  });
  const { memoText: _memoText, ...metadata } = review;
  repository.items.set(workspaceSk.review(review.id), {
    pk: workspacePk(repository.tenantId, "user"),
    sk: workspaceSk.review(review.id),
    schemaVersion: 2,
    entityType: "R",
    entityVersion: 1,
    currentRevision: 1,
    review: metadata,
    contentRef: ref,
    createdAt: review.createdAt ?? review.updatedAt,
    updatedAt: review.updatedAt
  });
  return review;
}

describe("normalized workspace adapter concurrency and bounds", () => {
  it("replays the winner when identical create requests race after both miss the receipt", async () => {
    const repository = new FakeWorkspaceRepository();
    const adapter = new NormalizedWorkspaceAccountAdapter(
      repository as never,
      new InMemoryWorkspaceContentStore(),
      transitions()
    );
    const command = { requestId: "request-1", inputHash: "same-input", memo: sampleMemo(), auditEvent: auditEvent() };
    const results = await Promise.all([
      adapter.createReviewIdempotent("user", command),
      adapter.createReviewIdempotent("user", command)
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(results[0].review.id).toBe(results[1].review.id);
    expect([...repository.items.values()].filter((item) => item.entityType === "R")).toHaveLength(1);
  });

  it("keeps shared immutable content when the physical creator loses and the reuser wins", async () => {
    const repository = new FakeWorkspaceRepository();
    const content = new CreatorDelayedContentStore();
    const adapter = new NormalizedWorkspaceAccountAdapter(
      repository as never,
      content,
      transitions()
    );
    const command = {
      requestId: "creator-loses",
      inputHash: "identical-input",
      memo: sampleMemo(),
      auditEvent: auditEvent()
    };

    const creator = adapter.createReviewIdempotent("user", command);
    await content.creatorStoredPromise;
    const reuser = await adapter.createReviewIdempotent("user", command);
    expect(reuser.replayed).toBe(false);

    content.release();
    const losingCreator = await creator;
    expect(losingCreator.replayed).toBe(true);

    const hydrated = await adapter.getReviewDetail("user", command.memo.id);
    expect(hydrated?.review.memoText).toBe(command.memo.memoText);
    expect(hydrated?.review.contentHash).toBe(command.memo.contentHash);
  });

  it("preserves the 300k builder capability and rejects over-limit state without truncation", async () => {
    const repository = new FakeWorkspaceRepository();
    const adapter = new NormalizedWorkspaceAccountAdapter(
      repository as never,
      new InMemoryWorkspaceContentStore(),
      transitions()
    );
    const near = paddedSession("near", WORKSPACE_BUILDER_SESSION_MAX_BYTES - 32);
    expect(Buffer.byteLength(stableCanonicalJson(near), "utf8")).toBeLessThanOrEqual(
      WORKSPACE_BUILDER_SESSION_MAX_BYTES
    );
    const stored = await adapter.upsertMemoBuilderSession("user", "near", {
      expectedVersion: 0,
      session: near
    });
    expect(stored.session.pendingAttachments?.[0]?.content).toBe(near.pendingAttachments?.[0]?.content);

    const over = paddedSession("over", WORKSPACE_BUILDER_SESSION_MAX_BYTES + 1);
    await expect(adapter.upsertMemoBuilderSession("user", "over", {
      expectedVersion: 0,
      session: over
    })).rejects.toBeInstanceOf(WorkspaceValidationError);
    expect(repository.items.has(workspaceSk.builderSession("over"))).toBe(false);
  });

  it("increments META entityVersion so a concurrent preference CAS cannot erase the builder count", async () => {
    const repository = new FakeWorkspaceRepository();
    const adapter = new NormalizedWorkspaceAccountAdapter(
      repository as never,
      new InMemoryWorkspaceContentStore(),
      transitions()
    );
    repository.holdMetaPut = true;
    const stalePreferenceWrite = adapter.updateWorkspacePreferences("user", {
      expectedVersion: 1,
      selectedMemoId: "memo-1"
    });
    await repository.metaPutReached;
    await adapter.upsertMemoBuilderSession("user", "builder-1", {
      expectedVersion: 0,
      session: paddedSession("builder-1", 1024)
    });
    repository.releaseHeldMetaPut();
    await expect(stalePreferenceWrite).rejects.toBeInstanceOf(WorkspaceConflictError);
    const meta = repository.items.get(workspaceSk.meta()) as WorkspaceMetaItem;
    expect(meta).toMatchObject({ entityVersion: 2, builderSessionCount: 1 });
  });

  it("pages chat by an atomic per-thread sequence, including tied timestamps", async () => {
    const repository = new FakeWorkspaceRepository();
    const content = new InMemoryWorkspaceContentStore();
    const review = await seedReview(repository, content);
    const adapter = new NormalizedWorkspaceAccountAdapter(repository as never, content, transitions());
    for (let batch = 0; batch < 12; batch += 1) {
      const messages = Array.from({ length: 20 }, (_, index) => {
        const sequence = batch * 20 + index;
        return {
          id: `message-${sequence.toString().padStart(3, "0")}`,
          memoId: review.id,
          role: sequence % 2 === 0 ? "user" as const : "assistant" as const,
          text: `message ${sequence}`,
          createdAt: "2026-07-14T12:00:00.000Z"
        };
      });
      await adapter.appendBoundChat("user", review.id, {
        expectedVersion: 1,
        expectedRevision: 1,
        expectedHash: review.contentHash!,
        messages
      });
    }
    const first = await adapter.listReviewChatMessages("user", review.id, { limit: 200 });
    const second = await adapter.listReviewChatMessages("user", review.id, {
      limit: 200,
      cursor: first.nextCursor
    });
    const ids = [...first.items, ...second.items].map((message) => message.id);
    expect(ids).toHaveLength(240);
    expect(new Set(ids)).toHaveLength(240);
    expect(ids).toEqual(Array.from({ length: 240 }, (_, index) =>
      `message-${(239 - index).toString().padStart(3, "0")}`));

    const authoritativeHash = hashAiApprovalChatHistory(first.items);
    const capture = await adapter.aiApprovalChatCondition("user", review.id, authoritativeHash);
    expect(capture.fence).toEqual({
      historyHash: authoritativeHash,
      chatMeta: { exists: true, entityVersion: 12, nextSequence: 240 }
    });

    // A stale or incomplete GSI page must never be accepted as the approval
    // fence. The strongly consistent CHAT_META window remains authoritative.
    const latestKey = workspaceSk.chat(review.id, "message-239");
    const latest = repository.items.get(latestKey)!;
    repository.items.delete(latestKey);
    const stale = await adapter.listReviewChatMessages("user", review.id, { limit: 200 });
    await expect(adapter.aiApprovalChatCondition(
      "user",
      review.id,
      hashAiApprovalChatHistory(stale.items)
    )).rejects.toBeInstanceOf(WorkspaceConflictError);
    repository.items.set(latestKey, latest);
    await expect(adapter.aiApprovalChatCondition("user", review.id, authoritativeHash)).resolves.toBeDefined();
  });

  it("allows only one live provider-start claim and atomically consumes it with the append", async () => {
    const repository = new FakeWorkspaceRepository();
    const content = new InMemoryWorkspaceContentStore();
    const review = await seedReview(repository, content);
    const now = "2026-07-14T12:00:00.000Z";
    const adapter = new NormalizedWorkspaceAccountAdapter(
      repository as never, content, transitions(), () => new Date(now)
    );
    const capture = await adapter.aiApprovalChatCondition("user", review.id, hashAiApprovalChatHistory([]));
    const nowEpoch = Math.floor(Date.parse(now) / 1_000);
    const firstClaim = {
      dispatchId: "dispatch-one",
      requestHash: "a".repeat(64),
      reservationToken: "token-one",
      expiresAtEpoch: nowEpoch + 60,
      outcome: "succeeded" as const,
      fence: capture.fence
    };
    await repository.transact([
      adapter.aiApprovalChatClaimTransition("user", review.id, capture.fence, firstClaim, now, nowEpoch) as never
    ]);
    await expect(repository.transact([
      adapter.aiApprovalChatClaimTransition("user", review.id, capture.fence, {
        ...firstClaim,
        dispatchId: "dispatch-two",
        requestHash: "b".repeat(64),
        reservationToken: "token-two"
      }, now, nowEpoch) as never
    ])).rejects.toBeInstanceOf(WorkspaceConflictError);

    await adapter.appendBoundChat("user", review.id, {
      expectedVersion: 1,
      expectedRevision: 1,
      expectedHash: review.contentHash!,
      aiDispatchClaim: firstClaim,
      messages: [{
        id: "claimed-message",
        memoId: review.id,
        role: "assistant",
        text: "claimed response",
        createdAt: now
      }]
    });
    const meta = repository.items.get(workspaceSk.chatMeta(review.id)) as WorkspaceItem & {
      aiDispatchClaim?: unknown;
      nextSequence?: number;
    };
    expect(meta.aiDispatchClaim).toBeUndefined();
    expect(meta.nextSequence).toBe(1);
    await expect(repository.transact([
      adapter.aiApprovalChatClaimTransition("user", review.id, capture.fence, {
        ...firstClaim,
        dispatchId: "dispatch-three",
        requestHash: "c".repeat(64),
        reservationToken: "token-three"
      }, now, nowEpoch) as never
    ])).rejects.toBeInstanceOf(WorkspaceConflictError);
  });

  it("rejects append when another dispatch replaces the observed claim before the transaction", async () => {
    const repository = new FakeWorkspaceRepository();
    const content = new InMemoryWorkspaceContentStore();
    const review = await seedReview(repository, content);
    const now = "2026-07-14T12:00:00.000Z";
    const adapter = new NormalizedWorkspaceAccountAdapter(
      repository as never, content, transitions(), () => new Date(now)
    );
    const capture = await adapter.aiApprovalChatCondition("user", review.id, hashAiApprovalChatHistory([]));
    const nowEpoch = Math.floor(Date.parse(now) / 1_000);
    const firstClaim = {
      dispatchId: "dispatch-one",
      requestHash: "d".repeat(64),
      reservationToken: "token-one",
      expiresAtEpoch: nowEpoch + 60,
      outcome: "succeeded" as const,
      fence: capture.fence
    };
    await repository.transact([
      adapter.aiApprovalChatClaimTransition("user", review.id, capture.fence, firstClaim, now, nowEpoch) as never
    ]);
    repository.beforeNextTransaction = () => {
      const meta = repository.items.get(workspaceSk.chatMeta(review.id)) as WorkspaceItem & {
        aiDispatchClaim?: Record<string, unknown>;
      };
      meta.aiDispatchClaim = {
        dispatchId: "dispatch-two",
        requestHash: "e".repeat(64),
        reservationToken: "token-two",
        expiresAtEpoch: nowEpoch + 60
      };
    };
    await expect(adapter.appendBoundChat("user", review.id, {
      expectedVersion: 1,
      expectedRevision: 1,
      expectedHash: review.contentHash!,
      aiDispatchClaim: firstClaim,
      messages: [{
        id: "losing-message",
        memoId: review.id,
        role: "assistant",
        text: "must not commit",
        createdAt: now
      }]
    })).rejects.toBeInstanceOf(WorkspaceConflictError);
    expect(repository.items.has(workspaceSk.chat(review.id, "losing-message"))).toBe(false);
  });

  it("permits deterministic fallback only after the exact failed claim is released", async () => {
    const repository = new FakeWorkspaceRepository();
    const content = new InMemoryWorkspaceContentStore();
    const review = await seedReview(repository, content);
    const now = "2026-07-14T12:00:00.000Z";
    const adapter = new NormalizedWorkspaceAccountAdapter(
      repository as never, content, transitions(), () => new Date(now)
    );
    const capture = await adapter.aiApprovalChatCondition("user", review.id, hashAiApprovalChatHistory([]));
    const nowEpoch = Math.floor(Date.parse(now) / 1_000);
    const claim = {
      dispatchId: "dispatch-failed",
      requestHash: "f".repeat(64),
      reservationToken: "token-failed",
      expiresAtEpoch: nowEpoch + 60,
      outcome: "failed" as const,
      fence: capture.fence
    };
    await repository.transact([
      adapter.aiApprovalChatClaimTransition("user", review.id, capture.fence, claim, now, nowEpoch) as never
    ]);
    await expect(adapter.appendBoundChat("user", review.id, {
      expectedVersion: 1,
      expectedRevision: 1,
      expectedHash: review.contentHash!,
      aiDispatchClaim: claim,
      messages: [{ id: "early-fallback", memoId: review.id, role: "assistant", text: "no", createdAt: now }]
    })).rejects.toBeInstanceOf(WorkspaceConflictError);
    await repository.transact([
      adapter.aiApprovalChatClaimRelease("user", review.id, capture.fence, claim, now) as never
    ]);
    await expect(adapter.appendBoundChat("user", review.id, {
      expectedVersion: 1,
      expectedRevision: 1,
      expectedHash: review.contentHash!,
      aiDispatchClaim: claim,
      messages: [{ id: "safe-fallback", memoId: review.id, role: "assistant", text: "fallback", createdAt: now }]
    })).resolves.toBeDefined();
  });
});
