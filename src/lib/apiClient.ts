import type {
  AdminMetrics,
  AiApprovalPolicyBinding,
  AiApprovalRequestListItem,
  AiApprovalRequestOfficerDetail,
  AiApprovalRequestStatus,
  AiApprovalRequestStatusKind,
  AiApprovalStatus,
  AiApprovalSubjectBinding,
  AuditEvent,
  CorpusSnapshot,
  DataClass,
  MemoBuilderDraftSource,
  MemoChatMessage,
  MemoRecord,
  OutreachDraft,
  OutreachLead,
  LeadSearchRun,
  LeadWorkflow,
  MemoBuilderSession,
  OutreachJob,
  NewReviewInput,
  ReviewResult,
  ReviewerDecision,
  UserAdminSummary,
  UserProfile
} from "../types";
import { withCloudFrontPayloadHash } from "./cloudfrontPayloadHash";
import { normalizeMemoChatMessage } from "../shared/aiLimits";

export type AnalysisMode = "standard" | "deep";

export const ANALYSIS_MODE_CONFIG = {
  standard: {
    label: "Full AI Council",
    depth: "standard",
    cost: "Haiku live review",
    description: "Use for routine seven-agent triage, citation checks, and missing-information mapping."
  },
  deep: {
    label: "Deep Council Pass",
    depth: "deep",
    cost: "Sonnet deep review",
    description: "Use when blockers, user friction, or signoff risk need a stricter second look."
  }
} as const satisfies Record<AnalysisMode, {
  label: string;
  depth: "standard" | "deep";
  cost: string;
  description: string;
}>;

export interface BackendHealth {
  ok: boolean;
  service: string;
  phase: string;
  time: string;
  provider: {
    configured: boolean;
    model?: string;
    deepModel?: string;
  };
}

export interface AuthResponse {
  user: UserProfile | null;
  csrfToken: string | null;
}

export type InviteStatus = "pending" | "used" | "expired";

export interface InviteSummary {
  id: string;
  email: string;
  name: string;
  role: UserProfile["role"];
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  invitedBy?: string;
  usedAt?: string;
}

export interface InvitePublicInfo {
  email: string;
  name: string;
  role: UserProfile["role"];
  expiresAt: string;
  status: InviteStatus;
}

export interface PasswordResetPublicInfo {
  email: string;
  expiresAt: string;
  status: InviteStatus;
}

export interface EmailDeliveryResult {
  sent: boolean;
  reason?: string;
}

export interface InviteCreationResponse {
  invite: InviteSummary;
  inviteLink: string;
  delivery: EmailDeliveryResult;
}

let csrfToken: string | undefined;
const logicalAiRequestIds = new Map<string, string>();
const AI_REQUEST_STORAGE_PREFIX = "rulix.ai-request.v1.";
const AI_REQUEST_ACCOUNT_KEY = "rulix.ai-request.account.v1";
const AI_REQUEST_STORAGE_TTL_MS = 72 * 60 * 60 * 1_000;
const AI_REQUEST_STORAGE_LIMIT = 256;

async function retainedAiRequestId(logicalKey: string) {
  const key = await logicalAiStorageKey(logicalKey);
  const existing = logicalAiRequestIds.get(key) ?? readPersistedAiRequestId(key);
  if (existing) return existing;
  const requestId = crypto.randomUUID();
  logicalAiRequestIds.set(key, requestId);
  persistAiRequestId(key, requestId);
  if (logicalAiRequestIds.size > AI_REQUEST_STORAGE_LIMIT) {
    const oldest = logicalAiRequestIds.keys().next().value as string | undefined;
    if (oldest) logicalAiRequestIds.delete(oldest);
  }
  return requestId;
}

async function completeAiLogicalRequest(logicalKey: string) {
  const key = await logicalAiStorageKey(logicalKey);
  logicalAiRequestIds.delete(key);
  safeStorage()?.removeItem(key);
}

/** Test-only reset for the module-scoped crash/retry idempotency cache. */
export function resetAiRequestIdsForTests() {
  logicalAiRequestIds.clear();
  clearPersistedAiRequestIds();
}

/** Test-only reload simulation: persistent crash-recovery IDs remain intact. */
export function resetAiRequestMemoryForTests() {
  logicalAiRequestIds.clear();
}

async function logicalAiStorageKey(logicalKey: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(logicalKey));
  return `${AI_REQUEST_STORAGE_PREFIX}${Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

function readPersistedAiRequestId(key: string) {
  const storage = safeStorage();
  if (!storage) return undefined;
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? "null") as unknown;
    if (!isRecord(parsed) || typeof parsed.requestId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.requestId) ||
        typeof parsed.createdAt !== "number" || !Number.isFinite(parsed.createdAt) ||
        parsed.createdAt > Date.now() + 60_000 || Date.now() - parsed.createdAt > AI_REQUEST_STORAGE_TTL_MS) {
      storage.removeItem(key);
      return undefined;
    }
    logicalAiRequestIds.set(key, parsed.requestId.toLowerCase());
    return parsed.requestId.toLowerCase();
  } catch {
    try { storage.removeItem(key); } catch { /* storage may become unavailable */ }
    return undefined;
  }
}

function persistAiRequestId(key: string, requestId: string) {
  const storage = safeStorage();
  if (!storage) return;
  try {
    prunePersistedAiRequestIds(storage);
    storage.setItem(key, JSON.stringify({ requestId, createdAt: Date.now() }));
  } catch {
    // In-memory retention still protects retries for this page lifetime.
  }
}

function prunePersistedAiRequestIds(storage: Storage) {
  const entries: Array<{ key: string; createdAt: number }> = [];
  const now = Date.now();
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(AI_REQUEST_STORAGE_PREFIX)) keys.push(key);
  }
  for (const key of keys) {
    try {
      const parsed = JSON.parse(storage.getItem(key) ?? "null") as unknown;
      const createdAt = isRecord(parsed) && typeof parsed.createdAt === "number" ? parsed.createdAt : 0;
      if (!Number.isFinite(createdAt) || createdAt > now + 60_000 || now - createdAt > AI_REQUEST_STORAGE_TTL_MS) {
        storage.removeItem(key);
      } else {
        entries.push({ key, createdAt });
      }
    } catch {
      storage.removeItem(key);
    }
  }
  entries.sort((left, right) => left.createdAt - right.createdAt);
  for (const entry of entries.slice(0, Math.max(0, entries.length - AI_REQUEST_STORAGE_LIMIT + 1))) {
    storage.removeItem(entry.key);
  }
}

async function bindPersistedAiRequestsToAccount(accountId: string | undefined) {
  const storage = safeStorage();
  if (!storage) return;
  try {
    if (!accountId) {
      logicalAiRequestIds.clear();
      clearPersistedAiRequestIds();
      storage.removeItem(AI_REQUEST_ACCOUNT_KEY);
      return;
    }
    const accountBinding = await logicalAiStorageKey(`account:${accountId}`);
    const previous = storage.getItem(AI_REQUEST_ACCOUNT_KEY);
    if (previous && previous !== accountBinding) {
      logicalAiRequestIds.clear();
      clearPersistedAiRequestIds();
    }
    storage.setItem(AI_REQUEST_ACCOUNT_KEY, accountBinding);
  } catch {
    // Browser privacy modes may disable storage; in-memory IDs remain scoped to this page.
  }
}

function clearPersistedAiRequestIds() {
  const storage = safeStorage();
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(AI_REQUEST_STORAGE_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => storage.removeItem(key));
  } catch {
    // Test cleanup remains best-effort when browser storage is disabled.
  }
}

function safeStorage() {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function setCsrfToken(token: string | undefined) {
  csrfToken = token;
}

export async function getBackendHealth(signal?: AbortSignal) {
  return fetchJson<BackendHealth>("/api/health", { signal });
}

export async function getBackendCorpus(signal?: AbortSignal) {
  return fetchJson<CorpusSnapshot>("/api/corpus", { signal });
}

export async function analyzeMemoWithBackend(
  memo: MemoRecord,
  mode: AnalysisMode,
  signal?: AbortSignal
) {
  const logicalKey = `council-dispatch:${memo.id}:${memo.version}:${memo.revision}:${memo.contentHash}:${mode}`;
  const response = await fetchJson<{
    review: MemoRecord;
    result: ReviewResult;
    decisionInvalidated?: boolean;
    auditEvents?: AuditEvent[];
  }>(
    `/api/reviews/${encodeURIComponent(memo.id)}/analyze`,
    {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        requestId: await retainedAiRequestId(logicalKey),
        depth: ANALYSIS_MODE_CONFIG[mode].depth,
        expectedVersion: memo.version,
        expectedRevision: memo.revision,
        expectedHash: memo.contentHash
      })
    }
  );
  await completeAiLogicalRequest(logicalKey);
  return response;
}

export interface CouncilApprovalView {
  purpose: "council";
  depth: "standard" | "deep";
  subject: AiApprovalSubjectBinding;
  payloadHash: string;
  policy: AiApprovalPolicyBinding;
  approval?: AiApprovalStatus;
  usable: boolean;
}

export async function getCouncilApproval(
  memoId: string,
  mode: AnalysisMode,
  signal?: AbortSignal
) {
  return fetchJson<CouncilApprovalView>(
    `/api/reviews/${encodeURIComponent(memoId)}/ai-approvals/council?depth=${encodeURIComponent(ANALYSIS_MODE_CONFIG[mode].depth)}`,
    { signal }
  );
}

export async function approveCouncilAnalysis(
  memo: Pick<MemoRecord, "id" | "version" | "revision" | "contentHash">,
  mode: AnalysisMode,
  signal?: AbortSignal
) {
  const logicalKey = `council-approval:${memo.id}:${memo.version}:${memo.revision}:${memo.contentHash}:${mode}`;
  const response = await fetchJson<{ approval: AiApprovalStatus; usable: boolean }>(
    `/api/reviews/${encodeURIComponent(memo.id)}/ai-approvals/council`,
    {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: await retainedAiRequestId(logicalKey),
        depth: ANALYSIS_MODE_CONFIG[mode].depth,
        expectedVersion: memo.version,
        expectedRevision: memo.revision,
        expectedHash: memo.contentHash
      })
    }
  );
  await completeAiLogicalRequest(logicalKey);
  return response;
}

export async function revokeAiApproval(
  approvalId: string,
  reason: string,
  signal?: AbortSignal
) {
  const logicalKey = `ai-approval-revoke:${approvalId}:${reason.trim()}`;
  const response = await fetchJson<{ approval: AiApprovalStatus; usable: false }>(
    `/api/ai-approvals/${encodeURIComponent(approvalId)}/revoke`,
    {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: await retainedAiRequestId(logicalKey),
        reason: reason.trim()
      })
    }
  );
  await completeAiLogicalRequest(logicalKey);
  return response;
}

export async function requestCouncilApproval(
  memo: Pick<MemoRecord, "id" | "version" | "revision" | "contentHash">,
  mode: AnalysisMode,
  signal?: AbortSignal
) {
  const logicalKey = `council-request:${memo.id}:${memo.version}:${memo.revision}:${memo.contentHash}:${mode}`;
  return createPendingAiApprovalRequest(logicalKey, (requestId) => ({
    requestId,
    purpose: "council",
    reviewId: memo.id,
    depth: ANALYSIS_MODE_CONFIG[mode].depth,
    expectedVersion: memo.version,
    expectedRevision: memo.revision,
    expectedHash: memo.contentHash
  }), signal);
}

export async function requestMemoChatApproval(
  memo: Pick<MemoRecord, "id" | "version" | "revision" | "contentHash">,
  message: string,
  signal?: AbortSignal
) {
  const normalized = requireMemoChatMessage(message);
  const logicalKey = `memo-chat-request:${memo.id}:${memo.version}:${memo.revision}:${memo.contentHash}:${normalized}`;
  return createPendingAiApprovalRequest(logicalKey, (requestId) => ({
    requestId,
    purpose: "memo-chat",
    reviewId: memo.id,
    message: normalized,
    expectedVersion: memo.version,
    expectedRevision: memo.revision,
    expectedHash: memo.contentHash
  }), signal);
}

export async function requestMemoBuilderApproval(
  sessionId: string,
  sessionFingerprint: string,
  signal?: AbortSignal
) {
  const logicalKey = `memo-builder-request:${sessionId}:${sessionFingerprint}`;
  return createPendingAiApprovalRequest(logicalKey, (requestId) => ({
    requestId,
    purpose: "memo-builder",
    sessionId
  }), signal);
}

async function createPendingAiApprovalRequest(
  logicalKey: string,
  body: (requestId: string) => Record<string, unknown>,
  signal?: AbortSignal
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchJson<AiApprovalRequestStatus>("/api/ai-approval-requests", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body(await retainedAiRequestId(logicalKey)))
      });
      if (response.status === "pending" || response.status === "approved") return response;
      // A rejected, cancelled, or expired exact request may be replaced once.
      await completeAiLogicalRequest(logicalKey);
    } catch (error) {
      if (attempt === 0 && error instanceof ApiError && error.status === 409) {
        // The logical browser operation now reconstructs a different exact
        // server payload (for example, chat history changed). Retire the old
        // binding and retry once with a fresh durable request ID.
        await completeAiLogicalRequest(logicalKey);
        continue;
      }
      throw error;
    }
  }
  throw new Error("A fresh AI approval request could not be created. Refresh the queue and try again.");
}

export async function listAiApprovalRequests(
  options: { limit?: number; cursor?: string; status?: AiApprovalRequestStatusKind; admin?: boolean } = {},
  signal?: AbortSignal
) {
  const params = new URLSearchParams({ limit: String(options.limit ?? 25) });
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.status) params.set("status", options.status);
  const base = options.admin ? "/api/admin/ai-approval-requests" : "/api/ai-approval-requests";
  return fetchJson<CursorPage<AiApprovalRequestListItem>>(`${base}?${params}`, { signal });
}

export type AiApprovalOfficerInspection =
  | {
      kind: "council";
      current: boolean;
      depth: "standard" | "deep";
      memo: MemoRecord;
      providerRequest?: unknown;
      providerRequestHash?: string;
      unavailableReason?: string;
    }
  | {
      kind: "memo-chat";
      current: boolean;
      memo: MemoRecord;
      history: MemoChatMessage[];
      pendingMessage?: string;
      providerRequest?: unknown;
      providerRequestHash?: string;
      unavailableReason?: string;
    }
  | {
      kind: "memo-builder";
      current: boolean;
      session?: MemoBuilderSession;
      version?: number;
      messages?: MemoBuildMessage[];
      pendingMessage?: string;
      providerRequest?: unknown;
      providerRequestHash?: string;
      unavailableReason?: string;
    };

export interface AiApprovalRequestOfficerView extends AiApprovalRequestOfficerDetail {
  inspection: AiApprovalOfficerInspection;
}

export function getAiApprovalRequest(
  requestId: string,
  options: { admin: true },
  signal?: AbortSignal
): Promise<AiApprovalRequestOfficerView>;
export function getAiApprovalRequest(
  requestId: string,
  options?: { admin?: false },
  signal?: AbortSignal
): Promise<AiApprovalRequestStatus>;
export function getAiApprovalRequest(
  requestId: string,
  options: { admin?: boolean } = {},
  signal?: AbortSignal
) {
  const base = options.admin ? "/api/admin/ai-approval-requests" : "/api/ai-approval-requests";
  return fetchJson<AiApprovalRequestStatus | AiApprovalRequestOfficerView>(
    `${base}/${encodeURIComponent(requestId)}`,
    { signal }
  );
}

export async function cancelAiApprovalRequest(
  requestId: string,
  reason: string,
  signal?: AbortSignal
) {
  const normalizedReason = reason.trim();
  const logicalKey = `ai-request-cancel:${requestId}:${normalizedReason}`;
  const response = await fetchJson<AiApprovalRequestStatus>(
    `/api/ai-approval-requests/${encodeURIComponent(requestId)}/cancel`,
    {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: await retainedAiRequestId(logicalKey),
        reason: normalizedReason
      })
    }
  );
  await completeAiLogicalRequest(logicalKey);
  return response;
}

export async function decideAiApprovalRequest(
  approvalRequestId: string,
  decision: "approve" | "reject",
  reason?: string,
  signal?: AbortSignal
) {
  const normalizedReason = reason?.trim();
  const logicalKey = `ai-request-${decision}:${approvalRequestId}:${normalizedReason ?? ""}`;
  const response = await fetchJson<AiApprovalRequestStatus>(
    `/api/admin/ai-approval-requests/${encodeURIComponent(approvalRequestId)}/${decision}`,
    {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: await retainedAiRequestId(logicalKey),
        ...(decision === "reject" ? { reason: normalizedReason } : {})
      })
    }
  );
  await completeAiLogicalRequest(logicalKey);
  return response;
}

export async function revokeQueuedAiApproval(
  approvalRequestId: string,
  reason: string,
  signal?: AbortSignal
) {
  const normalizedReason = reason.trim();
  const logicalKey = `ai-request-revoke:${approvalRequestId}:${normalizedReason}`;
  const response = await fetchJson<AiApprovalRequestStatus>(
    `/api/admin/ai-approval-requests/${encodeURIComponent(approvalRequestId)}/revoke`,
    {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: await retainedAiRequestId(logicalKey),
        reason: normalizedReason
      })
    }
  );
  await completeAiLogicalRequest(logicalKey);
  return response;
}

export async function getCurrentUser(signal?: AbortSignal) {
  const response = await fetchJson<AuthResponse>("/api/auth/me", { signal });
  setCsrfToken(response.csrfToken ?? undefined);
  await bindPersistedAiRequestsToAccount(response.user?.id);
  return response;
}

export async function signIn(email: string, password: string) {
  const response = await fetchJson<AuthResponse>("/api/auth/login", {
    method: "POST",
    publicRequest: true,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, password })
  });
  setCsrfToken(response.csrfToken ?? undefined);
  await bindPersistedAiRequestsToAccount(response.user?.id);
  return response;
}

export async function listInvites(signal?: AbortSignal) {
  const response = await fetchJson<{ invites: InviteSummary[] }>("/api/auth/invites", { signal });
  return response.invites;
}

export async function createInvite(email: string, name: string, role: UserProfile["role"]) {
  return fetchJson<InviteCreationResponse>("/api/auth/invites", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, name, role })
  });
}

export async function getAdminMetrics(rangeDays = 30, signal?: AbortSignal) {
  const response = await fetchJson<{ metrics: AdminMetrics }>(
    `/api/admin/metrics?rangeDays=${encodeURIComponent(String(rangeDays))}`,
    { signal }
  );
  return response.metrics;
}

export async function listAdminUsers(
  input: { limit?: number; cursor?: string } = {},
  signal?: AbortSignal
) {
  const params = new URLSearchParams({
    limit: String(Math.min(50, Math.max(1, input.limit ?? 25)))
  });
  if (input.cursor) params.set("cursor", input.cursor);
  return fetchJson<CursorPage<UserAdminSummary>>(`/api/admin/users?${params}`, { signal });
}

export async function validateInvite(token: string, signal?: AbortSignal) {
  const response = await fetchJson<{ invite: InvitePublicInfo }>("/api/auth/invite/inspect", {
    method: "POST",
    publicRequest: true,
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
  return response.invite;
}

export async function acceptInvite(token: string, password: string, name?: string) {
  const response = await fetchJson<AuthResponse>("/api/auth/invite/accept", {
    method: "POST",
    publicRequest: true,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ token, password, name })
  });
  setCsrfToken(response.csrfToken ?? undefined);
  await bindPersistedAiRequestsToAccount(response.user?.id);
  return response;
}

export async function requestPasswordReset(email: string) {
  await fetchJson<{ ok: true }>("/api/auth/password-reset/request", {
    method: "POST",
    publicRequest: true,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email })
  });
}

export async function validatePasswordReset(token: string, signal?: AbortSignal) {
  const response = await fetchJson<{ reset: PasswordResetPublicInfo }>("/api/auth/password-reset/inspect", {
    method: "POST",
    publicRequest: true,
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
  return response.reset;
}

export async function completePasswordReset(token: string, password: string) {
  const response = await fetchJson<AuthResponse>("/api/auth/password-reset/complete", {
    method: "POST",
    publicRequest: true,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ token, password })
  });
  setCsrfToken(response.csrfToken ?? undefined);
  await bindPersistedAiRequestsToAccount(response.user?.id);
  return response;
}

export async function signOut() {
  try {
    await fetchJson<void>("/api/auth/logout", { method: "POST" });
  } finally {
    setCsrfToken(undefined);
    await bindPersistedAiRequestsToAccount(undefined);
  }
}

export type ReviewSummary = Pick<
  MemoRecord,
  | "id"
  | "title"
  | "itemFamily"
  | "owner"
  | "updatedAt"
  | "documentCode"
  | "status"
  | "dataClass"
  | "manufacturer"
  | "sourcePath"
  | "intendedUse"
  | "archivedAt"
  | "archivedBy"
  | "revision"
  | "contentHash"
  | "createdAt"
  | "createdBy"
  | "ownerId"
  | "lifecycleStage"
  | "priority"
  | "assignedTo"
  | "dueAt"
  | "tags"
  | "version"
>;

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
}

export async function listReviews(
  input: { limit?: number; cursor?: string; state?: "active" | "archived" | "all" } = {},
  signal?: AbortSignal
) {
  const params = new URLSearchParams({
    limit: String(Math.min(50, Math.max(1, input.limit ?? 25))),
    state: input.state ?? "active"
  });
  if (input.cursor) params.set("cursor", input.cursor);
  return fetchJson<CursorPage<ReviewSummary>>(`/api/reviews?${params}`, { signal });
}

export async function getReviewDetail(memoId: string, signal?: AbortSignal) {
  return fetchJson<{
    review: MemoRecord;
    result?: ReviewResult;
    decision?: ReviewerDecision;
  }>(`/api/reviews/${encodeURIComponent(memoId)}`, { signal });
}

export async function listReviewAuditEvents(
  memoId: string,
  input: { limit?: number; cursor?: string } = {},
  signal?: AbortSignal
) {
  const params = pageParams(input);
  return fetchJson<CursorPage<AuditEvent>>(
    `/api/reviews/${encodeURIComponent(memoId)}/audit?${params}`,
    { signal }
  );
}

export async function listReviewChatMessages(
  memoId: string,
  input: { limit?: number; cursor?: string } = {},
  signal?: AbortSignal
) {
  const params = pageParams(input);
  return fetchJson<CursorPage<MemoChatMessage>>(
    `/api/reviews/${encodeURIComponent(memoId)}/chat?${params}`,
    { signal }
  );
}

export interface ReviewCommandResponse {
  review: MemoRecord;
  auditEvents: AuditEvent[];
}

export async function createReview(
  input: NewReviewInput,
  signal?: AbortSignal,
  requestId = crypto.randomUUID()
) {
  const body = JSON.stringify({ ...input, requestId });
  return retryOnceOnNetworkFailure(() => fetchJson<ReviewCommandResponse & { replayed: boolean }>(
    "/api/reviews",
    {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body
    }
  ));
}

export async function updateReviewMemo(
  memo: Pick<MemoRecord, "id" | "version" | "revision" | "contentHash">,
  memoText: string,
  signal?: AbortSignal
) {
  requireReviewBinding(memo);
  return fetchJson<ReviewCommandResponse>(`/api/reviews/${encodeURIComponent(memo.id)}`, {
    method: "PATCH",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedVersion: memo.version,
      expectedRevision: memo.revision,
      expectedHash: memo.contentHash,
      memoText
    })
  });
}

export async function setReviewArchived(
  memo: Pick<MemoRecord, "id" | "version" | "revision" | "contentHash">,
  archived: boolean,
  signal?: AbortSignal
) {
  requireReviewBinding(memo);
  return fetchJson<ReviewCommandResponse>(`/api/reviews/${encodeURIComponent(memo.id)}`, {
    method: "PATCH",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedVersion: memo.version,
      expectedRevision: memo.revision,
      expectedHash: memo.contentHash,
      archived
    })
  });
}

export async function recordReviewDecision(
  memo: Pick<MemoRecord, "id" | "version" | "revision" | "contentHash">,
  analysis: Pick<ReviewResult, "id" | "resultHash">,
  action: ReviewerDecision["action"],
  notes: string,
  signal?: AbortSignal
) {
  if (
    !Number.isInteger(memo.version)
    || !Number.isInteger(memo.revision)
    || !memo.contentHash
    || !analysis.id
    || !analysis.resultHash
  ) {
    throw new Error("Reload the analyzed review before recording a decision.");
  }
  return fetchJson<{
    review: MemoRecord;
    decision: ReviewerDecision;
    auditEvents: AuditEvent[];
  }>(`/api/reviews/${encodeURIComponent(memo.id)}/decision`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action,
      notes,
      expectedVersion: memo.version,
      expectedRevision: memo.revision,
      expectedHash: memo.contentHash,
      expectedAnalysisId: analysis.id,
      expectedAnalysisHash: analysis.resultHash
    })
  });
}

export async function loadWorkspacePreferences(signal?: AbortSignal) {
  return fetchJson<{
    selectedMemoId?: string;
    activeMemoBuilderSessionId?: string;
    version: number;
  }>("/api/account/preferences", { signal });
}

export async function updateWorkspacePreferences(
  expectedVersion: number,
  input: {
    selectedMemoId?: string | null;
    activeMemoBuilderSessionId?: string | null;
  },
  signal?: AbortSignal
) {
  return fetchJson<{
    selectedMemoId?: string;
    activeMemoBuilderSessionId?: string;
    version: number;
  }>("/api/account/preferences", {
    method: "PATCH",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedVersion,
      selectedMemoId: input.selectedMemoId ?? null,
      activeMemoBuilderSessionId: input.activeMemoBuilderSessionId ?? null
    })
  });
}

export interface StoredMemoBuilderSession {
  session: MemoBuilderSession;
  version: number;
}

export async function listMemoBuilderSessions(
  input: { limit?: number; cursor?: string } = {},
  signal?: AbortSignal
) {
  return fetchJson<CursorPage<StoredMemoBuilderSession>>(
    `/api/account/memo-builder/sessions?${pageParams(input)}`,
    { signal }
  );
}

export async function upsertMemoBuilderSession(
  session: MemoBuilderSession,
  expectedVersion: number,
  signal?: AbortSignal
) {
  const persisted = sanitizeMemoBuilderSessionForStorage(session);
  return fetchJson<StoredMemoBuilderSession>(
    `/api/account/memo-builder/sessions/${encodeURIComponent(session.id)}`,
    {
      method: "PUT",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion, session: persisted })
    }
  );
}

export async function deleteMemoBuilderSession(
  sessionId: string,
  expectedVersion: number,
  signal?: AbortSignal
) {
  await fetchJson<void>(
    `/api/account/memo-builder/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion })
    }
  );
}

export async function sendMemoChat(
  memo: Pick<MemoRecord, "id" | "version" | "revision" | "contentHash">,
  message: string,
  signal?: AbortSignal
) {
  const normalizedMessage = requireMemoChatMessage(message);
  const logicalKey = `memo-chat:${memo.id}:${memo.version}:${memo.revision}:${memo.contentHash}:${normalizedMessage}`;
  const response = await fetchJson<{
    review: MemoRecord;
    messages: MemoChatMessage[];
    auditEvents?: AuditEvent[];
  }>(
    `/api/reviews/${encodeURIComponent(memo.id)}/chat`,
    {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        requestId: await retainedAiRequestId(logicalKey),
        message: normalizedMessage,
        expectedVersion: memo.version,
        expectedRevision: memo.revision,
        expectedHash: memo.contentHash
      })
    }
  );
  await completeAiLogicalRequest(logicalKey);
  return response;
}

function requireMemoChatMessage(message: string) {
  const normalized = normalizeMemoChatMessage(message);
  if (!normalized) {
    throw new Error("Memo chat messages must contain 1 to 8,000 Unicode characters.");
  }
  return normalized;
}

export async function applyMemoChatSuggestion(
  memo: Pick<MemoRecord, "id" | "version" | "contentHash">,
  messageId: string,
  signal?: AbortSignal
) {
  return fetchJson<ReviewCommandResponse & { messages: MemoChatMessage[] }>(
    `/api/reviews/${encodeURIComponent(memo.id)}/chat/${encodeURIComponent(messageId)}/apply`,
    {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: memo.version,
        expectedHash: memo.contentHash
      })
    }
  );
}

export interface MemoBuildMessage {
  role: "user" | "assistant";
  content: string;
}

export interface MemoBuildDraft {
  title: string;
  itemFamily: string;
  manufacturer?: string;
  intendedUse?: string;
  dataClass: DataClass;
  memoText: string;
  attachments?: string[];
  source?: MemoBuilderDraftSource;
  qualityChecks?: string[];
  missingFacts?: string[];
  sourceNotes?: string[];
  reviewContextMemoId?: string;
}

export async function sendMemoBuildChat(
  sessionId: string,
  pendingMessage: string,
  sessionFingerprint: string,
  signal?: AbortSignal
) {
  const normalized = pendingMessage.trim();
  if (!/^builder-[A-Za-z0-9_-]+$/.test(sessionId) || !normalized || normalized.length > 8_000) {
    throw new Error("Memo Builder requires a saved session and one message of at most 8,000 characters.");
  }
  const logicalKey = `memo-builder:${sessionId}:${sessionFingerprint}:${normalized}`;
  const body = JSON.stringify({
    sessionId,
    pendingMessage: normalized,
    requestId: await retainedAiRequestId(logicalKey)
  });
  if (new TextEncoder().encode(body).byteLength > 256 * 1024) {
    throw new Error("The Memo Builder conversation exceeds the 256 KB request limit.");
  }
  const response = await fetchJson<{ reply: string; draft?: MemoBuildDraft }>("/api/ai/memo-builder-chat", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body
  });
  await completeAiLogicalRequest(logicalKey);
  return response;
}

export async function draftPublicMemo(item: string, signal?: AbortSignal) {
  return fetchJson<{
    title: string;
    memoText: string;
    sources: Array<{ title: string; url: string }>;
    provider: { configured: boolean; model: string; live: boolean; message: string };
  }>("/api/public-memo-draft", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ item })
  });
}

export interface DocumentExtraction {
  fileName: string;
  mediaType: string;
  text: string;
  method: "text" | "bedrock-document" | "bedrock-image" | "pdf-image-fallback" | "unavailable";
  warning?: string;
}

export async function extractDocument(input: {
  fileName: string;
  mediaType: string;
  dataBase64: string;
  dataClass: DataClass;
}, signal?: AbortSignal) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(input))
  );
  const logicalKey = `document-extraction:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
  const response = await fetchJson<{ extraction: DocumentExtraction }>("/api/documents/extract", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ...input, requestId: await retainedAiRequestId(logicalKey) })
  });
  await completeAiLogicalRequest(logicalKey);
  return response.extraction;
}

export interface OutreachProviderConfig {
  provider: "bedrock" | "anthropic";
  deploymentProvider: "bedrock" | "anthropic";
  credentialConfigured: boolean;
  ready: boolean;
}

export async function getOutreachProviderConfig(signal?: AbortSignal) {
  return fetchJson<OutreachProviderConfig>("/api/admin/outreach-config", { signal });
}

export async function setOutreachProviderConfig(config: { provider: "bedrock" | "anthropic" }) {
  return fetchJson<OutreachProviderConfig>("/api/admin/outreach-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config)
  });
}

export interface OutreachWorkspace {
  leads: OutreachLead[];
  drafts: Record<string, OutreachDraft>;
  leadSearchRuns: LeadSearchRun[];
  leadWorkflows: Record<string, LeadWorkflow>;
  outreachJobs: OutreachJob[];
  pagination: Record<OutreachCollection, OutreachPageMetadata>;
  bedrock: {
    ready: boolean;
    provider: "bedrock" | "anthropic";
    model: string;
    personalizationModel: string;
    leadSearchModel: string;
    region: string;
  };
}

export type OutreachCollection = "leads" | "drafts" | "runs" | "workflows" | "jobs";

export interface OutreachPageMetadata {
  loadedCount: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface OutreachLeadRow {
  lead: OutreachLead;
  draft?: OutreachDraft;
  workflow?: LeadWorkflow;
}

export async function getOutreachWorkspace(signal?: AbortSignal, limit = 25) {
  return fetchJson<OutreachWorkspace>(`/api/admin/outreach?limit=${Math.min(50, Math.max(1, limit))}`, { signal });
}

export async function getOutreachPage<T>(
  collection: OutreachCollection | "lead-rows",
  input: { limit?: number; cursor?: string } = {},
  signal?: AbortSignal
) {
  const params = pageParams(input);
  return fetchJson<CursorPage<T>>(
    `/api/admin/outreach/pages/${encodeURIComponent(collection)}?${params}`,
    { signal }
  );
}

export async function generateOutreachEmail(leadId: string, direction: string) {
  const logicalKey = `outreach-generate:${leadId}:${direction.trim()}`;
  const response = await fetchJson<{ lead: OutreachLead; draft: OutreachDraft }>("/api/admin/outreach/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: await retainedAiRequestId(logicalKey), leadId, direction })
  });
  await completeAiLogicalRequest(logicalKey);
  return response;
}

export async function saveOutreachDraft(leadId: string, subject: string, body: string) {
  return fetchJson<{ lead: OutreachLead; draft: OutreachDraft }>(
    `/api/admin/outreach/drafts/${encodeURIComponent(leadId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject, body })
    }
  );
}

export async function markOutreachSent(leadId: string) {
  return fetchJson<{ draft: OutreachDraft }>(
    `/api/admin/outreach/drafts/${encodeURIComponent(leadId)}/mark-sent`,
    { method: "POST" }
  );
}

export async function personalizeOutreachEmail(leadId: string) {
  const logicalKey = `outreach-personalize:${leadId}`;
  const response = await fetchJson<{ lead: OutreachLead; draft: OutreachDraft }>(
    `/api/admin/outreach/drafts/${encodeURIComponent(leadId)}/personalize`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: await retainedAiRequestId(logicalKey) })
    }
  );
  await completeAiLogicalRequest(logicalKey);
  return response;
}

export async function searchForLeads(durationSeconds: number, signal?: AbortSignal) {
  const logicalKey = `lead-search:${durationSeconds}`;
  const response = await fetchJson<{ leads: OutreachLead[]; run: LeadSearchRun }>("/api/admin/leads/search", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: await retainedAiRequestId(logicalKey), durationSeconds })
  });
  await completeAiLogicalRequest(logicalKey);
  return response;
}

export async function createOutreachJob(input: {
  type: OutreachJob["type"];
  maxCostUsd: number;
  maxRetries?: number;
  direction?: string;
  searchDurationSeconds?: number;
}) {
  return fetchJson<{ job: OutreachJob }>("/api/admin/outreach/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export async function updateOutreachJob(jobId: string, action: "pause" | "resume" | "retry" | "terminate") {
  return fetchJson<{ job: OutreachJob }>(
    `/api/admin/outreach/jobs/${encodeURIComponent(jobId)}/${action}`,
    { method: "POST" }
  );
}

export async function updateLeadWorkflow(
  leadId: string,
  workflow: Omit<LeadWorkflow, "leadId" | "updatedAt">
) {
  return fetchJson<{ lead: OutreachLead; workflow: LeadWorkflow }>(
    `/api/admin/leads/${encodeURIComponent(leadId)}/workflow`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(workflow)
    }
  );
}

const BUILDER_MESSAGE_LIMIT = 20;
const BUILDER_TEXT_LIMIT = 8_000;
const BUILDER_MEMO_LIMIT = 80_000;
const BUILDER_SESSION_BYTES_LIMIT = 300_000;
const ATTACHMENT_CONTEXT_MARKER = "\n\n---\nAttached source documents for Sonnet:\n";

/**
 * Produces the exact bounded record sent to the per-session store item. It
 * deliberately strips extracted attachment bodies from chat history; those
 * bodies are ephemeral AI input and must never become account preferences.
 */
export function sanitizeMemoBuilderSessionForStorage(session: MemoBuilderSession): MemoBuilderSession {
  requireBoundedText("session id", session.id, 128);
  requireBoundedText("session title", session.title, 160);
  if (session.messages.length > BUILDER_MESSAGE_LIMIT) {
    throw new Error(`Memo Builder chats can keep at most ${BUILDER_MESSAGE_LIMIT} messages. Start a new chat before saving.`);
  }

  const messages = session.messages.map((message) => {
    const markerIndex = message.content.indexOf(ATTACHMENT_CONTEXT_MARKER);
    const withoutAttachmentBodies = markerIndex === -1
      ? message.content
      : `${message.content.slice(0, markerIndex).trim()}\n\n[Attached source documents were used for this message; extracted bodies are not retained.]`;
    requireBoundedText("builder message", withoutAttachmentBodies, BUILDER_TEXT_LIMIT);
    return { role: message.role, content: withoutAttachmentBodies };
  });
  if (session.starterPrompt) requireBoundedText("starter prompt", session.starterPrompt, BUILDER_TEXT_LIMIT);
  if (session.contextMemoId) requireBoundedText("context memo id", session.contextMemoId, 128);
  if (session.pendingInput) requireBoundedText("pending input", session.pendingInput, BUILDER_TEXT_LIMIT);

  const draft = session.draft
    ? {
        title: requireBoundedText("draft title", session.draft.title, 240),
        itemFamily: requireBoundedText("draft item family", session.draft.itemFamily, 240),
        ...(session.draft.manufacturer
          ? { manufacturer: requireBoundedText("draft manufacturer", session.draft.manufacturer, 240) }
          : {}),
        ...(session.draft.intendedUse
          ? { intendedUse: requireBoundedText("draft intended use", session.draft.intendedUse, 2_000) }
          : {}),
        dataClass: session.draft.dataClass,
        memoText: requireBoundedText("draft memo", session.draft.memoText, BUILDER_MEMO_LIMIT),
        ...(session.draft.attachments
          ? { attachments: boundedTextList("draft attachments", session.draft.attachments, 16, 240) }
          : {}),
        ...(session.draft.source ? { source: session.draft.source } : {}),
        ...(session.draft.qualityChecks
          ? { qualityChecks: boundedTextList("draft quality checks", session.draft.qualityChecks, 24, 1_000) }
          : {}),
        ...(session.draft.missingFacts
          ? { missingFacts: boundedTextList("draft missing facts", session.draft.missingFacts, 24, 1_000) }
          : {}),
        ...(session.draft.sourceNotes
          ? { sourceNotes: boundedTextList("draft source notes", session.draft.sourceNotes, 24, 1_000) }
          : {}),
        ...(session.draft.reviewContextMemoId
          ? { reviewContextMemoId: requireBoundedText("draft context memo id", session.draft.reviewContextMemoId, 128) }
          : {})
      }
    : undefined;

  const persisted: MemoBuilderSession = {
    id: session.id,
    title: session.title,
    dataClass: session.dataClass,
    messages,
    updatedAt: session.updatedAt,
    ...(session.starterPrompt ? { starterPrompt: session.starterPrompt } : {}),
    ...(session.contextMemoId ? { contextMemoId: session.contextMemoId } : {}),
    ...(session.pendingInput ? { pendingInput: session.pendingInput } : {}),
    ...(draft ? { draft } : {})
  };
  const encodedBytes = new TextEncoder().encode(JSON.stringify(persisted)).byteLength;
  if (encodedBytes > BUILDER_SESSION_BYTES_LIMIT) {
    throw new Error("This Memo Builder chat is too large to save safely. Start a new chat; the current draft remains available locally.");
  }
  return persisted;
}

function requireBoundedText(label: string, value: string, limit: number) {
  if (value.length > limit) {
    throw new Error(`${label} exceeds the ${limit.toLocaleString()} character account-storage limit.`);
  }
  return value;
}

function boundedTextList(label: string, values: string[], countLimit: number, textLimit: number) {
  if (values.length > countLimit) {
    throw new Error(`${label} can contain at most ${countLimit} items.`);
  }
  return values.map((value) => requireBoundedText(label, value, textLimit));
}

async function retryOnceOnNetworkFailure<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError || (error instanceof DOMException && error.name === "AbortError")) {
      throw error;
    }
    return operation();
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function pageParams(input: { limit?: number; cursor?: string }) {
  const params = new URLSearchParams({
    limit: String(Math.min(50, Math.max(1, input.limit ?? 25)))
  });
  if (input.cursor) params.set("cursor", input.cursor);
  return params;
}

function requireReviewBinding(
  memo: Pick<MemoRecord, "version" | "revision" | "contentHash">
) {
  if (!Number.isInteger(memo.version) || !Number.isInteger(memo.revision) || !memo.contentHash) {
    throw new Error("Reload the review before changing it.");
  }
}

interface FetchJsonInit extends RequestInit {
  publicRequest?: boolean;
}

async function fetchJson<T>(url: string, init?: FetchJsonInit): Promise<T> {
  const { publicRequest = false, ...requestInit } = init ?? {};
  const headers = new Headers(requestInit.headers);
  const method = requestInit.method?.toUpperCase() ?? "GET";
  const needsCsrf = !publicRequest && !["GET", "HEAD", "OPTIONS"].includes(method);

  // First mutating request may arrive before getCurrentUser() resolves and sets
  // the CSRF token — fetch it transparently so the request doesn't fire blind.
  if (needsCsrf && !csrfToken) {
    try {
      const me = await fetch("/api/auth/me", { credentials: "include" });
      if (me.ok) {
        const data = await me.json() as { csrfToken?: string };
        if (data.csrfToken) csrfToken = data.csrfToken;
      }
    } catch {
      // proceed without token; server will 403 and app will surface the error
    }
  }

  if (csrfToken && needsCsrf) {
    headers.set("x-rulix-csrf", csrfToken);
  }

  const response = await fetch(url, await withCloudFrontPayloadHash({
    ...requestInit,
    credentials: "include",
    headers
  }));
  if (!response.ok) {
    const text = await response.text();
    let message = text || `Request failed with ${response.status}`;
    let code: string | undefined;
    if (text) {
      try {
        const payload = JSON.parse(text) as { error?: unknown; code?: unknown };
        if (typeof payload.error === "string") message = payload.error;
        if (typeof payload.code === "string") code = payload.code;
      } catch {
        // Preserve a plain-text error body.
      }
    }
    throw new ApiError(response.status, message, code);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
