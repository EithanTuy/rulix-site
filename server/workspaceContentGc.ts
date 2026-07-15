import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import {
  WORKSPACE_CONTENT_GC_CLOCK_SKEW_MS,
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceConflictError,
  WorkspaceIntegrityError,
  WorkspaceValidationError,
  workspaceContentGcLeasePk,
  workspaceSk
} from "./workspaceV2";

export const DEFAULT_WORKSPACE_GC_LEASE_MS = 180_000;
export const DEFAULT_WORKSPACE_GC_WRITER_DRAIN_MS = 120_000;
export const DEFAULT_WORKSPACE_GC_DELETE_TIMEOUT_MS = 15_000;
export const DEFAULT_WORKSPACE_GC_STALE_REQUEST_FENCE_MS = 30_000;

export interface WorkspaceContentGcLease {
  owner: string;
  fence: number;
  leaseUntilMs: number;
  drainUntilMs: number;
  status: "active" | "cooldown";
}

export interface WorkspaceContentGcLeaseConfig {
  leaseMs: number;
  writerDrainMs: number;
  deleteTimeoutMs: number;
  staleRequestFenceMs: number;
}

export interface WorkspaceContentGcLeaseStore {
  acquire(owner: string, nowMs: number, config: WorkspaceContentGcLeaseConfig): Promise<WorkspaceContentGcLease>;
  renew(lease: WorkspaceContentGcLease, nowMs: number, config: WorkspaceContentGcLeaseConfig): Promise<WorkspaceContentGcLease>;
  read(): Promise<WorkspaceContentGcLease | undefined>;
  release(lease: WorkspaceContentGcLease, nowMs: number, config: WorkspaceContentGcLeaseConfig): Promise<void>;
}

export class WorkspaceContentGcLeaseLostError extends WorkspaceConflictError {
  constructor(message = "Workspace content GC lease ownership was lost.") {
    super(message);
  }
}

export class DynamoWorkspaceContentGcLeaseStore implements WorkspaceContentGcLeaseStore {
  constructor(
    private readonly tableName: string,
    private readonly tenantId: string,
    private readonly doc: DynamoDBDocumentClient
  ) {
    if (!tableName.trim()) throw new WorkspaceValidationError("Workspace table name is required.");
    workspaceContentGcLeasePk(tenantId);
  }

  async acquire(owner: string, nowMs: number, config: WorkspaceContentGcLeaseConfig) {
    validateOwner(owner);
    const leaseUntilMs = nowMs + config.leaseMs + WORKSPACE_CONTENT_GC_CLOCK_SKEW_MS;
    const drainUntilMs = leaseUntilMs + config.staleRequestFenceMs + WORKSPACE_CONTENT_GC_CLOCK_SKEW_MS;
    try {
      const response = await this.doc.send(new UpdateCommand({
        TableName: this.tableName,
        Key: this.key(),
        UpdateExpression:
          "SET #schemaVersion = :schemaVersion, #entityType = :entityType, #owner = :owner, " +
          "#status = :active, #leaseUntilMs = :leaseUntilMs, #drainUntilMs = :drainUntilMs, " +
          "#createdAt = if_not_exists(#createdAt, :at), #updatedAt = :at ADD #fence :one",
        ConditionExpression: "attribute_not_exists(#pk) OR #drainUntilMs <= :safeNow",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#schemaVersion": "schemaVersion",
          "#entityType": "entityType",
          "#owner": "owner",
          "#fence": "fence",
          "#status": "status",
          "#leaseUntilMs": "leaseUntilMs",
          "#drainUntilMs": "drainUntilMs",
          "#createdAt": "createdAt",
          "#updatedAt": "updatedAt"
        },
        ExpressionAttributeValues: {
          ":schemaVersion": WORKSPACE_SCHEMA_VERSION,
          ":entityType": "WORKSPACE_CONTENT_GC_LEASE",
          ":owner": owner,
          ":active": "active",
          ":leaseUntilMs": leaseUntilMs,
          ":drainUntilMs": drainUntilMs,
          ":safeNow": safeNow(nowMs),
          ":at": new Date(nowMs).toISOString(),
          ":one": 1
        },
        ReturnValues: "ALL_NEW"
      }));
      return parseLease(response.Attributes);
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw new WorkspaceConflictError("Workspace content GC is already active or cooling down.");
      }
      throw error;
    }
  }

  async renew(lease: WorkspaceContentGcLease, nowMs: number, config: WorkspaceContentGcLeaseConfig) {
    const leaseUntilMs = nowMs + config.leaseMs + WORKSPACE_CONTENT_GC_CLOCK_SKEW_MS;
    const drainUntilMs = leaseUntilMs + config.staleRequestFenceMs + WORKSPACE_CONTENT_GC_CLOCK_SKEW_MS;
    try {
      const response = await this.doc.send(new UpdateCommand({
        TableName: this.tableName,
        Key: this.key(),
        UpdateExpression:
          "SET #leaseUntilMs = :leaseUntilMs, #drainUntilMs = :drainUntilMs, #updatedAt = :at",
        ConditionExpression:
          "#owner = :owner AND #fence = :fence AND #status = :active AND #leaseUntilMs > :safeNow",
        ExpressionAttributeNames: {
          "#owner": "owner",
          "#fence": "fence",
          "#status": "status",
          "#leaseUntilMs": "leaseUntilMs",
          "#drainUntilMs": "drainUntilMs",
          "#updatedAt": "updatedAt"
        },
        ExpressionAttributeValues: {
          ":owner": lease.owner,
          ":fence": lease.fence,
          ":active": "active",
          ":leaseUntilMs": leaseUntilMs,
          ":drainUntilMs": drainUntilMs,
          ":safeNow": safeNow(nowMs),
          ":at": new Date(nowMs).toISOString()
        },
        ReturnValues: "ALL_NEW"
      }));
      return parseLease(response.Attributes);
    } catch (error) {
      if (isConditionalFailure(error)) throw new WorkspaceContentGcLeaseLostError();
      throw error;
    }
  }

  async read() {
    const response = await this.doc.send(new GetCommand({
      TableName: this.tableName,
      Key: this.key(),
      ConsistentRead: true
    }));
    return response.Item ? parseLease(response.Item) : undefined;
  }

  async release(lease: WorkspaceContentGcLease, nowMs: number, config: WorkspaceContentGcLeaseConfig) {
    // Keep a cooldown record instead of deleting the lock. It fences a delete
    // request that reached S3 immediately before cancellation or process exit.
    const drainUntilMs = nowMs + config.deleteTimeoutMs +
      config.staleRequestFenceMs + WORKSPACE_CONTENT_GC_CLOCK_SKEW_MS;
    try {
      await this.doc.send(new UpdateCommand({
        TableName: this.tableName,
        Key: this.key(),
        UpdateExpression:
          "SET #status = :cooldown, #leaseUntilMs = :now, #drainUntilMs = :drainUntilMs, #updatedAt = :at",
        ConditionExpression: "#owner = :owner AND #fence = :fence AND #status = :active",
        ExpressionAttributeNames: {
          "#owner": "owner",
          "#fence": "fence",
          "#status": "status",
          "#leaseUntilMs": "leaseUntilMs",
          "#drainUntilMs": "drainUntilMs",
          "#updatedAt": "updatedAt"
        },
        ExpressionAttributeValues: {
          ":owner": lease.owner,
          ":fence": lease.fence,
          ":active": "active",
          ":cooldown": "cooldown",
          ":now": nowMs,
          ":drainUntilMs": drainUntilMs,
          ":at": new Date(nowMs).toISOString()
        }
      }));
    } catch (error) {
      if (isConditionalFailure(error)) throw new WorkspaceContentGcLeaseLostError();
      throw error;
    }
  }

  private key() {
    return { pk: workspaceContentGcLeasePk(this.tenantId), sk: workspaceSk.contentGcLease() };
  }
}

export class WorkspaceContentGcLeaseSession {
  private lease?: WorkspaceContentGcLease;
  private nextHeartbeatMs = 0;

  constructor(
    private readonly store: WorkspaceContentGcLeaseStore,
    private readonly config: WorkspaceContentGcLeaseConfig = defaultWorkspaceContentGcLeaseConfig(),
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (milliseconds: number) => Promise<void> = wait
  ) {
    validateConfig(config);
  }

  async acquire(owner: string) {
    if (this.lease) throw new WorkspaceValidationError("Workspace content GC lease is already acquired.");
    this.lease = await this.store.acquire(owner, this.now(), this.config);
    this.scheduleHeartbeat();
    return { ...this.lease };
  }

  async drainWriters(onHeartbeat?: () => Promise<void>) {
    this.requireLease();
    const deadline = this.now() + this.config.writerDrainMs;
    while (this.now() < deadline) {
      await this.heartbeat();
      if (onHeartbeat) await onHeartbeat();
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(remaining, Math.max(10, Math.floor(this.config.leaseMs / 4))));
    }
    await this.heartbeat(true);
  }

  async heartbeat(force = false) {
    const lease = this.requireLease();
    if (!force && this.now() < this.nextHeartbeatMs) return { ...lease };
    this.lease = await this.store.renew(lease, this.now(), this.config);
    this.scheduleHeartbeat();
    return { ...this.lease };
  }

  async assertOwned(minimumRemainingMs = 0) {
    const expected = this.requireLease();
    const actual = await this.store.read();
    const nowMs = this.now();
    if (
      !actual || actual.status !== "active" || actual.owner !== expected.owner ||
      actual.fence !== expected.fence || actual.leaseUntilMs < nowMs + minimumRemainingMs
    ) {
      throw new WorkspaceContentGcLeaseLostError();
    }
    this.lease = actual;
    return { ...actual };
  }

  async deleteBatch(operation: (signal: AbortSignal) => Promise<void>) {
    await this.heartbeat(true);
    await this.assertOwned(this.config.deleteTimeoutMs + WORKSPACE_CONTENT_GC_CLOCK_SKEW_MS);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.deleteTimeoutMs);
    try {
      await operation(controller.signal);
    } finally {
      clearTimeout(timeout);
    }
    await this.assertOwned();
  }

  async release() {
    const lease = this.lease;
    if (!lease) return;
    await this.store.release(lease, this.now(), this.config);
    this.lease = undefined;
    this.nextHeartbeatMs = 0;
  }

  snapshot() {
    const lease = this.requireLease();
    return { ...lease };
  }

  private requireLease() {
    if (!this.lease) throw new WorkspaceContentGcLeaseLostError("Workspace content GC lease is not held.");
    return this.lease;
  }

  private scheduleHeartbeat() {
    this.nextHeartbeatMs = this.now() + Math.max(10, Math.floor(this.config.leaseMs / 3));
  }
}

export function defaultWorkspaceContentGcLeaseConfig(
  overrides: Partial<WorkspaceContentGcLeaseConfig> = {}
): WorkspaceContentGcLeaseConfig {
  const config = {
    leaseMs: DEFAULT_WORKSPACE_GC_LEASE_MS,
    writerDrainMs: DEFAULT_WORKSPACE_GC_WRITER_DRAIN_MS,
    deleteTimeoutMs: DEFAULT_WORKSPACE_GC_DELETE_TIMEOUT_MS,
    staleRequestFenceMs: DEFAULT_WORKSPACE_GC_STALE_REQUEST_FENCE_MS,
    ...overrides
  };
  validateConfig(config);
  return config;
}

function parseLease(value: Record<string, unknown> | undefined): WorkspaceContentGcLease {
  if (
    !value || typeof value.owner !== "string" ||
    !Number.isSafeInteger(value.fence) || Number(value.fence) < 1 ||
    !Number.isSafeInteger(value.leaseUntilMs) || !Number.isSafeInteger(value.drainUntilMs) ||
    (value.status !== "active" && value.status !== "cooldown")
  ) throw new WorkspaceIntegrityError("Workspace content GC lease is malformed.");
  return {
    owner: value.owner,
    fence: Number(value.fence),
    leaseUntilMs: Number(value.leaseUntilMs),
    drainUntilMs: Number(value.drainUntilMs),
    status: value.status
  };
}

function validateConfig(config: WorkspaceContentGcLeaseConfig) {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60 * 1000) {
      throw new WorkspaceValidationError(`${name} must be an integer from 1 through 86400000 milliseconds.`);
    }
  }
  if (config.leaseMs <= config.deleteTimeoutMs + WORKSPACE_CONTENT_GC_CLOCK_SKEW_MS) {
    throw new WorkspaceValidationError("Workspace content GC lease must exceed the delete timeout plus clock-skew allowance.");
  }
}

function validateOwner(owner: string) {
  if (!/^[A-Za-z0-9+=,.@_-]{1,96}$/u.test(owner)) {
    throw new WorkspaceValidationError("Workspace content GC owner must be a 1-96 character safe session identifier.");
  }
}

function safeNow(nowMs: number) {
  return Math.max(0, Math.floor(nowMs - WORKSPACE_CONTENT_GC_CLOCK_SKEW_MS));
}

function isConditionalFailure(error: unknown) {
  return Boolean(error && typeof error === "object" &&
    "name" in error && (error as { name?: unknown }).name === "ConditionalCheckFailedException");
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
