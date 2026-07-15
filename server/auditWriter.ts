import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  type PutCommandInput
} from "@aws-sdk/lib-dynamodb";
import { sha256Canonical } from "./domain/hashes";

export const AUDIT_EVENT_SCHEMA = "rulix.audit-event/v1" as const;

export interface AuditAppendEvent {
  schemaVersion: typeof AUDIT_EVENT_SCHEMA;
  idempotencyKey: string;
  reviewId: string;
  assertedAction: string;
  assertedActorId: string;
  assertedActorType: "user" | "service";
  assertedSubjectType: "account" | "memo" | "outreach" | "review" | "system";
  assertedSubjectId: string;
  assertedOutcome: "denied" | "failed" | "succeeded";
  assertedSource: "api" | "system" | "worker";
  assertedOccurredAt: string;
  assertedCorrelationId?: string;
  assertedDetail?: string;
}

export interface AuditAppendResult {
  eventId: string;
  eventTime: string;
  recordedAt: string;
  tenantReviewId: string;
  payloadHash: string;
  duplicate: boolean;
}

export interface AuditCommandClient {
  send(command: PutCommand | GetCommand): Promise<unknown>;
}

export interface AuditAppenderOptions {
  client: AuditCommandClient;
  tableName: string;
  tenantId: string;
  writerId: string;
  now?: () => Date;
}

export class AuditValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditValidationError";
  }
}

export class AuditIdempotencyConflictError extends Error {
  constructor() {
    super("The audit idempotency key is already bound to a different payload.");
    this.name = "AuditIdempotencyConflictError";
  }
}

const EVENT_KEYS = new Set([
  "assertedAction",
  "assertedActorId",
  "assertedActorType",
  "assertedCorrelationId",
  "assertedDetail",
  "assertedOccurredAt",
  "assertedOutcome",
  "assertedSource",
  "assertedSubjectId",
  "assertedSubjectType",
  "idempotencyKey",
  "reviewId",
  "schemaVersion"
]);

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/;
const REVIEW_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ACTION = /^[a-z][a-z0-9]*(?:[.:-][a-z0-9]+)*$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseAuditAppendEvent(value: unknown): AuditAppendEvent {
  if (!isPlainRecord(value)) throw new AuditValidationError("Audit event must be an object.");
  const unknownKeys = Object.keys(value).filter((key) => !EVENT_KEYS.has(key));
  if (unknownKeys.length) {
    throw new AuditValidationError(`Unexpected audit event field: ${unknownKeys.sort()[0]}.`);
  }
  if (value.schemaVersion !== AUDIT_EVENT_SCHEMA) {
    throw new AuditValidationError(`schemaVersion must be ${AUDIT_EVENT_SCHEMA}.`);
  }

  const assertedOccurredAt = boundedString(
    value.assertedOccurredAt,
    "assertedOccurredAt",
    24
  );
  const occurredAtEpoch = Date.parse(assertedOccurredAt);
  if (
    !ISO_INSTANT.test(assertedOccurredAt) ||
    !Number.isFinite(occurredAtEpoch) ||
    new Date(occurredAtEpoch).toISOString() !== assertedOccurredAt
  ) {
    throw new AuditValidationError(
      "assertedOccurredAt must be an ISO-8601 UTC instant with milliseconds."
    );
  }

  return {
    schemaVersion: AUDIT_EVENT_SCHEMA,
    idempotencyKey: identifier(value.idempotencyKey, "idempotencyKey", 128),
    reviewId: matchingString(value.reviewId, "reviewId", 128, REVIEW_IDENTIFIER),
    assertedAction: matchingString(value.assertedAction, "assertedAction", 96, ACTION),
    assertedActorId: identifier(value.assertedActorId, "assertedActorId", 128),
    assertedActorType: enumeration(value.assertedActorType, "assertedActorType", [
      "user",
      "service"
    ]),
    assertedSubjectType: enumeration(value.assertedSubjectType, "assertedSubjectType", [
      "account",
      "memo",
      "outreach",
      "review",
      "system"
    ]),
    assertedSubjectId: identifier(value.assertedSubjectId, "assertedSubjectId", 128),
    assertedOutcome: enumeration(value.assertedOutcome, "assertedOutcome", [
      "denied",
      "failed",
      "succeeded"
    ]),
    assertedSource: enumeration(value.assertedSource, "assertedSource", [
      "api",
      "system",
      "worker"
    ]),
    assertedOccurredAt,
    ...(value.assertedCorrelationId === undefined
      ? {}
      : {
          assertedCorrelationId: identifier(
            value.assertedCorrelationId,
            "assertedCorrelationId",
            128
          )
        }),
    ...(value.assertedDetail === undefined
      ? {}
      : { assertedDetail: boundedString(value.assertedDetail, "assertedDetail", 2_048) })
  };
}

export function createAuditAppender({
  client,
  tableName,
  tenantId,
  writerId,
  now = () => new Date()
}: AuditAppenderOptions) {
  const normalizedTableName = tableName.trim();
  if (!normalizedTableName) throw new Error("Audit table name is required.");
  const trustedTenantId = identifier(tenantId, "configured tenantId", 64);
  const trustedWriterId = identifier(writerId, "configured writerId", 128);

  return async function appendAuditEvent(rawEvent: unknown): Promise<AuditAppendResult> {
    const event = parseAuditAppendEvent(rawEvent);
    const recordedAt = now().toISOString();
    const eventId = createHash("sha256")
      .update(`${trustedTenantId}\0${event.idempotencyKey}`, "utf8")
      .digest("hex");
    const eventTime = `event#${eventId}`;
    const tenantReviewId = `${trustedTenantId}/audit`;
    const payloadHash = sha256Canonical(event);
    const input: PutCommandInput = {
      TableName: normalizedTableName,
      Item: {
        ...event,
        tenantId: trustedTenantId,
        tenantReviewId,
        writerId: trustedWriterId,
        writerType: "service",
        eventId,
        eventTime,
        recordedAt,
        payloadHash
      },
      ConditionExpression:
        "attribute_not_exists(#tenantReviewId) AND attribute_not_exists(#eventTime)",
      ExpressionAttributeNames: {
        "#tenantReviewId": "tenantReviewId",
        "#eventTime": "eventTime"
      },
      ReturnValues: "NONE"
    };

    try {
      await client.send(new PutCommand(input));
    } catch (error) {
      if (isConditionalFailure(error)) {
        const existing = await readExistingAuditEvent(client, normalizedTableName, {
          tenantReviewId,
          eventTime
        });
        if (
          existing.payloadHash !== payloadHash
          || existing.idempotencyKey !== event.idempotencyKey
          || existing.tenantId !== trustedTenantId
          || existing.writerId !== trustedWriterId
        ) {
          throw new AuditIdempotencyConflictError();
        }
        return {
          eventId: existing.eventId,
          eventTime: existing.eventTime,
          recordedAt: existing.recordedAt,
          tenantReviewId: existing.tenantReviewId,
          payloadHash: existing.payloadHash,
          duplicate: true
        };
      }
      throw error;
    }
    return { eventId, eventTime, recordedAt, tenantReviewId, payloadHash, duplicate: false };
  };
}

async function readExistingAuditEvent(
  client: AuditCommandClient,
  tableName: string,
  key: { tenantReviewId: string; eventTime: string }
) {
  const response = await client.send(new GetCommand({
    TableName: tableName,
    Key: key,
    ConsistentRead: true
  }));
  const item = isPlainRecord(response) && isPlainRecord(response.Item)
    ? response.Item
    : undefined;
  if (
    !item
    || typeof item.eventId !== "string"
    || typeof item.eventTime !== "string"
    || typeof item.recordedAt !== "string"
    || typeof item.tenantReviewId !== "string"
    || typeof item.payloadHash !== "string"
    || typeof item.idempotencyKey !== "string"
    || typeof item.tenantId !== "string"
    || typeof item.writerId !== "string"
  ) {
    throw new Error("The existing audit event could not be verified after a conditional collision.");
  }
  return item as Record<string, unknown> & {
    eventId: string;
    eventTime: string;
    recordedAt: string;
    tenantReviewId: string;
    payloadHash: string;
    idempotencyKey: string;
    tenantId: string;
    writerId: string;
  };
}

export function createDefaultAuditAppender(options: {
  tableName: string;
  tenantId: string;
  writerId: string;
}) {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true }
  });
  const sendDocumentCommand = documentClient.send.bind(documentClient) as unknown as
    (command: PutCommand | GetCommand) => Promise<unknown>;
  return createAuditAppender({
    ...options,
    client: {
      send: sendDocumentCommand
    }
  });
}

function isConditionalFailure(error: unknown) {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedString(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string") throw new AuditValidationError(`${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new AuditValidationError(`${field} must contain 1 to ${maximum} safe characters.`);
  }
  return normalized;
}

function identifier(value: unknown, field: string, maximum: number) {
  return matchingString(value, field, maximum, IDENTIFIER);
}

function matchingString(
  value: unknown,
  field: string,
  maximum: number,
  pattern: RegExp
) {
  const normalized = boundedString(value, field, maximum);
  if (!pattern.test(normalized)) throw new AuditValidationError(`${field} has an invalid format.`);
  return normalized;
}

function enumeration<const T extends string>(
  value: unknown,
  field: string,
  choices: readonly T[]
): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new AuditValidationError(`${field} must be one of: ${choices.join(", ")}.`);
  }
  return value as T;
}
