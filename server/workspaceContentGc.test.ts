// @vitest-environment node

import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  NormalizedWorkspaceRepository,
  WORKSPACE_CONTENT_GC_CLOCK_SKEW_MS,
  WorkspaceContentGcActiveError,
  WorkspaceCursorCodec,
  workspaceContentGcLeasePk,
  workspacePk,
  workspaceSk,
  type WorkspaceContentRef,
  type WorkspaceItem
} from "./workspaceV2";
import {
  DynamoWorkspaceContentGcLeaseStore,
  WorkspaceContentGcLeaseLostError,
  WorkspaceContentGcLeaseSession,
  type WorkspaceContentGcLease,
  type WorkspaceContentGcLeaseConfig
} from "./workspaceContentGc";

const config: WorkspaceContentGcLeaseConfig = {
  leaseMs: 100_000,
  writerDrainMs: 120_000,
  deleteTimeoutMs: 10_000,
  staleRequestFenceMs: 20_000
};

class MemoryLeaseDocument {
  lease?: WorkspaceContentGcLease;
  createdAt?: string;
  getCalls = 0;

  async send(command: unknown) {
    if (command instanceof GetCommand) {
      this.getCalls += 1;
      return { Item: this.lease ? { ...this.lease } : undefined };
    }
    if (!(command instanceof UpdateCommand)) throw new Error("unexpected command");
    const input = command.input;
    const values = input.ExpressionAttributeValues as Record<string, unknown>;
    if (input.UpdateExpression?.includes("ADD #fence")) {
      const safeNow = Number(values[":safeNow"]);
      if (this.lease && this.lease.drainUntilMs > safeNow) throw conditionalFailure();
      this.lease = {
        owner: String(values[":owner"]),
        fence: (this.lease?.fence ?? 0) + 1,
        status: "active",
        leaseUntilMs: Number(values[":leaseUntilMs"]),
        drainUntilMs: Number(values[":drainUntilMs"])
      };
      this.createdAt ??= String(values[":at"]);
      return { Attributes: { ...this.lease } };
    }
    if (values[":cooldown"] === "cooldown") {
      this.requireOwner(values);
      this.lease = {
        ...this.lease!,
        status: "cooldown",
        leaseUntilMs: Number(values[":now"]),
        drainUntilMs: Number(values[":drainUntilMs"])
      };
      return { Attributes: { ...this.lease } };
    }
    this.requireOwner(values);
    if (this.lease!.leaseUntilMs <= Number(values[":safeNow"])) throw conditionalFailure();
    this.lease = {
      ...this.lease!,
      leaseUntilMs: Number(values[":leaseUntilMs"]),
      drainUntilMs: Number(values[":drainUntilMs"])
    };
    return { Attributes: { ...this.lease } };
  }

  private requireOwner(values: Record<string, unknown>) {
    if (
      !this.lease || this.lease.status !== "active" ||
      this.lease.owner !== values[":owner"] || this.lease.fence !== values[":fence"]
    ) throw conditionalFailure();
  }
}

function conditionalFailure() {
  return Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
}

function leaseStore(document: MemoryLeaseDocument) {
  return new DynamoWorkspaceContentGcLeaseStore(
    "workspace",
    "tenant",
    document as unknown as DynamoDBDocumentClient
  );
}

function contentRef(versionId: string): WorkspaceContentRef {
  return {
    bucket: "workspace-bucket",
    key: "tenant/tenant/user/user/memo/old/sha256",
    versionId,
    sha256: "a".repeat(64),
    byteLength: 3,
    storedByteLength: 3,
    mimeType: "text/plain",
    contentEncoding: "identity"
  };
}

describe("workspace content GC lease fencing", () => {
  it("waits the maximum writer window and renews while draining", async () => {
    const document = new MemoryLeaseDocument();
    let now = 1_000_000;
    const sleeps: number[] = [];
    const session = new WorkspaceContentGcLeaseSession(
      leaseStore(document),
      config,
      () => now,
      async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      }
    );
    await session.acquire("owner-a");
    const initialLeaseUntil = session.snapshot().leaseUntilMs;
    await session.drainWriters();
    expect(sleeps.reduce((sum, value) => sum + value, 0)).toBeGreaterThanOrEqual(config.writerDrainMs);
    expect(session.snapshot().leaseUntilMs).toBeGreaterThan(initialLeaseUntil);
  });

  it("fences an expired owner after takeover and never invokes its delete", async () => {
    const document = new MemoryLeaseDocument();
    let now = 2_000_000;
    const stale = new WorkspaceContentGcLeaseSession(leaseStore(document), config, () => now);
    const first = await stale.acquire("owner-a");
    now = first.drainUntilMs + WORKSPACE_CONTENT_GC_CLOCK_SKEW_MS;

    const current = new WorkspaceContentGcLeaseSession(leaseStore(document), config, () => now);
    const second = await current.acquire("owner-b");
    expect(second.fence).toBe(first.fence + 1);

    let deleted = false;
    await expect(stale.deleteBatch(async () => { deleted = true; }))
      .rejects.toBeInstanceOf(WorkspaceContentGcLeaseLostError);
    expect(deleted).toBe(false);
  });

  it("strongly rechecks owner and fence immediately around every delete batch", async () => {
    const document = new MemoryLeaseDocument();
    let now = 2_500_000;
    const session = new WorkspaceContentGcLeaseSession(leaseStore(document), config, () => now);
    await session.acquire("owner-a");
    let invoked = 0;
    await session.deleteBatch(async (signal) => {
      expect(signal.aborted).toBe(false);
      invoked += 1;
      now += 1;
    });
    expect(invoked).toBe(1);
    expect(document.getCalls).toBe(2);
  });

  it("releases into a fenced cooldown and recovers automatically", async () => {
    const document = new MemoryLeaseDocument();
    let now = 3_000_000;
    const session = new WorkspaceContentGcLeaseSession(leaseStore(document), config, () => now);
    await session.acquire("owner-a");
    await session.release();
    expect(document.lease?.status).toBe("cooldown");
    expect(document.lease?.drainUntilMs).toBeGreaterThan(now);

    const blocked = new WorkspaceContentGcLeaseSession(leaseStore(document), config, () => now);
    await expect(blocked.acquire("owner-b")).rejects.toThrow("cooling down");
    now = document.lease!.drainUntilMs + WORKSPACE_CONTENT_GC_CLOCK_SKEW_MS;
    await expect(blocked.acquire("owner-b")).resolves.toMatchObject({
      owner: "owner-b",
      fence: 2,
      status: "active"
    });
  });

  it("blocks old-version reuse without committing, then permits a whole-operation retry with a new version", async () => {
    let leaseActive = true;
    const committed: WorkspaceItem[] = [];
    const transactions: Array<Array<Record<string, unknown>>> = [];
    const document = {
      async send(command: unknown) {
        if (!(command instanceof TransactWriteCommand)) throw new Error("unexpected command");
        const items = command.input.TransactItems as Array<Record<string, unknown>>;
        transactions.push(items);
        if (leaseActive) {
          throw {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }]
          };
        }
        for (const transaction of items) {
          const put = transaction.Put as { Item?: WorkspaceItem } | undefined;
          if (put?.Item) committed.push(put.Item);
        }
        return {};
      }
    } as unknown as DynamoDBDocumentClient;
    const repository = new NormalizedWorkspaceRepository(
      "workspace",
      "tenant",
      document,
      new WorkspaceCursorCodec({
        activeKeyId: "v1",
        keys: { v1: "workspace-cursor-key-material-at-least-32-bytes" }
      })
    );
    const item = (ref: WorkspaceContentRef): WorkspaceItem => ({
      pk: workspacePk("tenant", "user"),
      sk: workspaceSk.review("memo"),
      schemaVersion: 2,
      entityType: "R",
      entityVersion: 1,
      contentRef: ref,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    });

    const blocked = await repository
      .transact([{ Put: { TableName: "workspace", Item: item(contentRef("v-old")) } }])
      .catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(WorkspaceContentGcActiveError);
    expect(blocked).toMatchObject({
      status: 503,
      code: "WORKSPACE_CONTENT_GC_ACTIVE",
      retryable: true
    });
    expect(committed).toHaveLength(0);
    expect(transactions[0]?.[0]).toMatchObject({
      ConditionCheck: {
        Key: {
          pk: workspaceContentGcLeasePk("tenant"),
          sk: workspaceSk.contentGcLease()
        }
      }
    });

    // GC deletes v-old while the request is fenced. The caller retries the
    // complete operation, so putImmutable supplies a new live VersionId.
    leaseActive = false;
    await repository.transact([{ Put: { TableName: "workspace", Item: item(contentRef("v-new")) } }]);
    expect(committed).toHaveLength(1);
    expect((committed[0]?.contentRef as WorkspaceContentRef).versionId).toBe("v-new");
  });

  it("does not create a tenant-wide outage for transactions without content pointers", async () => {
    const transactions: Array<Array<Record<string, unknown>>> = [];
    const document = {
      async send(command: unknown) {
        if (!(command instanceof TransactWriteCommand)) throw new Error("unexpected command");
        transactions.push(command.input.TransactItems as Array<Record<string, unknown>>);
        return {};
      }
    } as unknown as DynamoDBDocumentClient;
    const repository = new NormalizedWorkspaceRepository(
      "workspace", "tenant", document,
      new WorkspaceCursorCodec({
        activeKeyId: "v1",
        keys: { v1: "workspace-cursor-key-material-at-least-32-bytes" }
      })
    );
    const item: WorkspaceItem = {
      pk: workspacePk("tenant", "user"),
      sk: workspaceSk.outreach("LEAD", "lead-1"),
      schemaVersion: 2,
      entityType: "OUT_LEAD",
      entityVersion: 1,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    await repository.transact([{ Put: { TableName: "workspace", Item: item } }]);
    expect(transactions[0]).toHaveLength(1);
    expect(transactions[0]?.[0]).toHaveProperty("Put");
  });
});
