import { createHash } from "node:crypto";
import type {
  AiApprovalMemoChatFence,
  AiApprovalPolicyBinding,
  AiApprovalPurpose,
  AiApprovalRecord,
  AiApprovalRequestContext,
  AiApprovalRequestDecision,
  AiApprovalRequestRecord,
  AiApprovalRevocation,
  AiApprovalSubjectBinding,
  DataClass,
  MemoChatMessage,
  MemoBuilderSession
} from "../../src/types";
import { sha256Canonical } from "./hashes";

export const AI_APPROVAL_SCHEMA_VERSION = "rulix.ai-approval/v1" as const;
export const AI_APPROVAL_REVOCATION_SCHEMA_VERSION = "rulix.ai-approval-revocation/v1" as const;
export const AI_APPROVAL_REQUEST_SCHEMA_VERSION = "rulix.ai-approval-request/v1" as const;
export const AI_APPROVAL_REQUEST_DECISION_SCHEMA_VERSION =
  "rulix.ai-approval-request-decision/v1" as const;
export const DEFAULT_AI_APPROVAL_TTL_MS = 15 * 60 * 1_000;
export const MAX_AI_APPROVAL_TTL_MS = 60 * 60 * 1_000;
export const MAX_AI_APPROVAL_DISPATCHES = 2;

const PURPOSES = new Set<AiApprovalPurpose>([
  "council",
  "memo-chat",
  "public-draft",
  "outreach-writer",
  "outreach-personalization",
  "lead-search",
  "memo-builder",
  "document-extraction"
]);
const DATA_CLASSES = new Set<DataClass>([
  "public",
  "proprietary",
  "export-controlled",
  "itar-risk",
  "cui"
]);
const SUBJECT_KINDS = new Set<AiApprovalSubjectBinding["kind"]>([
  "review",
  "document",
  "memo-builder"
]);
const SHA_256 = /^[a-f0-9]{64}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:@/-]+$/u;

export class AiApprovalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiApprovalValidationError";
  }
}

/** Hashes an exact JSON payload without retaining its content. */
export function hashAiApprovalPayload(value: unknown) {
  return sha256Canonical(value);
}

/** The persisted builder session is the entire approved subject snapshot. */
export function hashAiBuilderSession(session: MemoBuilderSession) {
  return sha256Canonical(session);
}

export const AI_APPROVAL_CHAT_HISTORY_SCHEMA_VERSION = "rulix.memo-chat-history/v1" as const;

export interface AiApprovalChatHistoryEntry {
  id: string;
  createdAt: string;
  sequence: number;
  messageHash: string;
}

/** Compact canonical entry retained in CHAT_META so the authoritative latest
 * 200-message hash can be advanced atomically without rereading an eventual
 * GSI or persisting message content in the meta item. */
export function aiApprovalChatHistoryEntry(message: MemoChatMessage): AiApprovalChatHistoryEntry {
  const sequence = nonNegativeSafeInteger(message.sequence, "Memo-chat history sequence");
  return {
    id: boundedIdentifier(message.id, "Memo-chat history message ID", 1, 512),
    createdAt: validIsoDate(message.createdAt, "Memo-chat history message timestamp"),
    sequence,
    messageHash: sha256Canonical(message)
  };
}

export function hashAiApprovalChatHistoryEntries(entries: AiApprovalChatHistoryEntry[]) {
  const canonical = entries.map((entry) => ({
    id: boundedIdentifier(entry.id, "Memo-chat history message ID", 1, 512),
    createdAt: validIsoDate(entry.createdAt, "Memo-chat history message timestamp"),
    sequence: nonNegativeSafeInteger(entry.sequence, "Memo-chat history sequence"),
    messageHash: digest(entry.messageHash, "Memo-chat history message hash")
  })).sort((left, right) =>
    left.sequence - right.sequence || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  return sha256Canonical({
    schemaVersion: AI_APPROVAL_CHAT_HISTORY_SCHEMA_VERSION,
    messages: canonical
  });
}

/** Binds the exact ordered server chat window included in a memo-chat call. */
export function hashAiApprovalChatHistory(history: MemoChatMessage[]) {
  const ordered = [...history].sort((left, right) => {
    if (left.sequence !== undefined && right.sequence !== undefined) return left.sequence - right.sequence;
    return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  });
  return hashAiApprovalChatHistoryEntries(ordered.map((message, index) =>
    aiApprovalChatHistoryEntry({ ...message, sequence: message.sequence ?? index })));
}

export function assertAiApprovalMemoChatFence(value: unknown): AiApprovalMemoChatFence {
  if (!isRecord(value) || !hasExactKeys(value, ["chatMeta", "historyHash"]) ||
      !isRecord(value.chatMeta)) {
    throw new AiApprovalValidationError("Memo-chat approval fence is invalid.");
  }
  const historyHash = digest(value.historyHash, "Memo-chat approval history hash");
  if (value.chatMeta.exists === false && hasExactKeys(value.chatMeta, ["exists"])) {
    return { historyHash, chatMeta: { exists: false } };
  }
  if (value.chatMeta.exists === true &&
      hasExactKeys(value.chatMeta, ["entityVersion", "exists", "nextSequence"])) {
    return {
      historyHash,
      chatMeta: {
        exists: true,
        entityVersion: positiveSafeInteger(value.chatMeta.entityVersion, "Memo-chat meta version"),
        nextSequence: nonNegativeSafeInteger(value.chatMeta.nextSequence, "Memo-chat next sequence")
      }
    };
  }
  throw new AiApprovalValidationError("Memo-chat approval meta fence is invalid.");
}

export function assertAiApprovalSubject(value: unknown): AiApprovalSubjectBinding {
  if (!isRecord(value) || !SUBJECT_KINDS.has(value.kind as AiApprovalSubjectBinding["kind"])) {
    throw new AiApprovalValidationError("AI approval subject kind is not recognized.");
  }
  const id = boundedIdentifier(value.id, "AI approval subject ID", 1, 512);
  const version = positiveSafeInteger(value.version, "AI approval subject version");
  const revision = value.revision === undefined
    ? undefined
    : positiveSafeInteger(value.revision, "AI approval subject revision");
  const contentHash = digest(value.contentHash, "AI approval subject content hash");
  if (value.kind === "review" && revision === undefined) {
    throw new AiApprovalValidationError("Review AI approvals require an exact revision binding.");
  }
  if (value.kind !== "review" && revision !== undefined) {
    throw new AiApprovalValidationError("Only review AI approvals may carry a revision binding.");
  }
  return {
    kind: value.kind as AiApprovalSubjectBinding["kind"],
    id,
    version,
    ...(revision === undefined ? {} : { revision }),
    contentHash
  };
}

export function assertAiApprovalPolicy(value: unknown): AiApprovalPolicyBinding {
  if (!isRecord(value)) throw new AiApprovalValidationError("AI approval policy binding is required.");
  const version = boundedIdentifier(value.version, "AI approval policy version", 1, 128);
  if (value.mode !== "blocked" && value.mode !== "approved") {
    throw new AiApprovalValidationError("AI approval policy mode is not recognized.");
  }
  if (value.provider !== "amazon-bedrock" && value.provider !== "anthropic-direct") {
    throw new AiApprovalValidationError("AI approval provider is not recognized.");
  }
  const clientRegion = boundedIdentifier(value.clientRegion, "AI approval client Region", 1, 128).toLowerCase();
  const model = boundedIdentifier(value.model, "AI approval model", 1, 2_048);
  return {
    version,
    mode: value.mode,
    provider: value.provider,
    clientRegion,
    model
  };
}

/** Strictly validates persisted records. Unknown enum values fail closed. */
export function assertAiApprovalRecord(value: unknown): AiApprovalRecord {
  if (!isRecord(value) || value.schemaVersion !== AI_APPROVAL_SCHEMA_VERSION) {
    throw new AiApprovalValidationError("Persisted AI approval schema is not recognized.");
  }
  const purpose = value.purpose;
  const dataClass = value.dataClass;
  if (!PURPOSES.has(purpose as AiApprovalPurpose)) {
    throw new AiApprovalValidationError("Persisted AI approval purpose is not recognized.");
  }
  if (!DATA_CLASSES.has(dataClass as DataClass)) {
    throw new AiApprovalValidationError("Persisted AI approval data class is not recognized.");
  }
  if (!isRecord(value.approvedBy) || value.approvedBy.role !== "export-control-officer") {
    throw new AiApprovalValidationError("Persisted AI approval has no authorized officer binding.");
  }
  const approvedAt = validIsoDate(value.approvedAt, "AI approval timestamp");
  const expiresAt = validIsoDate(value.expiresAt, "AI approval expiry");
  const validUntilEpoch = positiveSafeInteger(value.validUntilEpoch, "AI approval validity epoch");
  const expiresAtEpoch = positiveSafeInteger(value.expiresAtEpoch, "AI approval retention epoch");
  if (Math.floor(Date.parse(expiresAt) / 1_000) !== validUntilEpoch) {
    throw new AiApprovalValidationError("Persisted AI approval expiry fields do not match.");
  }
  if (expiresAtEpoch <= validUntilEpoch) {
    throw new AiApprovalValidationError("Persisted AI approval retention must outlive authorization validity.");
  }
  if (Date.parse(expiresAt) <= Date.parse(approvedAt)) {
    throw new AiApprovalValidationError("Persisted AI approval expiry is not after its approval time.");
  }
  const dispatchLimit = positiveSafeInteger(value.dispatchLimit, "AI approval dispatch limit");
  if (dispatchLimit > MAX_AI_APPROVAL_DISPATCHES) {
    throw new AiApprovalValidationError("Persisted AI approval dispatch limit exceeds policy.");
  }
  if (!Array.isArray(value.providerRequestHashes) || value.providerRequestHashes.length !== dispatchLimit) {
    throw new AiApprovalValidationError(
      "Persisted AI approval must bind one exact provider request hash per dispatch."
    );
  }
  const providerRequestHashes = value.providerRequestHashes.map((item) =>
    digest(item, "AI approval provider request hash"));
  if (new Set(providerRequestHashes).size !== providerRequestHashes.length) {
    throw new AiApprovalValidationError("Persisted AI approval provider request hashes must be unique.");
  }
  const memoChatFence = value.memoChatFence === undefined
    ? undefined
    : assertAiApprovalMemoChatFence(value.memoChatFence);
  if ((purpose === "memo-chat") !== Boolean(memoChatFence)) {
    throw new AiApprovalValidationError(
      "Persisted memo-chat approvals require exactly one server-owned chat fence."
    );
  }
  return {
    schemaVersion: AI_APPROVAL_SCHEMA_VERSION,
    id: boundedIdentifier(value.id, "AI approval ID", 1, 160),
    requestId: boundedIdentifier(value.requestId, "AI approval request ID", 1, 160),
    commandHash: digest(value.commandHash, "AI approval command hash"),
    tenantId: boundedIdentifier(value.tenantId, "AI approval tenant ID", 1, 160),
    accountId: boundedIdentifier(value.accountId, "AI approval account ID", 1, 512),
    purpose: purpose as AiApprovalPurpose,
    subject: assertAiApprovalSubject(value.subject),
    payloadHash: digest(value.payloadHash, "AI approval payload hash"),
    providerRequestHashes,
    dataClass: dataClass as DataClass,
    policy: assertAiApprovalPolicy(value.policy),
    ...(memoChatFence ? { memoChatFence } : {}),
    approvedBy: {
      id: boundedIdentifier(value.approvedBy.id, "AI approval officer ID", 1, 512),
      role: "export-control-officer"
    },
    approvedAt,
    expiresAt,
    validUntilEpoch,
    expiresAtEpoch,
    dispatchLimit
  };
}

export function assertAiApprovalRevocation(value: unknown): AiApprovalRevocation {
  if (!isRecord(value) || value.schemaVersion !== AI_APPROVAL_REVOCATION_SCHEMA_VERSION) {
    throw new AiApprovalValidationError("Persisted AI approval revocation schema is not recognized.");
  }
  return {
    schemaVersion: AI_APPROVAL_REVOCATION_SCHEMA_VERSION,
    approvalId: boundedIdentifier(value.approvalId, "AI approval revocation ID", 1, 160),
    accountId: boundedIdentifier(value.accountId, "AI approval revocation account", 1, 512),
    requestId: boundedIdentifier(value.requestId, "AI approval revocation request ID", 1, 160),
    commandHash: digest(value.commandHash, "AI approval revocation command hash"),
    revokedBy: boundedIdentifier(value.revokedBy, "AI approval revoking officer", 1, 512),
    revokedAt: validIsoDate(value.revokedAt, "AI approval revocation timestamp"),
    reason: boundedText(value.reason, "AI approval revocation reason", 1, 500)
  };
}

export function assertAiApprovalRequestRecord(value: unknown): AiApprovalRequestRecord {
  if (!isRecord(value) || value.schemaVersion !== AI_APPROVAL_REQUEST_SCHEMA_VERSION) {
    throw new AiApprovalValidationError("Persisted AI approval request schema is not recognized.");
  }
  if (value.purpose !== "council" && value.purpose !== "memo-chat" && value.purpose !== "memo-builder") {
    throw new AiApprovalValidationError("Persisted AI approval request purpose is not recognized.");
  }
  if (!isRecord(value.requestedBy) || !isUserRole(value.requestedBy.role)) {
    throw new AiApprovalValidationError("Persisted AI approval requester binding is invalid.");
  }
  if (!DATA_CLASSES.has(value.dataClass as DataClass)) {
    throw new AiApprovalValidationError("Persisted AI approval request data class is not recognized.");
  }
  const subject = assertAiApprovalSubject(value.subject);
  const context = assertAiApprovalRequestContext(value.context);
  assertApprovalRequestPurposeBinding(value.purpose, subject, context);
  if (!Array.isArray(value.providerRequestHashes) || value.providerRequestHashes.length !== 1) {
    throw new AiApprovalValidationError("AI approval requests must bind exactly one provider request.");
  }
  const providerRequestHashes = value.providerRequestHashes.map((hash) =>
    digest(hash, "AI approval request provider hash"));
  const createdAt = validIsoDate(value.createdAt, "AI approval request creation time");
  const expiresAt = validIsoDate(value.expiresAt, "AI approval request expiry");
  const validUntilEpoch = positiveSafeInteger(value.validUntilEpoch, "AI approval request validity epoch");
  const expiresAtEpoch = positiveSafeInteger(value.expiresAtEpoch, "AI approval request retention epoch");
  if (Math.floor(Date.parse(expiresAt) / 1_000) !== validUntilEpoch ||
      Date.parse(expiresAt) <= Date.parse(createdAt) || expiresAtEpoch <= validUntilEpoch) {
    throw new AiApprovalValidationError("Persisted AI approval request expiry fields are invalid.");
  }
  const policy = assertAiApprovalPolicy(value.policy);
  if (policy.mode !== "approved") {
    throw new AiApprovalValidationError("Persisted AI approval request policy is not approved.");
  }
  return {
    schemaVersion: AI_APPROVAL_REQUEST_SCHEMA_VERSION,
    id: boundedIdentifier(value.id, "AI approval request ID", 1, 160),
    requestId: boundedIdentifier(value.requestId, "AI approval request idempotency key", 1, 160),
    commandHash: digest(value.commandHash, "AI approval request command hash"),
    dedupeHash: digest(value.dedupeHash, "AI approval request dedupe hash"),
    tenantId: boundedIdentifier(value.tenantId, "AI approval request tenant", 1, 160),
    targetAccountId: boundedIdentifier(value.targetAccountId, "AI approval target account", 1, 512),
    requestedBy: {
      id: boundedIdentifier(value.requestedBy.id, "AI approval requester ID", 1, 512),
      role: value.requestedBy.role
    },
    purpose: value.purpose,
    subject,
    payloadHash: digest(value.payloadHash, "AI approval request payload hash"),
    providerRequestHashes,
    dataClass: value.dataClass as DataClass,
    policy,
    context,
    createdAt,
    expiresAt,
    validUntilEpoch,
    expiresAtEpoch
  };
}

export function assertAiApprovalRequestDecision(value: unknown): AiApprovalRequestDecision {
  if (!isRecord(value) || value.schemaVersion !== AI_APPROVAL_REQUEST_DECISION_SCHEMA_VERSION) {
    throw new AiApprovalValidationError("Persisted AI approval request decision schema is not recognized.");
  }
  if (value.decision !== "approved" && value.decision !== "cancelled" && value.decision !== "rejected") {
    throw new AiApprovalValidationError("Persisted AI approval request decision is not recognized.");
  }
  if (!isRecord(value.decidedBy) || !isUserRole(value.decidedBy.role)) {
    throw new AiApprovalValidationError("Persisted AI approval decision actor is invalid.");
  }
  if ((value.decision === "approved" || value.decision === "rejected") &&
      value.decidedBy.role !== "export-control-officer") {
    throw new AiApprovalValidationError("Persisted officer decision has no officer binding.");
  }
  const reason = value.reason === undefined
    ? undefined
    : boundedText(value.reason, "AI approval decision reason", 1, 500);
  const approvalId = value.approvalId === undefined
    ? undefined
    : boundedIdentifier(value.approvalId, "AI approval decision approval ID", 1, 160);
  if (value.decision === "approved" ? !approvalId || reason !== undefined : !reason || approvalId !== undefined) {
    throw new AiApprovalValidationError("Persisted AI approval decision fields do not match its outcome.");
  }
  return {
    schemaVersion: AI_APPROVAL_REQUEST_DECISION_SCHEMA_VERSION,
    requestId: boundedIdentifier(value.requestId, "AI approval decision request ID", 1, 160),
    targetAccountId: boundedIdentifier(value.targetAccountId, "AI approval decision account", 1, 512),
    decisionRequestId: boundedIdentifier(value.decisionRequestId, "AI approval decision idempotency key", 1, 160),
    commandHash: digest(value.commandHash, "AI approval decision command hash"),
    decision: value.decision,
    decidedBy: {
      id: boundedIdentifier(value.decidedBy.id, "AI approval decision actor ID", 1, 512),
      role: value.decidedBy.role
    },
    decidedAt: validIsoDate(value.decidedAt, "AI approval decision timestamp"),
    ...(reason ? { reason } : {}),
    ...(approvalId ? { approvalId } : {}),
    expiresAtEpoch: positiveSafeInteger(value.expiresAtEpoch, "AI approval decision retention epoch")
  };
}

export function assertAiApprovalRequestContext(value: unknown): AiApprovalRequestContext {
  if (!isRecord(value)) throw new AiApprovalValidationError("AI approval request context is invalid.");
  if (value.kind === "council" && (value.depth === "standard" || value.depth === "deep") &&
      hasExactKeys(value, ["depth", "kind"])) {
    return { kind: "council", depth: value.depth };
  }
  if (value.kind === "memo-chat" && hasExactKeys(value, ["historyHash", "kind", "pendingMessageHash"])) {
    return {
      kind: "memo-chat",
      pendingMessageHash: digest(value.pendingMessageHash, "Pending chat message hash"),
      historyHash: digest(value.historyHash, "Memo-chat history hash")
    };
  }
  if (value.kind === "memo-builder" && hasExactKeys(value, ["kind"])) {
    return { kind: "memo-builder" };
  }
  throw new AiApprovalValidationError("AI approval request context is not recognized.");
}

export function createAiApprovalId(accountId: string, requestId: string) {
  const digest = createHash("sha256").update(`${accountId}\u0000${requestId}`, "utf8").digest("hex");
  return `aia-${digest.slice(0, 40)}`;
}

export function aiApprovalCurrentIdentity(
  subject: Pick<AiApprovalSubjectBinding, "kind" | "id">,
  purpose: AiApprovalPurpose
) {
  return `${subject.kind}\u0000${subject.id}\u0000${purpose}`;
}

export function sameAiApprovalSubject(left: AiApprovalSubjectBinding, right: AiApprovalSubjectBinding) {
  return left.kind === right.kind &&
    left.id === right.id &&
    left.version === right.version &&
    left.revision === right.revision &&
    left.contentHash === right.contentHash;
}

export function sameAiApprovalPolicy(left: AiApprovalPolicyBinding, right: AiApprovalPolicyBinding) {
  return left.version === right.version &&
    left.mode === right.mode &&
    left.provider === right.provider &&
    left.clientRegion === right.clientRegion &&
    left.model === right.model;
}

export function isAiApprovalPurpose(value: unknown): value is AiApprovalPurpose {
  return PURPOSES.has(value as AiApprovalPurpose);
}

export function isDataClass(value: unknown): value is DataClass {
  return DATA_CLASSES.has(value as DataClass);
}

export function assertSha256(value: unknown, label = "SHA-256 digest") {
  return digest(value, label);
}

function boundedIdentifier(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== "string" || value.length < min || value.length > max ||
      value !== value.trim() || !SAFE_IDENTIFIER.test(value)) {
    throw new AiApprovalValidationError(`${label} is invalid.`);
  }
  return value;
}

function boundedText(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== "string" || value.length < min || value.length > max || value !== value.trim()) {
    throw new AiApprovalValidationError(`${label} is invalid.`);
  }
  return value;
}

function digest(value: unknown, label: string) {
  if (typeof value !== "string" || !SHA_256.test(value)) {
    throw new AiApprovalValidationError(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AiApprovalValidationError(`${label} must be a positive safe integer.`);
  }
  return value as number;
}

function nonNegativeSafeInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AiApprovalValidationError(`${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function validIsoDate(value: unknown, label: string) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new AiApprovalValidationError(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function assertApprovalRequestPurposeBinding(
  purpose: "council" | "memo-chat" | "memo-builder",
  subject: AiApprovalSubjectBinding,
  context: AiApprovalRequestContext
) {
  const valid = purpose === "council"
    ? subject.kind === "review" && context.kind === "council"
    : purpose === "memo-chat"
      ? subject.kind === "review" && context.kind === "memo-chat"
      : subject.kind === "memo-builder" && context.kind === "memo-builder";
  if (!valid) throw new AiApprovalValidationError("AI approval request purpose binding is invalid.");
}

function isUserRole(value: unknown): value is AiApprovalRequestRecord["requestedBy"]["role"] {
  return value === "export-control-officer" || value === "reviewer" || value === "submitter" || value === "counsel";
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
