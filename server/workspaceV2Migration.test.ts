// @vitest-environment node

import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import type { AccountReviewState, AuditEvent, MemoRecord } from "../src/types";
import {
  InMemoryWorkspaceContentStore,
  WORKSPACE_MEMO_MAX_BYTES,
  WorkspaceContentGcActiveError,
  WorkspaceIntegrityError,
  WorkspaceValidationError,
  workspacePk,
  workspaceSk,
  type WorkspaceItem,
  type WorkspaceMetaItem
} from "./workspaceV2";
import {
  DynamoWorkspaceMigrationBackend,
  DynamoLegacyAccountSource,
  createMigrationReceipt,
  materializeMigrationPlan,
  migrateWorkspaceAccount,
  planWorkspaceMigration,
  publicWorkspaceMigrationPlan,
  verifyWorkspaceMigration,
  type WorkspaceMigrationBackend,
  type WorkspaceMigrationPlan
} from "./workspaceV2Migration";

class MemoryMigrationBackend implements WorkspaceMigrationBackend {
  readonly destinationTable = "workspace-v2";
  readonly items = new Map<string, WorkspaceItem>();
  writeCalls = 0;
  failWriteCall?: number;
  calls: string[] = [];
  private lease?: { owner: string; digest: string };

  async acquireLease(plan: WorkspaceMigrationPlan, owner: string) {
    this.calls.push("lease");
    if (this.lease && this.lease.owner !== owner) throw new Error("lease conflict");
    this.lease = { owner, digest: plan.migrationDigest };
  }

  async getMeta(userId: string) {
    return this.items.get(workspaceSk.meta()) as WorkspaceMetaItem | undefined;
  }

  async writeBatch(plan: WorkspaceMigrationPlan, items: WorkspaceItem[]) {
    this.calls.push("write");
    this.writeCalls += 1;
    if (this.failWriteCall === this.writeCalls) throw new Error("simulated crash");
    for (const item of items) {
      const existing = this.items.get(item.sk);
      if (existing && existing.migrationDigest !== plan.migrationDigest) throw new Error("digest conflict");
      this.items.set(item.sk, structuredClone(item));
    }
  }

  async listMaterializedItems() {
    this.calls.push("list");
    return Array.from(this.items.values()).map((item) => structuredClone(item));
  }

  async complete(plan: WorkspaceMigrationPlan, owner: string, now: string) {
    this.calls.push("complete");
    if (!this.lease || this.lease.owner !== owner || this.lease.digest !== plan.migrationDigest) {
      throw new Error("invalid lease");
    }
    this.items.set(workspaceSk.meta(), {
      pk: workspacePk(plan.tenantId, plan.userId),
      sk: workspaceSk.meta(),
      schemaVersion: 2,
      entityType: "META",
      entityVersion: 1,
      migrationStatus: "complete",
      sourceDigest: plan.sourceDigest,
      migrationDigest: plan.migrationDigest,
      ...structuredClone(plan.metaPayload),
      metaSemanticHash: plan.metaSemanticHash,
      migratedAt: now,
      createdAt: now,
      updatedAt: now
    });
    this.lease = undefined;
  }

  async releaseLease(_plan: WorkspaceMigrationPlan, owner: string) {
    this.calls.push("release");
    if (this.lease?.owner === owner) this.lease = undefined;
  }
}

function sampleState(commentCount = 0): AccountReviewState {
  const memo: MemoRecord = {
    id: "memo-1",
    title: "Navigation controller",
    itemFamily: "Avionics",
    owner: "Reviewer",
    updatedAt: "2026-07-14T10:00:00.000Z",
    createdAt: "2026-07-14T09:00:00.000Z",
    documentCode: "DOC-1",
    status: "ready",
    memoText: "A controlled navigation component.",
    attachments: [],
    dataClass: "export-controlled",
    revision: 1,
    version: 1,
    createdBy: "user-1"
  };
  const historicalEvent: AuditEvent = {
    id: "event-1",
    memoId: memo.id,
    at: "2026-07-14T10:00:00.000Z",
    actor: "Legacy Display Name",
    action: "memo.created",
    detail: "Created before normalized storage",
    severity: "info"
  };
  return {
    schemaVersion: 2,
    version: 9,
    organization: { id: "org-1", name: "Example", createdAt: "2026-01-01T00:00:00.000Z" },
    memos: [memo],
    decisions: {},
    auditEvents: [historicalEvent],
    analysisResults: {},
    chatMessages: {},
    memoRevisions: {},
    comments: {
      [memo.id]: Array.from({ length: commentCount }, (_, index) => ({
        id: `comment-${index}`,
        memoId: memo.id,
        authorId: "user-1",
        authorName: "Reviewer",
        body: `Comment ${index}`,
        createdAt: new Date(Date.UTC(2026, 6, 14, 10, 0, index)).toISOString(),
        mentions: []
      }))
    },
    notifications: [],
    memoBuilder: { messages: [], sessions: [] },
    outreachDrafts: {},
    discoveredLeads: [],
    leadSearchRuns: [],
    leadWorkflows: {},
    outreachJobs: []
  };
}

describe("workspace v2 migration", () => {
  it("reads the exact legacy account key and filters scan pages to the requested tenant account shape", async () => {
    const state = sampleState();
    const inputs: Array<Record<string, unknown>> = [];
    const doc = {
      send: async (command: { input: Record<string, unknown>; constructor: { name: string } }) => {
        inputs.push(command.input);
        if (command.constructor.name === "GetCommand") {
          return {
            Item: {
              pk: "TENANT#tenant#USER#user-1",
              tenantId: "tenant",
              userId: "user-1",
              state
            }
          };
        }
        return {
          Items: [
            { pk: "TENANT#tenant", sk: "USER#person@example.com", record: {} },
            { pk: "TENANT#other#USER#outsider", tenantId: "other", userId: "outsider", state },
            { pk: "TENANT#tenant#USER#user-1", tenantId: "tenant", userId: "user-1", state }
          ],
          LastEvaluatedKey: { pk: "cursor" }
        };
      }
    };
    const source = new DynamoLegacyAccountSource("legacy", "tenant", doc as never);

    await expect(source.get("user-1")).resolves.toMatchObject({ userId: "user-1" });
    const page = await source.list(undefined, 25);
    expect(inputs[0]?.Key).toEqual({ pk: "TENANT#tenant#USER#user-1" });
    expect(inputs[1]).toMatchObject({
      FilterExpression: "begins_with(#pk, :accountPrefix)",
      ExpressionAttributeValues: { ":accountPrefix": "TENANT#tenant#USER#" }
    });
    expect(page.accounts).toHaveLength(1);
    expect(page.accounts[0]?.userId).toBe("user-1");
    expect(page.nextCursor).toEqual({ pk: "cursor" });
  });

  it("plans without leaking content or making backend/content writes", async () => {
    const plan = await planWorkspaceMigration("tenant", "user", sampleState());
    const publicPlan = publicWorkspaceMigrationPlan(plan);
    expect(publicPlan).toMatchObject({ tenantId: "tenant", userId: "user" });
    expect(JSON.stringify(publicPlan)).not.toContain("controlled navigation component");

    const backend = new MemoryMigrationBackend();
    const result = await migrateWorkspaceAccount({
      mode: "plan", plan, backend, content: new InMemoryWorkspaceContentStore()
    });
    expect(result.status).toBe("planned");
    expect(backend.calls).toEqual([]);
  });

  it("resumes after a batch crash, remains idempotent, and verifies the semantic digest", async () => {
    const plan = await planWorkspaceMigration("tenant", "user", sampleState(55));
    const backend = new MemoryMigrationBackend();
    const content = new InMemoryWorkspaceContentStore();
    backend.failWriteCall = 2;
    await expect(migrateWorkspaceAccount({
      mode: "apply", plan, backend, content, owner: "worker-1"
    })).rejects.toThrow("simulated crash");
    expect(backend.items.size).toBeGreaterThan(0);
    expect(backend.items.has(workspaceSk.meta())).toBe(false);

    backend.failWriteCall = undefined;
    const resumed = await migrateWorkspaceAccount({
      mode: "apply", plan, backend, content, owner: "worker-2",
      now: () => new Date("2026-07-14T12:00:00.000Z")
    });
    expect(resumed.status).toBe("migrated");
    expect((await backend.getMeta("user"))?.migrationStatus).toBe("complete");
    await expect(verifyWorkspaceMigration(plan, backend)).resolves.toMatchObject({
      entityCount: plan.entityCount,
      migrationDigest: plan.migrationDigest
    });

    const repeated = await migrateWorkspaceAccount({
      mode: "apply", plan, backend, content, owner: "worker-3"
    });
    expect(repeated.status).toBe("skipped");
  });

  it("renews a short migration lease during content materialization and batches", async () => {
    const plan = await planWorkspaceMigration("tenant", "user", sampleState(30));
    const backend = new MemoryMigrationBackend();
    const content = new InMemoryWorkspaceContentStore();
    let nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const result = await migrateWorkspaceAccount({
      mode: "apply",
      plan,
      backend,
      content,
      owner: "heartbeat-worker",
      leaseMs: 9,
      now: () => {
        nowMs += 4;
        return new Date(nowMs);
      }
    });
    expect(result.status).toBe("migrated");
    expect(backend.calls.filter((call) => call === "lease").length).toBeGreaterThan(2);
  });

  it("fences migration batches that would commit content pointers during GC", async () => {
    const plan = await planWorkspaceMigration("tenant", "user", sampleState());
    const materialized = await materializeMigrationPlan(plan, new InMemoryWorkspaceContentStore());
    const contentItem = materialized.find((item) => "contentRef" in item)!;
    let transaction: TransactWriteCommand["input"] | undefined;
    const doc = {
      async send(command: unknown) {
        if (!(command instanceof TransactWriteCommand)) throw new Error("unexpected command");
        transaction = command.input;
        throw {
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }]
        };
      }
    };
    const backend = new DynamoWorkspaceMigrationBackend("workspace", "tenant", doc as never);
    await expect(backend.writeBatch(plan, [contentItem]))
      .rejects.toBeInstanceOf(WorkspaceContentGcActiveError);
    expect(transaction?.TransactItems?.[0]).toMatchObject({
      ConditionCheck: {
        Key: {
          pk: "TENANT#tenant#SYSTEM",
          sk: workspaceSk.contentGcLease()
        }
      }
    });
  });

  it("binds transaction idempotency tokens to exact materialized item payloads", async () => {
    const plan = await planWorkspaceMigration("tenant", "user", sampleState());
    const materialized = await materializeMigrationPlan(plan, new InMemoryWorkspaceContentStore());
    const original = materialized.find((item) => "contentRef" in item)!;
    const changed = structuredClone(original);
    const contentRef = changed.contentRef as { versionId: string };
    contentRef.versionId = `${contentRef.versionId}-retry`;
    const tokens: Array<string | undefined> = [];
    const doc = {
      async send(command: unknown) {
        if (!(command instanceof TransactWriteCommand)) throw new Error("unexpected command");
        tokens.push(command.input.ClientRequestToken);
        return {};
      }
    };
    const backend = new DynamoWorkspaceMigrationBackend("workspace", "tenant", doc as never);

    await backend.writeBatch(plan, [original]);
    await backend.writeBatch(plan, [structuredClone(original)]);
    await backend.writeBatch(plan, [changed]);

    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).not.toBe(tokens[0]);
  });

  it("atomically completes metadata and lease release without addressing one item twice", async () => {
    const plan = await planWorkspaceMigration("tenant", "user", sampleState());
    let transaction: TransactWriteCommand["input"] | undefined;
    const doc = {
      async send(command: unknown) {
        if (!(command instanceof TransactWriteCommand)) throw new Error("unexpected command");
        transaction = command.input;
        return {};
      }
    };
    const backend = new DynamoWorkspaceMigrationBackend("workspace", "tenant", doc as never);

    await backend.complete(plan, "migration-owner", "2026-07-14T12:00:00.000Z");

    const items = transaction?.TransactItems ?? [];
    const keys = items.map((item) => {
      if (item.Put) return `${String(item.Put.Item?.pk)}|${String(item.Put.Item?.sk)}`;
      if (item.Delete) return `${String(item.Delete.Key?.pk)}|${String(item.Delete.Key?.sk)}`;
      throw new Error("completion transaction must use put or conditional delete only");
    });
    expect(items).toHaveLength(2);
    expect(new Set(keys).size).toBe(keys.length);
    expect(items[0]?.Put?.Item).toMatchObject({ sk: workspaceSk.meta(), migrationStatus: "complete" });
    expect(items[1]?.Delete).toMatchObject({
      Key: { sk: workspaceSk.migrationLease() },
      ConditionExpression: "#leaseOwner = :owner AND #migrationDigest = :digest"
    });
  });

  it("detects target corruption and a changed legacy source after completion", async () => {
    const plan = await planWorkspaceMigration("tenant", "user", sampleState());
    const backend = new MemoryMigrationBackend();
    const content = new InMemoryWorkspaceContentStore();
    await migrateWorkspaceAccount({ mode: "apply", plan, backend, content, owner: "worker" });
    const review = backend.items.get(workspaceSk.review("memo-1"))!;
    review.updatedAt = "2026-07-15T00:00:00.000Z";
    await expect(verifyWorkspaceMigration(plan, backend)).rejects.toBeInstanceOf(WorkspaceIntegrityError);

    const changed = sampleState();
    changed.memos[0]!.memoText = "changed source";
    const changedPlan = await planWorkspaceMigration("tenant", "user", changed);
    await expect(migrateWorkspaceAccount({
      mode: "apply", plan: changedPlan, backend, content, owner: "other"
    })).rejects.toBeInstanceOf(WorkspaceIntegrityError);
  });

  it("marks display-only legacy audit identity as an unverified service import", async () => {
    const plan = await planWorkspaceMigration("tenant", "user", sampleState());
    const items = await materializeMigrationPlan(plan, new InMemoryWorkspaceContentStore());
    const audit = items.find((item) => item.entityType === "AU")!;
    expect(audit.auditEvent).toMatchObject({
      actor: "Legacy Display Name",
      actorId: "legacy-import",
      organizationId: "org-1",
      metadata: {
        actorType: "service",
        source: "system",
        outcome: "succeeded",
        subjectType: "review",
        subjectId: "memo-1",
        originalActor: "Legacy Display Name",
        legacyUnverified: true
      }
    });
  });

  it("rejects malformed or oversized legacy records rather than truncating them", async () => {
    const oversized = sampleState();
    oversized.memos[0]!.memoText = "x".repeat(WORKSPACE_MEMO_MAX_BYTES + 1);
    await expect(planWorkspaceMigration("tenant", "user", oversized))
      .rejects.toBeInstanceOf(WorkspaceValidationError);
    const malformed = sampleState();
    malformed.memos[0]!.updatedAt = "not-a-date";
    await expect(planWorkspaceMigration("tenant", "user", malformed))
      .rejects.toBeInstanceOf(WorkspaceValidationError);
  });

  it("creates a tamper-evident signed receipt", () => {
    const receipt = createMigrationReceipt({
      mode: "verify",
      tenantId: "tenant",
      destinationTable: "workspace-v2",
      generatedAt: "2026-07-14T12:00:00.000Z",
      signingKey: "migration-receipt-signing-key-at-least-32-bytes",
      accounts: [{
        userId: "user", sourceDigest: "a", migrationDigest: "b",
        entityCount: 5, status: "verified"
      }]
    });
    expect(receipt).toMatchObject({
      schemaVersion: "rulix.workspace-migration-receipt/v1",
      signatureAlgorithm: "hmac-sha256"
    });
    expect(receipt.signature).toMatch(/^[A-Za-z0-9_-]+$/u);
  });
});
