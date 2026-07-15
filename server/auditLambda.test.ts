// @vitest-environment node

import { marshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "../src/types";
import {
  AUDIT_OUTBOX_SCHEMA,
  AuditOutboxValidationError,
  createAuditLambdaHandler,
  parseAuditStreamRecord
} from "./auditLambda";
import { AUDIT_EVENT_SCHEMA, type AuditAppendResult } from "./auditWriter";
import { sha256Canonical } from "./domain/hashes";

const tenantId = "tenant-1";
const accountId = "workspace-user-7";
const workspaceStreamArn =
  "arn:aws:dynamodb:us-east-1:111122223333:table/workspace/stream/2026-07-14T00:00:00.000";
const validAuditEvent: AuditEvent = {
  id: "audit-7",
  memoId: "memo-42",
  at: "2026-07-14T04:05:06.789Z",
  actor: "Jane Reviewer",
  actorId: "user-7",
  organizationId: "org-7",
  action: "Reviewer decision: accept",
  detail: "Accepted after reviewing the current analysis.",
  severity: "info",
  metadata: {
    actorType: "user",
    source: "authenticated-api",
    outcome: "succeeded",
    subjectType: "review",
    subjectId: "memo-42",
    decisionId: "decision-7"
  }
};

const appendResult: AuditAppendResult = {
  eventId: "a".repeat(64),
  eventTime: `event#${"a".repeat(64)}`,
  recordedAt: "2026-07-14T04:05:07.000Z",
  tenantReviewId: "tenant-1/audit",
  payloadHash: "b".repeat(64),
  duplicate: false
};

describe("DynamoDB Streams audit consumer", () => {
  it("validates an authenticated AU image and maps its provenance deterministically", async () => {
    const appendAuditEvent = vi.fn(async (_event: unknown) => appendResult);
    const logger = testLogger();
    const record = streamRecord(outboxItem());
    const consume = createAuditLambdaHandler({
      appendAuditEvent,
      tenantId,
      workspaceStreamArn,
      logger
    });

    await expect(consume(streamEvent(record))).resolves.toEqual({ batchItemFailures: [] });

    expect(appendAuditEvent).toHaveBeenCalledTimes(1);
    const mapped = appendAuditEvent.mock.calls[0][0];
    expect(mapped).toEqual(parseAuditStreamRecord(record, tenantId, workspaceStreamArn));
    expect(mapped).toMatchObject({
      schemaVersion: AUDIT_EVENT_SCHEMA,
      idempotencyKey: validAuditEvent.id,
      reviewId: validAuditEvent.memoId,
      assertedAction: expect.stringMatching(
        /^review\.audit\.reviewer-decision-accept\.[a-f0-9]{12}$/
      ),
      assertedActorId: "user-7",
      assertedActorType: "user",
      assertedSubjectType: "review",
      assertedSubjectId: "memo-42",
      assertedOutcome: "succeeded",
      assertedSource: "api",
      assertedOccurredAt: validAuditEvent.at,
      assertedDetail: validAuditEvent.detail
    });
    expect(mapped).not.toHaveProperty("tenantId");
    expect(mapped).not.toHaveProperty("writerId");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("accepts complete migration integrity metadata without weakening the audit payload contract", async () => {
    const appendAuditEvent = vi.fn(async (_event: unknown) => appendResult);
    const consume = createAuditLambdaHandler({
      appendAuditEvent,
      tenantId,
      workspaceStreamArn,
      logger: testLogger()
    });
    const migrated = {
      ...outboxItem(),
      entityVersion: 1,
      migrationDigest: "c".repeat(64),
      semanticHash: "d".repeat(64)
    };

    await expect(consume(streamEvent(streamRecord(migrated, "migration-1"))))
      .resolves.toEqual({ batchItemFailures: [] });
    expect(appendAuditEvent).toHaveBeenCalledTimes(1);
  });

  it("reports a display-name-only record as poison so bounded retries can send it to the DLQ", async () => {
    const displayOnly = { ...validAuditEvent } as Record<string, unknown>;
    delete displayOnly.actorId;
    const appendAuditEvent = vi.fn(async () => appendResult);
    const logger = testLogger();
    const consume = createAuditLambdaHandler({ appendAuditEvent, tenantId, workspaceStreamArn, logger });

    const response = await consume(streamEvent(streamRecord(outboxItem(displayOnly), "poison-1")));

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "poison-1" }] });
    expect(appendAuditEvent).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"failureKind":"poison"'));
  });

  it("completes valid siblings and reports only invalid or transient records", async () => {
    const appendAuditEvent = vi.fn(async (event: unknown) => {
      if ((event as { idempotencyKey?: string }).idempotencyKey === "audit-transient") {
        throw new Error("DynamoDB unavailable");
      }
      return appendResult;
    });
    const logger = testLogger();
    const consume = createAuditLambdaHandler({ appendAuditEvent, tenantId, workspaceStreamArn, logger });
    const transientEvent: AuditEvent = {
      ...validAuditEvent,
      id: "audit-transient"
    };
    const tampered = { ...outboxItem(), payloadHash: "0".repeat(64) };

    const response = await consume(streamEvent(
      streamRecord(outboxItem(), "good-1"),
      streamRecord(tampered, "poison-2"),
      streamRecord(outboxItem(transientEvent), "transient-3")
    ));

    expect(response).toEqual({
      batchItemFailures: [
        { itemIdentifier: "poison-2" },
        { itemIdentifier: "transient-3" }
      ]
    });
    expect(appendAuditEvent).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"failureKind":"poison"'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"failureKind":"transient"'));
  });

  it.each([
    ["cross-tenant partition", { pk: "TENANT#other#USER#org-7" }],
    ["forged writer identity", { writerId: "caller-controlled" }],
    ["wrong schema", { schemaVersion: "rulix.audit-outbox/v2" }],
    ["mismatched event identity", { eventId: "audit-other" }],
    ["partial migration metadata", {
      entityVersion: 1,
      migrationDigest: "c".repeat(64)
    }],
    ["invalid migration metadata", {
      entityVersion: 2,
      migrationDigest: "c".repeat(64),
      semanticHash: "d".repeat(64)
    }]
  ])("rejects %s as a poison image", async (_label, changes) => {
    const appendAuditEvent = vi.fn(async () => appendResult);
    const consume = createAuditLambdaHandler({
      appendAuditEvent,
      tenantId,
      workspaceStreamArn,
      logger: testLogger()
    });
    const item = { ...outboxItem(), ...changes };

    await expect(consume(streamEvent(streamRecord(item, "poison")))).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: "poison" }]
    });
    expect(appendAuditEvent).not.toHaveBeenCalled();
  });

  it("rejects a mismatched stream ARN, key image, or INSERT OldImage", async () => {
    const appendAuditEvent = vi.fn(async () => appendResult);
    const consume = createAuditLambdaHandler({
      appendAuditEvent,
      tenantId,
      workspaceStreamArn,
      logger: testLogger()
    });
    const wrongArn = streamRecord(outboxItem(), "wrong-arn");
    wrongArn.eventSourceARN = `${workspaceStreamArn}-other`;
    const wrongKeys = streamRecord(outboxItem(), "wrong-keys");
    wrongKeys.dynamodb!.Keys = marshall({ pk: "TENANT#other#USER#user", sk: "AU#other" }) as unknown as
      NonNullable<DynamoDBRecord["dynamodb"]>["Keys"];
    const oldImage = streamRecord(outboxItem(), "old-image");
    oldImage.dynamodb!.OldImage = oldImage.dynamodb!.NewImage;

    await expect(consume(streamEvent(wrongArn, wrongKeys, oldImage))).resolves.toEqual({
      batchItemFailures: [
        { itemIdentifier: "wrong-arn" },
        { itemIdentifier: "wrong-keys" },
        { itemIdentifier: "old-image" }
      ]
    });
    expect(appendAuditEvent).not.toHaveBeenCalled();
  });

  it("ignores unrelated and non-INSERT images and requires a sequence number for an AU checkpoint", async () => {
    const appendAuditEvent = vi.fn(async () => appendResult);
    const consume = createAuditLambdaHandler({
      appendAuditEvent,
      tenantId,
      workspaceStreamArn,
      logger: testLogger()
    });
    const modify = streamRecord(outboxItem(), "modify-1", "MODIFY");
    const unrelated = streamRecord({
      ...outboxItem(),
      schemaVersion: "rulix.workspace/v2",
      entityType: "R"
    }, "unrelated-1");

    await expect(consume(streamEvent(modify, unrelated))).resolves.toEqual({ batchItemFailures: [] });
    expect(appendAuditEvent).not.toHaveBeenCalled();

    const missingSequence = streamRecord(outboxItem(), "missing");
    delete missingSequence.dynamodb?.SequenceNumber;
    await expect(consume(streamEvent(missingSequence)))
      .rejects.toBeInstanceOf(AuditOutboxValidationError);
  });

  it("rejects non-stream direct invocation instead of bypassing the transactional outbox", async () => {
    const appendAuditEvent = vi.fn(async () => appendResult);
    const logger = testLogger();
    const consume = createAuditLambdaHandler({ appendAuditEvent, tenantId, workspaceStreamArn, logger });
    const direct = {
      schemaVersion: AUDIT_EVENT_SCHEMA,
      idempotencyKey: "direct-1",
      reviewId: "memo-42",
      assertedAction: "review.decision.accepted",
      assertedActorId: "user-7",
      assertedActorType: "user",
      assertedSubjectType: "review",
      assertedSubjectId: "memo-42",
      assertedOutcome: "succeeded",
      assertedSource: "api",
      assertedOccurredAt: validAuditEvent.at
    };

    await expect(consume(direct)).rejects.toBeInstanceOf(AuditOutboxValidationError);
    expect(appendAuditEvent).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('"event":"audit_stream_invocation_rejected"')
    );
  });

  it.each([
    ["authenticated-api", "review", "api", "review"],
    ["analysis-worker", "workspace", "worker", "account"],
    ["system", "builder-session", "system", "system"],
    ["authenticated-api", "outreach", "api", "outreach"]
  ] as const)(
    "maps source %s and subject %s without falling through",
    (source, subjectType, expectedSource, expectedSubjectType) => {
      const subjectId = subjectType === "review" ? validAuditEvent.memoId : `${subjectType}-7`;
      const auditEvent: AuditEvent = {
        ...validAuditEvent,
        metadata: {
          ...validAuditEvent.metadata,
          actorType: source === "authenticated-api" ? "user" : "service",
          source,
          subjectType,
          subjectId
        }
      };

      const mapped = parseAuditStreamRecord(
        streamRecord(outboxItem(auditEvent)),
        tenantId,
        workspaceStreamArn
      );

      expect(mapped.assertedSource).toBe(expectedSource);
      expect(mapped.assertedSubjectType).toBe(expectedSubjectType);
      expect(mapped.assertedSubjectId).toBe(subjectId);
    }
  );
});

function outboxItem(
  auditEvent: AuditEvent | Record<string, unknown> = validAuditEvent
): Record<string, unknown> {
  const event = structuredClone(auditEvent) as Record<string, unknown>;
  const eventId = String(event.id);
  const memoId = String(event.memoId);
  const at = String(event.at);
  return {
    pk: `TENANT#${encodeURIComponent(tenantId)}#USER#${encodeURIComponent(accountId)}`,
    sk: `AU#${encodeURIComponent(memoId)}#${at}#${encodeURIComponent(eventId)}`,
    schemaVersion: AUDIT_OUTBOX_SCHEMA,
    entityType: "AU",
    idempotencyKey: eventId,
    eventId,
    accountId,
    createdAt: at,
    updatedAt: at,
    payloadHash: sha256Canonical({ accountId, auditEvent: event }),
    auditEvent: event
  };
}

function streamRecord(
  item: Record<string, unknown>,
  sequenceNumber = "sequence-1",
  eventName: DynamoDBRecord["eventName"] = "INSERT"
): DynamoDBRecord {
  return {
    eventID: `event-${sequenceNumber}`,
    eventName,
    eventSource: "aws:dynamodb",
    eventSourceARN: workspaceStreamArn,
    awsRegion: "us-east-1",
    dynamodb: {
      ApproximateCreationDateTime: Date.parse(validAuditEvent.at) / 1_000,
      Keys: marshall({ pk: item.pk, sk: item.sk }) as unknown as
        NonNullable<DynamoDBRecord["dynamodb"]>["Keys"],
      NewImage: marshall(item, { removeUndefinedValues: true }) as unknown as
        NonNullable<DynamoDBRecord["dynamodb"]>["NewImage"],
      SequenceNumber: sequenceNumber,
      SizeBytes: 1_024,
      StreamViewType: "NEW_IMAGE"
    }
  };
}

function streamEvent(...records: DynamoDBRecord[]): DynamoDBStreamEvent {
  return { Records: records };
}

function testLogger() {
  return {
    info: vi.fn(),
    error: vi.fn()
  };
}
