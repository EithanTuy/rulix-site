import type { AuditEvent } from "../src/types";
import { sha256Canonical } from "./domain/hashes";

export const AUDIT_OUTBOX_SCHEMA = "rulix.audit-outbox/v1" as const;

const AUDIT_EVENT_KEYS = new Set([
  "action",
  "actor",
  "actorId",
  "at",
  "detail",
  "eventHash",
  "id",
  "memoId",
  "metadata",
  "organizationId",
  "previousHash",
  "severity"
]);
const RESERVED_METADATA_KEYS = new Set([
  "tenantId",
  "tenantReviewId",
  "writerId",
  "writerType"
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/;
const REVIEW_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface AuthoritativeAuditProvenance {
  actorType: "user" | "service";
  source: "authenticated-api" | "analysis-worker" | "system";
  outcome: "succeeded" | "denied" | "failed";
  subjectType: "review" | "workspace" | "builder-session" | "outreach";
  subjectId: string;
}

export type AuthoritativeAuditMetadata = AuthoritativeAuditProvenance &
  Record<string, string | number | boolean>;

export type AuthoritativeAuditEvent = Omit<
  AuditEvent,
  "actorId" | "organizationId" | "metadata"
> & {
  actorId: string;
  organizationId: string;
  metadata: AuthoritativeAuditMetadata;
};

export interface CanonicalAuditPayload {
  accountId: string;
  auditEvent: AuthoritativeAuditEvent;
  payloadHash: string;
}

export class AuditOutboxContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditOutboxContractError";
  }
}

/**
 * The producer and consumer both call this function before hashing. Text is
 * required to already be canonical (no surrounding whitespace); optional
 * undefined metadata is removed and metadata keys are sorted deterministically.
 */
export function canonicalAuditPayload(
  accountValue: unknown,
  eventValue: unknown
): CanonicalAuditPayload {
  const accountId = canonicalAuditAccountId(accountValue);
  const auditEvent = canonicalizeAuthoritativeAuditEvent(eventValue);
  return {
    accountId,
    auditEvent,
    payloadHash: sha256Canonical({ accountId, auditEvent })
  };
}

export function canonicalAuditAccountId(value: unknown) {
  return canonicalWorkspaceKey(value, "accountId");
}

export function canonicalizeAuthoritativeAuditEvent(
  value: unknown
): AuthoritativeAuditEvent {
  if (!isPlainRecord(value)) throw new AuditOutboxContractError("auditEvent must be an object.");
  const unknownKey = Object.keys(value).find((key) => !AUDIT_EVENT_KEYS.has(key));
  if (unknownKey) throw new AuditOutboxContractError(`Unexpected auditEvent field: ${unknownKey}.`);

  const id = matchingString(value.id, "auditEvent.id", 128, IDENTIFIER);
  const memoId = matchingString(value.memoId, "auditEvent.memoId", 128, REVIEW_IDENTIFIER);
  const at = canonicalInstant(value.at, "auditEvent.at");
  const actor = canonicalString(value.actor, "auditEvent.actor", 256);
  const actorId = matchingString(value.actorId, "auditEvent.actorId", 128, IDENTIFIER);
  const organizationId = canonicalWorkspaceKey(
    value.organizationId,
    "auditEvent.organizationId"
  );
  const action = canonicalString(value.action, "auditEvent.action", 256);
  const detail = canonicalString(value.detail, "auditEvent.detail", 2_048);
  const severity = enumeration(value.severity, "auditEvent.severity", [
    "info",
    "review",
    "escalate"
  ]);
  const metadata = canonicalizeMetadata(value.metadata, memoId);
  const previousHash = optionalSha256(value.previousHash, "auditEvent.previousHash");
  const eventHash = optionalSha256(value.eventHash, "auditEvent.eventHash");

  return {
    id,
    memoId,
    at,
    actor,
    actorId,
    organizationId,
    action,
    detail,
    severity,
    metadata,
    ...(previousHash ? { previousHash } : {}),
    ...(eventHash ? { eventHash } : {})
  };
}

function canonicalizeMetadata(value: unknown, memoId: string): AuthoritativeAuditMetadata {
  if (!isPlainRecord(value)) {
    throw new AuditOutboxContractError(
      "auditEvent.metadata with authoritative provenance is required."
    );
  }
  const reserved = Object.keys(value).find((key) => RESERVED_METADATA_KEYS.has(key));
  if (reserved) throw new AuditOutboxContractError(`Reserved audit metadata field: ${reserved}.`);

  const output: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(value).sort()) {
    if (!key || key.length > 96 || !/^[A-Za-z][A-Za-z0-9]*$/.test(key)) {
      throw new AuditOutboxContractError("Audit metadata key is invalid.");
    }
    const field = value[key];
    if (field === undefined) continue;
    if (typeof field === "string") {
      output[key] = canonicalString(field, `auditEvent.metadata.${key}`, 512);
      continue;
    }
    if (typeof field === "boolean") {
      output[key] = field;
      continue;
    }
    if (typeof field === "number" && Number.isFinite(field)) {
      output[key] = Object.is(field, -0) ? 0 : field;
      continue;
    }
    throw new AuditOutboxContractError(`Audit metadata ${key} must be a scalar value.`);
  }

  const actorType = enumeration(output.actorType, "auditEvent.metadata.actorType", [
    "user",
    "service"
  ]);
  const source = enumeration(output.source, "auditEvent.metadata.source", [
    "authenticated-api",
    "analysis-worker",
    "system"
  ]);
  const outcome = enumeration(output.outcome, "auditEvent.metadata.outcome", [
    "denied",
    "failed",
    "succeeded"
  ]);
  const subjectType = enumeration(output.subjectType, "auditEvent.metadata.subjectType", [
    "review",
    "workspace",
    "builder-session",
    "outreach"
  ]);
  const subjectId = matchingString(
    output.subjectId,
    "auditEvent.metadata.subjectId",
    128,
    IDENTIFIER
  );
  if (subjectType === "review" && subjectId !== memoId) {
    throw new AuditOutboxContractError(
      "Review audit subject does not match auditEvent.memoId."
    );
  }
  if (
    (source === "authenticated-api" && actorType !== "user")
    || (source !== "authenticated-api" && actorType !== "service")
  ) {
    throw new AuditOutboxContractError("Audit actor type is inconsistent with its source.");
  }

  return {
    ...output,
    actorType,
    source,
    outcome,
    subjectType,
    subjectId
  } as AuthoritativeAuditMetadata;
}

function canonicalWorkspaceKey(value: unknown, label: string) {
  const text = canonicalString(value, label, 180);
  if (Buffer.byteLength(text, "utf8") > 180) {
    throw new AuditOutboxContractError(`${label} exceeds the workspace key limit.`);
  }
  return text;
}

function optionalSha256(value: unknown, label: string) {
  return value === undefined ? undefined : matchingString(value, label, 64, SHA256);
}

function canonicalInstant(value: unknown, label: string) {
  const text = canonicalString(value, label, 24);
  const time = Date.parse(text);
  if (!ISO_INSTANT.test(text) || !Number.isFinite(time) || new Date(time).toISOString() !== text) {
    throw new AuditOutboxContractError(`${label} must be a canonical UTC instant.`);
  }
  return text;
}

function matchingString(
  value: unknown,
  label: string,
  maximum: number,
  pattern: RegExp
) {
  const text = canonicalString(value, label, maximum);
  if (!pattern.test(text)) throw new AuditOutboxContractError(`${label} has an invalid format.`);
  return text;
}

function canonicalString(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string") throw new AuditOutboxContractError(`${label} must be a string.`);
  const trimmed = value.trim();
  if (
    value !== trimmed
    || !value
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new AuditOutboxContractError(`${label} is not in canonical safe-string form.`);
  }
  return value;
}

function enumeration<const T extends string>(value: unknown, label: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new AuditOutboxContractError(`${label} has an invalid value.`);
  }
  return value as T;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
