import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectOutput,
  type S3ClientConfig
} from "@aws-sdk/client-s3";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type QueryCommandInput,
  type TransactWriteCommandInput
} from "@aws-sdk/lib-dynamodb";
import type { AuditEvent } from "../src/types";
import {
  AuditOutboxContractError,
  canonicalAuditPayload,
  canonicalizeAuthoritativeAuditEvent,
  type AuthoritativeAuditProvenance
} from "./auditOutboxContract";

export const WORKSPACE_SCHEMA_VERSION = 2 as const;
export const WORKSPACE_ITEM_MAX_BYTES = 350 * 1024;
export const WORKSPACE_RESPONSE_MAX_BYTES = 1024 * 1024;
export const WORKSPACE_MEMO_MAX_BYTES = 512 * 1024;
export const WORKSPACE_ANALYSIS_MAX_BYTES = 1024 * 1024;
export const WORKSPACE_CHAT_TEXT_MAX_BYTES = 12 * 1024;
export const WORKSPACE_BUILDER_SESSION_MAX_BYTES = 300_000;
export const WORKSPACE_CURSOR_MAX_BYTES = 4096;
export const WORKSPACE_CONTENT_STORED_OVERHEAD_BYTES = 64 * 1024;
/** Conservative allowance for clock skew between Lambda, operators, and DynamoDB clients. */
export const WORKSPACE_CONTENT_GC_CLOCK_SKEW_MS = 60_000;
export const WORKSPACE_CONTENT_GC_LEASE_SK = "GC#WORKSPACE_CONTENT#LEASE" as const;

export type WorkspaceMode = "legacy" | "dual-read" | "normalized";

export interface WorkspaceItem {
  pk: string;
  sk: string;
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION | "rulix.audit-outbox/v1";
  entityType: string;
  entityVersion?: number;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface WorkspaceMetaItem extends WorkspaceItem {
  sk: "META";
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  entityType: "META";
  entityVersion: number;
  migrationStatus: "pending" | "complete";
  sourceDigest?: string;
  migratedAt?: string;
  selectedMemoId?: string;
  activeMemoBuilderSessionId?: string;
  builderSessionCount?: number;
}

export interface WorkspaceContentRef {
  bucket: string;
  key: string;
  /** Always pin reads to the exact immutable S3 version committed by DynamoDB. */
  versionId: string;
  sha256: string;
  byteLength: number;
  storedByteLength: number;
  mimeType: string;
  contentEncoding: "identity" | "gzip";
}

export interface WorkspaceCursorPayload {
  v: 1;
  pk: string;
  prefix: string;
  queryHash: string;
  lastEvaluatedKey: Record<string, unknown>;
  exp: number;
}

export interface WorkspaceCursorExpectation {
  pk: string;
  prefix: string;
  queryHash: string;
}

export interface WorkspaceCursorKeyRing {
  activeKeyId: string;
  keys: Record<string, string | Uint8Array>;
}

export interface WorkspacePage<T> {
  items: T[];
  nextCursor?: string;
}

export type WorkspaceAuditProvenance = AuthoritativeAuditProvenance;

export class WorkspaceValidationError extends Error {
  readonly status = 400;
  readonly code = "WORKSPACE_VALIDATION_FAILED";
}

export class WorkspaceIntegrityError extends Error {
  readonly status = 500;
  readonly code = "WORKSPACE_INTEGRITY_FAILED";
}

export class WorkspaceConflictError extends Error {
  readonly status = 409;
  readonly code = "WORKSPACE_VERSION_CONFLICT";
}

/** A content-bearing write was fenced by reference-aware garbage collection. */
export class WorkspaceContentGcActiveError extends Error {
  readonly status = 503;
  readonly code = "WORKSPACE_CONTENT_GC_ACTIVE";
  readonly retryable = true;

  constructor() {
    super("Workspace content maintenance is active. Retry the complete request shortly.");
  }
}

export class WorkspaceNotFoundError extends Error {
  readonly status = 404;
  readonly code = "WORKSPACE_NOT_FOUND";
}

export class WorkspaceNotMigratedError extends Error {
  readonly status = 503;
  readonly code = "WORKSPACE_MIGRATION_REQUIRED";
  readonly retryable = true;

  constructor() {
    super("Workspace migration is not complete. Retry after migration finishes.");
  }
}

export function parseWorkspaceMode(value: string | undefined): WorkspaceMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "legacy";
  if (normalized === "legacy" || normalized === "dual-read" || normalized === "normalized") {
    return normalized;
  }
  throw new WorkspaceValidationError(
    "RULIX_WORKSPACE_MODE must be legacy, dual-read, or normalized."
  );
}

export function workspacePk(tenantId: string, userId: string) {
  return `TENANT#${workspaceKeySegment(tenantId, "tenantId")}#USER#${workspaceKeySegment(userId, "userId")}`;
}

/** A separate tenant-system partition lets IAM scope GC lease writes by LeadingKeys. */
export function workspaceContentGcLeasePk(tenantId: string) {
  return `TENANT#${workspaceKeySegment(tenantId, "tenantId")}#SYSTEM`;
}

export const workspaceSk = {
  meta: () => "META" as const,
  review: (memoId: string) => `R#${workspaceKeySegment(memoId, "memoId")}`,
  revision: (memoId: string, revision: number) =>
    `RV#${workspaceKeySegment(memoId, "memoId")}#${padSequence(revision, "revision")}`,
  analysisCurrent: (memoId: string) => `AC#${workspaceKeySegment(memoId, "memoId")}`,
  analysisHistory: (memoId: string, analysisId: string) =>
    `AH#${workspaceKeySegment(memoId, "memoId")}#${workspaceKeySegment(analysisId, "analysisId")}`,
  decision: (memoId: string) => `DC#${workspaceKeySegment(memoId, "memoId")}`,
  chat: (memoId: string, messageId: string) =>
    `CH#${workspaceKeySegment(memoId, "memoId")}#${workspaceKeySegment(messageId, "messageId")}`,
  chatMeta: (memoId: string) => `CHAT_META#${workspaceKeySegment(memoId, "memoId")}`,
  audit: (memoId: string, at: string, eventId: string) =>
    `AU#${workspaceKeySegment(memoId, "memoId")}#${sortableTimestamp(at)}#${workspaceKeySegment(eventId, "eventId")}`,
  builderSession: (sessionId: string) => `BS#${workspaceKeySegment(sessionId, "sessionId")}`,
  idempotency: (requestId: string) => `IC#${workspaceKeySegment(requestId, "requestId")}`,
  comment: (memoId: string, commentId: string) =>
    `CM#${workspaceKeySegment(memoId, "memoId")}#${workspaceKeySegment(commentId, "commentId")}`,
  notification: (notificationId: string) =>
    `NT#${workspaceKeySegment(notificationId, "notificationId")}`,
  outreach: (kind: string, id: string) =>
    `OUT#${workspaceKeySegment(kind, "outreachKind")}#${workspaceKeySegment(id, "outreachId")}`,
  migrationLease: () => "MIGRATION#LEASE" as const,
  contentGcLease: () => WORKSPACE_CONTENT_GC_LEASE_SK
};

export function containsWorkspaceContentRef(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsWorkspaceContentRef(entry, seen));
  const record = value as Record<string, unknown>;
  if (
    typeof record.bucket === "string" && typeof record.key === "string" &&
    typeof record.versionId === "string" && typeof record.sha256 === "string" &&
    typeof record.byteLength === "number" && typeof record.storedByteLength === "number" &&
    typeof record.mimeType === "string" &&
    (record.contentEncoding === "identity" || record.contentEncoding === "gzip")
  ) return true;
  return Object.values(record).some((entry) => containsWorkspaceContentRef(entry, seen));
}

export function workspaceContentGcWriteGuard(
  tableName: string,
  tenantId: string,
  nowMs = Date.now()
): NonNullable<TransactWriteCommandInput["TransactItems"]>[number] {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { pk: workspaceContentGcLeasePk(tenantId), sk: workspaceSk.contentGcLease() },
      ConditionExpression: "attribute_not_exists(#pk) OR #drainUntilMs <= :safeNow",
      ExpressionAttributeNames: { "#pk": "pk", "#drainUntilMs": "drainUntilMs" },
      ExpressionAttributeValues: {
        ":safeNow": Math.max(0, Math.floor(nowMs - WORKSPACE_CONTENT_GC_CLOCK_SKEW_MS))
      }
    }
  };
}

export function workspaceKeySegment(value: string, label: string) {
  if (typeof value !== "string") throw new WorkspaceValidationError(`${label} must be a string.`);
  const trimmed = value.trim();
  const byteLength = Buffer.byteLength(trimmed, "utf8");
  if (!trimmed || byteLength > 180 || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new WorkspaceValidationError(`${label} must be 1-180 UTF-8 bytes without control characters.`);
  }
  return encodeURIComponent(trimmed);
}

function padSequence(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 999_999_999_999) {
    throw new WorkspaceValidationError(`${label} must be a non-negative safe integer.`);
  }
  return value.toString().padStart(12, "0");
}

function sortableTimestamp(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new WorkspaceValidationError("Audit timestamp is invalid.");
  return new Date(timestamp).toISOString();
}

export function serializedJsonBytes(value: unknown) {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new WorkspaceValidationError("Workspace value must be JSON serializable.");
  }
  if (serialized === undefined) throw new WorkspaceValidationError("Workspace value must be JSON serializable.");
  return Buffer.byteLength(serialized, "utf8");
}

export function assertWorkspaceItemSize(item: WorkspaceItem, cap = WORKSPACE_ITEM_MAX_BYTES) {
  const size = serializedJsonBytes(item);
  if (size > cap) {
    throw new WorkspaceValidationError(
      `Workspace ${item.entityType} item is ${size} bytes; the maximum is ${cap} bytes.`
    );
  }
  return size;
}

export function assertWorkspaceResponseSize(value: unknown, cap = WORKSPACE_RESPONSE_MAX_BYTES) {
  const size = serializedJsonBytes(value);
  if (size > cap) {
    throw new WorkspaceValidationError(
      `Workspace response is ${size} bytes; the maximum is ${cap} bytes. Request a smaller page.`
    );
  }
  return size;
}

export function assertUtf8Field(value: string, label: string, maxBytes: number) {
  if (typeof value !== "string") throw new WorkspaceValidationError(`${label} must be a string.`);
  const size = Buffer.byteLength(value, "utf8");
  if (size > maxBytes) {
    throw new WorkspaceValidationError(`${label} is ${size} bytes; the maximum is ${maxBytes} bytes.`);
  }
  return size;
}

export function stableCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Canonical(value: unknown) {
  return createHash("sha256").update(stableCanonicalJson(value)).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new WorkspaceValidationError("Workspace values may not contain non-finite numbers.");
  }
  return value;
}

export class WorkspaceCursorCodec {
  constructor(
    private readonly keyRing: WorkspaceCursorKeyRing,
    private readonly now: () => number = Date.now
  ) {
    const active = keyRing.keys[keyRing.activeKeyId];
    if (!active || keyBytes(active).byteLength < 32) {
      throw new WorkspaceValidationError("The active workspace cursor key must be at least 32 bytes.");
    }
    for (const [keyId, key] of Object.entries(keyRing.keys)) {
      workspaceKeySegment(keyId, "cursor key id");
      if (keyBytes(key).byteLength < 32) {
        throw new WorkspaceValidationError(`Workspace cursor key ${keyId} must be at least 32 bytes.`);
      }
    }
  }

  encode(
    payload: Omit<WorkspaceCursorPayload, "v" | "exp"> & { exp?: number },
    ttlMs = 15 * 60 * 1000
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60 * 1000) {
      throw new WorkspaceValidationError("Cursor TTL must be from 1 ms through 24 hours.");
    }
    validateCursorKey(payload.lastEvaluatedKey, payload.pk);
    const fullPayload: WorkspaceCursorPayload = {
      ...payload,
      v: 1,
      exp: payload.exp ?? this.now() + ttlMs
    };
    const encodedPayload = Buffer.from(stableCanonicalJson(fullPayload)).toString("base64url");
    const keyId = this.keyRing.activeKeyId;
    const unsigned = `${keyId}.${encodedPayload}`;
    const signature = createHmac("sha256", keyBytes(this.keyRing.keys[keyId]!))
      .update(unsigned)
      .digest("base64url");
    const token = `${unsigned}.${signature}`;
    if (Buffer.byteLength(token, "utf8") > WORKSPACE_CURSOR_MAX_BYTES) {
      throw new WorkspaceValidationError("Cursor is too large.");
    }
    return token;
  }

  decode(token: string, expected: WorkspaceCursorExpectation): WorkspaceCursorPayload {
    if (!token || Buffer.byteLength(token, "utf8") > WORKSPACE_CURSOR_MAX_BYTES) {
      throw new WorkspaceValidationError("Cursor is invalid.");
    }
    const segments = token.split(".");
    if (segments.length !== 3) throw new WorkspaceValidationError("Cursor is invalid.");
    const [keyId, encodedPayload, suppliedSignature] = segments;
    const key = this.keyRing.keys[keyId];
    if (!key) throw new WorkspaceValidationError("Cursor signing key is unknown.");
    const unsigned = `${keyId}.${encodedPayload}`;
    const expectedSignature = createHmac("sha256", keyBytes(key)).update(unsigned).digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(suppliedSignature, "base64url");
    } catch {
      throw new WorkspaceValidationError("Cursor signature is invalid.");
    }
    if (supplied.byteLength !== expectedSignature.byteLength || !timingSafeEqual(supplied, expectedSignature)) {
      throw new WorkspaceValidationError("Cursor signature is invalid.");
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    } catch {
      throw new WorkspaceValidationError("Cursor payload is invalid.");
    }
    if (!isRecord(decoded)) throw new WorkspaceValidationError("Cursor payload is invalid.");
    const payload = decoded as unknown as WorkspaceCursorPayload;
    if (
      payload.v !== 1 ||
      payload.pk !== expected.pk ||
      payload.prefix !== expected.prefix ||
      payload.queryHash !== expected.queryHash ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= this.now()
    ) {
      throw new WorkspaceValidationError("Cursor does not match this query or has expired.");
    }
    validateCursorKey(payload.lastEvaluatedKey, expected.pk);
    return payload;
  }
}

function keyBytes(value: string | Uint8Array) {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

function validateCursorKey(value: unknown, expectedPk: string) {
  if (!isRecord(value) || value.pk !== expectedPk || typeof value.sk !== "string") {
    throw new WorkspaceValidationError("Cursor continuation key is invalid for this identity.");
  }
  if (Object.keys(value).some((key) => ![
    "pk", "sk", "gsi1pk", "gsi1sk", "gsi2pk", "gsi2sk"
  ].includes(key))) {
    throw new WorkspaceValidationError("Cursor continuation key contains unexpected attributes.");
  }
}

export interface PutWorkspaceContentInput {
  tenantId: string;
  userId: string;
  entity: string;
  id: string;
  body: string | Uint8Array;
  mimeType: string;
  maxBytes: number;
}

export interface WorkspaceContentStore {
  putImmutable(input: PutWorkspaceContentInput): Promise<WorkspaceContentRef>;
  get(
    ref: WorkspaceContentRef,
    maxLogicalBytes: number,
    scope: Pick<PutWorkspaceContentInput, "tenantId" | "userId" | "entity">
  ): Promise<Uint8Array>;
}

/** Deterministic bounded content store for local development and migration tests. */
export class InMemoryWorkspaceContentStore implements WorkspaceContentStore {
  private readonly objects = new Map<string, { body: Buffer; ref: WorkspaceContentRef }>();

  async putImmutable(input: PutWorkspaceContentInput): Promise<WorkspaceContentRef> {
    validateMimeType(input.mimeType);
    const body = typeof input.body === "string" ? Buffer.from(input.body, "utf8") : Buffer.from(input.body);
    if (body.byteLength > input.maxBytes) {
      throw new WorkspaceValidationError(
        `Workspace content is ${body.byteLength} bytes; the maximum is ${input.maxBytes} bytes.`
      );
    }
    const sha256 = createHash("sha256").update(body).digest("hex");
    const key = workspaceContentKey(input, sha256);
    const existing = this.objects.get(key);
    if (existing) {
      if (!safeDigestEqual(existing.ref.sha256, sha256) || !existing.body.equals(body)) {
        throw new WorkspaceIntegrityError("Immutable local content key collision.");
      }
      return structuredClone(existing.ref);
    }
    const ref: WorkspaceContentRef = {
      bucket: "rulix-workspace-memory",
      key,
      versionId: `memory-${sha256}`,
      sha256,
      byteLength: body.byteLength,
      storedByteLength: body.byteLength,
      mimeType: input.mimeType,
      contentEncoding: "identity"
    };
    this.objects.set(key, { body, ref });
    return structuredClone(ref);
  }

  async get(
    ref: WorkspaceContentRef,
    maxLogicalBytes: number,
    scope: Pick<PutWorkspaceContentInput, "tenantId" | "userId" | "entity">
  ) {
    if (ref.bucket !== "rulix-workspace-memory" || !ref.key.startsWith(workspaceContentPrefix(scope))) {
      throw new WorkspaceIntegrityError("Workspace content pointer is outside its authorized bucket or identity scope.");
    }
    const existing = this.objects.get(ref.key);
    if (!existing || existing.ref.versionId !== ref.versionId) {
      throw new WorkspaceIntegrityError("Immutable local content version is missing.");
    }
    validateContentRef(ref, maxLogicalBytes);
    if (!existing.body.equals(Buffer.from(existing.body)) || !safeDigestEqual(existing.ref.sha256, ref.sha256)) {
      throw new WorkspaceIntegrityError("Immutable local content digest mismatch.");
    }
    return Buffer.from(existing.body);
  }

}

export class S3WorkspaceContentStore implements WorkspaceContentStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    private readonly kmsKeyId: string,
    options: { client?: S3Client; clientConfig?: S3ClientConfig } = {}
  ) {
    if (!validBucketName(bucket) || !boundedVisibleAscii(kmsKeyId, 1, 2048)) {
      throw new WorkspaceValidationError("Workspace content bucket and KMS key are required.");
    }
    this.client = options.client ?? new S3Client(options.clientConfig ?? {});
  }

  async putImmutable(input: PutWorkspaceContentInput): Promise<WorkspaceContentRef> {
    validateMimeType(input.mimeType);
    const body = typeof input.body === "string" ? Buffer.from(input.body, "utf8") : Buffer.from(input.body);
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 || body.byteLength > input.maxBytes) {
      throw new WorkspaceValidationError(
        `Workspace content is ${body.byteLength} bytes; the maximum is ${input.maxBytes} bytes.`
      );
    }
    const sha256 = createHash("sha256").update(body).digest("hex");
    const key = workspaceContentKey(input, sha256);
    try {
      const response = await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: input.mimeType,
        ContentLength: body.byteLength,
        IfNoneMatch: "*",
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: this.kmsKeyId,
        Metadata: {
          sha256,
          logicalbytes: String(body.byteLength),
          encoding: "identity"
        }
      }));
      if (!response.VersionId) {
        throw new WorkspaceIntegrityError("The versioned content bucket did not return an object version ID.");
      }
      const ref: WorkspaceContentRef = {
        bucket: this.bucket,
        key,
        versionId: response.VersionId,
        sha256,
        byteLength: body.byteLength,
        storedByteLength: body.byteLength,
        mimeType: input.mimeType,
        contentEncoding: "identity"
      };
      return ref;
    } catch (error) {
      if (!isS3PreconditionFailure(error)) throw error;
      // Another idempotent writer already created the deterministic object. Read
      // and hash the current version before committing its exact VersionId.
      const ref = await readVerifiedExistingRefWithRetry(
        this.client,
        { bucket: this.bucket, key, sha256, byteLength: body.byteLength, mimeType: input.mimeType },
        input.maxBytes
      );
      return ref;
    }
  }

  async get(
    ref: WorkspaceContentRef,
    maxLogicalBytes: number,
    scope: Pick<PutWorkspaceContentInput, "tenantId" | "userId" | "entity">
  ) {
    validateContentRef(ref, maxLogicalBytes);
    const expectedPrefix = workspaceContentPrefix(scope);
    if (ref.bucket !== this.bucket || !ref.key.startsWith(expectedPrefix)) {
      throw new WorkspaceIntegrityError("Workspace content pointer is outside its authorized bucket or identity scope.");
    }
    const response = await this.client.send(new GetObjectCommand({
      Bucket: ref.bucket,
      Key: ref.key,
      VersionId: ref.versionId
    }));
    if (response.VersionId !== ref.versionId) {
      throw new WorkspaceIntegrityError("S3 returned a different content version than the committed pointer.");
    }
    const stored = await readS3BodyBounded(response.Body, ref.storedByteLength);
    let logical: Buffer;
    if (ref.contentEncoding === "gzip") {
      try {
        logical = gunzipSync(stored, { maxOutputLength: maxLogicalBytes });
      } catch {
        throw new WorkspaceIntegrityError("Workspace content decompression failed or exceeded its limit.");
      }
    } else {
      logical = stored;
    }
    if (logical.byteLength !== ref.byteLength || logical.byteLength > maxLogicalBytes) {
      throw new WorkspaceIntegrityError("Workspace content length does not match its committed pointer.");
    }
    const digest = createHash("sha256").update(logical).digest("hex");
    if (!safeDigestEqual(digest, ref.sha256)) {
      throw new WorkspaceIntegrityError("Workspace content digest does not match its committed pointer.");
    }
    return logical;
  }

}

async function readVerifiedExistingRefWithRetry(
  client: S3Client,
  expected: Pick<WorkspaceContentRef, "bucket" | "key" | "sha256" | "byteLength" | "mimeType">,
  maxBytes: number
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: expected.bucket, Key: expected.key }));
      return await verifiedExistingRef(response, expected, maxBytes);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function verifiedExistingRef(
  response: GetObjectOutput,
  expected: Pick<WorkspaceContentRef, "bucket" | "key" | "sha256" | "byteLength" | "mimeType">,
  maxBytes: number
): Promise<WorkspaceContentRef> {
  if (!response.VersionId) throw new WorkspaceIntegrityError("Existing content has no version ID.");
  const body = await readS3BodyBounded(response.Body, maxBytes);
  if (body.byteLength !== expected.byteLength) {
    throw new WorkspaceIntegrityError("Existing content length does not match the idempotent write.");
  }
  const digest = createHash("sha256").update(body).digest("hex");
  if (!safeDigestEqual(digest, expected.sha256)) {
    throw new WorkspaceIntegrityError("Existing content digest does not match the idempotent write.");
  }
  return {
    ...expected,
    versionId: response.VersionId,
    storedByteLength: body.byteLength,
    contentEncoding: "identity"
  };
}

function validateContentRef(ref: WorkspaceContentRef, maxLogicalBytes: number) {
  const maxStoredBytes = maxLogicalBytes + WORKSPACE_CONTENT_STORED_OVERHEAD_BYTES;
  if (
    !validBucketName(ref.bucket) || !boundedVisibleAscii(ref.versionId, 1, 1024) ||
    Buffer.byteLength(ref.key, "utf8") < 1 || Buffer.byteLength(ref.key, "utf8") > 1024 ||
    /[\u0000-\u001f\u007f]/u.test(ref.key) || !/^[a-f0-9]{64}$/u.test(ref.sha256) ||
    !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0 || ref.byteLength > maxLogicalBytes ||
    !Number.isSafeInteger(ref.storedByteLength) || ref.storedByteLength < 0 || ref.storedByteLength > maxStoredBytes ||
    !["identity", "gzip"].includes(ref.contentEncoding) || !validMimeType(ref.mimeType)
  ) {
    throw new WorkspaceIntegrityError("Workspace content pointer is invalid.");
  }
}

async function readS3BodyBounded(body: GetObjectOutput["Body"], maxBytes: number) {
  if (!body) throw new WorkspaceIntegrityError("Workspace content body is missing.");
  const chunks: Buffer[] = [];
  let size = 0;
  if (Symbol.asyncIterator in Object(body)) {
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      const buffer = Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxBytes) throw new WorkspaceIntegrityError("Workspace content exceeds its bounded read limit.");
      chunks.push(buffer);
    }
  } else if (body instanceof Uint8Array) {
    size = body.byteLength;
    if (size > maxBytes) throw new WorkspaceIntegrityError("Workspace content exceeds its bounded read limit.");
    chunks.push(Buffer.from(body));
  } else {
    throw new WorkspaceIntegrityError("Workspace content body is not readable.");
  }
  return Buffer.concat(chunks, size);
}

function safeDigestEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function workspaceContentKey(input: PutWorkspaceContentInput, sha256: string) {
  const key = `${workspaceContentPrefix(input)}${workspaceKeySegment(input.id, "content id")}/${sha256}`;
  if (Buffer.byteLength(key, "utf8") > 1024) {
    throw new WorkspaceValidationError("Workspace content key exceeds the S3 key length limit.");
  }
  return key;
}

function workspaceContentPrefix(
  input: Pick<PutWorkspaceContentInput, "tenantId" | "userId" | "entity">
) {
  return `${[
    "tenant",
    workspaceKeySegment(input.tenantId, "tenantId"),
    "user",
    workspaceKeySegment(input.userId, "userId"),
    workspaceKeySegment(input.entity, "entity")
  ].join("/")}/`;
}

function isS3PreconditionFailure(error: unknown) {
  if (!isRecord(error)) return false;
  return error.name === "PreconditionFailed" || error.name === "ConditionalRequestConflict" ||
    error.$metadata && isRecord(error.$metadata) &&
    (error.$metadata.httpStatusCode === 412 || error.$metadata.httpStatusCode === 409);
}

export class NormalizedWorkspaceRepository {
  constructor(
    readonly tableName: string,
    readonly tenantId: string,
    private readonly doc: DynamoDBDocumentClient,
    private readonly cursors: WorkspaceCursorCodec
  ) {
    if (!tableName.trim()) throw new WorkspaceValidationError("Workspace table name is required.");
    workspaceKeySegment(tenantId, "tenantId");
  }

  async getMeta(userId: string, consistentRead = true): Promise<WorkspaceMetaItem | undefined> {
    const pk = workspacePk(this.tenantId, userId);
    const response = await this.doc.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk, sk: workspaceSk.meta() },
      ConsistentRead: consistentRead
    }));
    return response.Item as WorkspaceMetaItem | undefined;
  }

  async requireMigrated(userId: string) {
    const meta = await this.getMeta(userId, true);
    if (!meta || meta.migrationStatus !== "complete" || meta.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
      throw new WorkspaceNotMigratedError();
    }
    return meta;
  }

  async getItem<T extends WorkspaceItem>(userId: string, sk: string, consistentRead = true) {
    const pk = workspacePk(this.tenantId, userId);
    const response = await this.doc.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk, sk },
      ConsistentRead: consistentRead
    }));
    return response.Item as T | undefined;
  }

  async queryPage<T extends WorkspaceItem>(input: {
    userId: string;
    prefix: string;
    limit: number;
    maxLimit: number;
    cursor?: string;
    forward?: boolean;
    indexName?: string;
    indexPk?: string;
    indexPartitionAttribute?: "gsi1pk" | "gsi2pk";
    indexSortAttribute?: "gsi1sk" | "gsi2sk";
  }): Promise<WorkspacePage<T>> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > input.maxLimit) {
      throw new WorkspaceValidationError(`Page limit must be from 1 through ${input.maxLimit}.`);
    }
    const pk = workspacePk(this.tenantId, input.userId);
    const queryHash = sha256Canonical({
      indexName: input.indexName ?? null,
      indexPk: input.indexPk ?? null,
      indexPartitionAttribute: input.indexPartitionAttribute ?? null,
      indexSortAttribute: input.indexSortAttribute ?? null,
      forward: input.forward ?? true,
      limit: input.limit
    });
    const expected = { pk, prefix: input.prefix, queryHash };
    const exclusiveStartKey = input.cursor
      ? this.cursors.decode(input.cursor, expected).lastEvaluatedKey
      : undefined;
    const useIndex = Boolean(input.indexName && input.indexPk);
    const indexPartitionAttribute = input.indexPartitionAttribute ?? "gsi1pk";
    const indexSortAttribute = input.indexSortAttribute ?? "gsi1sk";
    const command: QueryCommandInput = {
      TableName: this.tableName,
      IndexName: input.indexName,
      KeyConditionExpression: useIndex
        ? "#gsi1pk = :gsi1pk AND begins_with(#gsi1sk, :prefix)"
        : "#pk = :pk AND begins_with(#sk, :prefix)",
      ExpressionAttributeNames: useIndex
        ? { "#gsi1pk": indexPartitionAttribute, "#gsi1sk": indexSortAttribute }
        : { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: useIndex
        ? { ":gsi1pk": input.indexPk, ":prefix": input.prefix }
        : { ":pk": pk, ":prefix": input.prefix },
      ExclusiveStartKey: exclusiveStartKey,
      Limit: input.limit,
      ScanIndexForward: input.forward ?? true,
      ConsistentRead: useIndex ? false : true
    };
    const response = await this.doc.send(new QueryCommand(command));
    const items = (response.Items ?? []) as T[];
    const page: WorkspacePage<T> = { items };
    if (response.LastEvaluatedKey) {
      // A GSI continuation key includes both base and index attributes. The
      // cursor validator accepts only this exact allow-list and binds the base PK.
      validateCursorKey(response.LastEvaluatedKey, pk);
      page.nextCursor = this.cursors.encode({ ...expected, lastEvaluatedKey: response.LastEvaluatedKey });
    }
    assertWorkspaceResponseSize(page);
    return page;
  }

  async transact(transactItems: NonNullable<TransactWriteCommandInput["TransactItems"]>) {
    for (const transaction of transactItems) {
      const candidate = "Put" in transaction ? transaction.Put?.Item : undefined;
      if (candidate) assertWorkspaceItemSize(candidate as WorkspaceItem);
    }
    const contentBearing = transactItems.some((transaction) =>
      "Put" in transaction && containsWorkspaceContentRef(transaction.Put?.Item)
    );
    const guardedItems = contentBearing
      ? [workspaceContentGcWriteGuard(this.tableName, this.tenantId), ...transactItems]
      : transactItems;
    if (guardedItems.length > 100) {
      throw new WorkspaceValidationError("A workspace transaction may contain at most 100 operations including safety guards.");
    }
    try {
      await this.doc.send(new TransactWriteCommand({
        TransactItems: guardedItems,
        ClientRequestToken: randomUUID()
      }));
    } catch (error) {
      if (contentBearing && await this.gcGuardRejected(error)) {
        // Never retry this already-materialized pointer after the fence clears:
        // GC may delete its S3 VersionId while the request waits. Retrying the
        // complete API operation re-runs putImmutable and obtains a live version.
        throw new WorkspaceContentGcActiveError();
      }
      if (isDynamoConditionalFailure(error)) throw new WorkspaceConflictError("Workspace version changed.");
      throw error;
    }
  }

  private async gcGuardRejected(error: unknown) {
    if (isRecord(error) && error.name === "TransactionCanceledException") {
      const reasons = error.CancellationReasons;
      if (Array.isArray(reasons) && isRecord(reasons[0]) && reasons[0].Code === "ConditionalCheckFailed") {
        return true;
      }
    }
    // Some SDK/service combinations omit cancellation reasons. A strong read
    // preserves retryable error semantics without weakening the transaction.
    if (!isDynamoConditionalFailure(error)) return false;
    const response = await this.doc.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: workspaceContentGcLeasePk(this.tenantId), sk: workspaceSk.contentGcLease() },
      ConsistentRead: true
    }));
    const drainUntilMs = response.Item?.drainUntilMs;
    if (response.Item && typeof drainUntilMs !== "number") {
      throw new WorkspaceIntegrityError("Workspace content GC lease is malformed; content writes are fenced.");
    }
    return typeof drainUntilMs === "number" &&
      drainUntilMs > Date.now() - WORKSPACE_CONTENT_GC_CLOCK_SKEW_MS;
  }

  outboxItem(userId: string, event: AuditEvent): WorkspaceItem {
    let canonical;
    try {
      canonical = canonicalAuditPayload(userId, event);
    } catch (error) {
      if (error instanceof AuditOutboxContractError) {
        throw new WorkspaceValidationError(error.message);
      }
      throw error;
    }
    const { accountId, auditEvent, payloadHash } = canonical;
    const pk = workspacePk(this.tenantId, userId);
    const item: WorkspaceItem = {
      pk,
      sk: workspaceSk.audit(auditEvent.memoId, auditEvent.at, auditEvent.id),
      schemaVersion: "rulix.audit-outbox/v1",
      entityType: "AU",
      idempotencyKey: auditEvent.id,
      eventId: auditEvent.id,
      accountId,
      createdAt: auditEvent.at,
      updatedAt: auditEvent.at,
      payloadHash,
      auditEvent
    };
    assertWorkspaceItemSize(item, 32 * 1024);
    return item;
  }

  outboxPut(userId: string, event: AuditEvent) {
    const item = this.outboxItem(userId, event);
    return {
      Put: {
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" }
      }
    } satisfies NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
  }
}

export function validateAuthoritativeAuditEvent(event: AuditEvent): AuditEvent {
  try {
    return canonicalizeAuthoritativeAuditEvent(event);
  } catch (error) {
    if (error instanceof AuditOutboxContractError) {
      throw new WorkspaceValidationError(error.message);
    }
    throw error;
  }
}

function isDynamoConditionalFailure(error: unknown) {
  if (!isRecord(error)) return false;
  if (error.name === "ConditionalCheckFailedException") return true;
  if (error.name !== "TransactionCanceledException") return false;
  const reasons = error.CancellationReasons;
  return Array.isArray(reasons) && reasons.some((reason) => isRecord(reason) && reason.Code === "ConditionalCheckFailed");
}

function validateMimeType(value: string) {
  if (!validMimeType(value)) {
    throw new WorkspaceValidationError("Workspace content MIME type must be 1-128 visible ASCII bytes.");
  }
}

function validMimeType(value: unknown): value is string {
  return typeof value === "string" && boundedVisibleAscii(value, 1, 128);
}

function boundedVisibleAscii(value: string, min: number, max: number) {
  const bytes = Buffer.byteLength(value, "ascii");
  return bytes >= min && bytes <= max && /^[\x20-\x7e]+$/u.test(value);
}

function validBucketName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 63 &&
    /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(value) && !value.includes("..") &&
    !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
