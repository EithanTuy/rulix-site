import type { UsageEvent, UserAdminSummary, UserProfile } from "../src/types";
import { usageCostUsd } from "./bedrockPricing";
import { sha256Canonical } from "./domain/hashes";
import { onlineWindowMs } from "./metrics";

export const ADMIN_AGGREGATE_SCHEMA_VERSION = 1 as const;
export const MAX_TRACKED_ADMIN_SESSIONS = 64;

export interface AdminUsageAggregate {
  schemaVersion: typeof ADMIN_AGGREGATE_SCHEMA_VERSION;
  version: number;
  userId: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface AdminSessionEntry {
  lastSeenAt: string;
  expiresAt: string;
  authGeneration: number;
}

export interface AdminSessionAggregate {
  schemaVersion: typeof ADMIN_AGGREGATE_SCHEMA_VERSION;
  version: number;
  userId: string;
  sessions: Record<string, AdminSessionEntry>;
}

export interface AdminAggregateMarker {
  schemaVersion: typeof ADMIN_AGGREGATE_SCHEMA_VERSION;
  /** Optimistic-control version. Legacy v1 markers may not have this field. */
  version?: number;
  status: "building" | "complete";
  startedAt: string;
  completedAt?: string;
  buildId?: string;
  leaseExpiresAtEpoch?: number;
  metricsSchemaVersion?: number;
  usersTotal?: number;
  lastUserChangeAt?: string;
  usageEventsProcessed?: number;
  sessionsProcessed?: number;
  sessionsRevoked?: number;
}

export class AdminAggregateIntegrityError extends Error {}
export class AdminSessionCapacityError extends Error {}

export function emptyAdminUsageAggregate(userId: string): AdminUsageAggregate {
  return {
    schemaVersion: ADMIN_AGGREGATE_SCHEMA_VERSION,
    version: 0,
    userId,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    calls: 0
  };
}

export function addUsageToAdminAggregate(
  current: AdminUsageAggregate | undefined,
  event: UsageEvent
): AdminUsageAggregate {
  const aggregate = current ?? emptyAdminUsageAggregate(event.userId);
  if (aggregate.userId !== event.userId) {
    throw new AdminAggregateIntegrityError("Usage aggregate owner does not match the event owner.");
  }
  return {
    ...aggregate,
    version: aggregate.version + 1,
    costUsd: aggregate.costUsd + usageCostUsd(event),
    inputTokens: aggregate.inputTokens + event.inputTokens,
    outputTokens: aggregate.outputTokens + event.outputTokens,
    calls: aggregate.calls + 1
  };
}

export function usageEventHash(event: UsageEvent) {
  return sha256Canonical({
    id: event.id,
    userId: event.userId,
    userEmail: event.userEmail,
    at: event.at,
    model: event.model,
    callType: event.callType,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    latencyMs: event.latencyMs
  });
}

export function emptyAdminSessionAggregate(userId: string): AdminSessionAggregate {
  return {
    schemaVersion: ADMIN_AGGREGATE_SCHEMA_VERSION,
    version: 0,
    userId,
    sessions: {}
  };
}

export function upsertAdminSession(
  current: AdminSessionAggregate | undefined,
  userId: string,
  tokenHash: string,
  entry: AdminSessionEntry,
  nowMs = Date.now()
): AdminSessionAggregate {
  const aggregate = cleanExpiredAdminSessions(
    current ?? emptyAdminSessionAggregate(userId),
    nowMs
  );
  if (aggregate.userId !== userId) {
    throw new AdminAggregateIntegrityError("Session aggregate owner does not match the session owner.");
  }
  const isNew = !aggregate.sessions[tokenHash];
  if (isNew && Object.keys(aggregate.sessions).length >= MAX_TRACKED_ADMIN_SESSIONS) {
    throw new AdminSessionCapacityError(
      `No more than ${MAX_TRACKED_ADMIN_SESSIONS} active sessions may be tracked for one user.`
    );
  }
  return {
    ...aggregate,
    version: aggregate.version + 1,
    sessions: { ...aggregate.sessions, [tokenHash]: { ...entry } }
  };
}

export function initialAdminSessionAggregate(
  userId: string,
  tokenHash: string,
  entry: AdminSessionEntry
): AdminSessionAggregate {
  return {
    ...emptyAdminSessionAggregate(userId),
    version: 1,
    sessions: { [tokenHash]: { ...entry } }
  };
}

export function removeAdminSession(
  current: AdminSessionAggregate,
  tokenHash: string,
  nowMs = Date.now()
): AdminSessionAggregate {
  const cleaned = cleanExpiredAdminSessions(current, nowMs);
  const sessions = { ...cleaned.sessions };
  delete sessions[tokenHash];
  return { ...cleaned, version: current.version + 1, sessions };
}

export function cleanExpiredAdminSessions(
  current: AdminSessionAggregate,
  nowMs = Date.now()
): AdminSessionAggregate {
  const sessions = Object.fromEntries(
    Object.entries(current.sessions).filter(([, entry]) => Date.parse(entry.expiresAt) > nowMs)
  );
  return { ...current, sessions };
}

export function summarizeAdminUser(
  user: UserProfile,
  usage: AdminUsageAggregate | undefined,
  sessionAggregate: AdminSessionAggregate | undefined,
  nowMs = Date.now()
): UserAdminSummary {
  assertAdminUsageAggregate(usage, user.id);
  assertAdminSessionAggregate(sessionAggregate, user.id);
  const activeSessions = sessionAggregate
    ? Object.values(sessionAggregate.sessions).filter((entry) => Date.parse(entry.expiresAt) > nowMs)
    : [];
  const lastSeenAt = activeSessions.reduce<string | undefined>((latest, entry) => (
    !latest || Date.parse(entry.lastSeenAt) > Date.parse(latest) ? entry.lastSeenAt : latest
  ), undefined);
  return {
    ...user,
    lastSeenAt,
    online: Boolean(lastSeenAt && nowMs - Date.parse(lastSeenAt) <= onlineWindowMs()),
    usage: {
      costUsd: usage?.costUsd ?? 0,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      calls: usage?.calls ?? 0
    }
  };
}

export function assertAdminUsageAggregate(
  value: AdminUsageAggregate | undefined,
  userId: string
): asserts value is AdminUsageAggregate | undefined {
  if (value === undefined) return;
  if (
    value.schemaVersion !== ADMIN_AGGREGATE_SCHEMA_VERSION ||
    value.userId !== userId ||
    !isNonNegativeInteger(value.version) ||
    !isNonNegativeFinite(value.costUsd) ||
    !isNonNegativeFinite(value.inputTokens) ||
    !isNonNegativeFinite(value.outputTokens) ||
    !isNonNegativeInteger(value.calls)
  ) {
    throw new AdminAggregateIntegrityError("Usage aggregate is malformed or belongs to another user.");
  }
}

export function assertAdminSessionAggregate(
  value: AdminSessionAggregate | undefined,
  userId: string
): asserts value is AdminSessionAggregate | undefined {
  if (value === undefined) return;
  if (
    value.schemaVersion !== ADMIN_AGGREGATE_SCHEMA_VERSION ||
    value.userId !== userId ||
    !isNonNegativeInteger(value.version) ||
    !value.sessions ||
    typeof value.sessions !== "object" ||
    Array.isArray(value.sessions) ||
    Object.keys(value.sessions).length > MAX_TRACKED_ADMIN_SESSIONS ||
    Object.entries(value.sessions).some(([tokenHash, entry]) => (
      !tokenHash ||
      !entry ||
      typeof entry !== "object" ||
      !Number.isFinite(Date.parse(entry.lastSeenAt)) ||
      !Number.isFinite(Date.parse(entry.expiresAt)) ||
      !isNonNegativeInteger(entry.authGeneration)
    ))
  ) {
    throw new AdminAggregateIntegrityError("Session aggregate is malformed or belongs to another user.");
  }
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
