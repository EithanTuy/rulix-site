import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput
} from "@aws-sdk/lib-dynamodb";
import type {
  AccountReviewState,
  AuditEvent,
  MemoChatMessage,
  MemoBuilderSession,
  MemoRecord,
  MemoRevision,
  ReviewResult
} from "../src/types";
import {
  WORKSPACE_ANALYSIS_MAX_BYTES,
  WORKSPACE_BUILDER_SESSION_MAX_BYTES,
  WORKSPACE_CHAT_TEXT_MAX_BYTES,
  WORKSPACE_CONTENT_GC_CLOCK_SKEW_MS,
  WORKSPACE_MEMO_MAX_BYTES,
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceConflictError,
  WorkspaceContentGcActiveError,
  WorkspaceIntegrityError,
  WorkspaceValidationError,
  assertUtf8Field,
  assertWorkspaceItemSize,
  containsWorkspaceContentRef,
  sha256Canonical,
  stableCanonicalJson,
  workspacePk,
  workspaceContentGcWriteGuard,
  workspaceContentGcLeasePk,
  workspaceSk,
  type PutWorkspaceContentInput,
  type WorkspaceContentRef,
  type WorkspaceContentStore,
  type WorkspaceItem,
  type WorkspaceMetaItem
} from "./workspaceV2";
import { canonicalAuditPayload } from "./auditOutboxContract";
import {
  AI_APPROVAL_CHAT_HISTORY_SCHEMA_VERSION,
  aiApprovalChatHistoryEntry,
  hashAiApprovalChatHistoryEntries
} from "./domain/aiApproval";

const MIGRATION_BATCH_SIZE = 25;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const IDEMPOTENCY_TTL_DAYS = 30;

export type WorkspaceMigrationMode = "plan" | "apply" | "verify";

interface MigrationContentSpec extends Omit<PutWorkspaceContentInput, "tenantId" | "userId"> {
  field: string;
}

export interface WorkspaceMigrationEntitySpec {
  sk: string;
  entityType: string;
  entityVersion: number;
  createdAt: string;
  updatedAt: string;
  payload: Record<string, unknown>;
  contents: MigrationContentSpec[];
}

export interface WorkspaceMigrationPlan {
  tenantId: string;
  userId: string;
  sourceDigest: string;
  migrationDigest: string;
  entityCount: number;
  contentObjectCount: number;
  contentBytes: number;
  metaPayload: Record<string, unknown>;
  metaSemanticHash: string;
  entities: WorkspaceMigrationEntitySpec[];
}

export interface PublicWorkspaceMigrationPlan {
  tenantId: string;
  userId: string;
  sourceDigest: string;
  migrationDigest: string;
  entityCount: number;
  contentObjectCount: number;
  contentBytes: number;
  entityCounts: Record<string, number>;
}

export interface WorkspaceMigrationReceipt {
  schemaVersion: "rulix.workspace-migration-receipt/v1";
  receiptId: string;
  mode: WorkspaceMigrationMode;
  tenantId: string;
  destinationTable: string;
  changeTicket?: string;
  generatedAt: string;
  accounts: Array<{
    userId: string;
    sourceDigest: string;
    migrationDigest: string;
    entityCount: number;
    status: "planned" | "migrated" | "verified" | "skipped";
  }>;
  payloadHash: string;
  signature?: string;
  signatureAlgorithm?: "hmac-sha256";
}

export interface WorkspaceMigrationCheckpoint {
  schemaVersion: "rulix.workspace-migration-checkpoint/v1";
  tenantId: string;
  destinationTable: string;
  updatedAt: string;
  accounts: Record<string, {
    sourceDigest: string;
    migrationDigest: string;
    status: "migrated" | "verified";
    completedAt: string;
  }>;
}

export interface LegacyAccountRecord {
  userId: string;
  state: AccountReviewState;
}

export interface LegacyAccountPage {
  accounts: LegacyAccountRecord[];
  nextCursor?: Record<string, unknown>;
}

export interface LegacyAccountSource {
  get(userId: string): Promise<LegacyAccountRecord | undefined>;
  list(cursor?: Record<string, unknown>, limit?: number): Promise<LegacyAccountPage>;
}

export interface WorkspaceMigrationBackend {
  readonly destinationTable: string;
  acquireLease(plan: WorkspaceMigrationPlan, owner: string, nowMs: number, leaseMs: number): Promise<void>;
  getMeta(userId: string): Promise<WorkspaceMetaItem | undefined>;
  writeBatch(plan: WorkspaceMigrationPlan, items: WorkspaceItem[]): Promise<void>;
  listMaterializedItems(userId: string): Promise<WorkspaceItem[]>;
  complete(plan: WorkspaceMigrationPlan, owner: string, now: string): Promise<void>;
  releaseLease(plan: WorkspaceMigrationPlan, owner: string): Promise<void>;
}

export interface MigrateWorkspaceAccountOptions {
  mode: WorkspaceMigrationMode;
  plan: WorkspaceMigrationPlan;
  backend: WorkspaceMigrationBackend;
  content: WorkspaceContentStore;
  owner?: string;
  now?: () => Date;
  leaseMs?: number;
  onBatchComplete?: (completed: number, total: number) => void | Promise<void>;
}

export async function planWorkspaceMigration(
  tenantId: string,
  userId: string,
  source: AccountReviewState
): Promise<WorkspaceMigrationPlan> {
  const sourceDigest = sha256Canonical(source);
  const entities = buildMigrationSpecs(tenantId, userId, source);
  const metaPayload = migrationMetaPayload(source);
  const migrationDigest = sha256Canonical(entities.map(semanticSpec));
  return {
    tenantId,
    userId,
    sourceDigest,
    migrationDigest,
    entityCount: entities.length,
    contentObjectCount: entities.reduce((sum, entity) => sum + entity.contents.length, 0),
    contentBytes: entities.reduce(
      (sum, entity) => sum + entity.contents.reduce(
        (entitySum, content) => entitySum + contentBody(content).byteLength,
        0
      ),
      0
    ),
    metaPayload,
    metaSemanticHash: sha256Canonical(metaPayload),
    entities
  };
}

export function publicWorkspaceMigrationPlan(plan: WorkspaceMigrationPlan): PublicWorkspaceMigrationPlan {
  return {
    tenantId: plan.tenantId,
    userId: plan.userId,
    sourceDigest: plan.sourceDigest,
    migrationDigest: plan.migrationDigest,
    entityCount: plan.entityCount,
    contentObjectCount: plan.contentObjectCount,
    contentBytes: plan.contentBytes,
    entityCounts: Object.fromEntries(
      Array.from(new Set(plan.entities.map((entity) => entity.entityType)))
        .sort()
        .map((type) => [type, plan.entities.filter((entity) => entity.entityType === type).length])
    )
  };
}

export async function migrateWorkspaceAccount(options: MigrateWorkspaceAccountOptions) {
  const { plan, backend } = options;
  if (options.mode === "plan") return { status: "planned" as const, plan: publicWorkspaceMigrationPlan(plan) };
  if (options.mode === "verify") {
    await verifyWorkspaceMigration(plan, backend);
    return { status: "verified" as const, plan: publicWorkspaceMigrationPlan(plan) };
  }

  const existingMeta = await backend.getMeta(plan.userId);
  if (existingMeta?.migrationStatus === "complete") {
    if (
      existingMeta.sourceDigest !== plan.sourceDigest ||
      existingMeta.migrationDigest !== plan.migrationDigest
    ) {
      throw new WorkspaceIntegrityError(
        `Workspace ${plan.userId} is already complete with a different source digest.`
      );
    }
    await verifyWorkspaceMigration(plan, backend);
    return { status: "skipped" as const, plan: publicWorkspaceMigrationPlan(plan) };
  }

  const owner = options.owner ?? `migration-${randomUUID()}`;
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  await backend.acquireLease(plan, owner, now().getTime(), leaseMs);
  let renewAfterMs = now().getTime() + Math.max(1, Math.floor(leaseMs / 3));
  let heartbeatFailure: unknown;
  let heartbeatChain: Promise<void> = Promise.resolve();
  const renewLease = async (force = false) => {
    await heartbeatChain;
    if (heartbeatFailure) throw heartbeatFailure;
    const currentMs = now().getTime();
    if (!force && currentMs < renewAfterMs) return;
    await backend.acquireLease(plan, owner, currentMs, leaseMs);
    renewAfterMs = currentMs + Math.max(1, Math.floor(leaseMs / 3));
  };
  const heartbeat = setInterval(() => {
    heartbeatChain = heartbeatChain
      .then(async () => {
        if (heartbeatFailure) return;
        const currentMs = now().getTime();
        if (currentMs < renewAfterMs) return;
        await backend.acquireLease(plan, owner, currentMs, leaseMs);
        renewAfterMs = currentMs + Math.max(1, Math.floor(leaseMs / 3));
      })
      .catch((error: unknown) => {
        heartbeatFailure = error;
      });
  }, Math.max(10, Math.min(60_000, Math.floor(leaseMs / 3))));
  heartbeat.unref?.();
  try {
    const items = await materializeMigrationPlan(plan, options.content, () => renewLease());
    const batches = chunk(items, MIGRATION_BATCH_SIZE);
    for (let index = 0; index < batches.length; index += 1) {
      await renewLease();
      await backend.writeBatch(plan, batches[index]!);
      await renewLease();
      await options.onBatchComplete?.(index + 1, batches.length);
    }
    await renewLease(true);
    await verifyWorkspaceMigration(plan, backend);
    clearInterval(heartbeat);
    await heartbeatChain;
    if (heartbeatFailure) throw heartbeatFailure;
    await renewLease(true);
    await backend.complete(plan, owner, now().toISOString());
    await verifyWorkspaceMigration(plan, backend);
    return { status: "migrated" as const, plan: publicWorkspaceMigrationPlan(plan) };
  } catch (error) {
    clearInterval(heartbeat);
    await heartbeatChain.catch(() => undefined);
    await backend.releaseLease(plan, owner).catch(() => undefined);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

export async function materializeMigrationPlan(
  plan: WorkspaceMigrationPlan,
  content: WorkspaceContentStore,
  onProgress?: () => void | Promise<void>
) {
  const pk = workspacePk(plan.tenantId, plan.userId);
  const items: WorkspaceItem[] = [];
  for (const spec of plan.entities) {
    const payload = structuredClone(spec.payload);
    for (const contentSpec of spec.contents) {
      const ref = await content.putImmutable({
        tenantId: plan.tenantId,
        userId: plan.userId,
        entity: contentSpec.entity,
        id: contentSpec.id,
        body: contentSpec.body,
        mimeType: contentSpec.mimeType,
        maxBytes: contentSpec.maxBytes
      });
      payload[contentSpec.field] = ref;
      await onProgress?.();
    }
    const item: WorkspaceItem = {
      pk,
      sk: spec.sk,
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      entityType: spec.entityType,
      entityVersion: spec.entityVersion,
      createdAt: spec.createdAt,
      updatedAt: spec.updatedAt,
      ...payload,
      migrationDigest: plan.migrationDigest
    };
    item.semanticHash = semanticItemHash(item);
    assertWorkspaceItemSize(item);
    items.push(item);
    await onProgress?.();
  }
  return items.sort((left, right) => left.sk.localeCompare(right.sk));
}

export async function verifyWorkspaceMigration(
  plan: WorkspaceMigrationPlan,
  backend: WorkspaceMigrationBackend
) {
  const items = (await backend.listMaterializedItems(plan.userId))
    .filter((item) => item.sk !== workspaceSk.meta() && item.sk !== workspaceSk.migrationLease())
    .sort((left, right) => left.sk.localeCompare(right.sk));
  if (items.length !== plan.entityCount) {
    throw new WorkspaceIntegrityError(
      `Workspace ${plan.userId} has ${items.length} materialized entities; expected ${plan.entityCount}.`
    );
  }
  for (const item of items) {
    if (item.migrationDigest !== plan.migrationDigest || item.semanticHash !== semanticItemHash(item)) {
      throw new WorkspaceIntegrityError(`Workspace entity ${item.sk} failed its semantic integrity check.`);
    }
  }
  const digest = sha256Canonical(items.map(semanticItem));
  if (digest !== plan.migrationDigest) {
    throw new WorkspaceIntegrityError(
      `Workspace ${plan.userId} semantic digest does not match its source plan.`
    );
  }
  const meta = await backend.getMeta(plan.userId);
  if (meta?.migrationStatus === "complete") {
    const actualMetaHash = sha256Canonical(migrationMetaFromItem(meta));
    if (actualMetaHash !== plan.metaSemanticHash || meta.metaSemanticHash !== plan.metaSemanticHash) {
      throw new WorkspaceIntegrityError(
        `Workspace ${plan.userId} metadata does not match its source plan.`
      );
    }
  }
  return { entityCount: items.length, migrationDigest: digest };
}

export function createMigrationReceipt(input: Omit<WorkspaceMigrationReceipt, "schemaVersion" | "receiptId" | "generatedAt" | "payloadHash" | "signature" | "signatureAlgorithm"> & {
  generatedAt?: string;
  signingKey?: string;
}) {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const unsigned = {
    schemaVersion: "rulix.workspace-migration-receipt/v1" as const,
    receiptId: randomUUID(),
    mode: input.mode,
    tenantId: input.tenantId,
    destinationTable: input.destinationTable,
    changeTicket: input.changeTicket,
    generatedAt,
    accounts: [...input.accounts].sort((left, right) => left.userId.localeCompare(right.userId))
  };
  const payloadHash = sha256Canonical(unsigned);
  const receipt: WorkspaceMigrationReceipt = { ...unsigned, payloadHash };
  if (input.signingKey) {
    if (Buffer.byteLength(input.signingKey, "utf8") < 32) {
      throw new WorkspaceValidationError("Migration receipt signing key must be at least 32 bytes.");
    }
    receipt.signatureAlgorithm = "hmac-sha256";
    receipt.signature = createHmac("sha256", input.signingKey)
      .update(stableCanonicalJson({ ...receipt, signature: undefined }))
      .digest("base64url");
  }
  return receipt;
}

export function verifyMigrationReceipt(receipt: WorkspaceMigrationReceipt, signingKey: string) {
  if (!receipt.signature || receipt.signatureAlgorithm !== "hmac-sha256") return false;
  if (Buffer.byteLength(signingKey, "utf8") < 32) return false;
  const expectedPayloadHash = sha256Canonical({
    schemaVersion: receipt.schemaVersion,
    receiptId: receipt.receiptId,
    mode: receipt.mode,
    tenantId: receipt.tenantId,
    destinationTable: receipt.destinationTable,
    changeTicket: receipt.changeTicket,
    generatedAt: receipt.generatedAt,
    accounts: receipt.accounts
  });
  if (expectedPayloadHash !== receipt.payloadHash) return false;
  const expected = createHmac("sha256", signingKey)
    .update(stableCanonicalJson({ ...receipt, signature: undefined }))
    .digest("base64url");
  const supplied = Buffer.from(receipt.signature, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  return supplied.byteLength === expectedBytes.byteLength && timingSafeEqual(supplied, expectedBytes);
}

export class DynamoLegacyAccountSource implements LegacyAccountSource {
  constructor(
    private readonly tableName: string,
    private readonly tenantId: string,
    private readonly doc: DynamoDBDocumentClient
  ) {}

  async get(userId: string) {
    const pk = legacyAccountPk(this.tenantId, userId);
    const response = await this.doc.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk },
      ConsistentRead: true
    }));
    return response.Item ? legacyRecord(response.Item, this.tenantId) : undefined;
  }

  async list(cursor?: Record<string, unknown>, limit = 25): Promise<LegacyAccountPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new WorkspaceValidationError("Legacy scan page limit must be from 1 through 100.");
    }
    const response = await this.doc.send(new ScanCommand({
      TableName: this.tableName,
      ExclusiveStartKey: cursor,
      Limit: limit,
      ConsistentRead: true,
      FilterExpression: "begins_with(#pk, :accountPrefix)",
      ProjectionExpression: "pk, tenantId, userId, #state",
      ExpressionAttributeNames: { "#pk": "pk", "#state": "state" },
      ExpressionAttributeValues: { ":accountPrefix": legacyAccountPrefix(this.tenantId) }
    }));
    return {
      // Keep the client-side boundary too: a mock, local emulator, or future
      // Scan change must never allow auth/index rows or another tenant into the
      // migration planner (nor let those unrelated shapes abort the page).
      accounts: (response.Items ?? [])
        .filter((item) => typeof item.pk === "string" && item.pk.startsWith(legacyAccountPrefix(this.tenantId)))
        .map((item) => legacyRecord(item, this.tenantId)),
      nextCursor: response.LastEvaluatedKey
    };
  }
}

function legacyRecord(item: Record<string, unknown>, tenantId: string): LegacyAccountRecord {
  const prefix = legacyAccountPrefix(tenantId);
  const rawUserId = typeof item.pk === "string" && item.pk.startsWith(prefix)
    ? item.pk.slice(prefix.length)
    : undefined;
  if (!rawUserId || !item.state || typeof item.state !== "object") {
    throw new WorkspaceValidationError("Legacy account item is missing userId or state.");
  }
  if (item.userId !== undefined && item.userId !== rawUserId) {
    throw new WorkspaceValidationError("Legacy account item userId does not match its partition key.");
  }
  if (item.tenantId !== undefined && item.tenantId !== tenantId) {
    throw new WorkspaceValidationError("Legacy account item belongs to another tenant.");
  }
  return { userId: rawUserId, state: structuredClone(item.state as AccountReviewState) };
}

function legacyAccountPrefix(tenantId: string) {
  return `TENANT#${tenantId}#USER#`;
}

function legacyAccountPk(tenantId: string, userId: string) {
  return `${legacyAccountPrefix(tenantId)}${userId}`;
}

export class DynamoWorkspaceMigrationBackend implements WorkspaceMigrationBackend {
  constructor(
    readonly destinationTable: string,
    private readonly tenantId: string,
    private readonly doc: DynamoDBDocumentClient
  ) {}

  async acquireLease(plan: WorkspaceMigrationPlan, owner: string, nowMs: number, leaseMs: number) {
    const now = new Date(nowMs).toISOString();
    const leaseUntil = new Date(nowMs + leaseMs).toISOString();
    const item: WorkspaceItem = {
      pk: workspacePk(this.tenantId, plan.userId),
      sk: workspaceSk.migrationLease(),
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      entityType: "MIGRATION_LEASE",
      entityVersion: 1,
      createdAt: now,
      updatedAt: now,
      leaseOwner: owner,
      leaseUntil,
      sourceDigest: plan.sourceDigest,
      migrationDigest: plan.migrationDigest
    };
    assertWorkspaceItemSize(item, 8 * 1024);
    try {
      await this.doc.send(new PutCommand({
        TableName: this.destinationTable,
        Item: item,
        ConditionExpression:
          "attribute_not_exists(#pk) OR #leaseUntil < :now OR (#leaseOwner = :owner AND #migrationDigest = :digest)",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#leaseUntil": "leaseUntil",
          "#leaseOwner": "leaseOwner",
          "#migrationDigest": "migrationDigest"
        },
        ExpressionAttributeValues: { ":now": now, ":owner": owner, ":digest": plan.migrationDigest }
      }));
    } catch (error) {
      if (isConditionalFailure(error)) throw new WorkspaceConflictError("Another workspace migration owns the lease.");
      throw error;
    }
  }

  async getMeta(userId: string) {
    const response = await this.doc.send(new GetCommand({
      TableName: this.destinationTable,
      Key: { pk: workspacePk(this.tenantId, userId), sk: workspaceSk.meta() },
      ConsistentRead: true
    }));
    return response.Item as WorkspaceMetaItem | undefined;
  }

  async writeBatch(plan: WorkspaceMigrationPlan, items: WorkspaceItem[]) {
    const itemPuts: NonNullable<TransactWriteCommandInput["TransactItems"]> = items.map((item) => ({
      Put: {
        TableName: this.destinationTable,
        Item: item,
        ConditionExpression: "attribute_not_exists(#pk) OR #migrationDigest = :migrationDigest",
        ExpressionAttributeNames: { "#pk": "pk", "#migrationDigest": "migrationDigest" },
        ExpressionAttributeValues: { ":migrationDigest": plan.migrationDigest }
      }
    }));
    const contentBearing = items.some((item) => containsWorkspaceContentRef(item));
    const transactItems = contentBearing
      ? [workspaceContentGcWriteGuard(this.destinationTable, this.tenantId), ...itemPuts]
      : itemPuts;
    try {
      await this.doc.send(new TransactWriteCommand({
        TransactItems: transactItems,
        ClientRequestToken: sha256Canonical({
          tenantId: plan.tenantId,
          userId: plan.userId,
          migrationDigest: plan.migrationDigest,
          keys: items.map((item) => item.sk)
        }).slice(0, 36)
      }));
    } catch (error) {
      if (contentBearing && (
        firstTransactionConditionFailed(error) ||
        (isConditionalFailure(error) && await this.contentGcLeaseBlocksWrites())
      )) {
        throw new WorkspaceContentGcActiveError();
      }
      if (isConditionalFailure(error)) {
        throw new WorkspaceConflictError("Migration collided with different normalized workspace data.");
      }
      throw error;
    }
  }

  private async contentGcLeaseBlocksWrites() {
    const response = await this.doc.send(new GetCommand({
      TableName: this.destinationTable,
      Key: { pk: workspaceContentGcLeasePk(this.tenantId), sk: workspaceSk.contentGcLease() },
      ConsistentRead: true
    }));
    const drainUntilMs = response.Item?.drainUntilMs;
    if (response.Item && typeof drainUntilMs !== "number") {
      throw new WorkspaceIntegrityError("Workspace content GC lease is malformed; migration writes are fenced.");
    }
    return typeof drainUntilMs === "number" &&
      drainUntilMs > Date.now() - WORKSPACE_CONTENT_GC_CLOCK_SKEW_MS;
  }

  async listMaterializedItems(userId: string) {
    const pk = workspacePk(this.tenantId, userId);
    const items: WorkspaceItem[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const response = await this.doc.send(new QueryCommand({
        TableName: this.destinationTable,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: { ":pk": pk },
        ExclusiveStartKey: cursor,
        ConsistentRead: true,
        Limit: 100
      }));
      items.push(...((response.Items ?? []) as WorkspaceItem[]));
      cursor = response.LastEvaluatedKey;
    } while (cursor);
    return items;
  }

  async complete(plan: WorkspaceMigrationPlan, owner: string, now: string) {
    const pk = workspacePk(this.tenantId, plan.userId);
    const meta: WorkspaceMetaItem = {
      pk,
      sk: workspaceSk.meta(),
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      entityType: "META",
      entityVersion: 1,
      migrationStatus: "complete",
      sourceDigest: plan.sourceDigest,
      migrationDigest: plan.migrationDigest,
      entityCount: plan.entityCount,
      builderSessionCount: plan.entities.filter((entity) => entity.entityType === "BS").length,
      ...structuredClone(plan.metaPayload),
      metaSemanticHash: plan.metaSemanticHash,
      migratedAt: now,
      createdAt: now,
      updatedAt: now
    };
    assertWorkspaceItemSize(meta, 32 * 1024);
    await this.doc.send(new TransactWriteCommand({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: this.destinationTable,
            Key: { pk, sk: workspaceSk.migrationLease() },
            ConditionExpression: "#leaseOwner = :owner AND #migrationDigest = :digest",
            ExpressionAttributeNames: { "#leaseOwner": "leaseOwner", "#migrationDigest": "migrationDigest" },
            ExpressionAttributeValues: { ":owner": owner, ":digest": plan.migrationDigest }
          }
        },
        {
          Put: {
            TableName: this.destinationTable,
            Item: meta,
            ConditionExpression: "attribute_not_exists(#pk) OR #migrationDigest = :digest",
            ExpressionAttributeNames: { "#pk": "pk", "#migrationDigest": "migrationDigest" },
            ExpressionAttributeValues: { ":digest": plan.migrationDigest }
          }
        },
        {
          Delete: {
            TableName: this.destinationTable,
            Key: { pk, sk: workspaceSk.migrationLease() }
          }
        }
      ]
    }));
  }

  async releaseLease(plan: WorkspaceMigrationPlan, owner: string) {
    try {
      await this.doc.send(new DeleteCommand({
        TableName: this.destinationTable,
        Key: {
          pk: workspacePk(this.tenantId, plan.userId),
          sk: workspaceSk.migrationLease()
        },
        ConditionExpression: "#leaseOwner = :owner",
        ExpressionAttributeNames: { "#leaseOwner": "leaseOwner" },
        ExpressionAttributeValues: { ":owner": owner }
      }));
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
  }
}

function firstTransactionConditionFailed(error: unknown) {
  if (!error || typeof error !== "object" || !("CancellationReasons" in error)) return false;
  const reasons = (error as { CancellationReasons?: unknown }).CancellationReasons;
  if (!Array.isArray(reasons)) return false;
  const first = reasons[0];
  return Boolean(first && typeof first === "object" &&
    "Code" in first && (first as { Code?: unknown }).Code === "ConditionalCheckFailed");
}

function buildMigrationSpecs(
  tenantId: string,
  userId: string,
  source: AccountReviewState
): WorkspaceMigrationEntitySpec[] {
  const now = "1970-01-01T00:00:00.000Z";
  const pk = workspacePk(tenantId, userId);
  const specs: WorkspaceMigrationEntitySpec[] = [];
  const memos = Array.isArray(source.memos) ? source.memos : [];
  const revisionsByMemo = source.memoRevisions ?? {};

  for (const rawMemo of memos) {
    const memo = validateMemo(rawMemo);
    const createdAt = validTimestamp(memo.createdAt ?? memo.updatedAt, "memo createdAt");
    const updatedAt = validTimestamp(memo.updatedAt, "memo updatedAt");
    const { memoText, ...review } = memo;
    const revision = positiveVersion(memo.version ?? memo.revision ?? 1);
    const archived = Boolean(memo.archivedAt || memo.status === "archived");
    specs.push(spec({
      sk: workspaceSk.review(memo.id),
      entityType: "R",
      entityVersion: revision,
      createdAt,
      updatedAt,
      payload: {
        review,
        currentRevision: positiveVersion(memo.revision ?? revision),
        gsi1pk: `${pk}#REVIEWS`,
        gsi1sk: `R#${updatedAt}#${memo.id}`,
        gsi2pk: `${pk}#REVIEWS#${archived ? "ARCHIVED" : "ACTIVE"}`,
        gsi2sk: `R#${updatedAt}#${memo.id}`
      },
      contents: [contentSpec("contentRef", "memo", `${memo.id}/current`, memoText, WORKSPACE_MEMO_MAX_BYTES)]
    }));

    const existingRevisions = revisionsByMemo[memo.id] ?? [];
    const revisions: MemoRevision[] = existingRevisions.length > 0
      ? existingRevisions
      : [{
          id: `${memo.id}-r${memo.revision ?? 1}`,
          memoId: memo.id,
          revision: memo.revision ?? 1,
          contentHash: sha256Canonical(memoText),
          memoText,
          title: memo.title,
          itemFamily: memo.itemFamily,
          manufacturer: memo.manufacturer,
          intendedUse: memo.intendedUse,
          dataClass: memo.dataClass ?? "proprietary",
          sourcePath: memo.sourcePath,
          createdAt,
          createdBy: memo.createdBy ?? userId,
          reason: "migration"
        }];
    for (const rawRevision of revisions) {
      const { memoText: revisionText, ...revisionRecord } = rawRevision;
      if (rawRevision.memoId !== memo.id) {
        throw new WorkspaceValidationError(`Revision ${rawRevision.id} belongs to another memo.`);
      }
      specs.push(spec({
        sk: workspaceSk.revision(memo.id, positiveVersion(rawRevision.revision)),
        entityType: "RV",
        entityVersion: positiveVersion(rawRevision.revision),
        createdAt: validTimestamp(rawRevision.createdAt, "revision createdAt"),
        updatedAt: validTimestamp(rawRevision.createdAt, "revision createdAt"),
        payload: { revision: revisionRecord },
        contents: [contentSpec(
          "contentRef", "memo-revision", `${memo.id}/${rawRevision.revision}`,
          revisionText, WORKSPACE_MEMO_MAX_BYTES
        )]
      }));
    }
  }

  for (const [memoId, result] of Object.entries(source.analysisResults ?? {})) {
    const analysisId = result.id ?? sha256Canonical(result).slice(0, 24);
    const generatedAt = validTimestamp(result.generatedAt, "analysis generatedAt");
    const analysisContent = stableCanonicalJson(result);
    const contents = [contentSpec(
      "analysisRef", "analysis", `${memoId}/${analysisId}`, analysisContent,
      WORKSPACE_ANALYSIS_MAX_BYTES, "application/json"
    )];
    const summary = analysisSummary(result);
    specs.push(spec({
      sk: workspaceSk.analysisHistory(memoId, analysisId),
      entityType: "AH",
      entityVersion: 1,
      createdAt: generatedAt,
      updatedAt: generatedAt,
      payload: { memoId, analysisId, summary },
      contents
    }));
    specs.push(spec({
      sk: workspaceSk.analysisCurrent(memoId),
      entityType: "AC",
      entityVersion: 1,
      createdAt: generatedAt,
      updatedAt: generatedAt,
      payload: { memoId, analysisId, summary },
      contents
    }));
  }

  for (const [memoId, decision] of Object.entries(source.decisions ?? {})) {
    const at = validTimestamp(decision.createdAt ?? decision.signedAt ?? now, "decision createdAt");
    specs.push(spec({
      sk: workspaceSk.decision(memoId),
      entityType: "DC",
      entityVersion: 1,
      createdAt: at,
      updatedAt: at,
      payload: { memoId, decision },
      contents: []
    }, 32 * 1024));
  }

  for (const [memoId, messages] of Object.entries(source.chatMessages ?? {})) {
    for (const [index, message] of messages.entries()) {
      specs.push(chatSpec(pk, memoId, message, index));
    }
    if (messages.length > 0) {
      const historyWindow = messages.map((message, index) =>
        aiApprovalChatHistoryEntry({ ...message, sequence: index })).slice(-200);
      specs.push(spec({
        sk: workspaceSk.chatMeta(memoId),
        entityType: "CHAT_META",
        entityVersion: 1,
        createdAt: validTimestamp(messages[0]!.createdAt, "chat message createdAt"),
        updatedAt: validTimestamp(messages[messages.length - 1]!.createdAt, "chat message createdAt"),
        payload: {
          memoId,
          nextSequence: messages.length,
          historySchemaVersion: AI_APPROVAL_CHAT_HISTORY_SCHEMA_VERSION,
          historyWindow,
          historyHash: hashAiApprovalChatHistoryEntries(historyWindow)
        },
        contents: []
      }, 96 * 1024));
    }
  }

  for (const rawEvent of source.auditEvents ?? []) {
    const event = legacyAuditEvent(rawEvent, source, tenantId);
    const canonical = canonicalAuditPayload(userId, event);
    const at = validTimestamp(event.at, "audit event at");
    const { accountId, auditEvent, payloadHash } = canonical;
    specs.push(spec({
      sk: workspaceSk.audit(event.memoId, at, event.id),
      entityType: "AU",
      entityVersion: 1,
      createdAt: at,
      updatedAt: at,
      payload: {
        schemaVersion: "rulix.audit-outbox/v1",
        idempotencyKey: event.id,
        eventId: event.id,
        accountId,
        payloadHash,
        auditEvent
      },
      contents: []
    }, 32 * 1024));
  }

  for (const receipt of source.reviewCreateReceipts ?? []) {
    const createdAt = validTimestamp(receipt.createdAt, "receipt createdAt");
    specs.push(spec({
      sk: workspaceSk.idempotency(receipt.requestId),
      entityType: "IC",
      entityVersion: 1,
      createdAt,
      updatedAt: createdAt,
      payload: {
        receipt,
        expiresAt: Math.floor(Date.parse(createdAt) / 1000) + IDEMPOTENCY_TTL_DAYS * 86_400
      },
      contents: []
    }, 8 * 1024));
  }

  for (const [memoId, comments] of Object.entries(source.comments ?? {})) {
    for (const comment of comments) {
      const at = validTimestamp(comment.createdAt, "comment createdAt");
      specs.push(spec({
        sk: workspaceSk.comment(memoId, comment.id), entityType: "CM", entityVersion: 1,
        createdAt: at, updatedAt: comment.resolvedAt ?? at, payload: { comment }, contents: []
      }, 32 * 1024));
    }
  }
  for (const notification of source.notifications ?? []) {
    const at = validTimestamp(notification.createdAt, "notification createdAt");
    specs.push(spec({
      sk: workspaceSk.notification(notification.id), entityType: "NT", entityVersion: 1,
      createdAt: at, updatedAt: notification.readAt ?? at, payload: { notification }, contents: []
    }, 32 * 1024));
  }

  const builderSessions = source.memoBuilder?.sessions ?? [];
  for (const session of builderSessions) {
    assertBuilderSession(session);
    specs.push(spec({
      sk: workspaceSk.builderSession(session.id), entityType: "BS", entityVersion: 1,
      createdAt: validTimestamp(session.updatedAt, "builder session updatedAt"),
      updatedAt: validTimestamp(session.updatedAt, "builder session updatedAt"),
      payload: { session }, contents: []
    }, 320 * 1024));
    const builder = specs[specs.length - 1]!;
    builder.payload.gsi1pk = `${pk}#BUILDERS`;
    builder.payload.gsi1sk = `BS#${session.updatedAt}#${session.id}`;
  }

  addOutreachSpecs(specs, source, now);
  rejectDuplicateKeys(specs);
  return specs.sort((left, right) => left.sk.localeCompare(right.sk));
}

function chatSpec(pk: string, memoId: string, message: MemoChatMessage, messageSequence: number) {
  assertUtf8Field(message.text, "chat message text", WORKSPACE_CHAT_TEXT_MAX_BYTES);
  const at = validTimestamp(message.createdAt, "chat message createdAt");
  const { proposedMemoText, sequence: _legacySequence, ...messageRecord } = message;
  return spec({
    sk: workspaceSk.chat(memoId, message.id), entityType: "CH", entityVersion: 1,
    createdAt: at,
    updatedAt: at,
    payload: {
      message: messageRecord,
      messageSequence,
      gsi1pk: `${pk}#CHAT#${workspaceSk.review(memoId).slice(2)}`,
      gsi1sk: `CH#${messageSequence.toString().padStart(12, "0")}#${workspaceSk.chat(memoId, message.id)}`
    },
    contents: proposedMemoText === undefined ? [] : [contentSpec(
      "proposedMemoRef", "chat-suggestion", `${memoId}/${message.id}`,
      proposedMemoText, WORKSPACE_MEMO_MAX_BYTES
    )]
  }, 48 * 1024);
}

function addOutreachSpecs(specs: WorkspaceMigrationEntitySpec[], source: AccountReviewState, fallback: string) {
  const add = (kind: string, id: string, value: unknown, updatedAt?: string) => {
    const at = validTimestamp(updatedAt ?? fallback, `${kind} updatedAt`);
    specs.push(spec({
      sk: workspaceSk.outreach(kind, id), entityType: `OUT_${kind}`, entityVersion: 1,
      createdAt: at, updatedAt: at, payload: { value }, contents: []
    }, 64 * 1024));
  };
  for (const lead of source.discoveredLeads ?? []) add("LEAD", lead.leadId, lead, lead.discoveredAt);
  for (const [leadId, draft] of Object.entries(source.outreachDrafts ?? {})) add("DRAFT", leadId, draft, draft.updatedAt);
  for (const run of source.leadSearchRuns ?? []) add("RUN", run.id, run, run.completedAt);
  for (const [leadId, workflow] of Object.entries(source.leadWorkflows ?? {})) add("WORKFLOW", leadId, workflow, workflow.updatedAt);
  for (const job of source.outreachJobs ?? []) add("JOB", job.id, job, job.updatedAt);
}

function spec(input: WorkspaceMigrationEntitySpec, cap?: number) {
  const preview: WorkspaceItem = {
    pk: "preview",
    sk: input.sk,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    entityType: input.entityType,
    entityVersion: input.entityVersion,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    ...input.payload
  };
  assertWorkspaceItemSize(preview, cap);
  for (const content of input.contents) contentBody(content);
  return input;
}

function contentSpec(
  field: string,
  entity: string,
  id: string,
  body: string | Uint8Array,
  maxBytes: number,
  mimeType = "text/plain; charset=utf-8"
): MigrationContentSpec {
  const content = { field, entity, id, body, maxBytes, mimeType };
  const bytes = contentBody(content);
  if (bytes.byteLength > maxBytes) {
    throw new WorkspaceValidationError(`${entity} content exceeds ${maxBytes} bytes.`);
  }
  return content;
}

function contentBody(content: MigrationContentSpec) {
  return typeof content.body === "string" ? Buffer.from(content.body, "utf8") : Buffer.from(content.body);
}

function semanticSpec(entity: WorkspaceMigrationEntitySpec) {
  const payload = structuredClone(entity.payload);
  for (const content of entity.contents) {
    const body = contentBody(content);
    payload[content.field] = {
      sha256: sha256CanonicalBytes(body),
      byteLength: body.byteLength,
      mimeType: content.mimeType,
      contentEncoding: "identity"
    };
  }
  return {
    sk: entity.sk,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    entityType: entity.entityType,
    entityVersion: entity.entityVersion,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    ...payload
  };
}

function semanticItem(item: WorkspaceItem) {
  const copy = structuredClone(item) as Record<string, unknown>;
  delete copy.pk;
  delete copy.migrationDigest;
  delete copy.semanticHash;
  return normalizeContentRefs(copy);
}

function semanticItemHash(item: WorkspaceItem) {
  return sha256Canonical(semanticItem(item));
}

function normalizeContentRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeContentRefs);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (isContentRef(record)) {
      return {
        sha256: record.sha256,
        byteLength: record.byteLength,
        mimeType: record.mimeType,
        contentEncoding: record.contentEncoding
      };
    }
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, normalizeContentRefs(entry)]));
  }
  return value;
}

function isContentRef(value: Record<string, unknown>): value is Record<string, unknown> & WorkspaceContentRef {
  return typeof value.bucket === "string" && typeof value.key === "string" &&
    typeof value.versionId === "string" && typeof value.sha256 === "string" &&
    typeof value.byteLength === "number" && typeof value.mimeType === "string";
}

function sha256CanonicalBytes(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function legacyAuditEvent(event: AuditEvent, source: AccountReviewState, tenantId: string): AuditEvent {
  return {
    ...event,
    actorId: "legacy-import",
    organizationId: source.organization?.id ?? tenantId,
    metadata: {
      actorType: "service",
      source: "system",
      outcome: "succeeded",
      subjectType: "review",
      subjectId: event.memoId,
      originalActor: event.actor,
      legacyUnverified: true,
      ...(event.metadata ? { legacyMetadataHash: sha256Canonical(event.metadata) } : {})
    }
  };
}

function validateMemo(memo: MemoRecord) {
  if (!memo?.id || !memo.title || typeof memo.memoText !== "string") {
    throw new WorkspaceValidationError("Legacy memo is missing id, title, or memoText.");
  }
  assertUtf8Field(memo.memoText, "memo text", WORKSPACE_MEMO_MAX_BYTES);
  return structuredClone(memo);
}

function analysisSummary(result: ReviewResult) {
  return {
    memoId: result.memoId,
    generatedAt: result.generatedAt,
    id: result.id,
    memoRevision: result.memoRevision,
    inputHash: result.inputHash,
    resultHash: result.resultHash,
    corpusId: result.corpusId,
    corpusChecksum: result.corpusChecksum,
    provider: result.provider,
    recommended: result.recommended,
    jurisdiction: result.jurisdiction
  };
}

function assertBuilderSession(session: MemoBuilderSession) {
  const serializedBytes = Buffer.byteLength(stableCanonicalJson(session), "utf8");
  if (serializedBytes > WORKSPACE_BUILDER_SESSION_MAX_BYTES) {
    throw new WorkspaceValidationError(
      `Builder session is ${serializedBytes} bytes; the maximum is ${WORKSPACE_BUILDER_SESSION_MAX_BYTES} bytes.`
    );
  }
  const candidate = session as unknown as { id?: string; messages?: Array<{ content?: string }> };
  if (!candidate.id || !Array.isArray(candidate.messages) || candidate.messages.length > 20) {
    throw new WorkspaceValidationError("Builder session must have an id and at most 20 messages.");
  }
  for (const message of candidate.messages) {
    assertUtf8Field(message.content ?? "", "builder message", WORKSPACE_CHAT_TEXT_MAX_BYTES);
  }
}

function rejectDuplicateKeys(specs: WorkspaceMigrationEntitySpec[]) {
  const seen = new Set<string>();
  for (const entity of specs) {
    if (seen.has(entity.sk)) throw new WorkspaceValidationError(`Duplicate normalized entity key ${entity.sk}.`);
    seen.add(entity.sk);
  }
}

function migrationMetaPayload(source: AccountReviewState) {
  return {
    ...(source.organization ? { organization: structuredClone(source.organization) } : {}),
    ...(source.policy ? { policy: structuredClone(source.policy) } : {}),
    ...(source.preferences ? { preferences: structuredClone(source.preferences) } : {}),
    ...(source.selectedMemoId ? { selectedMemoId: source.selectedMemoId } : {}),
    ...(source.memoBuilder?.activeSessionId
      ? { activeMemoBuilderSessionId: source.memoBuilder.activeSessionId }
      : {})
  };
}

function migrationMetaFromItem(item: WorkspaceMetaItem) {
  return {
    ...(item.organization ? { organization: item.organization } : {}),
    ...(item.policy ? { policy: item.policy } : {}),
    ...(item.preferences ? { preferences: item.preferences } : {}),
    ...(item.selectedMemoId ? { selectedMemoId: item.selectedMemoId } : {}),
    ...(item.activeMemoBuilderSessionId
      ? { activeMemoBuilderSessionId: item.activeMemoBuilderSessionId }
      : {})
  };
}

function positiveVersion(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WorkspaceValidationError("Entity version must be a positive safe integer.");
  }
  return value;
}

function validTimestamp(value: string, label: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new WorkspaceValidationError(`${label} is invalid.`);
  return new Date(time).toISOString();
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function isConditionalFailure(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  if (record.name === "ConditionalCheckFailedException") return true;
  if (record.name !== "TransactionCanceledException" || !Array.isArray(record.CancellationReasons)) return false;
  return record.CancellationReasons.some(
    (reason) => reason && typeof reason === "object" && (reason as Record<string, unknown>).Code === "ConditionalCheckFailed"
  );
}
