// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_EVENT_SCHEMA,
  AuditIdempotencyConflictError,
  AuditValidationError,
  createAuditAppender,
  type AuditAppendEvent,
  type AuditCommandClient
} from "./auditWriter";

const validEvent: AuditAppendEvent = {
  schemaVersion: AUDIT_EVENT_SCHEMA,
  idempotencyKey: "audit-review-42-decision",
  reviewId: "review-42",
  assertedAction: "review.decision.signed",
  assertedActorId: "user-7",
  assertedActorType: "user",
  assertedSubjectType: "review",
  assertedSubjectId: "review-42",
  assertedOutcome: "succeeded",
  assertedSource: "api",
  assertedOccurredAt: "2026-07-14T03:04:05.000Z",
  assertedCorrelationId: "request-99",
  assertedDetail: "Decision recorded after policy checks."
};

const trustedIdentity = {
  tenantId: "tenant-1",
  writerId: "rulix-audit-writer"
};

describe("append-only audit writer", () => {
  it("uses stable service-owned keys and a payload hash for conditional append", async () => {
    const send = vi.fn(async (_command: Parameters<AuditCommandClient["send"]>[0]) => ({}));
    const append = createAuditAppender({
      tableName: "rulix-audit",
      client: { send },
      ...trustedIdentity,
      now: () => new Date("2026-07-14T04:05:06.789Z")
    });

    const result = await append(validEvent);

    expect(result).toMatchObject({
      eventId: expect.stringMatching(/^[a-f0-9]{64}$/),
      recordedAt: "2026-07-14T04:05:06.789Z",
      tenantReviewId: "tenant-1/audit",
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      duplicate: false
    });
    expect(result.eventTime).toBe(`event#${result.eventId}`);
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0];
    expect(command.constructor.name).toBe("PutCommand");
    expect(command.input).toMatchObject({
      TableName: "rulix-audit",
      Item: {
        ...validEvent,
        tenantId: "tenant-1",
        writerId: "rulix-audit-writer",
        writerType: "service",
        eventId: result.eventId,
        eventTime: result.eventTime,
        recordedAt: result.recordedAt,
        payloadHash: result.payloadHash
      },
      ConditionExpression:
        "attribute_not_exists(#tenantReviewId) AND attribute_not_exists(#eventTime)",
      ReturnValues: "NONE"
    });
  });

  it("recovers a lost first response as one immutable row and an identical duplicate", async () => {
    const client = new InMemoryAuditClient(true);
    const times = [
      new Date("2026-07-14T04:05:06.789Z"),
      new Date("2026-07-14T06:07:08.999Z")
    ];
    const append = createAuditAppender({
      tableName: "rulix-audit",
      client,
      ...trustedIdentity,
      now: () => times.shift() ?? new Date("2026-07-14T07:00:00.000Z")
    });

    await expect(append(validEvent)).rejects.toThrow("response lost");
    const retry = await append(validEvent);

    expect(retry.duplicate).toBe(true);
    expect(client.rows).toHaveLength(1);
    expect(client.commandNames).toEqual(["PutCommand", "PutCommand", "GetCommand"]);
    expect(retry.recordedAt).toBe("2026-07-14T04:05:06.789Z");
  });

  it("rejects reuse of one idempotency key for a different payload", async () => {
    const client = new InMemoryAuditClient();
    const append = createAuditAppender({
      tableName: "rulix-audit",
      client,
      ...trustedIdentity
    });
    await append(validEvent);

    await expect(append({
      ...validEvent,
      reviewId: "other-review",
      assertedOccurredAt: "2026-07-14T05:00:00.000Z",
      assertedDetail: "Forged replacement detail."
    }))
      .rejects.toBeInstanceOf(AuditIdempotencyConflictError);
    expect(client.rows).toHaveLength(1);
  });

  it.each([
    ["non-object payload", null],
    ["unknown field", { ...validEvent, injected: true }],
    ["missing idempotency key", { ...validEvent, idempotencyKey: undefined }],
    ["wrong schema", { ...validEvent, schemaVersion: "rulix.audit-event/v2" }],
    ["oversized detail", { ...validEvent, assertedDetail: "x".repeat(2_049) }],
    ["cross-partition review identifier", { ...validEvent, reviewId: "other-tenant/review-9" }],
    ["invalid action", { ...validEvent, assertedAction: "Review Decision!" }],
    ["invalid enum", { ...validEvent, assertedActorType: "administrator" }],
    ["invalid timestamp", { ...validEvent, assertedOccurredAt: "yesterday" }],
    ["invalid calendar date", { ...validEvent, assertedOccurredAt: "2026-02-30T00:00:00.000Z" }]
  ])("rejects %s before DynamoDB", async (_label, event) => {
    const send = vi.fn(async () => ({}));
    const append = createAuditAppender({
      tableName: "rulix-audit",
      client: { send },
      ...trustedIdentity
    });

    await expect(append(event)).rejects.toBeInstanceOf(AuditValidationError);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    "tenantId",
    "tenantReviewId",
    "writerId",
    "writerType",
    "recordedAt",
    "eventId",
    "eventTime",
    "payloadHash",
    "actorId",
    "actorType",
    "action",
    "subjectType",
    "subjectId",
    "outcome",
    "source",
    "occurredAt",
    "correlationId",
    "detail"
  ])("rejects caller-supplied authoritative field %s", async (field) => {
    const send = vi.fn(async () => ({}));
    const append = createAuditAppender({
      tableName: "rulix-audit",
      client: { send },
      ...trustedIdentity
    });

    await expect(append({ ...validEvent, [field]: "forged" }))
      .rejects.toBeInstanceOf(AuditValidationError);
    expect(send).not.toHaveBeenCalled();
  });

  it("preserves ordinary storage failures for operational handling", async () => {
    const unavailable = new Error("DynamoDB unavailable");
    const append = createAuditAppender({
      tableName: "rulix-audit",
      ...trustedIdentity,
      client: { send: async () => { throw unavailable; } }
    });

    await expect(append(validEvent)).rejects.toBe(unavailable);
  });
});

class InMemoryAuditClient implements AuditCommandClient {
  rows: Record<string, unknown>[] = [];
  commandNames: string[] = [];
  private loseFirstResponse: boolean;

  constructor(loseFirstResponse = false) {
    this.loseFirstResponse = loseFirstResponse;
  }

  async send(command: Parameters<AuditCommandClient["send"]>[0]) {
    const name = command.constructor.name;
    const input = command.input as Record<string, any>;
    this.commandNames.push(name);
    if (name === "GetCommand") {
      const key = input.Key as Record<string, unknown>;
      return {
        Item: structuredClone(this.rows.find((row) =>
          row.tenantReviewId === key.tenantReviewId && row.eventTime === key.eventTime
        ))
      };
    }
    const item = structuredClone(input.Item as Record<string, unknown>);
    const duplicate = this.rows.some((row) =>
      row.tenantReviewId === item.tenantReviewId && row.eventTime === item.eventTime
    );
    if (duplicate) {
      const error = new Error("conditional collision");
      error.name = "ConditionalCheckFailedException";
      throw error;
    }
    this.rows.push(item);
    if (this.loseFirstResponse) {
      this.loseFirstResponse = false;
      throw new Error("response lost after DynamoDB committed the row");
    }
    return {};
  }
}
