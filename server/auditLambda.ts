import { createHash, timingSafeEqual } from "node:crypto";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type {
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent
} from "aws-lambda";
import {
  AUDIT_OUTBOX_SCHEMA,
  AuditOutboxContractError,
  canonicalAuditPayload,
  type AuthoritativeAuditEvent
} from "./auditOutboxContract";
import {
  AUDIT_EVENT_SCHEMA,
  createDefaultAuditAppender,
  type AuditAppendEvent,
  type AuditAppendResult
} from "./auditWriter";

export { AUDIT_OUTBOX_SCHEMA } from "./auditOutboxContract";

const OUTBOX_KEYS = new Set([
  "accountId",
  "auditEvent",
  "createdAt",
  "entityVersion",
  "entityType",
  "eventId",
  "idempotencyKey",
  "migrationDigest",
  "payloadHash",
  "pk",
  "schemaVersion",
  "semanticHash",
  "sk",
  "updatedAt"
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type AuditAppender = (event: unknown) => Promise<AuditAppendResult>;
type AuditLogger = Pick<Console, "info" | "error">;

export interface AuditLambdaOptions {
  appendAuditEvent: AuditAppender;
  tenantId: string;
  workspaceStreamArn: string;
  logger?: AuditLogger;
}

export class AuditOutboxValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditOutboxValidationError";
  }
}

interface AuditOutboxItem {
  pk: string;
  sk: string;
  schemaVersion: typeof AUDIT_OUTBOX_SCHEMA;
  entityType: "AU";
  idempotencyKey: string;
  eventId: string;
  accountId: string;
  createdAt: string;
  updatedAt: string;
  payloadHash: string;
  auditEvent: AuthoritativeAuditEvent;
}

/**
 * Builds the normalized workspace audit consumer. Only records delivered from
 * the configured DynamoDB stream are accepted; there is no direct append mode.
 */
export function createAuditLambdaHandler({
  appendAuditEvent,
  tenantId,
  workspaceStreamArn,
  logger = console
}: AuditLambdaOptions) {
  const trustedTenantId = identifier(tenantId, "configured tenantId", 64);
  const trustedWorkspaceStreamArn = boundedString(
    workspaceStreamArn,
    "configured workspace stream ARN",
    2_048
  );

  return async (event: unknown): Promise<DynamoDBBatchResponse> => {
    if (!isDynamoStreamEvent(event)) {
      logger.error(JSON.stringify({
        event: "audit_stream_invocation_rejected",
        errorType: "AuditOutboxValidationError"
      }));
      throw new AuditOutboxValidationError(
        "The audit writer accepts only DynamoDB workspace stream events."
      );
    }
    return consumeAuditStream(
      event,
      trustedTenantId,
      trustedWorkspaceStreamArn,
      appendAuditEvent,
      logger
    );
  };
}

let productionHandler: ReturnType<typeof createAuditLambdaHandler> | undefined;

export const handler = async (event: unknown) => runtimeHandler()(event);

function runtimeHandler() {
  if (productionHandler) return productionHandler;
  const tableName = process.env.RULIX_AUDIT_TABLE?.trim();
  const tenantId = process.env.RULIX_AUDIT_TENANT_ID?.trim();
  const writerId = process.env.RULIX_AUDIT_WRITER_ID?.trim();
  const workspaceStreamArn = process.env.RULIX_WORKSPACE_STREAM_ARN?.trim();
  if (!tableName || !tenantId || !writerId || !workspaceStreamArn) {
    throw new Error("The trusted audit writer environment is not configured.");
  }
  productionHandler = createAuditLambdaHandler({
    tenantId,
    workspaceStreamArn,
    appendAuditEvent: createDefaultAuditAppender({ tableName, tenantId, writerId })
  });
  return productionHandler;
}

async function consumeAuditStream(
  event: DynamoDBStreamEvent,
  trustedTenantId: string,
  trustedWorkspaceStreamArn: string,
  appendAuditEvent: AuditAppender,
  logger: AuditLogger
): Promise<DynamoDBBatchResponse> {
  const batchItemFailures: DynamoDBBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records) {
    if (record.eventName !== "INSERT") continue;
    if (record.dynamodb?.NewImage?.entityType?.S !== "AU") continue;
    const itemIdentifier = record.dynamodb?.SequenceNumber;
    if (!itemIdentifier) {
      // Lambda cannot checkpoint a DynamoDB Streams failure without the
      // sequence number. Throwing retries the whole batch and lets the event
      // source mapping's bounded retry/DLQ policy quarantine it.
      throw new AuditOutboxValidationError("DynamoDB stream record is missing SequenceNumber.");
    }

    try {
      const appendEvent = parseAuditStreamRecord(
        record,
        trustedTenantId,
        trustedWorkspaceStreamArn
      );
      const result = await appendAuditEvent(appendEvent);
      logger.info(JSON.stringify({
        event: "audit_outbox_record_appended",
        invocationMode: "dynamodb-stream",
        itemIdentifier,
        eventId: result.eventId,
        duplicate: result.duplicate
      }));
    } catch (error) {
      batchItemFailures.push({ itemIdentifier });
      logger.error(JSON.stringify({
        event: "audit_outbox_record_failed",
        invocationMode: "dynamodb-stream",
        itemIdentifier,
        failureKind: error instanceof AuditOutboxValidationError ? "poison" : "transient",
        errorType: errorName(error)
      }));
    }
  }

  return { batchItemFailures };
}

export function parseAuditStreamRecord(
  record: DynamoDBRecord,
  trustedTenantId: string,
  trustedWorkspaceStreamArn: string
): AuditAppendEvent {
  if (record.eventSource !== "aws:dynamodb") {
    throw new AuditOutboxValidationError("Record is not from DynamoDB Streams.");
  }
  if (record.eventName !== "INSERT") {
    throw new AuditOutboxValidationError("Only DynamoDB INSERT records are audit outbox events.");
  }
  if (record.eventSourceARN !== trustedWorkspaceStreamArn) {
    throw new AuditOutboxValidationError("Record is not from the configured workspace stream.");
  }
  const image = record.dynamodb?.NewImage;
  if (!image) throw new AuditOutboxValidationError("Audit outbox INSERT is missing NewImage.");
  if (record.dynamodb?.OldImage && Object.keys(record.dynamodb.OldImage).length > 0) {
    throw new AuditOutboxValidationError("Audit outbox INSERT must not contain OldImage.");
  }
  const keys = record.dynamodb?.Keys;
  if (!keys) throw new AuditOutboxValidationError("Audit outbox INSERT is missing Keys.");

  let value: unknown;
  let keyValue: unknown;
  try {
    value = unmarshall(image as Parameters<typeof unmarshall>[0]);
    keyValue = unmarshall(keys as Parameters<typeof unmarshall>[0]);
  } catch {
    throw new AuditOutboxValidationError("Audit outbox image or keys are not valid DynamoDB data.");
  }
  if (
    !isPlainRecord(value)
    || !isPlainRecord(keyValue)
    || keyValue.pk !== value.pk
    || keyValue.sk !== value.sk
  ) {
    throw new AuditOutboxValidationError(
      "Audit outbox DynamoDB keys do not match the immutable NewImage."
    );
  }
  const item = parseAuditOutboxItem(value, trustedTenantId);
  return mapOutboxEvent(item);
}

function parseAuditOutboxItem(value: unknown, trustedTenantId: string): AuditOutboxItem {
  if (!isPlainRecord(value)) throw new AuditOutboxValidationError("Audit outbox item must be an object.");
  const unknownKey = Object.keys(value).find((key) => !OUTBOX_KEYS.has(key));
  if (unknownKey) throw new AuditOutboxValidationError(`Unexpected audit outbox field: ${unknownKey}.`);
  if (value.schemaVersion !== AUDIT_OUTBOX_SCHEMA || value.entityType !== "AU") {
    throw new AuditOutboxValidationError("Audit outbox schema or entity type is invalid.");
  }
  validateMigrationMetadata(value);

  let canonical;
  try {
    canonical = canonicalAuditPayload(value.accountId, value.auditEvent);
  } catch (error) {
    if (error instanceof AuditOutboxContractError) {
      throw new AuditOutboxValidationError(error.message);
    }
    throw error;
  }
  const { accountId, auditEvent: event, payloadHash: expectedHash } = canonical;
  const payloadHash = matchingString(value.payloadHash, "payloadHash", 64, SHA256);
  if (!equalSha256(payloadHash, expectedHash)) {
    throw new AuditOutboxValidationError("Audit outbox payload hash is invalid.");
  }
  const idempotencyKey = matchingString(value.idempotencyKey, "idempotencyKey", 128, IDENTIFIER);
  const eventId = matchingString(value.eventId, "eventId", 128, IDENTIFIER);
  if (idempotencyKey !== event.id || eventId !== event.id) {
    throw new AuditOutboxValidationError("Audit outbox event identity does not match its payload.");
  }

  const createdAt = isoInstant(value.createdAt, "createdAt");
  const updatedAt = isoInstant(value.updatedAt, "updatedAt");
  if (createdAt !== event.at || updatedAt !== event.at) {
    throw new AuditOutboxValidationError("Audit outbox timestamps do not match the audit event.");
  }

  const pk = boundedString(value.pk, "pk", 512);
  const expectedPk = `TENANT#${encodeURIComponent(trustedTenantId)}#USER#${encodeURIComponent(accountId)}`;
  if (pk !== expectedPk) {
    throw new AuditOutboxValidationError("Audit outbox partition is outside the trusted tenant/account.");
  }
  const sk = boundedString(value.sk, "sk", 768);
  const expectedSk = `AU#${encodeURIComponent(event.memoId)}#${event.at}#${encodeURIComponent(event.id)}`;
  if (sk !== expectedSk) {
    throw new AuditOutboxValidationError("Audit outbox sort key does not match the audit event.");
  }

  return {
    pk,
    sk,
    schemaVersion: AUDIT_OUTBOX_SCHEMA,
    entityType: "AU",
    idempotencyKey,
    eventId,
    accountId,
    createdAt,
    updatedAt,
    payloadHash,
    auditEvent: event
  };
}

function validateMigrationMetadata(value: Record<string, unknown>) {
  const hasMigrationMetadata = value.entityVersion !== undefined
    || value.migrationDigest !== undefined
    || value.semanticHash !== undefined;
  if (!hasMigrationMetadata) return;
  if (value.entityVersion !== 1) {
    throw new AuditOutboxValidationError("Migrated audit outbox entityVersion must be 1.");
  }
  matchingString(value.migrationDigest, "migrationDigest", 64, SHA256);
  matchingString(value.semanticHash, "semanticHash", 64, SHA256);
}

function mapOutboxEvent(item: AuditOutboxItem): AuditAppendEvent {
  const event = item.auditEvent;
  const metadata = event.metadata;
  return {
    schemaVersion: AUDIT_EVENT_SCHEMA,
    idempotencyKey: item.idempotencyKey,
    reviewId: event.memoId,
    assertedAction: normalizedAuditAction(event.action),
    assertedActorId: event.actorId,
    assertedActorType: metadata.actorType,
    assertedSubjectType: mapAuditSubjectType(metadata.subjectType),
    assertedSubjectId: metadata.subjectId,
    assertedOutcome: metadata.outcome,
    assertedSource: mapAuditSource(metadata.source),
    assertedOccurredAt: event.at,
    assertedDetail: event.detail
  };
}

function normalizedAuditAction(value: string) {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56) || "event";
  const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
  return `review.audit.${slug}.${digest}`;
}

function mapAuditSource(value: "authenticated-api" | "analysis-worker" | "system"):
  AuditAppendEvent["assertedSource"] {
  switch (value) {
    case "authenticated-api": return "api";
    case "analysis-worker": return "worker";
    case "system": return "system";
    default: return assertNever(value);
  }
}

function mapAuditSubjectType(
  value: "review" | "workspace" | "builder-session" | "outreach"
): AuditAppendEvent["assertedSubjectType"] {
  switch (value) {
    case "review": return "review";
    case "workspace": return "account";
    case "builder-session": return "system";
    case "outreach": return "outreach";
    default: return assertNever(value);
  }
}

function assertNever(value: never): never {
  throw new AuditOutboxValidationError(`Unhandled audit provenance value: ${String(value)}.`);
}

function isDynamoStreamEvent(value: unknown): value is DynamoDBStreamEvent {
  return isPlainRecord(value) && Array.isArray(value.Records);
}

function equalSha256(left: string, right: string) {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function isoInstant(value: unknown, label: string) {
  const text = boundedString(value, label, 24);
  const time = Date.parse(text);
  if (!ISO_INSTANT.test(text) || !Number.isFinite(time) || new Date(time).toISOString() !== text) {
    throw new AuditOutboxValidationError(`${label} must be a canonical UTC instant.`);
  }
  return text;
}

function identifier(value: unknown, label: string, maximum: number) {
  return matchingString(value, label, maximum, IDENTIFIER);
}

function matchingString(
  value: unknown,
  label: string,
  maximum: number,
  pattern: RegExp
) {
  const text = boundedString(value, label, maximum);
  if (!pattern.test(text)) throw new AuditOutboxValidationError(`${label} has an invalid format.`);
  return text;
}

function boundedString(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string") throw new AuditOutboxValidationError(`${label} must be a string.`);
  const text = value.trim();
  if (
    value !== text
    || !text
    || text.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(text)
  ) {
    throw new AuditOutboxValidationError(`${label} must contain 1-${maximum} safe characters.`);
  }
  return text;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : "UnknownError";
}
