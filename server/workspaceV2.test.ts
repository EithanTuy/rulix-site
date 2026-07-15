// @vitest-environment node

import { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  InMemoryWorkspaceContentStore,
  NormalizedWorkspaceRepository,
  S3WorkspaceContentStore,
  WORKSPACE_ITEM_MAX_BYTES,
  WorkspaceCursorCodec,
  WorkspaceIntegrityError,
  WorkspaceValidationError,
  assertWorkspaceItemSize,
  sha256Canonical,
  workspacePk,
  workspaceSk,
  type WorkspaceContentRef,
  type WorkspaceItem
} from "./workspaceV2";

const cursorKeys = {
  activeKeyId: "2026-07",
  keys: {
    "2026-06": "previous-cursor-key-material-is-at-least-32-bytes",
    "2026-07": "current-cursor-key-material-is-at-least-32-bytes!"
  }
};

describe("workspace v2 entity invariants", () => {
  it("encodes delimiter-like IDs into non-colliding tenant-scoped keys", () => {
    const pk = workspacePk("tenant#other", "user#admin");
    expect(pk).toBe("TENANT#tenant%23other#USER#user%23admin");
    expect(workspaceSk.review("memo#decision")).toBe("R#memo%23decision");
    expect(workspaceSk.revision("memo#decision", 12)).toBe(
      "RV#memo%23decision#000000000012"
    );
  });

  it("fails closed before DynamoDB's 400 KiB item limit", () => {
    const base: WorkspaceItem = {
      pk: workspacePk("tenant", "user"),
      sk: workspaceSk.review("memo"),
      schemaVersion: 2,
      entityType: "R",
      entityVersion: 1,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    expect(assertWorkspaceItemSize({ ...base, summary: "x".repeat(1024) })).toBeLessThan(
      WORKSPACE_ITEM_MAX_BYTES
    );
    expect(() => assertWorkspaceItemSize({ ...base, summary: "x".repeat(WORKSPACE_ITEM_MAX_BYTES) }))
      .toThrow(WorkspaceValidationError);
  });
});

describe("workspace cursor security", () => {
  it("supports key rotation and rejects tampering, expiry, and identity reuse", () => {
    let now = 1_000_000;
    const current = new WorkspaceCursorCodec(cursorKeys, () => now);
    const pk = workspacePk("tenant", "user");
    const expected = { pk, prefix: "R#", queryHash: "query" };
    const token = current.encode({ ...expected, lastEvaluatedKey: { pk, sk: "R#050" } }, 1000);
    expect(current.decode(token, expected).lastEvaluatedKey).toEqual({ pk, sk: "R#050" });
    expect(() => current.decode(`${token.slice(0, -1)}A`, expected)).toThrow(WorkspaceValidationError);
    expect(() => current.decode(token, { ...expected, pk: workspacePk("tenant", "other") }))
      .toThrow(WorkspaceValidationError);
    now += 1001;
    expect(() => current.decode(token, expected)).toThrow(WorkspaceValidationError);

    const previous = new WorkspaceCursorCodec({
      activeKeyId: "2026-06",
      keys: cursorKeys.keys
    }, () => 2_000_000);
    const oldToken = previous.encode({ ...expected, lastEvaluatedKey: { pk, sk: "R#051" } });
    const rotated = new WorkspaceCursorCodec(cursorKeys, () => 2_000_000);
    expect(rotated.decode(oldToken, expected).lastEvaluatedKey).toEqual({ pk, sk: "R#051" });
  });
});

describe("workspace content integrity", () => {
  it("binds local objects to tenant/user/entity scope", async () => {
    const content = new InMemoryWorkspaceContentStore();
    const ref = await content.putImmutable({
      tenantId: "tenant",
      userId: "user",
      entity: "memo",
      id: "memo-1/r1",
      body: "controlled memo",
      mimeType: "text/plain; charset=utf-8",
      maxBytes: 1024
    });
    expect(Buffer.from(await content.get(ref, 1024, {
      tenantId: "tenant", userId: "user", entity: "memo"
    })).toString()).toBe("controlled memo");
    await expect(content.get(ref, 1024, {
      tenantId: "tenant", userId: "other", entity: "memo"
    })).rejects.toBeInstanceOf(WorkspaceIntegrityError);
    await expect(content.putImmutable({
      tenantId: "tenant", userId: "user", entity: "memo", id: "bad",
      body: "x", mimeType: "text/plain\r\nx-injected: yes", maxBytes: 1024
    })).rejects.toBeInstanceOf(WorkspaceValidationError);
    await expect(content.get({ ...ref, versionId: "v\n2" }, 1024, {
      tenantId: "tenant", userId: "user", entity: "memo"
    })).rejects.toBeInstanceOf(WorkspaceIntegrityError);
    await expect(content.get({ ...ref, key: "x".repeat(1025) }, 1024, {
      tenantId: "tenant", userId: "user", entity: "memo"
    })).rejects.toBeInstanceOf(WorkspaceIntegrityError);
  });

  it("pins every S3 read to the committed VersionId and rejects bucket/scope substitution", async () => {
    const bodyByVersion = new Map([
      ["v1", Buffer.from("committed")],
      ["v2", Buffer.from("attacker replacement")]
    ]);
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const fakeClient = {
      async send(command: unknown) {
        const typed = command as { input: Record<string, unknown> };
        calls.push({ name: (command as { constructor: { name: string } }).constructor.name, input: typed.input });
        if (command instanceof PutObjectCommand) return { VersionId: "v1" };
        if (command instanceof GetObjectCommand) {
          const version = String(typed.input.VersionId ?? "v2");
          return { VersionId: version, Body: Readable.from(bodyByVersion.get(version) ?? Buffer.alloc(0)) };
        }
        throw new Error("unexpected command");
      }
    } as unknown as S3Client;
    const content = new S3WorkspaceContentStore("workspace-bucket", "kms-key", { client: fakeClient });
    const ref = await content.putImmutable({
      tenantId: "tenant",
      userId: "user",
      entity: "memo",
      id: "memo-1/r1",
      body: "committed",
      mimeType: "text/plain",
      maxBytes: 1024
    });
    expect(ref.versionId).toBe("v1");
    const result = await content.get(ref, 1024, { tenantId: "tenant", userId: "user", entity: "memo" });
    expect(Buffer.from(result).toString()).toBe("committed");
    expect(calls[calls.length - 1]?.input.VersionId).toBe("v1");

    await expect(content.get({ ...ref, bucket: "other-readable-bucket" }, 1024, {
      tenantId: "tenant", userId: "user", entity: "memo"
    })).rejects.toBeInstanceOf(WorkspaceIntegrityError);
    await expect(content.get(ref, 1024, {
      tenantId: "tenant", userId: "other", entity: "memo"
    })).rejects.toBeInstanceOf(WorkspaceIntegrityError);
  });

  it("verifies an idempotently pre-existing object before pinning its current version", async () => {
    const existing = Buffer.from("same body");
    const fakeClient = {
      async send(command: unknown) {
        if (command instanceof PutObjectCommand) {
          throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
        }
        return { VersionId: "existing-v7", Body: Readable.from(existing) };
      }
    } as unknown as S3Client;
    const content = new S3WorkspaceContentStore("workspace-bucket", "kms-key", { client: fakeClient });
    const ref = await content.putImmutable({
      tenantId: "tenant", userId: "user", entity: "memo", id: "memo-1/r1",
      body: existing, mimeType: "text/plain", maxBytes: 1024
    });
    expect(ref.versionId).toBe("existing-v7");
  });

  it("recovers a concurrent S3 409 by verifying and pinning the winning version", async () => {
    const existing = Buffer.from("same concurrent body");
    let getCalls = 0;
    const fakeClient = {
      async send(command: unknown) {
        if (command instanceof PutObjectCommand) {
          throw { name: "ConditionalRequestConflict", $metadata: { httpStatusCode: 409 } };
        }
        if (command instanceof GetObjectCommand) {
          getCalls += 1;
          return { VersionId: "winner-v9", Body: Readable.from(existing) };
        }
        throw new Error("unexpected command");
      }
    } as unknown as S3Client;
    const content = new S3WorkspaceContentStore("workspace-bucket", "kms-key", { client: fakeClient });
    const ref = await content.putImmutable({
      tenantId: "tenant", userId: "user", entity: "memo", id: "memo-1/r1",
      body: existing, mimeType: "text/plain", maxBytes: 1024
    });
    expect(ref.versionId).toBe("winner-v9");
    expect(getCalls).toBe(1);
  });

});

describe("workspace pagination and outbox", () => {
  it("pages more than 250 records without gaps and rejects a cross-query cursor", async () => {
    const pk = workspacePk("tenant", "user");
    const rows = Array.from({ length: 275 }, (_, index): WorkspaceItem => ({
      pk,
      sk: `R#${String(index).padStart(4, "0")}`,
      schemaVersion: 2,
      entityType: "R",
      entityVersion: 1,
      createdAt: new Date(index).toISOString(),
      updatedAt: new Date(index).toISOString()
    }));
    const doc = {
      async send(command: unknown) {
        if (!(command instanceof QueryCommand)) throw new Error("unexpected command");
        const input = command.input;
        const startSk = input.ExclusiveStartKey?.sk as string | undefined;
        const start = startSk ? rows.findIndex((row) => row.sk === startSk) + 1 : 0;
        const items = rows.slice(start, start + Number(input.Limit));
        const last = start + items.length < rows.length ? items[items.length - 1] : undefined;
        return { Items: items, LastEvaluatedKey: last ? { pk, sk: last.sk } : undefined };
      }
    } as unknown as DynamoDBDocumentClient;
    const cursors = new WorkspaceCursorCodec(cursorKeys, () => 1_000_000);
    const repository = new NormalizedWorkspaceRepository("workspace", "tenant", doc, cursors);
    const collected: WorkspaceItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await repository.queryPage<WorkspaceItem>({
        userId: "user", prefix: "R#", limit: 100, maxLimit: 100, cursor
      });
      collected.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(collected.map((item) => item.sk)).toEqual(rows.map((item) => item.sk));

    const first = await repository.queryPage<WorkspaceItem>({
      userId: "user", prefix: "R#", limit: 50, maxLimit: 100
    });
    await expect(repository.queryPage({
      userId: "user", prefix: "CH#", limit: 50, maxLimit: 100, cursor: first.nextCursor
    })).rejects.toBeInstanceOf(WorkspaceValidationError);
  });

  it("emits the immutable audit writer contract with a canonical payload hash", () => {
    const doc = { send: async () => ({}) } as unknown as DynamoDBDocumentClient;
    const repository = new NormalizedWorkspaceRepository(
      "workspace", "tenant", doc, new WorkspaceCursorCodec(cursorKeys)
    );
    const event = {
      id: "event-1",
      memoId: "memo-1",
      at: "2026-07-14T12:00:00.000Z",
      actor: "Reviewer",
      actorId: "user-1",
      organizationId: "org-1",
      action: "review.decision.accepted",
      detail: "Accepted",
      severity: "info" as const,
      metadata: {
        actorType: "user",
        source: "authenticated-api",
        outcome: "succeeded",
        subjectType: "review",
        subjectId: "memo-1"
      }
    };
    const item = repository.outboxItem("user", event);
    expect(item).toMatchObject({
      entityType: "AU",
      schemaVersion: "rulix.audit-outbox/v1",
      eventId: "event-1",
      idempotencyKey: "event-1",
      accountId: "user",
      auditEvent: event
    });
    expect(item.payloadHash).toBe(sha256Canonical({ accountId: "user", auditEvent: event }));
    expect(() => repository.outboxItem("user", { ...event, actorId: undefined }))
      .toThrow(WorkspaceValidationError);
  });
});
