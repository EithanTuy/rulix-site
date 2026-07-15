import {
  createCipheriv,
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type PutCommandInput,
  type TransactWriteCommandInput
} from "@aws-sdk/lib-dynamodb";
import type {
  AccountReviewState,
  AiApprovalPolicyBinding,
  AiApprovalMemoChatFence,
  AiApprovalPurpose,
  AiApprovalRecord,
  AiApprovalRequestContext,
  AiApprovalRequestDecision,
  AiApprovalRequestListItem,
  AiApprovalRequestOfficerDetail,
  AiApprovalRequestRecord,
  AiApprovalRequestStatus,
  AiApprovalRequestStatusKind,
  AiApprovalRevocation,
  AiApprovalStatus,
  AiApprovalSubjectBinding,
  AuditEvent,
  DataClass,
  LeadSearchRun,
  LeadWorkflow,
  MemoBuilderSession,
  MemoChatMessage,
  MemoRecord,
  MemoRevision,
  OutreachDraft,
  OutreachJob,
  OutreachLead,
  ReviewResult,
  ReviewerDecision,
  AdminMetrics,
  UsageEvent,
  UserAdminSummary,
  UserProfile
} from "../src/types";
import { outreachLeads as bundledOutreachLeads } from "../src/outreachLeads";
import { analyzeMemo } from "../src/lib/eccnReview";
import { deriveReviewStatus } from "../src/lib/reviewLifecycle";
import {
  MEMO_CHAT_TEXT_MAX_BYTES,
  normalizeMemoChatMessage
} from "../src/shared/aiLimits";
import { defaultOutreachConfig, sanitizeOutreachConfig, type StoredOutreachConfig } from "./aiClient";
import {
  ADMIN_AGGREGATE_SCHEMA_VERSION,
  MAX_TRACKED_ADMIN_SESSIONS,
  AdminAggregateIntegrityError,
  AdminSessionCapacityError,
  addUsageToAdminAggregate,
  assertAdminSessionAggregate,
  assertAdminUsageAggregate,
  emptyAdminSessionAggregate,
  emptyAdminUsageAggregate,
  initialAdminSessionAggregate,
  removeAdminSession,
  summarizeAdminUser,
  upsertAdminSession,
  usageEventHash,
  type AdminAggregateMarker,
  type AdminSessionAggregate,
  type AdminSessionEntry,
  type AdminUsageAggregate
} from "./adminAggregates";
import {
  ADMIN_METRICS_SCHEMA_VERSION,
  AdminMetricsIntegrityError,
  addUsageToAdminDailyAggregate,
  adminMetricsWindow,
  assertAdminDailyUsageAggregate,
  buildMaterializedAdminMetrics,
  isAdminMetricsRangeDays,
  utcDay as adminMetricsUtcDay,
  type AdminDailyUsageAggregate,
  type AdminMetricsRangeDays
} from "./adminMetricsAggregates";
import { hashMemoContent, hashReviewResult, sha256Canonical } from "./domain/hashes";
import {
  AI_APPROVAL_REVOCATION_SCHEMA_VERSION,
  AI_APPROVAL_REQUEST_DECISION_SCHEMA_VERSION,
  AI_APPROVAL_REQUEST_SCHEMA_VERSION,
  AI_APPROVAL_SCHEMA_VERSION,
  DEFAULT_AI_APPROVAL_TTL_MS,
  MAX_AI_APPROVAL_DISPATCHES,
  MAX_AI_APPROVAL_TTL_MS,
  AiApprovalValidationError,
  aiApprovalCurrentIdentity,
  assertAiApprovalMemoChatFence,
  assertAiApprovalPolicy,
  assertAiApprovalRecord,
  assertAiApprovalRequestContext,
  assertAiApprovalRequestDecision,
  assertAiApprovalRequestRecord,
  assertAiApprovalRevocation,
  assertAiApprovalSubject,
  assertSha256,
  createAiApprovalId,
  hashAiApprovalChatHistory,
  hashAiBuilderSession,
  hashAiApprovalPayload,
  isAiApprovalPurpose,
  isDataClass,
  sameAiApprovalPolicy,
  sameAiApprovalSubject
} from "./domain/aiApproval";
import { buildAdminMetrics, summarizeUsers } from "./metrics";
import {
  assertDecisionAllowed,
  ReviewPolicyError,
  type AnalysisDecisionBinding,
  type ReviewPolicyCode,
  type RevisionBinding
} from "./domain/reviewPolicy";
import {
  NormalizedWorkspaceAccountAdapter,
  isWorkspaceAdapterError,
  type WorkspaceStateTransitions
} from "./workspaceV2AccountAdapter";
import {
  NormalizedWorkspaceRepository,
  S3WorkspaceContentStore,
  WorkspaceCursorCodec,
  WorkspaceValidationError,
  parseWorkspaceMode,
  type WorkspaceMode
} from "./workspaceV2";

const PASSWORD_ITERATIONS = 210_000;
const DEFAULT_SESSION_TTL_HOURS = 8;
const DEFAULT_INVITE_TTL_HOURS = 72;
const DEFAULT_RESET_TTL_MINUTES = 30;
const MAX_FAILED_ATTEMPTS = 6;
const LOCKOUT_MS = 1000 * 60 * 10;
const MAX_AUTH_TRANSITION_RETRIES = 16;
const MAX_AUTH_QUERY_PAGES = 10_000;
const MAX_AUTH_QUERY_ITEMS = 1_000_000;
const MAX_AI_ADMISSION_RETRIES = 16;
const MAX_ACCOUNT_STATE_RETRIES = 16;
const DEFAULT_TENANT_ID = "prod";
const MAX_EMAIL_UTF8_BYTES = 254;
const MAX_NAME_UTF8_BYTES = 120;
const MAX_PASSWORD_UTF8_BYTES = 1_024;
const MAX_ADMIN_USER_PAGE_SIZE = 50;
const SESSION_TOUCH_INTERVAL_MS = 60_000;
const AI_MEMO_CHAT_CLAIM_MS = 15 * 60 * 1_000;
const ADMIN_AGGREGATE_MARKER_KEY = "ADMIN_AGGREGATES#v1";
const ADMIN_AGGREGATE_LEASE_SECONDS = 60 * 60;
const EPHEMERAL_ADMIN_CURSOR_CODEC = new WorkspaceCursorCodec({
  activeKeyId: "ephemeral",
  keys: { ephemeral: randomBytes(32) }
});

type TransactionItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

export interface UserRecord extends UserProfile {
  passwordHash: string;
  passwordSalt: string;
  passwordIterations: number;
  failedAttempts: number;
  lockedUntil?: string;
  passwordResetGeneration?: number;
  authGeneration?: number;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  userEmail: string;
  csrfToken: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  expiresAtEpoch: number;
  authGeneration?: number;
  adminAggregateVersion?: typeof ADMIN_AGGREGATE_SCHEMA_VERSION;
}

interface AggregatedUsageRecord extends UsageEvent {
  adminAggregateVersion: typeof ADMIN_AGGREGATE_SCHEMA_VERSION;
  adminMetricsAggregateVersion?: typeof ADMIN_METRICS_SCHEMA_VERSION;
  usageEventHash: string;
  expiresAtEpoch: number;
}

interface UsageAggregationReceipt {
  eventId: string;
  eventHash: string;
  eventKey: string;
  expiresAtEpoch: number;
}

export interface InviteRecord {
  id: string;
  tokenHash: string;
  email: string;
  name: string;
  role: UserProfile["role"];
  status: "pending" | "used" | "expired";
  createdAt: string;
  expiresAt: string;
  expiresAtEpoch: number;
  invitedBy?: string;
  usedAt?: string;
}

export interface ResetRecord {
  id: string;
  tokenHash: string;
  userId: string;
  userEmail: string;
  status: "pending" | "used" | "expired";
  createdAt: string;
  expiresAt: string;
  expiresAtEpoch: number;
  usedAt?: string;
  generation?: number;
}

interface InviteEmailReservation {
  email: string;
  tokenHash: string;
  status: "pending";
  createdAt: string;
  expiresAt: string;
  expiresAtEpoch: number;
}

interface PersistedStore {
  users: UserRecord[];
  sessions: SessionRecord[];
  invites: InviteRecord[];
  resets: ResetRecord[];
  accounts: Record<string, AccountReviewState>;
  usage: UsageEvent[];
  outreachConfig?: StoredOutreachConfig;
  aiAdmission?: Record<string, AiAdmissionStateRecord>;
  aiApprovals?: Record<string, AiApprovalRecord>;
  aiApprovalRevocations?: Record<string, AiApprovalRevocation>;
  aiApprovalPointers?: Record<string, AiApprovalCurrentPointer>;
  aiApprovalCounters?: Record<string, AiApprovalDispatchCounter>;
  aiDispatches?: Record<string, AiDispatchReceipt>;
  aiApprovalRequests?: Record<string, AiApprovalRequestRecord>;
  aiApprovalRequestDecisions?: Record<string, AiApprovalRequestDecision>;
  aiApprovalRequestPreviews?: Record<string, AiApprovalRequestEncryptedPreview>;
  aiApprovalRequestPendingPointers?: Record<string, AiApprovalRequestPendingPointer>;
  workspacePreferences?: Record<string, WorkspacePreferenceRecord>;
  memoBuilderSessions?: Record<string, Record<string, StoredMemoBuilderSession>>;
}

export interface ActiveSessionSummary {
  userId: string;
  lastSeenAt: string;
}

const USAGE_TTL_DAYS = 90;

interface CreateStoreOptions {
  filePath?: string;
  persist?: boolean;
}

export interface CreateInviteInput {
  email: string;
  name?: string;
  role?: UserProfile["role"];
  invitedBy?: string;
  expiresAt?: string;
}

export interface InviteSummary {
  id: string;
  email: string;
  name: string;
  role: UserProfile["role"];
  status: InviteRecord["status"];
  createdAt: string;
  expiresAt: string;
  invitedBy?: string;
  usedAt?: string;
}

export interface InviteCreationResult {
  invite: InviteSummary;
  rawToken: string;
  inviteLink: string;
}

export interface InvitePublicInfo {
  email: string;
  name: string;
  role: UserProfile["role"];
  expiresAt: string;
  status: InviteRecord["status"];
}

export interface PasswordResetResult {
  email: string;
  rawToken?: string;
  resetLink?: string;
  expiresAt?: string;
}

export interface PasswordResetPublicInfo {
  email: string;
  expiresAt: string;
  status: ResetRecord["status"];
}

export interface AuthSession {
  rawToken: string;
  csrfToken: string;
  user: UserProfile;
}

export interface AiAdmissionLimits {
  maxConcurrentLeases: number;
  requestsPerMinute: number;
  tokensPerDay: number;
  spendUsdPerDay: number;
  maxTokensPerCall: number;
  maxCostUsdPerCall: number;
}

export type AiAdmissionDenialReason =
  | "concurrency"
  | "request_rate"
  | "daily_tokens"
  | "daily_spend"
  | "call_tokens"
  | "call_cost";

export interface AiUsageReservationRequest {
  accountId: string;
  reservationId: string;
  nowMs: number;
  leaseExpiresAtMs: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  limits: AiAdmissionLimits;
}

export type AiUsageReservationResult =
  | {
      ok: true;
      reservationId: string;
      leaseExpiresAtMs: number;
      reservedTokens: number;
      reservedCostUsd: number;
    }
  | {
      ok: false;
      reason: AiAdmissionDenialReason;
      retryAfterMs?: number;
    };

export interface AiUsageSettlementRequest {
  accountId: string;
  reservationId: string;
  nowMs: number;
  disposition: "settle" | "release" | "retain";
  actualTokens?: number;
  actualCostUsd?: number;
}

export type AiUsageSettlementResult = "settled" | "released" | "retained" | "missing";

interface AiAdmissionLeaseRecord {
  reservationId: string;
  expiresAtMs: number;
  reservedTokens: number;
  reservedCostUsd: number;
}

interface AiAdmissionStateRecord {
  version: number;
  budgetDay: string;
  tokensUsed: number;
  spendUsd: number;
  requestTimestamps: number[];
  leases: AiAdmissionLeaseRecord[];
}

export interface CreateAiApprovalCommand {
  /** Idempotency key generated by the authenticated application boundary. */
  requestId: string;
  purpose: AiApprovalPurpose;
  subject: AiApprovalSubjectBinding;
  payloadHash: string;
  providerRequestHashes: string[];
  dataClass: DataClass;
  policy: AiApprovalPolicyBinding;
  /** Caller observation, accepted only after equality with authoritative state. */
  memoChatHistoryHash?: string;
  approvedBy: {
    id: string;
    role: UserProfile["role"];
  };
  expiresAt?: string;
  /** One normally; document extraction may authorize its bounded PDF fallback. */
  dispatchLimit?: number;
}

export interface CurrentAiApprovalQuery {
  purpose: AiApprovalPurpose;
  subjectKind: AiApprovalSubjectBinding["kind"];
  subjectId: string;
}

export interface RevokeAiApprovalCommand {
  requestId: string;
  revokedBy: {
    id: string;
    role: UserProfile["role"];
  };
  reason: string;
  revokedAt?: string;
}

export interface CreateAiApprovalRequestCommand {
  requestId: string;
  requestedBy: {
    id: string;
    role: UserProfile["role"];
  };
  purpose: "council" | "memo-chat" | "memo-builder";
  subject: AiApprovalSubjectBinding;
  payloadHash: string;
  providerRequestHashes: string[];
  dataClass: DataClass;
  policy: AiApprovalPolicyBinding;
  context: AiApprovalRequestContext;
  /** Exact prospective content, encrypted separately and deleted on decision. */
  pendingContent?: { kind: "memo-chat"; text: string };
  expiresAt?: string;
}

export interface AiApprovalRequestPageQuery extends PageQuery {
  status?: AiApprovalRequestStatusKind;
}

export interface AiApprovalRequestActor {
  id: string;
  role: UserProfile["role"];
}

export interface CancelAiApprovalRequestCommand {
  requestId: string;
  actor: AiApprovalRequestActor;
  reason: string;
}

export interface DecideAiApprovalRequestCommand {
  requestId: string;
  decidedBy: AiApprovalRequestActor;
  reason?: string;
}

export interface ReserveAiDispatchRequest {
  accountId: string;
  approvalId?: string;
  trustedWorkflow?: "lead-search" | "outreach-personalization" | "outreach-writer";
  trustedSubjectId?: string;
  dispatchId: string;
  purpose: AiApprovalPurpose;
  subject?: AiApprovalSubjectBinding;
  payloadHash: string;
  providerRequestHash: string;
  dataClass: DataClass;
  policy: AiApprovalPolicyBinding;
  /** Internal durable binding copied from the validated approval/receipt. */
  memoChatFence?: AiApprovalMemoChatFence;
  nowMs: number;
}

export interface ReserveAiDispatchResult {
  replayed: boolean;
  requestHash: string;
  reservationToken: string;
}

export interface TransitionAiDispatchRequest {
  accountId: string;
  dispatchId: string;
  requestHash: string;
  reservationToken: string;
  transition: "mark-started" | "release" | "settle-failed" | "settle-succeeded";
  nowMs: number;
}

interface AiApprovalCurrentPointer {
  accountId: string;
  identity: string;
  approvalId: string;
  updatedAt: string;
  expiresAtEpoch: number;
}

interface AiApprovalDispatchCounter {
  accountId: string;
  approvalId: string;
  version: number;
  dispatchLimit: number;
  dispatchesReserved: number;
  providerRequestHashesReserved: string[];
  expiresAtEpoch: number;
}

type AiDispatchStatus = "reserved" | "started" | "failed" | "succeeded";

interface AiDispatchReceipt {
  schemaVersion: "rulix.ai-dispatch/v1";
  accountId: string;
  dispatchId: string;
  requestHash: string;
  reservationToken: string;
  purpose: AiApprovalPurpose;
  subject?: AiApprovalSubjectBinding;
  authorizationKind: "approval" | "trusted-workflow";
  approvalId?: string;
  trustedWorkflow?: "lead-search" | "outreach-personalization" | "outreach-writer";
  trustedSubjectId?: string;
  payloadHash: string;
  providerRequestHash: string;
  dataClass: DataClass;
  policy: AiApprovalPolicyBinding;
  memoChatFence?: AiApprovalMemoChatFence;
  memoChatClaimedAt?: string;
  memoChatClaimExpiresAtEpoch?: number;
  memoChatCommittedAt?: string;
  memoChatAbandonedAt?: string;
  status: AiDispatchStatus;
  createdAt: string;
  updatedAt: string;
  reservationExpiresAtEpoch: number;
  expiresAtEpoch: number;
}

interface AiApprovalRequestIndexRecord extends AiApprovalRequestListItem {
  schemaVersion: "rulix.ai-approval-request-index/v1";
  requestKey: string;
  accountIndexKey: string;
  tenantIndexKey: string;
  expiresAtEpoch: number;
}

interface AiApprovalRequestEncryptedPreview {
  schemaVersion: "rulix.ai-approval-request-preview/v1";
  requestId: string;
  targetAccountId: string;
  bindingHash: string;
  keyId: string;
  iv: string;
  ciphertext: string;
  authTag: string;
  expiresAtEpoch: number;
}

interface AiApprovalRequestPendingPointer {
  schemaVersion: "rulix.ai-approval-request-pending/v1";
  targetAccountId: string;
  dedupeHash: string;
  approvalRequestId: string;
  validUntilEpoch: number;
  expiresAtEpoch: number;
}

export interface PageQuery {
  limit: number;
  cursor?: string;
}

export interface ReviewPageQuery extends PageQuery {
  state: "active" | "archived" | "all";
}

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface AdminAggregateBackfillResult {
  status: "complete";
  usageEventsProcessed: number;
  sessionsProcessed: number;
  sessionsRevoked: number;
}

export type ReviewSummary = Omit<MemoRecord, "memoText" | "attachments">;

export interface ReviewDetail {
  review: MemoRecord;
  result?: ReviewResult;
  decision?: ReviewerDecision;
}

export interface ReviewExpectedBindings {
  expectedVersion: number;
  expectedRevision: number;
  expectedHash: string;
}

export interface ReviewCommandResult {
  review: MemoRecord;
  auditEvents: AuditEvent[];
}

export interface CreateReviewCommand {
  requestId: string;
  inputHash: string;
  memo: MemoRecord;
  auditEvent: AuditEvent;
}

export interface CreateReviewResult extends ReviewCommandResult {
  replayed: boolean;
}

export interface UpdateReviewMemoCommand extends ReviewExpectedBindings {
  memoText: string;
  auditEvent: AuditEvent;
}

export interface ArchiveReviewCommand extends ReviewExpectedBindings {
  archived: boolean;
  actor: string;
  auditEvent: AuditEvent;
}

export interface AppendBoundChatCommand extends ReviewExpectedBindings {
  messages: MemoChatMessage[];
  auditEvent?: AuditEvent;
  /** Server-generated dispatch ID; never accepted from the HTTP request body. */
  aiDispatchId?: string;
  /** Resolved only inside the store before crossing the workspace boundary. */
  aiDispatchClaim?: AiMemoChatDispatchClaim;
}

export interface AiMemoChatDispatchClaim {
  dispatchId: string;
  requestHash: string;
  reservationToken: string;
  expiresAtEpoch: number;
  outcome?: "succeeded" | "failed";
  fence?: AiApprovalMemoChatFence;
}

export interface ApplyChatSuggestionCommand {
  messageId: string;
  expectedVersion: number;
  expectedHash: string;
  auditEvent: AuditEvent;
}

export interface ChatCommandResult extends ReviewCommandResult {
  messages: MemoChatMessage[];
}

export interface WorkspacePreferenceRecord {
  selectedMemoId?: string;
  activeMemoBuilderSessionId?: string;
  version: number;
}

export interface UpdateWorkspacePreferencesCommand {
  expectedVersion: number;
  selectedMemoId?: string | null;
  activeMemoBuilderSessionId?: string | null;
}

export interface StoredMemoBuilderSession {
  session: MemoBuilderSession;
  version: number;
}

export interface UpsertMemoBuilderSessionCommand {
  expectedVersion: number;
  session: MemoBuilderSession;
}

export interface AccountStore {
  createInvite(input: CreateInviteInput): Promise<InviteCreationResult>;
  listInvites(): Promise<InviteSummary[]>;
  getInviteByToken(rawToken: string): Promise<InvitePublicInfo>;
  acceptInvite(rawToken: string, password: string, name?: string): Promise<AuthSession>;
  authenticate(emailInput: string, password: string): Promise<AuthSession>;
  requestPasswordReset(emailInput: string): Promise<PasswordResetResult>;
  getPasswordResetByToken(rawToken: string): Promise<PasswordResetPublicInfo>;
  completePasswordReset(rawToken: string, password: string): Promise<AuthSession>;
  getSession(rawToken: string | undefined): Promise<{ user: UserProfile; session: SessionRecord } | undefined>;
  destroySession(rawToken: string | undefined): Promise<void>;
  /** Legacy migration read; browser routes must use the paged entity APIs below. */
  getAccountState(userId: string): Promise<AccountReviewState>;
  listReviews(userId: string, query: ReviewPageQuery): Promise<CursorPage<ReviewSummary>>;
  getReviewDetail(userId: string, memoId: string): Promise<ReviewDetail | undefined>;
  listReviewAuditEvents(userId: string, memoId: string, query: PageQuery): Promise<CursorPage<AuditEvent>>;
  listReviewChatMessages(userId: string, memoId: string, query: PageQuery): Promise<CursorPage<MemoChatMessage>>;
  createReviewIdempotent(userId: string, command: CreateReviewCommand): Promise<CreateReviewResult>;
  updateReviewMemo(userId: string, memoId: string, command: UpdateReviewMemoCommand): Promise<ReviewCommandResult>;
  setReviewArchived(userId: string, memoId: string, command: ArchiveReviewCommand): Promise<ReviewCommandResult>;
  appendBoundChat(userId: string, memoId: string, command: AppendBoundChatCommand): Promise<ChatCommandResult>;
  applyChatSuggestion(userId: string, memoId: string, command: ApplyChatSuggestionCommand): Promise<ChatCommandResult>;
  getWorkspacePreferences(userId: string): Promise<WorkspacePreferenceRecord>;
  updateWorkspacePreferences(userId: string, command: UpdateWorkspacePreferencesCommand): Promise<WorkspacePreferenceRecord>;
  listMemoBuilderSessions(userId: string, query: PageQuery): Promise<CursorPage<StoredMemoBuilderSession>>;
  upsertMemoBuilderSession(userId: string, sessionId: string, command: UpsertMemoBuilderSessionCommand): Promise<StoredMemoBuilderSession>;
  deleteMemoBuilderSession(userId: string, sessionId: string, expectedVersion: number): Promise<void>;
  listOutreachLeadsPage(userId: string, query: PageQuery): Promise<CursorPage<OutreachLead>>;
  listOutreachLeads(userId: string): Promise<OutreachLead[]>;
  getOutreachLead(userId: string, leadId: string): Promise<OutreachLead | undefined>;
  upsertOutreachLeads(userId: string, leads: OutreachLead[]): Promise<void>;
  listOutreachDraftsPage(userId: string, query: PageQuery): Promise<CursorPage<OutreachDraft>>;
  listOutreachDrafts(userId: string): Promise<Record<string, OutreachDraft>>;
  getOutreachDraft(userId: string, leadId: string): Promise<OutreachDraft | undefined>;
  upsertOutreachDraft(userId: string, draft: OutreachDraft, expectedUpdatedAt?: string): Promise<void>;
  listLeadSearchRunsPage(userId: string, query: PageQuery): Promise<CursorPage<LeadSearchRun>>;
  listLeadSearchRuns(userId: string): Promise<LeadSearchRun[]>;
  appendLeadSearchRun(userId: string, run: LeadSearchRun): Promise<void>;
  listLeadWorkflowsPage(userId: string, query: PageQuery): Promise<CursorPage<LeadWorkflow>>;
  listLeadWorkflows(userId: string): Promise<Record<string, LeadWorkflow>>;
  getLeadWorkflow(userId: string, leadId: string): Promise<LeadWorkflow | undefined>;
  upsertLeadWorkflow(userId: string, workflow: LeadWorkflow, expectedUpdatedAt?: string): Promise<void>;
  listOutreachJobsPage(userId: string, query: PageQuery): Promise<CursorPage<OutreachJob>>;
  listOutreachJobs(userId: string): Promise<OutreachJob[]>;
  getOutreachJob(userId: string, jobId: string): Promise<OutreachJob | undefined>;
  upsertOutreachJob(userId: string, job: OutreachJob, expectedUpdatedAt?: string): Promise<void>;
  upsertReview(userId: string, memo: MemoRecord): Promise<void>;
  updateReview(userId: string, memo: MemoRecord): Promise<void>;
  findReview(userId: string, memoId: string): Promise<MemoRecord | undefined>;
  setAnalysisResult(
    userId: string,
    memo: MemoRecord,
    result: ReviewResult,
    auditEvents?: AnalysisTransitionAuditEvents
  ): Promise<AnalysisTransitionResult>;
  setDecision(
    userId: string,
    memoId: string,
    decision: ReviewerDecision,
    auditEvent: AuditEvent,
    expected: DecisionExpectedBindings
  ): Promise<DecisionTransitionResult>;
  appendAuditEvent(userId: string, event: AuditEvent): Promise<void>;
  appendChatMessages(userId: string, memoId: string, messages: MemoChatMessage[]): Promise<MemoChatMessage[]>;
  recordUsage(event: UsageEvent): Promise<void>;
  getUsage(rangeDays?: number): Promise<UsageEvent[]>;
  getAdminMetrics(rangeDays: AdminMetricsRangeDays): Promise<AdminMetrics>;
  reserveAiUsage(request: AiUsageReservationRequest): Promise<AiUsageReservationResult>;
  settleAiUsage(request: AiUsageSettlementRequest): Promise<AiUsageSettlementResult>;
  createAiApproval(accountId: string, command: CreateAiApprovalCommand): Promise<AiApprovalRecord>;
  getCurrentAiApproval(accountId: string, query: CurrentAiApprovalQuery): Promise<AiApprovalStatus | undefined>;
  revokeAiApproval(
    accountId: string,
    approvalId: string,
    command: RevokeAiApprovalCommand
  ): Promise<AiApprovalStatus>;
  createAiApprovalRequest(
    requesterAccountId: string,
    command: CreateAiApprovalRequestCommand
  ): Promise<AiApprovalRequestStatus>;
  listAiApprovalRequests(
    accountId: string,
    query: AiApprovalRequestPageQuery
  ): Promise<CursorPage<AiApprovalRequestListItem>>;
  getAiApprovalRequest(accountId: string, requestId: string): Promise<AiApprovalRequestStatus | undefined>;
  cancelAiApprovalRequest(
    accountId: string,
    approvalRequestId: string,
    command: CancelAiApprovalRequestCommand
  ): Promise<AiApprovalRequestStatus>;
  listTenantAiApprovalRequests(
    actor: AiApprovalRequestActor,
    query: AiApprovalRequestPageQuery
  ): Promise<CursorPage<AiApprovalRequestListItem>>;
  getTenantAiApprovalRequest(
    actor: AiApprovalRequestActor,
    requestId: string
  ): Promise<AiApprovalRequestOfficerDetail | undefined>;
  approveAiApprovalRequest(
    approvalRequestId: string,
    command: DecideAiApprovalRequestCommand
  ): Promise<AiApprovalRequestStatus>;
  rejectAiApprovalRequest(
    approvalRequestId: string,
    command: DecideAiApprovalRequestCommand
  ): Promise<AiApprovalRequestStatus>;
  revokeAiApprovalRequestApproval(
    approvalRequestId: string,
    command: RevokeAiApprovalCommand
  ): Promise<AiApprovalRequestStatus>;
  reserveAiDispatch(request: ReserveAiDispatchRequest): Promise<ReserveAiDispatchResult>;
  transitionAiDispatch(request: TransitionAiDispatchRequest): Promise<void>;
  listUsers(): Promise<UserProfile[]>;
  listActiveSessions(): Promise<ActiveSessionSummary[]>;
  listAdminUsersPage(query: PageQuery): Promise<CursorPage<UserAdminSummary>>;
  backfillAdminAggregates(): Promise<AdminAggregateBackfillResult>;
  getOutreachConfig(): Promise<StoredOutreachConfig>;
  setOutreachConfig(config: StoredOutreachConfig): Promise<void>;
}

export class LocalAccountStore implements AccountStore {
  private readonly filePath?: string;
  private readonly persistEnabled: boolean;
  private users = new Map<string, UserRecord>();
  private sessions = new Map<string, SessionRecord>();
  private invites = new Map<string, InviteRecord>();
  private resets = new Map<string, ResetRecord>();
  private accounts = new Map<string, AccountReviewState>();
  private usage: UsageEvent[] = [];
  private aiAdmission = new Map<string, AiAdmissionStateRecord>();
  private aiApprovals = new Map<string, AiApprovalRecord>();
  private aiApprovalRevocations = new Map<string, AiApprovalRevocation>();
  private aiApprovalPointers = new Map<string, AiApprovalCurrentPointer>();
  private aiApprovalCounters = new Map<string, AiApprovalDispatchCounter>();
  private aiDispatches = new Map<string, AiDispatchReceipt>();
  private aiApprovalRequests = new Map<string, AiApprovalRequestRecord>();
  private aiApprovalRequestDecisions = new Map<string, AiApprovalRequestDecision>();
  private aiApprovalRequestPreviews = new Map<string, AiApprovalRequestEncryptedPreview>();
  private aiApprovalRequestPendingPointers = new Map<string, AiApprovalRequestPendingPointer>();
  private outreachConfig: StoredOutreachConfig = defaultOutreachConfig();
  private workspacePreferences = new Map<string, WorkspacePreferenceRecord>();
  private memoBuilderSessions = new Map<string, Map<string, StoredMemoBuilderSession>>();

  constructor(options: CreateStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultStorePath();
    this.persistEnabled = options.persist ?? true;
    if (this.persistEnabled) {
      this.load();
    }
  }

  async createInvite(input: CreateInviteInput): Promise<InviteCreationResult> {
    const email = normalizeEmail(input.email);
    if (this.findUserByEmail(email)) {
      throw new StoreError(409, "An account already exists for that email.");
    }
    if (Array.from(this.invites.values()).some((invite) => invite.email === email && invite.status === "pending" && !isExpired(invite.expiresAt))) {
      throw new StoreError(409, "A pending invite already exists for that email.");
    }

    const rawToken = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const expiresAt = input.expiresAt ?? new Date(Date.now() + inviteTtlMs()).toISOString();
    const invite: InviteRecord = {
      id: `invite-${randomBytes(12).toString("base64url")}`,
      tokenHash: hashToken(rawToken),
      email,
      name: normalizeName(input.name ?? "", email),
      role: input.role ?? "reviewer",
      status: "pending",
      createdAt: now,
      expiresAt,
      expiresAtEpoch: toEpochSeconds(expiresAt),
      invitedBy: input.invitedBy
    };
    this.invites.set(invite.tokenHash, invite);
    this.persist();
    return { invite: summarizeInvite(invite), rawToken, inviteLink: inviteLink(rawToken) };
  }

  async listInvites() {
    this.expireInvites();
    return Array.from(this.invites.values())
      .map(summarizeInvite)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getInviteByToken(rawToken: string): Promise<InvitePublicInfo> {
    const invite = this.invites.get(hashToken(rawToken));
    return publicInviteInfo(validateInvite(invite));
  }

  async acceptInvite(rawToken: string, password: string, name?: string): Promise<AuthSession> {
    const tokenHash = hashToken(rawToken);
    const invite = validateInvite(this.invites.get(tokenHash));
    validatePassword(password);
    if (this.findUserByEmail(invite.email)) {
      throw new StoreError(409, "An account already exists for that email.");
    }

    const user = createUserRecord(invite.email, name ?? invite.name, invite.role, password);
    this.users.set(user.id, user);
    this.accounts.set(user.id, emptyAccountState());
    invite.status = "used";
    invite.usedAt = new Date().toISOString();
    this.invites.set(tokenHash, invite);
    const session = this.createSession(user);
    this.persist();
    return session;
  }

  async authenticate(emailInput: string, password: string): Promise<AuthSession> {
    validateAuthenticationPassword(password);
    let email: string;
    try {
      email = normalizeEmail(emailInput);
    } catch {
      throw invalidCredentials();
    }
    const user = this.findUserByEmail(email);
    if (!user) {
      hashPassword(password, randomBytes(16).toString("base64url"), PASSWORD_ITERATIONS);
      throw invalidCredentials();
    }

    if (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) {
      throw new StoreError(429, "Too many failed sign-in attempts. Try again later.");
    }

    if (!verifyPassword(password, user)) {
      recordFailedAttempt(user);
      this.users.set(user.id, user);
      this.persist();
      throw invalidCredentials();
    }

    clearFailedAttempts(user);
    this.users.set(user.id, user);
    const session = this.createSession(user);
    this.persist();
    return session;
  }

  async requestPasswordReset(emailInput: string): Promise<PasswordResetResult> {
    const email = normalizeEmail(emailInput);
    const user = this.findUserByEmail(email);
    if (!user) return { email };

    const generation = (user.passwordResetGeneration ?? 0) + 1;
    user.passwordResetGeneration = generation;
    for (const [tokenHash, existing] of this.resets.entries()) {
      if (existing.userId === user.id && existing.status === "pending") {
        this.resets.set(tokenHash, { ...existing, status: "expired" });
      }
    }
    const rawToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + resetTtlMs()).toISOString();
    const reset: ResetRecord = {
      id: `reset-${randomBytes(12).toString("base64url")}`,
      tokenHash: hashToken(rawToken),
      userId: user.id,
      userEmail: user.email,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt,
      expiresAtEpoch: toEpochSeconds(expiresAt),
      generation
    };
    this.users.set(user.id, user);
    this.resets.set(reset.tokenHash, reset);
    this.persist();
    return { email, rawToken, resetLink: resetLink(rawToken), expiresAt };
  }

  async getPasswordResetByToken(rawToken: string): Promise<PasswordResetPublicInfo> {
    const reset = validateReset(this.resets.get(hashToken(rawToken)));
    const user = this.users.get(reset.userId);
    validateResetGeneration(reset, user);
    return { email: reset.userEmail, expiresAt: reset.expiresAt, status: reset.status };
  }

  async completePasswordReset(rawToken: string, password: string): Promise<AuthSession> {
    const tokenHash = hashToken(rawToken);
    const reset = validateReset(this.resets.get(tokenHash));
    validatePassword(password);
    const user = this.users.get(reset.userId);
    if (!user) throw new StoreError(404, "Password reset link is invalid or expired.");
    validateResetGeneration(reset, user);

    setUserPassword(user, password);
    clearFailedAttempts(user);
    user.passwordResetGeneration = (user.passwordResetGeneration ?? 0) + 1;
    user.authGeneration = currentAuthGeneration(user) + 1;
    reset.status = "used";
    reset.usedAt = new Date().toISOString();
    this.resets.set(tokenHash, reset);
    this.users.set(user.id, user);
    this.revokeUserSessions(user.id);
    const session = this.createSession(user);
    this.persist();
    return session;
  }

  async getSession(rawToken: string | undefined): Promise<{ user: UserProfile; session: SessionRecord } | undefined> {
    if (!rawToken) return undefined;
    const tokenHash = hashToken(rawToken);
    const session = this.sessions.get(tokenHash);
    if (!session) return undefined;
    if (isExpired(session.expiresAt)) {
      this.sessions.delete(tokenHash);
      this.persist();
      return undefined;
    }

    const user = this.users.get(session.userId);
    if (!user) return undefined;
    if (currentAuthGeneration(user) !== currentSessionGeneration(session)) {
      this.sessions.delete(tokenHash);
      this.persist();
      return undefined;
    }
    if (sessionTouchDue(session.lastSeenAt)) {
      session.lastSeenAt = new Date().toISOString();
      this.sessions.set(tokenHash, session);
      this.persist();
    }
    return { user: publicUser(user), session };
  }

  async destroySession(rawToken: string | undefined) {
    if (!rawToken) return;
    this.sessions.delete(hashToken(rawToken));
    this.persist();
  }

  async getAccountState(userId: string): Promise<AccountReviewState> {
    const current = this.accounts.get(userId) ?? emptyAccountState();
    this.accounts.set(userId, current);
    return cloneAccountState(current);
  }

  async replaceAccountState(userId: string, state: AccountReviewState) {
    const incoming = normalizeAccountState(state);
    this.mutateAccountState(userId, (existing) => {
      replaceStateContents(existing, mergeAccountState(existing, incoming));
    });
  }

  async listReviews(userId: string, query: ReviewPageQuery) {
    const state = await this.getAccountState(userId);
    const reviews = state.memos
      .filter((memo) => query.state === "all"
        || (query.state === "archived" ? Boolean(memo.archivedAt) : !memo.archivedAt))
      .sort((left, right) => compareByDateThenId(right.updatedAt, right.id, left.updatedAt, left.id))
      .map(reviewSummary);
    return paginate(reviews, query);
  }

  async getReviewDetail(userId: string, memoId: string) {
    const state = await this.getAccountState(userId);
    const review = state.memos.find((memo) => memo.id === memoId);
    if (!review) return undefined;
    return {
      review,
      result: state.analysisResults[memoId],
      decision: state.decisions[memoId]
    };
  }

  async listReviewAuditEvents(userId: string, memoId: string, query: PageQuery) {
    const state = await this.getAccountState(userId);
    const events = state.auditEvents
      .filter((event) => event.memoId === memoId)
      .sort((left, right) => compareByDateThenId(right.at, right.id, left.at, left.id));
    return paginate(events, query);
  }

  async listReviewChatMessages(userId: string, memoId: string, query: PageQuery) {
    const state = await this.getAccountState(userId);
    const messages = [...(state.chatMessages[memoId] ?? [])]
      .sort((left, right) => compareByDateThenId(right.createdAt, right.id, left.createdAt, left.id));
    return paginate(messages, query);
  }

  async createReviewIdempotent(userId: string, command: CreateReviewCommand) {
    return this.mutateAccountState(userId, (state) =>
      applyCreateReviewCommand(state, userId, command)
    );
  }

  async updateReviewMemo(userId: string, memoId: string, command: UpdateReviewMemoCommand) {
    return this.mutateAccountState(userId, (state) =>
      applyUpdateReviewMemoCommand(state, userId, memoId, command)
    );
  }

  async setReviewArchived(userId: string, memoId: string, command: ArchiveReviewCommand) {
    return this.mutateAccountState(userId, (state) =>
      applyArchiveReviewCommand(state, memoId, command)
    );
  }

  async appendBoundChat(userId: string, memoId: string, command: AppendBoundChatCommand) {
    const nowMs = Date.now();
    const receipt = command.aiDispatchId
      ? storedAiDispatchReceipt(this.aiDispatches.get(localAiDispatchKey(userId, command.aiDispatchId)))
      : undefined;
    if (receipt) {
      assertMemoChatAppendReceipt(receipt, userId, memoId, nowMs);
      this.assertLocalMemoChatFenceCurrent(userId, memoId, receipt.memoChatFence);
    } else {
      this.assertNoLocalMemoChatClaim(userId, memoId, nowMs);
    }
    const current = cloneAccountState(normalizeAccountState(this.accounts.get(userId) ?? emptyAccountState()));
    const expectedVersion = current.version ?? 0;
    try {
      const result = applyAppendBoundChatCommand(current, memoId, command);
      current.version = expectedVersion + 1;
      this.accounts.set(userId, normalizeAccountState(current));
      if (receipt) {
        receipt.memoChatCommittedAt = new Date(nowMs).toISOString();
        receipt.updatedAt = receipt.memoChatCommittedAt;
        this.aiDispatches.set(localAiDispatchKey(userId, receipt.dispatchId), receipt);
      }
      this.persist();
      return cloneMutationResult(result);
    } catch (error) {
      if (receipt && !receipt.memoChatCommittedAt) {
        receipt.memoChatAbandonedAt = new Date(nowMs).toISOString();
        receipt.updatedAt = receipt.memoChatAbandonedAt;
        this.aiDispatches.set(localAiDispatchKey(userId, receipt.dispatchId), receipt);
        this.persist();
      }
      throw error;
    }
  }

  async applyChatSuggestion(userId: string, memoId: string, command: ApplyChatSuggestionCommand) {
    return this.mutateAccountState(userId, (state) =>
      applyChatSuggestionCommand(state, userId, memoId, command)
    );
  }

  async getWorkspacePreferences(userId: string) {
    return cloneAccountState(this.workspacePreferences.get(userId) ?? { version: 0 });
  }

  async updateWorkspacePreferences(userId: string, command: UpdateWorkspacePreferencesCommand) {
    const current = this.workspacePreferences.get(userId) ?? { version: 0 };
    if (command.expectedVersion !== current.version) {
      throw new StoreError(409, "Workspace preferences changed in another session. Reload and try again.", "stale_preferences");
    }
    const next: WorkspacePreferenceRecord = {
      version: current.version + 1,
      ...(command.selectedMemoId === undefined
        ? (current.selectedMemoId ? { selectedMemoId: current.selectedMemoId } : {})
        : (command.selectedMemoId ? { selectedMemoId: command.selectedMemoId } : {})),
      ...(command.activeMemoBuilderSessionId === undefined
        ? (current.activeMemoBuilderSessionId
            ? { activeMemoBuilderSessionId: current.activeMemoBuilderSessionId }
            : {})
        : (command.activeMemoBuilderSessionId
            ? { activeMemoBuilderSessionId: command.activeMemoBuilderSessionId }
            : {}))
    };
    this.workspacePreferences.set(userId, next);
    this.persist();
    return cloneAccountState(next);
  }

  async listMemoBuilderSessions(userId: string, query: PageQuery) {
    const sessions = [...(this.memoBuilderSessions.get(userId)?.values() ?? [])]
      .sort((left, right) => compareByDateThenId(
        right.session.updatedAt,
        right.session.id,
        left.session.updatedAt,
        left.session.id
      ));
    return paginate(sessions, query);
  }

  async upsertMemoBuilderSession(
    userId: string,
    sessionId: string,
    command: UpsertMemoBuilderSessionCommand
  ) {
    if (sessionId !== command.session.id) {
      throw new StoreError(400, "Memo Builder session ID does not match the route.", "invalid_session_id");
    }
    const sessions = this.memoBuilderSessions.get(userId) ?? new Map<string, StoredMemoBuilderSession>();
    const current = sessions.get(sessionId);
    const currentVersion = current?.version ?? 0;
    if (command.expectedVersion !== currentVersion) {
      throw new StoreError(409, "Memo Builder session changed in another tab. Reload and try again.", "stale_builder_session");
    }
    if (!current && sessions.size >= 50) {
      throw new StoreError(409, "Memo Builder can retain at most 50 saved chats. Delete an older chat first.", "builder_session_limit");
    }
    const stored: StoredMemoBuilderSession = {
      session: cloneAccountState(command.session),
      version: currentVersion + 1
    };
    sessions.set(sessionId, stored);
    this.memoBuilderSessions.set(userId, sessions);
    this.persist();
    return cloneAccountState(stored);
  }

  async deleteMemoBuilderSession(userId: string, sessionId: string, expectedVersion: number) {
    const sessions = this.memoBuilderSessions.get(userId) ?? new Map<string, StoredMemoBuilderSession>();
    const current = sessions.get(sessionId);
    if (!current) return;
    if (current.version !== expectedVersion) {
      throw new StoreError(409, "Memo Builder session changed in another tab. Reload and try again.", "stale_builder_session");
    }
    sessions.delete(sessionId);
    this.memoBuilderSessions.set(userId, sessions);
    this.persist();
  }

  async listOutreachLeadsPage(userId: string, query: PageQuery) {
    const discovered = (this.accounts.get(userId) ?? emptyAccountState()).discoveredLeads ?? [];
    return paginateOutreachCollection(
      mergeBundledOutreachLeads(discovered),
      query,
      userId,
      "leads",
      EPHEMERAL_ADMIN_CURSOR_CODEC
    );
  }

  async listOutreachLeads(userId: string) {
    return cloneAccountState((this.accounts.get(userId) ?? emptyAccountState()).discoveredLeads ?? []);
  }

  async getOutreachLead(userId: string, leadId: string) {
    const bundled = bundledOutreachLeads.find((lead) => lead.leadId === leadId);
    if (bundled) return cloneAccountState(bundled);
    const stored = (this.accounts.get(userId) ?? emptyAccountState()).discoveredLeads
      ?.find((lead) => lead.leadId === leadId);
    return stored ? cloneAccountState(stored) : undefined;
  }

  async upsertOutreachLeads(userId: string, leads: OutreachLead[]) {
    this.mutateAccountState(userId, (state) => {
      state.discoveredLeads = mergeByKey(leads, state.discoveredLeads ?? [], (lead) => lead.leadId);
    });
  }

  async listOutreachDraftsPage(userId: string, query: PageQuery) {
    const drafts = Object.values((this.accounts.get(userId) ?? emptyAccountState()).outreachDrafts ?? {})
      .sort((left, right) => left.leadId.localeCompare(right.leadId));
    return paginateOutreachCollection(drafts, query, userId, "drafts", EPHEMERAL_ADMIN_CURSOR_CODEC);
  }

  async listOutreachDrafts(userId: string) {
    return cloneAccountState((this.accounts.get(userId) ?? emptyAccountState()).outreachDrafts ?? {});
  }

  async getOutreachDraft(userId: string, leadId: string) {
    const draft = (this.accounts.get(userId) ?? emptyAccountState()).outreachDrafts?.[leadId];
    return draft ? cloneAccountState(draft) : undefined;
  }

  async upsertOutreachDraft(userId: string, draft: OutreachDraft, expectedUpdatedAt?: string) {
    this.mutateAccountState(userId, (state) => {
      const current = state.outreachDrafts?.[draft.leadId];
      if (expectedUpdatedAt !== undefined && current?.updatedAt !== expectedUpdatedAt) {
        throw new StoreError(409, "Outreach draft changed in another session.", "stale_outreach_draft");
      }
      state.outreachDrafts = { ...(state.outreachDrafts ?? {}), [draft.leadId]: cloneAccountState(draft) };
    });
  }

  async listLeadSearchRunsPage(userId: string, query: PageQuery) {
    const runs = [...((this.accounts.get(userId) ?? emptyAccountState()).leadSearchRuns ?? [])]
      .sort((left, right) => right.id.localeCompare(left.id));
    return paginateOutreachCollection(runs, query, userId, "runs", EPHEMERAL_ADMIN_CURSOR_CODEC);
  }

  async listLeadSearchRuns(userId: string) {
    return cloneAccountState((this.accounts.get(userId) ?? emptyAccountState()).leadSearchRuns ?? []);
  }

  async appendLeadSearchRun(userId: string, run: LeadSearchRun) {
    this.mutateAccountState(userId, (state) => {
      state.leadSearchRuns = mergeById([run], state.leadSearchRuns ?? []);
    });
  }

  async listLeadWorkflowsPage(userId: string, query: PageQuery) {
    const workflows = Object.values((this.accounts.get(userId) ?? emptyAccountState()).leadWorkflows ?? {})
      .sort((left, right) => left.leadId.localeCompare(right.leadId));
    return paginateOutreachCollection(workflows, query, userId, "workflows", EPHEMERAL_ADMIN_CURSOR_CODEC);
  }

  async listLeadWorkflows(userId: string) {
    return cloneAccountState((this.accounts.get(userId) ?? emptyAccountState()).leadWorkflows ?? {});
  }

  async getLeadWorkflow(userId: string, leadId: string) {
    const workflow = (this.accounts.get(userId) ?? emptyAccountState()).leadWorkflows?.[leadId];
    return workflow ? cloneAccountState(workflow) : undefined;
  }

  async upsertLeadWorkflow(userId: string, workflow: LeadWorkflow, expectedUpdatedAt?: string) {
    this.mutateAccountState(userId, (state) => {
      const current = state.leadWorkflows?.[workflow.leadId];
      if (expectedUpdatedAt !== undefined && current?.updatedAt !== expectedUpdatedAt) {
        throw new StoreError(409, "Lead workflow changed in another session.", "stale_lead_workflow");
      }
      state.leadWorkflows = { ...(state.leadWorkflows ?? {}), [workflow.leadId]: cloneAccountState(workflow) };
    });
  }

  async listOutreachJobsPage(userId: string, query: PageQuery) {
    const jobs = [...((this.accounts.get(userId) ?? emptyAccountState()).outreachJobs ?? [])]
      .sort((left, right) => right.id.localeCompare(left.id));
    return paginateOutreachCollection(jobs, query, userId, "jobs", EPHEMERAL_ADMIN_CURSOR_CODEC);
  }

  async listOutreachJobs(userId: string) {
    return cloneAccountState((this.accounts.get(userId) ?? emptyAccountState()).outreachJobs ?? []);
  }

  async getOutreachJob(userId: string, jobId: string) {
    const job = (this.accounts.get(userId) ?? emptyAccountState()).outreachJobs
      ?.find((candidate) => candidate.id === jobId);
    return job ? cloneAccountState(job) : undefined;
  }

  async upsertOutreachJob(userId: string, job: OutreachJob, expectedUpdatedAt?: string) {
    this.mutateAccountState(userId, (state) => {
      const current = state.outreachJobs?.find((candidate) => candidate.id === job.id);
      if (expectedUpdatedAt !== undefined && current?.updatedAt !== expectedUpdatedAt) {
        throw new StoreError(409, "Outreach job changed in another session.", "stale_outreach_job");
      }
      state.outreachJobs = mergeById([job], state.outreachJobs ?? []);
    });
  }

  async upsertReview(userId: string, memo: MemoRecord) {
    this.mutateAccountState(userId, (state) => {
      const securedMemo = ensureMemoIntegrity(memo);
      state.memos = [securedMemo, ...state.memos.filter((item) => item.id !== memo.id)];
      state.selectedMemoId = memo.id;
      const revisions = state.memoRevisions ??= {};
      revisions[memo.id] = mergeById(
        [memoRevisionFromRecord(securedMemo, securedMemo.createdBy ?? userId, "created")],
        revisions[memo.id] ?? []
      );
    });
  }

  async updateReview(userId: string, memo: MemoRecord) {
    this.mutateAccountState(userId, (state) => {
      applyReviewUpdate(state, memo, userId);
    });
  }

  async findReview(userId: string, memoId: string) {
    return (await this.getAccountState(userId)).memos.find((memo) => memo.id === memoId);
  }

  async setAnalysisResult(
    userId: string,
    memo: MemoRecord,
    result: ReviewResult,
    auditEvents?: AnalysisTransitionAuditEvents
  ) {
    return this.mutateAccountState(userId, (state) =>
      applyAnalysisTransition(
        state,
        userId,
        memo,
        result,
        auditEvents
      )
    );
  }

  async setDecision(
    userId: string,
    memoId: string,
    decision: ReviewerDecision,
    auditEvent: AuditEvent,
    expected: DecisionExpectedBindings
  ) {
    return this.mutateAccountState(userId, (state) =>
      applyDecisionTransition(state, userId, memoId, decision, auditEvent, expected)
    );
  }

  async appendAuditEvent(userId: string, event: AuditEvent) {
    this.mutateAccountState(userId, (state) => {
      state.auditEvents = mergeById([event], state.auditEvents);
    });
  }

  async appendChatMessages(userId: string, memoId: string, messages: MemoChatMessage[]) {
    return this.mutateAccountState(userId, (state) => {
      state.chatMessages[memoId] = mergeById(
        [...(state.chatMessages[memoId] ?? []), ...messages],
        []
      );
      return state.chatMessages[memoId];
    });
  }

  async recordUsage(event: UsageEvent) {
    try {
      addUsageToAdminDailyAggregate(undefined, event);
    } catch (error) {
      if (error instanceof AdminMetricsIntegrityError) {
        throw new StoreError(400, error.message, "invalid_usage_event");
      }
      throw error;
    }
    const existing = this.usage.find((candidate) => candidate.id === event.id);
    if (existing) {
      if (usageEventHash(existing) === usageEventHash(event)) return;
      throw new StoreError(409, "Usage event id is already bound to different telemetry.", "usage_event_conflict");
    }
    this.usage.push(event);
    this.persist();
  }

  async getUsage(rangeDays?: number) {
    const cutoff = rangeDaysCutoff(rangeDays);
    return this.usage.filter((event) => Date.parse(event.at) >= cutoff);
  }

  async getAdminMetrics(rangeDays: AdminMetricsRangeDays): Promise<AdminMetrics> {
    if (!isAdminMetricsRangeDays(rangeDays)) {
      throw new StoreError(400, "Admin metrics support only 7, 30, or 90 days.", "invalid_metrics_range");
    }
    return buildAdminMetrics({
      usage: dedupeUsageEvents(this.usage),
      users: await this.listUsers(),
      sessions: await this.listActiveSessions(),
      rangeDays
    });
  }

  async reserveAiUsage(request: AiUsageReservationRequest): Promise<AiUsageReservationResult> {
    const transition = reserveAiUsageTransition(this.aiAdmission.get(request.accountId), request);
    if (!transition.result.ok || !transition.state) return transition.result;
    this.aiAdmission.set(request.accountId, transition.state);
    this.persist();
    return transition.result;
  }

  async settleAiUsage(request: AiUsageSettlementRequest): Promise<AiUsageSettlementResult> {
    const transition = settleAiUsageTransition(this.aiAdmission.get(request.accountId), request);
    if (transition.state) {
      this.aiAdmission.set(request.accountId, transition.state);
      this.persist();
    }
    return transition.result;
  }

  async createAiApproval(accountId: string, command: CreateAiApprovalCommand): Promise<AiApprovalRecord> {
    const memoChatFence = command.purpose === "memo-chat"
      ? this.captureLocalMemoChatFence(accountId, command.subject.id, command.memoChatHistoryHash)
      : undefined;
    const approval = prepareAiApproval(DEFAULT_TENANT_ID, accountId, command, Date.now(), memoChatFence);
    this.assertLocalApprovalSubjectCurrent(accountId, approval.subject);
    const existing = this.aiApprovals.get(localAiApprovalKey(accountId, approval.id));
    if (existing) {
      const validated = storedAiApproval(existing);
      if (validated.commandHash === approval.commandHash) return structuredClone(validated);
      throw new StoreError(
        409,
        "This AI approval request ID is already bound to different content.",
        "ai_approval_idempotency_conflict"
      );
    }
    const pointerKey = localAiApprovalPointerKey(accountId, approval.subject, approval.purpose);
    this.aiApprovals.set(localAiApprovalKey(accountId, approval.id), approval);
    this.aiApprovalCounters.set(localAiApprovalKey(accountId, approval.id), {
      accountId,
      approvalId: approval.id,
      version: 1,
      dispatchLimit: approval.dispatchLimit,
      dispatchesReserved: 0,
      providerRequestHashesReserved: [],
      expiresAtEpoch: approval.expiresAtEpoch
    });
    this.aiApprovalPointers.set(pointerKey, {
      accountId,
      identity: aiApprovalCurrentIdentity(approval.subject, approval.purpose),
      approvalId: approval.id,
      updatedAt: approval.approvedAt,
      expiresAtEpoch: approval.expiresAtEpoch
    });
    this.persist();
    return structuredClone(approval);
  }

  async getCurrentAiApproval(
    accountId: string,
    query: CurrentAiApprovalQuery
  ): Promise<AiApprovalStatus | undefined> {
    assertCurrentAiApprovalQuery(query);
    const pointer = this.aiApprovalPointers.get(localAiApprovalPointerKey(
      accountId,
      { kind: query.subjectKind, id: query.subjectId },
      query.purpose
    ));
    if (!pointer) return undefined;
    const approval = storedAiApproval(this.aiApprovals.get(localAiApprovalKey(accountId, pointer.approvalId)));
    const revocationValue = this.aiApprovalRevocations.get(localAiApprovalKey(accountId, approval.id));
    const revocation = revocationValue ? storedAiApprovalRevocation(revocationValue) : undefined;
    const counter = this.aiApprovalCounters.get(localAiApprovalKey(accountId, approval.id));
    return {
      approval: structuredClone(approval),
      current: pointer.approvalId === approval.id && !revocation && Date.parse(approval.expiresAt) > Date.now(),
      dispatchesReserved: validDispatchCount(counter?.dispatchesReserved),
      ...(revocation ? { revocation: structuredClone(revocation) } : {})
    };
  }

  async revokeAiApproval(
    accountId: string,
    approvalId: string,
    command: RevokeAiApprovalCommand
  ): Promise<AiApprovalStatus> {
    assertOfficer(command.revokedBy, "Only an export-control officer may revoke AI approval.");
    const key = localAiApprovalKey(accountId, approvalId);
    const approval = storedAiApproval(this.aiApprovals.get(key));
    if (approval.accountId !== accountId) throw new StoreError(404, "AI approval not found.", "ai_approval_not_found");
    const existing = this.aiApprovalRevocations.get(key);
    const revocation = prepareAiApprovalRevocation(accountId, approvalId, command);
    if (existing) {
      const validated = storedAiApprovalRevocation(existing);
      if (validated.commandHash !== revocation.commandHash) {
        throw new StoreError(409, "AI approval was already revoked.", "ai_approval_already_revoked");
      }
    } else {
      this.aiApprovalRevocations.set(key, revocation);
    }
    const pointerKey = localAiApprovalPointerKey(accountId, approval.subject, approval.purpose);
    if (this.aiApprovalPointers.get(pointerKey)?.approvalId === approvalId) {
      this.aiApprovalPointers.delete(pointerKey);
    }
    this.persist();
    return {
      approval: structuredClone(approval),
      current: false,
      dispatchesReserved: validDispatchCount(this.aiApprovalCounters.get(key)?.dispatchesReserved),
      revocation: structuredClone(existing ? storedAiApprovalRevocation(existing) : revocation)
    };
  }

  async createAiApprovalRequest(
    requesterAccountId: string,
    command: CreateAiApprovalRequestCommand
  ): Promise<AiApprovalRequestStatus> {
    const prepared = prepareAiApprovalRequest(DEFAULT_TENANT_ID, requesterAccountId, command, Date.now());
    const existing = this.aiApprovalRequests.get(prepared.id);
    if (existing) {
      const original = idempotentAiApprovalRequest(existing, prepared);
      return this.localAiApprovalRequestStatus(original);
    }
    const preview = prepareAiApprovalRequestPreview(prepared, command.pendingContent);
    const pendingKey = localAiApprovalRequestPendingKey(requesterAccountId, prepared.dedupeHash);
    const pendingValue = this.aiApprovalRequestPendingPointers.get(pendingKey);
    if (pendingValue) {
      const pending = storedAiApprovalRequestPendingPointer(pendingValue);
      const duplicate = this.aiApprovalRequests.get(pending.approvalRequestId);
      const decision = duplicate ? this.aiApprovalRequestDecisions.get(duplicate.id) : undefined;
      if (duplicate && duplicate.dedupeHash === prepared.dedupeHash && !decision &&
          Date.now() < Date.parse(duplicate.expiresAt)) {
        return this.localAiApprovalRequestStatus(storedAiApprovalRequest(duplicate));
      }
      this.aiApprovalRequestPendingPointers.delete(pendingKey);
    }
    assertLocalAiApprovalRequestQuota(this.aiApprovalRequests.values(), requesterAccountId, Date.now());
    this.assertLocalAiApprovalRequestCurrent(prepared);
    this.aiApprovalRequests.set(prepared.id, prepared);
    if (preview) this.aiApprovalRequestPreviews.set(prepared.id, preview);
    this.aiApprovalRequestPendingPointers.set(pendingKey, initialAiApprovalRequestPendingPointer(prepared));
    this.persist();
    return this.localAiApprovalRequestStatus(prepared);
  }

  async listAiApprovalRequests(
    accountId: string,
    query: AiApprovalRequestPageQuery
  ): Promise<CursorPage<AiApprovalRequestListItem>> {
    boundedAiIdentifier(accountId, "AI approval account ID", 512);
    const items = [...this.aiApprovalRequests.values()]
      .filter((request) => request.targetAccountId === accountId)
      .map((request) => approvalRequestListItem(
        storedAiApprovalRequest(request),
        this.aiApprovalRequestDecisions.get(request.id)
          ? storedAiApprovalRequestDecision(this.aiApprovalRequestDecisions.get(request.id))
          : undefined
      ));
    return paginateAiApprovalRequests(items, query, `account:${aiAccountDigest(accountId)}`);
  }

  async getAiApprovalRequest(
    accountId: string,
    requestId: string
  ): Promise<AiApprovalRequestStatus | undefined> {
    boundedAiIdentifier(accountId, "AI approval account ID", 512);
    boundedAiIdentifier(requestId, "AI approval request ID", 160);
    const request = this.aiApprovalRequests.get(requestId);
    if (!request || request.targetAccountId !== accountId) return undefined;
    return this.localAiApprovalRequestStatus(storedAiApprovalRequest(request));
  }

  async cancelAiApprovalRequest(
    accountId: string,
    approvalRequestId: string,
    command: CancelAiApprovalRequestCommand
  ): Promise<AiApprovalRequestStatus> {
    const request = storedAiApprovalRequest(this.aiApprovalRequests.get(approvalRequestId));
    if (request.targetAccountId !== accountId || command.actor.id !== accountId) {
      throw new StoreError(404, "AI approval request not found.", "ai_approval_request_not_found");
    }
    const proposed = prepareAiApprovalRequestDecision(request, "cancelled", command, Date.now());
    const existing = this.aiApprovalRequestDecisions.get(request.id);
    if (existing) {
      idempotentAiApprovalRequestDecision(existing, proposed);
      return this.localAiApprovalRequestStatus(request);
    }
    if (Date.now() >= Date.parse(request.expiresAt)) {
      throw new StoreError(409, "AI approval request expired.", "ai_approval_request_expired");
    }
    this.clearLocalAiApprovalRequestPending(request);
    this.aiApprovalRequestDecisions.set(request.id, proposed);
    this.aiApprovalRequestPreviews.delete(request.id);
    this.persist();
    return this.localAiApprovalRequestStatus(request);
  }

  async listTenantAiApprovalRequests(
    actor: AiApprovalRequestActor,
    query: AiApprovalRequestPageQuery
  ): Promise<CursorPage<AiApprovalRequestListItem>> {
    assertOfficer(actor, "Only an export-control officer may list tenant approval requests.");
    const items = [...this.aiApprovalRequests.values()].map((request) => approvalRequestListItem(
      storedAiApprovalRequest(request),
      this.aiApprovalRequestDecisions.get(request.id)
        ? storedAiApprovalRequestDecision(this.aiApprovalRequestDecisions.get(request.id))
        : undefined
    ));
    return paginateAiApprovalRequests(items, query, "tenant");
  }

  async getTenantAiApprovalRequest(
    actor: AiApprovalRequestActor,
    requestId: string
  ): Promise<AiApprovalRequestOfficerDetail | undefined> {
    assertOfficer(actor, "Only an export-control officer may inspect tenant approval requests.");
    boundedAiIdentifier(requestId, "AI approval request ID", 160);
    const request = this.aiApprovalRequests.get(requestId);
    if (!request) return undefined;
    const stored = storedAiApprovalRequest(request);
    const status = this.localAiApprovalRequestStatus(stored);
    const preview = this.aiApprovalRequestPreviews.get(stored.id);
    return {
      approvalRequest: status,
      ...(stored.purpose === "memo-chat" && status.status === "pending"
        ? {
            pendingContent: {
              kind: "memo-chat" as const,
              text: decryptAiApprovalRequestPreview(stored, preview)
            }
          }
        : {})
    };
  }

  async approveAiApprovalRequest(
    approvalRequestId: string,
    command: DecideAiApprovalRequestCommand
  ): Promise<AiApprovalRequestStatus> {
    const request = storedAiApprovalRequest(this.aiApprovalRequests.get(approvalRequestId));
    assertOfficer(command.decidedBy, "Only an export-control officer may approve AI requests.");
    const nowMs = Date.now();
    const memoChatFence = request.context.kind === "memo-chat"
      ? this.captureLocalMemoChatFence(
          request.targetAccountId,
          request.subject.id,
          request.context.historyHash
        )
      : undefined;
    const approval = prepareAiApproval(DEFAULT_TENANT_ID, request.targetAccountId, {
      requestId: queuedApprovalIdempotencyKey(request.id),
      purpose: request.purpose,
      subject: request.subject,
      payloadHash: request.payloadHash,
      providerRequestHashes: request.providerRequestHashes,
      dataClass: request.dataClass,
      policy: request.policy,
      ...(request.context.kind === "memo-chat"
        ? { memoChatHistoryHash: request.context.historyHash }
        : {}),
      approvedBy: command.decidedBy,
      dispatchLimit: 1
    }, nowMs, memoChatFence);
    const proposed = prepareAiApprovalRequestDecision(request, "approved", command, nowMs, approval.id);
    const existingDecision = this.aiApprovalRequestDecisions.get(request.id);
    if (existingDecision) {
      idempotentAiApprovalRequestDecision(existingDecision, proposed);
      return this.localAiApprovalRequestStatus(request);
    }
    if (nowMs >= Date.parse(request.expiresAt)) {
      throw new StoreError(409, "AI approval request expired.", "ai_approval_request_expired");
    }
    this.assertLocalAiApprovalRequestCurrent(request);
    if (request.purpose === "memo-chat") {
      decryptAiApprovalRequestPreview(request, this.aiApprovalRequestPreviews.get(request.id), nowMs);
    }
    const approvalKey = localAiApprovalKey(request.targetAccountId, approval.id);
    const existingApproval = this.aiApprovals.get(approvalKey);
    if (existingApproval) idempotentAiApproval(existingApproval, approval);
    const pointerKey = localAiApprovalPointerKey(request.targetAccountId, request.subject, request.purpose);
    this.clearLocalAiApprovalRequestPending(request);
    this.aiApprovals.set(approvalKey, approval);
    this.aiApprovalCounters.set(approvalKey, initialAiApprovalCounter(approval));
    this.aiApprovalPointers.set(pointerKey, initialAiApprovalPointer(approval));
    this.aiApprovalRequestDecisions.set(request.id, proposed);
    this.aiApprovalRequestPreviews.delete(request.id);
    this.persist();
    return this.localAiApprovalRequestStatus(request);
  }

  async rejectAiApprovalRequest(
    approvalRequestId: string,
    command: DecideAiApprovalRequestCommand
  ): Promise<AiApprovalRequestStatus> {
    const request = storedAiApprovalRequest(this.aiApprovalRequests.get(approvalRequestId));
    const proposed = prepareAiApprovalRequestDecision(request, "rejected", command, Date.now());
    const existing = this.aiApprovalRequestDecisions.get(request.id);
    if (existing) {
      idempotentAiApprovalRequestDecision(existing, proposed);
      return this.localAiApprovalRequestStatus(request);
    }
    if (Date.now() >= Date.parse(request.expiresAt)) {
      throw new StoreError(409, "AI approval request expired.", "ai_approval_request_expired");
    }
    this.clearLocalAiApprovalRequestPending(request);
    this.aiApprovalRequestDecisions.set(request.id, proposed);
    this.aiApprovalRequestPreviews.delete(request.id);
    this.persist();
    return this.localAiApprovalRequestStatus(request);
  }

  async revokeAiApprovalRequestApproval(
    approvalRequestId: string,
    command: RevokeAiApprovalCommand
  ): Promise<AiApprovalRequestStatus> {
    assertOfficer(command.revokedBy, "Only an export-control officer may revoke queued AI approval.");
    const request = storedAiApprovalRequest(this.aiApprovalRequests.get(approvalRequestId));
    const decision = storedAiApprovalRequestDecision(this.aiApprovalRequestDecisions.get(request.id));
    if (decision.decision !== "approved" || !decision.approvalId) {
      throw new StoreError(409, "AI approval request was not approved.", "ai_approval_request_not_approved");
    }
    await this.revokeAiApproval(request.targetAccountId, decision.approvalId, command);
    return this.localAiApprovalRequestStatus(request);
  }

  async reserveAiDispatch(request: ReserveAiDispatchRequest): Promise<ReserveAiDispatchResult> {
    const approval = request.approvalId
      ? storedAiApproval(this.aiApprovals.get(localAiApprovalKey(request.accountId, request.approvalId)))
      : undefined;
    const prepared = prepareAiDispatchReservation(request, approval?.memoChatFence);
    const key = localAiDispatchKey(request.accountId, request.dispatchId);
    let existingValue = this.aiDispatches.get(key);
    let existing = existingValue ? storedAiDispatchReceipt(existingValue) : undefined;
    if (existing) {
      if (existing.requestHash !== prepared.requestHash) {
        throw new StoreError(
          409,
          "This AI dispatch ID is already bound to a different request.",
          "ai_dispatch_id_conflict"
        );
      }
      if (existing.status === "reserved" && existing.reservationExpiresAtEpoch <= Math.floor(request.nowMs / 1_000)) {
        await this.transitionAiDispatch({
          accountId: request.accountId,
          dispatchId: request.dispatchId,
          requestHash: prepared.requestHash,
          reservationToken: existing.reservationToken,
          transition: "release",
          nowMs: request.nowMs
        });
        existing = undefined;
      } else {
        return {
          replayed: true,
          requestHash: prepared.requestHash,
          reservationToken: existing.reservationToken
        };
      }
    }

    if (prepared.authorizationKind === "approval") {
      const currentApproval = approval ?? storedAiApproval(this.aiApprovals.get(
        localAiApprovalKey(request.accountId, prepared.approvalId as string)
      ));
      this.assertLocalAiDispatchApproved({
        ...request,
        ...(prepared.memoChatFence ? { memoChatFence: prepared.memoChatFence } : {})
      }, currentApproval);
      const approvalKey = localAiApprovalKey(request.accountId, currentApproval.id);
      const counter = this.aiApprovalCounters.get(approvalKey);
      if (!validAiApprovalCounter(counter, currentApproval)) {
        throw new StoreError(503, "AI approval dispatch state is invalid.", "ai_approval_state_invalid");
      }
      if (counter.dispatchesReserved >= counter.dispatchLimit) {
        throw new StoreError(409, "AI approval dispatch limit was reached.", "ai_approval_dispatch_limit");
      }
      if (counter.providerRequestHashesReserved.includes(request.providerRequestHash)) {
        throw new StoreError(
          409,
          "This exact approved provider request was already reserved.",
          "ai_approval_provider_request_consumed"
        );
      }
      counter.dispatchesReserved += 1;
      counter.providerRequestHashesReserved.push(request.providerRequestHash);
      counter.version += 1;
      this.aiApprovalCounters.set(approvalKey, counter);
    }
    this.aiDispatches.set(key, prepared);
    this.persist();
    return {
      replayed: false,
      requestHash: prepared.requestHash,
      reservationToken: prepared.reservationToken
    };
  }

  async transitionAiDispatch(request: TransitionAiDispatchRequest): Promise<void> {
    validateAiDispatchTransition(request);
    const key = localAiDispatchKey(request.accountId, request.dispatchId);
    const receiptValue = this.aiDispatches.get(key);
    if (!receiptValue) {
      if (request.transition === "mark-started") {
        throw new StoreError(409, "AI dispatch reservation is no longer owned by this caller.", "ai_dispatch_fenced");
      }
      return;
    }
    const receipt = storedAiDispatchReceipt(receiptValue);
    if (receipt.requestHash !== request.requestHash) {
      throw new StoreError(409, "AI dispatch receipt binding changed.", "ai_dispatch_id_conflict");
    }
    if (receipt.reservationToken !== request.reservationToken) {
      if (request.transition === "mark-started") {
        throw new StoreError(409, "AI dispatch reservation is no longer owned by this caller.", "ai_dispatch_fenced");
      }
      return;
    }
    if (request.transition === "mark-started") {
      if (receipt.status === "started" || receipt.status === "failed" || receipt.status === "succeeded") return;
      if (receipt.approvalId) {
        const approval = storedAiApproval(this.aiApprovals.get(
          localAiApprovalKey(request.accountId, receipt.approvalId)
        ));
        this.assertLocalAiDispatchApproved(
          dispatchRequestFromReceipt(receipt, request.nowMs),
          approval
        );
      }
      if (receipt.purpose === "memo-chat") {
        const nowEpoch = Math.floor(request.nowMs / 1_000);
        const competing = [...this.aiDispatches.entries()].some(([candidateKey, candidateValue]) => {
          if (candidateKey === key) return false;
          const candidate = storedAiDispatchReceipt(candidateValue);
          return candidate.accountId === receipt.accountId && candidate.purpose === "memo-chat" &&
            candidate.subject?.id === receipt.subject?.id && !candidate.memoChatCommittedAt &&
            !candidate.memoChatAbandonedAt &&
            (candidate.status === "started" || candidate.status === "succeeded") &&
            (candidate.memoChatClaimExpiresAtEpoch ?? 0) > nowEpoch;
        });
        if (competing) {
          throw new StoreError(409, "Another memo-chat turn already owns this history.", "ai_dispatch_fenced");
        }
        receipt.memoChatClaimedAt = new Date(request.nowMs).toISOString();
        receipt.memoChatClaimExpiresAtEpoch = Math.floor(
          (request.nowMs + AI_MEMO_CHAT_CLAIM_MS) / 1_000
        );
      }
      if (receipt.reservationExpiresAtEpoch <= Math.floor(request.nowMs / 1_000)) {
        await this.transitionAiDispatch({ ...request, transition: "release" });
        throw new StoreError(409, "AI dispatch reservation expired before provider start.", "ai_dispatch_fenced");
      }
      receipt.status = "started";
      receipt.updatedAt = new Date(request.nowMs).toISOString();
      this.aiDispatches.set(key, receipt);
    } else if (request.transition === "release") {
      if (receipt.status !== "reserved") return;
      this.aiDispatches.delete(key);
      if (receipt.approvalId) {
        const approvalKey = localAiApprovalKey(request.accountId, receipt.approvalId);
        const counter = this.aiApprovalCounters.get(approvalKey);
        const approval = storedAiApproval(this.aiApprovals.get(approvalKey));
        if (!validAiApprovalCounter(counter, approval) || counter.dispatchesReserved < 1 ||
            !counter.providerRequestHashesReserved.includes(receipt.providerRequestHash)) {
          throw new StoreError(503, "AI approval dispatch state is invalid.", "ai_approval_state_invalid");
        }
        counter.dispatchesReserved -= 1;
        counter.providerRequestHashesReserved = counter.providerRequestHashesReserved.filter(
          (hash) => hash !== receipt.providerRequestHash
        );
        counter.version += 1;
        this.aiApprovalCounters.set(approvalKey, counter);
      }
    } else {
      const expected = request.transition === "settle-succeeded" ? "succeeded" : "failed";
      if (receipt.status === expected) return;
      if (receipt.status !== "started") return;
      receipt.status = expected;
      receipt.updatedAt = new Date(request.nowMs).toISOString();
      this.aiDispatches.set(key, receipt);
    }
    this.persist();
  }

  private assertLocalApprovalSubjectCurrent(accountId: string, subject: AiApprovalSubjectBinding) {
    if (subject.kind === "document") return;
    if (subject.kind === "review") {
      const review = this.accounts.get(accountId)?.memos.find((candidate) => candidate.id === subject.id);
      assertReviewApprovalBinding(review, subject);
      return;
    }
    const builder = this.memoBuilderSessions.get(accountId)?.get(subject.id);
    assertBuilderApprovalBinding(builder, subject);
  }

  private assertLocalAiApprovalRequestCurrent(request: AiApprovalRequestRecord) {
    this.assertLocalApprovalSubjectCurrent(request.targetAccountId, request.subject);
    if (request.context.kind !== "memo-chat") return;
    const history = currentAiApprovalChatWindow(
      this.accounts.get(request.targetAccountId)?.chatMessages[request.subject.id] ?? []
    );
    if (hashAiApprovalChatHistory(history) !== request.context.historyHash) {
      throw new StoreError(
        409,
        "Memo-chat history changed before officer approval.",
        "ai_approval_stale_subject"
      );
    }
  }

  private captureLocalMemoChatFence(
    accountId: string,
    memoId: string,
    observedHistoryHash: unknown
  ): AiApprovalMemoChatFence {
    const messages = this.accounts.get(accountId)?.chatMessages[memoId] ?? [];
    const history = currentAiApprovalChatWindow(messages);
    const historyHash = hashAiApprovalChatHistory(history);
    const observed = approvalValue(() =>
      assertSha256(observedHistoryHash, "Observed memo-chat history hash"));
    if (historyHash !== observed) {
      throw new StoreError(409, "Memo-chat history changed before approval.", "ai_approval_stale_subject");
    }
    return messages.length === 0
      ? { historyHash, chatMeta: { exists: false } }
      : {
          historyHash,
          chatMeta: {
            exists: true,
            entityVersion: messages.length,
            nextSequence: messages.length
          }
        };
  }

  private assertLocalMemoChatFenceCurrent(
    accountId: string,
    memoId: string,
    fence: AiApprovalMemoChatFence | undefined
  ) {
    if (!fence) {
      throw new StoreError(503, "Memo-chat approval fence is missing.", "ai_approval_state_invalid");
    }
    const messages = this.accounts.get(accountId)?.chatMessages[memoId] ?? [];
    const current = messages.length === 0
      ? {
          historyHash: hashAiApprovalChatHistory([]),
          chatMeta: { exists: false as const }
        }
      : {
          historyHash: hashAiApprovalChatHistory(currentAiApprovalChatWindow(messages)),
          chatMeta: {
            exists: true as const,
            entityVersion: messages.length,
            nextSequence: messages.length
          }
        };
    if (!sameAiApprovalMemoChatFence(current, fence)) {
      throw new StoreError(409, "Memo-chat history changed after approval.", "ai_dispatch_fenced");
    }
  }

  private assertNoLocalMemoChatClaim(accountId: string, memoId: string, nowMs: number) {
    const nowEpoch = Math.floor(nowMs / 1_000);
    for (const value of this.aiDispatches.values()) {
      const receipt = storedAiDispatchReceipt(value);
      if (receipt.accountId === accountId && receipt.purpose === "memo-chat" &&
          receipt.subject?.id === memoId && !receipt.memoChatCommittedAt && !receipt.memoChatAbandonedAt &&
          (receipt.status === "started" || receipt.status === "succeeded") &&
          (receipt.memoChatClaimExpiresAtEpoch ?? 0) > nowEpoch) {
        throw new StoreError(409, "Another memo-chat turn is already in progress.", "ai_dispatch_fenced");
      }
    }
  }

  private assertLocalAiDispatchApproved(request: ReserveAiDispatchRequest, approval: AiApprovalRecord) {
    assertAiDispatchMatchesApproval(request, approval, DEFAULT_TENANT_ID);
    const pointer = this.aiApprovalPointers.get(localAiApprovalPointerKey(
      request.accountId,
      approval.subject,
      approval.purpose
    ));
    if (pointer?.approvalId !== approval.id) {
      throw new StoreError(403, "AI approval is not the current subject approval.", "ai_approval_superseded");
    }
    if (this.aiApprovalRevocations.has(localAiApprovalKey(request.accountId, approval.id))) {
      throw new StoreError(403, "AI approval was revoked.", "ai_approval_revoked");
    }
    this.assertLocalApprovalSubjectCurrent(request.accountId, approval.subject);
    if (approval.purpose === "memo-chat") {
      this.assertLocalMemoChatFenceCurrent(request.accountId, approval.subject.id, approval.memoChatFence);
    }
  }

  private localAiApprovalRequestStatus(request: AiApprovalRequestRecord): AiApprovalRequestStatus {
    const decisionValue = this.aiApprovalRequestDecisions.get(request.id);
    const decision = decisionValue ? storedAiApprovalRequestDecision(decisionValue) : undefined;
    let approval: AiApprovalStatus | undefined;
    if (decision?.approvalId) {
      const approvalKey = localAiApprovalKey(request.targetAccountId, decision.approvalId);
      const record = storedAiApproval(this.aiApprovals.get(approvalKey));
      const pointer = this.aiApprovalPointers.get(localAiApprovalPointerKey(
        request.targetAccountId,
        record.subject,
        record.purpose
      ));
      const revocationValue = this.aiApprovalRevocations.get(approvalKey);
      const revocation = revocationValue ? storedAiApprovalRevocation(revocationValue) : undefined;
      approval = {
        approval: structuredClone(record),
        current: pointer?.approvalId === record.id && !revocation && Date.now() < Date.parse(record.expiresAt),
        dispatchesReserved: validDispatchCount(this.aiApprovalCounters.get(approvalKey)?.dispatchesReserved),
        ...(revocation ? { revocation: structuredClone(revocation) } : {})
      };
    }
    return {
      request: structuredClone(request),
      status: approvalRequestStatusKind(request, decision),
      ...(decision ? { decision: structuredClone(decision) } : {}),
      ...(approval ? { approval } : {})
    };
  }

  private clearLocalAiApprovalRequestPending(request: AiApprovalRequestRecord) {
    const key = localAiApprovalRequestPendingKey(request.targetAccountId, request.dedupeHash);
    const pointer = this.aiApprovalRequestPendingPointers.get(key);
    if (!pointer || pointer.approvalRequestId !== request.id) {
      throw new StoreError(409, "Pending approval request ownership changed.", "ai_approval_request_decided");
    }
    this.aiApprovalRequestPendingPointers.delete(key);
  }

  async listUsers() {
    return Array.from(this.users.values()).map(publicUser);
  }

  async listActiveSessions(): Promise<ActiveSessionSummary[]> {
    return Array.from(this.sessions.values())
      .filter((session) => !isExpired(session.expiresAt))
      .map((session) => ({ userId: session.userId, lastSeenAt: session.lastSeenAt }));
  }

  async listAdminUsersPage(query: PageQuery): Promise<CursorPage<UserAdminSummary>> {
    const summaries = summarizeUsers({
      users: await this.listUsers(),
      usage: dedupeUsageEvents(this.usage),
      sessions: await this.listActiveSessions()
    }).sort((left, right) => left.email.localeCompare(right.email));
    return paginate(summaries, query);
  }

  async backfillAdminAggregates(): Promise<AdminAggregateBackfillResult> {
    const usage = dedupeUsageEvents(this.usage);
    const activeSessions = Array.from(this.sessions.values())
      .filter((session) => !isExpired(session.expiresAt));
    let sessionsRevoked = 0;
    const grouped = new Map<string, SessionRecord[]>();
    for (const session of activeSessions) {
      const entries = grouped.get(session.userId) ?? [];
      entries.push(session);
      grouped.set(session.userId, entries);
    }
    for (const sessions of grouped.values()) {
      sessions.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
      for (const session of sessions.slice(MAX_TRACKED_ADMIN_SESSIONS)) {
        this.sessions.delete(session.tokenHash);
        sessionsRevoked += 1;
      }
    }
    this.usage = usage;
    this.persist();
    return {
      status: "complete",
      usageEventsProcessed: usage.length,
      sessionsProcessed: activeSessions.length - sessionsRevoked,
      sessionsRevoked
    };
  }

  async getOutreachConfig(): Promise<StoredOutreachConfig> {
    this.outreachConfig = sanitizeOutreachConfig(this.outreachConfig);
    this.persist();
    return { ...this.outreachConfig };
  }

  async setOutreachConfig(config: StoredOutreachConfig): Promise<void> {
    this.outreachConfig = sanitizeOutreachConfig(config);
    this.persist();
  }

  private mutateAccountState<T>(
    userId: string,
    mutation: (state: AccountReviewState) => T
  ): T {
    const current = cloneAccountState(
      normalizeAccountState(this.accounts.get(userId) ?? emptyAccountState())
    );
    const expectedVersion = current.version ?? 0;
    const result = mutation(current);
    current.version = expectedVersion + 1;
    this.accounts.set(userId, normalizeAccountState(current));
    this.persist();
    return cloneMutationResult(result);
  }

  private createSession(user: UserRecord): AuthSession {
    const session = createSessionMaterial(user);
    this.sessions.set(session.record.tokenHash, session.record);
    return session.auth;
  }

  private revokeUserSessions(userId: string) {
    Array.from(this.sessions.entries()).forEach(([tokenHash, session]) => {
      if (session.userId === userId) this.sessions.delete(tokenHash);
    });
  }

  private expireInvites() {
    for (const [tokenHash, invite] of this.invites.entries()) {
      if (invite.status === "pending" && isExpired(invite.expiresAt)) {
        this.invites.set(tokenHash, { ...invite, status: "expired" });
      }
    }
    this.persist();
  }

  private load() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PersistedStore>;
      this.users = new Map((parsed.users ?? []).map((user) => [user.id, user]));
      this.sessions = new Map(
        (parsed.sessions ?? [])
          .filter((session) => !isExpired(session.expiresAt))
          .map((session) => [session.tokenHash, session])
      );
      this.invites = new Map((parsed.invites ?? []).map((invite) => [invite.tokenHash, invite]));
      this.resets = new Map((parsed.resets ?? []).map((reset) => [reset.tokenHash, reset]));
      this.accounts = new Map(
        Object.entries(parsed.accounts ?? {}).map(([userId, state]) => [
          userId,
          normalizeAccountState(state)
        ])
      );
      this.usage = Array.isArray(parsed.usage) ? parsed.usage : [];
      this.aiAdmission = new Map(Object.entries(parsed.aiAdmission ?? {}));
      this.aiApprovals = new Map(Object.entries(parsed.aiApprovals ?? {}));
      this.aiApprovalRevocations = new Map(Object.entries(parsed.aiApprovalRevocations ?? {}));
      this.aiApprovalPointers = new Map(Object.entries(parsed.aiApprovalPointers ?? {}));
      this.aiApprovalCounters = new Map(Object.entries(parsed.aiApprovalCounters ?? {}));
      this.aiDispatches = new Map(Object.entries(parsed.aiDispatches ?? {}).map(([key, value]) => [
        key,
        storedAiDispatchReceipt(value)
      ]));
      this.aiApprovalRequests = new Map(Object.entries(parsed.aiApprovalRequests ?? {}));
      this.aiApprovalRequestDecisions = new Map(Object.entries(parsed.aiApprovalRequestDecisions ?? {}));
      this.aiApprovalRequestPreviews = new Map(Object.entries(parsed.aiApprovalRequestPreviews ?? {}));
      this.aiApprovalRequestPendingPointers = new Map(Object.entries(parsed.aiApprovalRequestPendingPointers ?? {}));
      this.outreachConfig = sanitizeOutreachConfig(parsed.outreachConfig);
      this.workspacePreferences = new Map(Object.entries(parsed.workspacePreferences ?? {}));
      this.memoBuilderSessions = new Map(
        Object.entries(parsed.memoBuilderSessions ?? {}).map(([userId, sessions]) => [
          userId,
          new Map(Object.entries(sessions))
        ])
      );
      // Rewrites the allow-listed shape on load, permanently removing any
      // legacy plaintext provider credential from the local persistence file.
      this.persist();
    } catch {
      this.users = new Map();
      this.sessions = new Map();
      this.invites = new Map();
      this.resets = new Map();
      this.accounts = new Map();
      this.usage = [];
      this.aiAdmission = new Map();
      this.aiApprovals = new Map();
      this.aiApprovalRevocations = new Map();
      this.aiApprovalPointers = new Map();
      this.aiApprovalCounters = new Map();
      this.aiDispatches = new Map();
      this.aiApprovalRequests = new Map();
      this.aiApprovalRequestDecisions = new Map();
      this.aiApprovalRequestPreviews = new Map();
      this.aiApprovalRequestPendingPointers = new Map();
      this.outreachConfig = defaultOutreachConfig();
      this.workspacePreferences = new Map();
      this.memoBuilderSessions = new Map();
    }
  }

  private persist() {
    if (!this.persistEnabled || !this.filePath) return;
    const dir = path.dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const payload: PersistedStore = {
      users: Array.from(this.users.values()),
      sessions: Array.from(this.sessions.values()).filter((session) => !isExpired(session.expiresAt)),
      invites: Array.from(this.invites.values()),
      resets: Array.from(this.resets.values()),
      accounts: Object.fromEntries(this.accounts.entries()),
      usage: this.usage,
      aiAdmission: Object.fromEntries(this.aiAdmission.entries()),
      aiApprovals: Object.fromEntries(this.aiApprovals.entries()),
      aiApprovalRevocations: Object.fromEntries(this.aiApprovalRevocations.entries()),
      aiApprovalPointers: Object.fromEntries(this.aiApprovalPointers.entries()),
      aiApprovalCounters: Object.fromEntries(this.aiApprovalCounters.entries()),
      aiDispatches: Object.fromEntries(this.aiDispatches.entries()),
      aiApprovalRequests: Object.fromEntries(this.aiApprovalRequests.entries()),
      aiApprovalRequestDecisions: Object.fromEntries(this.aiApprovalRequestDecisions.entries()),
      aiApprovalRequestPreviews: Object.fromEntries(this.aiApprovalRequestPreviews.entries()),
      aiApprovalRequestPendingPointers: Object.fromEntries(this.aiApprovalRequestPendingPointers.entries()),
      outreachConfig: this.outreachConfig,
      workspacePreferences: Object.fromEntries(this.workspacePreferences.entries()),
      memoBuilderSessions: Object.fromEntries(
        [...this.memoBuilderSessions.entries()].map(([userId, sessions]) => [
          userId,
          Object.fromEntries(sessions.entries())
        ])
      )
    };
    writeFileSync(this.filePath, JSON.stringify(payload, null, 2));
  }

  private findUserByEmail(email: string) {
    return Array.from(this.users.values()).find((user) => user.email === email);
  }
}

export class DynamoAccountStore implements AccountStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tenantId: string;
  private readonly newAccountWorkspacePut: (userId: string) => TransactionItem;
  private readonly workspaceMode: WorkspaceMode;
  private readonly workspace?: NormalizedWorkspaceAccountAdapter;
  private readonly adminCursors: WorkspaceCursorCodec;

  constructor(
    private readonly authTable: string,
    private readonly accountTable: string,
    options: {
      tenantId?: string;
      client?: DynamoDBDocumentClient;
      newAccountWorkspacePut?: (userId: string) => TransactionItem;
      workspaceMode?: WorkspaceMode;
      workspace?: NormalizedWorkspaceAccountAdapter;
      adminCursors?: WorkspaceCursorCodec;
    } = {}
  ) {
    this.tenantId = options.tenantId ?? process.env.RULIX_TENANT_ID ?? DEFAULT_TENANT_ID;
    this.doc = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true }
    });
    this.workspaceMode = options.workspaceMode ?? "legacy";
    this.workspace = options.workspace;
    // Direct constructor use is reserved for tests/local adapters. The
    // production factory always injects the deployment-shared key ring.
    this.adminCursors = options.adminCursors ?? EPHEMERAL_ADMIN_CURSOR_CODEC;
    if (this.workspaceMode !== "legacy" && !this.workspace) {
      throw new StoreError(500, "Normalized workspace configuration is incomplete.", "workspace_config_invalid");
    }
    this.newAccountWorkspacePut = options.newAccountWorkspacePut ?? ((userId) => ({
      Put: {
        TableName: this.accountTable,
        Item: {
          pk: accountKey(this.tenantId, userId),
          tenantId: this.tenantId,
          userId,
          state: normalizeAccountState(emptyAccountState())
        },
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "pk" }
      }
    }));
  }

  async createInvite(input: CreateInviteInput): Promise<InviteCreationResult> {
    const email = normalizeEmail(input.email);
    if (await this.findUserByEmail(email)) {
      throw new StoreError(409, "An account already exists for that email.");
    }
    const existingPending = (await this.listInvites()).some(
      (invite) => invite.email === email && invite.status === "pending" && !isExpired(invite.expiresAt)
    );
    if (existingPending) {
      throw new StoreError(409, "A pending invite already exists for that email.");
    }

    const rawToken = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const expiresAt = input.expiresAt ?? new Date(Date.now() + inviteTtlMs()).toISOString();
    const invite: InviteRecord = {
      id: `invite-${randomBytes(12).toString("base64url")}`,
      tokenHash: hashToken(rawToken),
      email,
      name: normalizeName(input.name ?? "", email),
      role: input.role ?? "reviewer",
      status: "pending",
      createdAt: now,
      expiresAt,
      expiresAtEpoch: toEpochSeconds(expiresAt),
      invitedBy: input.invitedBy
    };
    const reservation: InviteEmailReservation = {
      email,
      tokenHash: invite.tokenHash,
      status: "pending",
      createdAt: now,
      expiresAt,
      expiresAtEpoch: invite.expiresAtEpoch
    };
    try {
      await this.doc.send(new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: this.authTable,
              Key: {
                pk: tenantKey(this.tenantId),
                sk: userKey(email)
              },
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": "pk" }
            }
          },
          {
            Put: {
              TableName: this.authTable,
              Item: this.authItem(inviteEmailKey(email), reservation),
              ConditionExpression: [
                "attribute_not_exists(#pk)",
                "#record.#status <> :pending",
                "#record.#expiresAtEpoch <= :nowEpoch"
              ].join(" OR "),
              ExpressionAttributeNames: {
                "#pk": "pk",
                "#record": "record",
                "#status": "status",
                "#expiresAtEpoch": "expiresAtEpoch"
              },
              ExpressionAttributeValues: {
                ":pending": "pending",
                ":nowEpoch": Math.floor(Date.now() / 1000)
              }
            }
          },
          {
            Put: {
              TableName: this.authTable,
              Item: this.authItem(inviteKey(invite.tokenHash), invite),
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": "pk" }
            }
          }
        ]
      }));
    } catch (error) {
      if (!isAuthStateConflict(error)) throw error;
      if (await this.findUserByEmail(email, true)) {
        throw new StoreError(409, "An account already exists for that email.");
      }
      throw new StoreError(409, "A pending invite already exists for that email.");
    }
    return { invite: summarizeInvite(invite), rawToken, inviteLink: inviteLink(rawToken) };
  }

  async listInvites() {
    const items = await this.queryAuthByPrefix("INVITE#");
    return items
      .map((item) => item.record as InviteRecord)
      .map((invite) => invite.status === "pending" && isExpired(invite.expiresAt) ? { ...invite, status: "expired" as const } : invite)
      .map(summarizeInvite)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getInviteByToken(rawToken: string): Promise<InvitePublicInfo> {
    const invite = await this.getAuthRecord<InviteRecord>(inviteKey(hashToken(rawToken)));
    return publicInviteInfo(validateInvite(invite));
  }

  async acceptInvite(rawToken: string, password: string, name?: string): Promise<AuthSession> {
    validatePassword(password);
    const tokenHash = hashToken(rawToken);
    const invite = validateInvite(
      await this.getAuthRecord<InviteRecord>(inviteKey(tokenHash), true)
    );
    if (await this.findUserByEmail(invite.email, true)) {
      throw new StoreError(409, "An account already exists for that email.");
    }

    const metricsMarker = await this.getAuthRecord<AdminAggregateMarker>(
      ADMIN_AGGREGATE_MARKER_KEY,
      true
    );
    if (metricsMarker?.status === "building") {
      throw new StoreError(
        503,
        "Account creation is briefly paused while exact admin metrics are rebuilt.",
        "admin_metrics_backfill_in_progress"
      );
    }
    if (
      metricsMarker?.status === "complete"
      && metricsMarker.metricsSchemaVersion === ADMIN_METRICS_SCHEMA_VERSION
      && !isCompleteAdminMetricsMarker(metricsMarker)
    ) {
      throw new StoreError(
        503,
        "Account creation is paused because the admin metrics marker failed integrity checks.",
        "admin_metrics_integrity_failed"
      );
    }

    const user = createUserRecord(invite.email, name ?? invite.name, invite.role, password);
    const session = createSessionMaterial(user);
    const usedInvite: InviteRecord = {
      ...invite,
      status: "used",
      usedAt: new Date().toISOString()
    };
    try {
      await this.doc.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.authTable,
              Item: this.authItem(inviteKey(tokenHash), usedInvite),
              ConditionExpression: [
                "#record.#status = :pending",
                "#record.#tokenHash = :tokenHash",
                "#record.#expiresAtEpoch > :nowEpoch"
              ].join(" AND "),
              ExpressionAttributeNames: {
                "#record": "record",
                "#status": "status",
                "#tokenHash": "tokenHash",
                "#expiresAtEpoch": "expiresAtEpoch"
              },
              ExpressionAttributeValues: {
                ":pending": "pending",
                ":tokenHash": tokenHash,
                ":nowEpoch": Math.floor(Date.now() / 1000)
              }
            }
          },
          {
            Put: {
              TableName: this.authTable,
              Item: this.authItem(userKey(user.email), user),
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": "pk" }
            }
          },
          this.newAccountWorkspacePut(user.id),
          {
            Put: {
              TableName: this.authTable,
              Item: this.authItem(sessionKey(session.record.tokenHash), session.record),
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": "pk" }
            }
          },
          this.adminSessionAggregatePut(
            initialAdminSessionAggregate(
              user.id,
              session.record.tokenHash,
              adminSessionEntry(session.record)
            ),
            undefined
          ),
          this.adminUsageAggregatePut(emptyAdminUsageAggregate(user.id), undefined),
          this.adminMetricsAccountCreationItem(metricsMarker, user.createdAt),
          {
            Delete: {
              TableName: this.authTable,
              Key: {
                pk: tenantKey(this.tenantId),
                sk: inviteEmailKey(invite.email)
              },
              ConditionExpression:
                "attribute_not_exists(#pk) OR #record.#tokenHash = :tokenHash",
              ExpressionAttributeNames: {
                "#pk": "pk",
                "#record": "record",
                "#tokenHash": "tokenHash"
              },
              ExpressionAttributeValues: { ":tokenHash": tokenHash }
            }
          }
        ]
      }));
    } catch (error) {
      if (!isAuthStateConflict(error)) throw error;
      const [currentInvite, existingUser, currentMetricsMarker] = await Promise.all([
        this.getAuthRecord<InviteRecord>(inviteKey(tokenHash), true),
        this.findUserByEmail(invite.email, true),
        this.getAuthRecord<AdminAggregateMarker>(ADMIN_AGGREGATE_MARKER_KEY, true)
      ]);
      if (currentMetricsMarker?.status === "building") {
        throw new StoreError(
          503,
          "Account creation is briefly paused while exact admin metrics are rebuilt.",
          "admin_metrics_backfill_in_progress"
        );
      }
      if (!currentInvite || currentInvite.status !== "pending" || isExpired(currentInvite.expiresAt)) {
        throw new StoreError(410, "Invite link is invalid or expired.");
      }
      if (existingUser) {
        throw new StoreError(409, "An account already exists for that email.");
      }
      throw new StoreError(409, "Invite acceptance conflicted with another request. Try again.");
    }
    return session.auth;
  }

  async authenticate(emailInput: string, password: string): Promise<AuthSession> {
    validateAuthenticationPassword(password);
    let email: string;
    try {
      email = normalizeEmail(emailInput);
    } catch {
      throw invalidCredentials();
    }
    for (let attempt = 0; attempt < MAX_AUTH_TRANSITION_RETRIES; attempt += 1) {
      const user = await this.findUserByEmail(email, true);
      if (!user) {
        hashPassword(password, randomBytes(16).toString("base64url"), PASSWORD_ITERATIONS);
        throw invalidCredentials();
      }
      if (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) {
        throw new StoreError(429, "Too many failed sign-in attempts. Try again later.");
      }

      const expectedAuthGeneration = currentAuthGeneration(user);
      try {
        if (!verifyPassword(password, user)) {
          await this.recordFailedLogin(user, expectedAuthGeneration);
          throw invalidCredentials();
        }

        await this.clearFailedLoginState(user, expectedAuthGeneration);
        await this.deleteAuthItem(lockoutKey(user.email));
        return await this.createSession(user);
      } catch (error) {
        if (isAuthStateConflict(error)) {
          const currentUser = await this.findUserByEmail(user.email, true);
          if (
            !currentUser ||
            currentAuthGeneration(currentUser) !== expectedAuthGeneration ||
            currentUser.passwordHash !== user.passwordHash
          ) {
            throw invalidCredentials();
          }
          continue;
        }
        throw error;
      }
    }

    throw new StoreError(503, "Sign-in state changed too many times. Try again.");
  }

  async requestPasswordReset(emailInput: string): Promise<PasswordResetResult> {
    const email = normalizeEmail(emailInput);
    const user = await this.findUserByEmail(email);
    if (!user) return { email };
    const expectedGeneration = user.passwordResetGeneration ?? 0;
    const generation = expectedGeneration + 1;
    const rawToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + resetTtlMs()).toISOString();
    const reset: ResetRecord = {
      id: `reset-${randomBytes(12).toString("base64url")}`,
      tokenHash: hashToken(rawToken),
      userId: user.id,
      userEmail: user.email,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt,
      expiresAtEpoch: toEpochSeconds(expiresAt),
      generation
    };
    const updatedUser = { ...user, passwordResetGeneration: generation };
    try {
      await this.doc.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.authTable,
              Item: this.authItem(userKey(user.email), updatedUser),
              ConditionExpression:
                "attribute_not_exists(#record.#generation) OR #record.#generation = :expectedGeneration",
              ExpressionAttributeNames: {
                "#record": "record",
                "#generation": "passwordResetGeneration"
              },
              ExpressionAttributeValues: { ":expectedGeneration": expectedGeneration }
            }
          },
          {
            Put: {
              TableName: this.authTable,
              Item: this.authItem(resetKey(reset.tokenHash), reset),
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": "pk" }
            }
          }
        ]
      }));
    } catch {
      throw new StoreError(409, "A newer password-reset request was issued. Request another link.");
    }
    return { email, rawToken, resetLink: resetLink(rawToken), expiresAt };
  }

  async getPasswordResetByToken(rawToken: string): Promise<PasswordResetPublicInfo> {
    const reset = validateReset(await this.getAuthRecord<ResetRecord>(resetKey(hashToken(rawToken))));
    const user = await this.findUserByEmail(reset.userEmail, true);
    if (user?.id !== reset.userId) {
      throw new StoreError(404, "Password reset link is invalid or expired.");
    }
    validateResetGeneration(reset, user);
    return { email: reset.userEmail, expiresAt: reset.expiresAt, status: reset.status };
  }

  async completePasswordReset(rawToken: string, password: string): Promise<AuthSession> {
    const tokenHash = hashToken(rawToken);
    const reset = validateReset(await this.getAuthRecord<ResetRecord>(resetKey(tokenHash)));
    validatePassword(password);
    const user = await this.findUserByEmail(reset.userEmail, true);
    if (user?.id !== reset.userId) {
      throw new StoreError(404, "Password reset link is invalid or expired.");
    }
    validateResetGeneration(reset, user);

    setUserPassword(user, password);
    clearFailedAttempts(user);
    const expectedGeneration = user.passwordResetGeneration ?? 0;
    const expectedAuthGeneration = currentAuthGeneration(user);
    user.passwordResetGeneration = expectedGeneration + 1;
    user.authGeneration = expectedAuthGeneration + 1;
    reset.status = "used";
    reset.usedAt = new Date().toISOString();
    try {
      await this.doc.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.authTable,
              Item: this.authItem(userKey(user.email), user),
              ConditionExpression:
                `#record.#generation = :expectedGeneration AND ${authGenerationCondition(expectedAuthGeneration)}`,
              ExpressionAttributeNames: {
                "#record": "record",
                "#generation": "passwordResetGeneration",
                "#authGeneration": "authGeneration"
              },
              ExpressionAttributeValues: {
                ":expectedGeneration": expectedGeneration,
                ":expectedAuthGeneration": expectedAuthGeneration
              }
            }
          },
          {
            Put: {
              TableName: this.authTable,
              Item: this.authItem(resetKey(tokenHash), reset),
              ConditionExpression: "#record.#status = :pending",
              ExpressionAttributeNames: { "#record": "record", "#status": "status" },
              ExpressionAttributeValues: { ":pending": "pending" }
            }
          }
        ]
      }));
    } catch {
      throw new StoreError(410, "Password reset link is invalid or expired.");
    }
    await this.deleteAuthItem(lockoutKey(user.email));
    await this.revokeUserSessions(user.id);
    return this.createSession(user);
  }

  async getSession(rawToken: string | undefined): Promise<{ user: UserProfile; session: SessionRecord } | undefined> {
    if (!rawToken) return undefined;
    const tokenHash = hashToken(rawToken);
    const key = sessionKey(tokenHash);
    for (let attempt = 0; attempt < MAX_AUTH_TRANSITION_RETRIES; attempt += 1) {
      const session = await this.getAuthRecord<SessionRecord>(key, true);
      if (!session) return undefined;
      if (isExpired(session.expiresAt)) {
        await this.deleteSessionRecord(session);
        return undefined;
      }
      const user = await this.findUserByEmail(session.userEmail, true);
      if (!user) {
        await this.deleteSessionRecord(session);
        return undefined;
      }
      const expectedAuthGeneration = currentSessionGeneration(session);
      if (currentAuthGeneration(user) !== expectedAuthGeneration) {
        await this.deleteSessionRecord(session);
        return undefined;
      }
      const nowMs = Date.now();
      if (!sessionTouchDue(session.lastSeenAt, nowMs)) {
        // Re-read the session after the user so a concurrent logout cannot be
        // resurrected by the read-only fast path. Generation validation still
        // happens on every request; only activity persistence is throttled.
        const confirmedSession = await this.getAuthRecord<SessionRecord>(key, true);
        if (!confirmedSession) return undefined;
        if (isExpired(confirmedSession.expiresAt)) {
          await this.deleteSessionRecord(confirmedSession);
          return undefined;
        }
        if (!sameSessionAuthState(session, confirmedSession)) continue;
        return { user: publicUser(user), session: confirmedSession };
      }
      const aggregate = await this.getAdminSessionAggregate(user.id, true);
      const lastSeenAt = new Date(nowMs).toISOString();
      const updatedSession: SessionRecord = {
        ...session,
        lastSeenAt,
        adminAggregateVersion: ADMIN_AGGREGATE_SCHEMA_VERSION
      };
      let nextAggregate: AdminSessionAggregate;
      try {
        nextAggregate = upsertAdminSession(
          aggregate,
          user.id,
          tokenHash,
          adminSessionEntry(updatedSession)
        );
      } catch (error) {
        if (error instanceof AdminSessionCapacityError) {
          await this.deleteSessionRecord(session);
          return undefined;
        }
        throw error;
      }
      try {
        await this.doc.send(new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.authTable,
                Key: { pk: tenantKey(this.tenantId), sk: userKey(user.email) },
                ConditionExpression: authGenerationCondition(expectedAuthGeneration),
                ExpressionAttributeNames: {
                  "#record": "record",
                  "#authGeneration": "authGeneration"
                },
                ExpressionAttributeValues: {
                  ":expectedAuthGeneration": expectedAuthGeneration
                }
              }
            },
            {
              Put: {
                TableName: this.authTable,
                Item: this.authItem(key, updatedSession),
                ConditionExpression:
                  `attribute_exists(#pk) AND #record.#tokenHash = :tokenHash AND ${authGenerationCondition(expectedAuthGeneration)}`,
                ExpressionAttributeNames: {
                  "#pk": "pk",
                  "#record": "record",
                  "#tokenHash": "tokenHash",
                  "#authGeneration": "authGeneration"
                },
                ExpressionAttributeValues: {
                  ":tokenHash": tokenHash,
                  ":expectedAuthGeneration": expectedAuthGeneration
                }
              }
            },
            this.adminSessionAggregatePut(nextAggregate, aggregate)
          ]
        }));
        return { user: publicUser(user), session: updatedSession };
      } catch (error) {
        if (isAuthStateConflict(error)) continue;
        throw error;
      }
    }
    throw new StoreError(503, "Session state changed too many times. Try again.");
  }

  async destroySession(rawToken: string | undefined) {
    if (!rawToken) return;
    const session = await this.getAuthRecord<SessionRecord>(sessionKey(hashToken(rawToken)), true);
    if (session) await this.deleteSessionRecord(session);
  }

  async getAccountState(userId: string): Promise<AccountReviewState> {
    this.requireLegacyAggregateAccess();
    return (await this.readAccountState(userId, false)).state;
  }

  async replaceAccountState(userId: string, state: AccountReviewState) {
    this.requireLegacyAggregateAccess();
    const incoming = normalizeAccountState(state);
    await this.mutateAccountState(userId, (existing) => {
      replaceStateContents(existing, mergeAccountState(existing, incoming));
    });
  }

  async listReviews(userId: string, query: ReviewPageQuery) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.listReviews(userId, query));
    }
    const state = (await this.readAccountState(userId, false)).state;
    const reviews = state.memos
      .filter((memo) => query.state === "all"
        || (query.state === "archived" ? Boolean(memo.archivedAt) : !memo.archivedAt))
      .sort((left, right) => compareByDateThenId(right.updatedAt, right.id, left.updatedAt, left.id))
      .map(reviewSummary);
    return paginate(reviews, query);
  }

  async getReviewDetail(userId: string, memoId: string) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.getReviewDetail(userId, memoId));
    }
    const state = (await this.readAccountState(userId, false)).state;
    const review = state.memos.find((memo) => memo.id === memoId);
    if (!review) return undefined;
    return { review, result: state.analysisResults[memoId], decision: state.decisions[memoId] };
  }

  async listReviewAuditEvents(userId: string, memoId: string, query: PageQuery) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.listReviewAuditEvents(userId, memoId, query));
    }
    const events = (await this.readAccountState(userId, false)).state.auditEvents
      .filter((event) => event.memoId === memoId)
      .sort((left, right) => compareByDateThenId(right.at, right.id, left.at, left.id));
    return paginate(events, query);
  }

  async listReviewChatMessages(userId: string, memoId: string, query: PageQuery) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.listReviewChatMessages(userId, memoId, query));
    }
    const messages = [...((await this.readAccountState(userId, false)).state.chatMessages[memoId] ?? [])]
      .sort((left, right) => compareByDateThenId(right.createdAt, right.id, left.createdAt, left.id));
    return paginate(messages, query);
  }

  async createReviewIdempotent(userId: string, command: CreateReviewCommand) {
    if (this.workspaceMode !== "legacy") {
      return this.callWorkspace((workspace) => workspace.createReviewIdempotent(userId, command));
    }
    return this.mutateAccountState(userId, (state) => applyCreateReviewCommand(state, userId, command));
  }

  async updateReviewMemo(userId: string, memoId: string, command: UpdateReviewMemoCommand) {
    if (this.workspaceMode !== "legacy") {
      return this.callWorkspace((workspace) => workspace.updateReviewMemo(userId, memoId, command));
    }
    return this.mutateAccountState(userId, (state) =>
      applyUpdateReviewMemoCommand(state, userId, memoId, command));
  }

  async setReviewArchived(userId: string, memoId: string, command: ArchiveReviewCommand) {
    if (this.workspaceMode !== "legacy") {
      return this.callWorkspace((workspace) => workspace.setReviewArchived(userId, memoId, command));
    }
    return this.mutateAccountState(userId, (state) => applyArchiveReviewCommand(state, memoId, command));
  }

  async appendBoundChat(userId: string, memoId: string, command: AppendBoundChatCommand) {
    if (this.workspaceMode !== "legacy") {
      const receipt = command.aiDispatchId
        ? storedAiDispatchReceipt(await this.getAuthRecord<AiDispatchReceipt>(
            aiDispatchKey(userId, command.aiDispatchId),
            true
          ))
        : undefined;
      if (receipt) assertMemoChatAppendReceipt(receipt, userId, memoId, Date.now());
      const resolvedCommand: AppendBoundChatCommand = receipt
        ? {
            ...command,
            aiDispatchClaim: {
              dispatchId: receipt.dispatchId,
              requestHash: receipt.requestHash,
              reservationToken: receipt.reservationToken,
              expiresAtEpoch: receipt.memoChatClaimExpiresAtEpoch!,
              outcome: receipt.status === "succeeded" ? "succeeded" : "failed",
              fence: structuredClone(receipt.memoChatFence!)
            }
          }
        : command;
      try {
        const result = await this.callWorkspace((workspace) =>
          workspace.appendBoundChat(userId, memoId, resolvedCommand));
        if (receipt) {
          const committedAt = new Date().toISOString();
          await this.doc.send(new UpdateCommand({
            TableName: this.authTable,
            Key: { pk: tenantKey(this.tenantId), sk: aiDispatchKey(userId, receipt.dispatchId) },
            UpdateExpression:
              "SET #record.#memoChatCommittedAt = :committedAt, #record.#updatedAt = :committedAt",
            ConditionExpression: [
              "#record.#requestHash = :requestHash",
              "#record.#reservationToken = :reservationToken",
              "#record.#status = :status",
              "attribute_not_exists(#record.#memoChatCommittedAt)"
            ].join(" AND "),
            ExpressionAttributeNames: {
              "#record": "record",
              "#requestHash": "requestHash",
              "#reservationToken": "reservationToken",
              "#status": "status",
              "#memoChatCommittedAt": "memoChatCommittedAt",
              "#updatedAt": "updatedAt"
            },
            ExpressionAttributeValues: {
              ":committedAt": committedAt,
              ":requestHash": receipt.requestHash,
              ":reservationToken": receipt.reservationToken,
              ":status": receipt.status
            }
          }));
        }
        return result;
      } catch (error) {
        if (receipt?.status === "succeeded" && receipt.subject && receipt.memoChatFence) {
          try {
            const release = await this.callWorkspace((workspace) => workspace.aiApprovalChatClaimRelease(
              userId,
              receipt.subject!.id,
              receipt.memoChatFence!,
              {
                dispatchId: receipt.dispatchId,
                requestHash: receipt.requestHash,
                reservationToken: receipt.reservationToken
              },
              new Date().toISOString()
            ));
            await this.doc.send(new TransactWriteCommand({ TransactItems: [release] }));
          } catch (cleanupError) {
            if (!isAuthStateConflict(cleanupError)) throw cleanupError;
          }
        }
        throw error;
      }
    }
    return this.mutateAccountState(userId, (state) => applyAppendBoundChatCommand(state, memoId, command));
  }

  async applyChatSuggestion(userId: string, memoId: string, command: ApplyChatSuggestionCommand) {
    if (this.workspaceMode !== "legacy") {
      return this.callWorkspace((workspace) => workspace.applyChatSuggestion(userId, memoId, command));
    }
    return this.mutateAccountState(userId, (state) =>
      applyChatSuggestionCommand(state, userId, memoId, command));
  }

  async getWorkspacePreferences(userId: string) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.getWorkspacePreferences(userId));
    }
    const state = (await this.readAccountState(userId, false)).state;
    const metadata = legacyWorkspaceMetadata(state);
    return {
      ...(state.selectedMemoId ? { selectedMemoId: state.selectedMemoId } : {}),
      ...(state.memoBuilder?.activeSessionId
        ? { activeMemoBuilderSessionId: state.memoBuilder.activeSessionId }
        : {}),
      version: metadata.preferenceVersion ?? 0
    };
  }

  async updateWorkspacePreferences(userId: string, command: UpdateWorkspacePreferencesCommand) {
    if (this.workspaceMode !== "legacy") {
      return this.callWorkspace((workspace) => workspace.updateWorkspacePreferences(userId, command));
    }
    return this.mutateAccountState(userId, (state) => {
      const metadata = legacyWorkspaceMetadata(state);
      if (metadata.preferenceVersion !== command.expectedVersion) {
        throw new StoreError(409, "Workspace preferences changed in another session.", "stale_preferences");
      }
      if (command.selectedMemoId !== undefined) {
        state.selectedMemoId = command.selectedMemoId || undefined;
      }
      state.memoBuilder ??= { messages: [] };
      if (command.activeMemoBuilderSessionId !== undefined) {
        state.memoBuilder.activeSessionId = command.activeMemoBuilderSessionId || undefined;
      }
      writeLegacyWorkspaceMetadata(state, {
        ...metadata,
        preferenceVersion: metadata.preferenceVersion + 1
      });
      return {
        ...(state.selectedMemoId ? { selectedMemoId: state.selectedMemoId } : {}),
        ...(state.memoBuilder.activeSessionId
          ? { activeMemoBuilderSessionId: state.memoBuilder.activeSessionId }
          : {}),
        version: metadata.preferenceVersion + 1
      };
    });
  }

  async listMemoBuilderSessions(userId: string, query: PageQuery) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.listMemoBuilderSessions(userId, query));
    }
    const state = (await this.readAccountState(userId, false)).state;
    const versions = legacyWorkspaceMetadata(state).builderVersions;
    const sessions = [...(state.memoBuilder?.sessions ?? [])]
      .sort((left, right) => compareByDateThenId(right.updatedAt, right.id, left.updatedAt, left.id))
      .map((session) => ({ session, version: versions[session.id] ?? 1 }));
    return paginate(sessions, query);
  }

  async upsertMemoBuilderSession(
    userId: string,
    sessionId: string,
    command: UpsertMemoBuilderSessionCommand
  ) {
    if (this.workspaceMode !== "legacy") {
      return this.callWorkspace((workspace) => workspace.upsertMemoBuilderSession(userId, sessionId, command));
    }
    if (sessionId !== command.session.id) {
      throw new StoreError(400, "Memo Builder session ID does not match the route.", "invalid_session_id");
    }
    return this.mutateAccountState(userId, (state) => {
      state.memoBuilder ??= { messages: [] };
      const sessions = state.memoBuilder.sessions ?? [];
      const existing = sessions.find((session) => session.id === sessionId);
      const metadata = legacyWorkspaceMetadata(state);
      const currentVersion = existing ? (metadata.builderVersions[sessionId] ?? 1) : 0;
      if (currentVersion !== command.expectedVersion) {
        throw new StoreError(409, "Memo Builder session changed in another tab.", "stale_builder_session");
      }
      if (!existing && sessions.length >= 50) {
        throw new StoreError(409, "Memo Builder can retain at most 50 saved chats.", "builder_session_limit");
      }
      state.memoBuilder.sessions = [
        cloneAccountState(command.session),
        ...sessions.filter((session) => session.id !== sessionId)
      ];
      const version = currentVersion + 1;
      writeLegacyWorkspaceMetadata(state, {
        ...metadata,
        builderVersions: { ...metadata.builderVersions, [sessionId]: version }
      });
      return { session: cloneAccountState(command.session), version };
    });
  }

  async deleteMemoBuilderSession(userId: string, sessionId: string, expectedVersion: number) {
    if (this.workspaceMode !== "legacy") {
      return this.callWorkspace((workspace) => workspace.deleteMemoBuilderSession(userId, sessionId, expectedVersion));
    }
    await this.mutateAccountState(userId, (state) => {
      const sessions = state.memoBuilder?.sessions ?? [];
      const existing = sessions.find((session) => session.id === sessionId);
      if (!existing) return;
      const metadata = legacyWorkspaceMetadata(state);
      if ((metadata.builderVersions[sessionId] ?? 1) !== expectedVersion) {
        throw new StoreError(409, "Memo Builder session changed in another tab.", "stale_builder_session");
      }
      state.memoBuilder!.sessions = sessions.filter((session) => session.id !== sessionId);
      const builderVersions = { ...metadata.builderVersions };
      delete builderVersions[sessionId];
      writeLegacyWorkspaceMetadata(state, { ...metadata, builderVersions });
    });
  }

  async listOutreachLeadsPage(userId: string, query: PageQuery) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return paginateNormalizedOutreachLeads(
        userId,
        query,
        this.adminCursors,
        (pageQuery) => this.callWorkspace((workspace) =>
          workspace.listOutreachLeadsPage(userId, pageQuery)
        )
      );
    }
    const discovered = (await this.readAccountState(userId, false)).state.discoveredLeads ?? [];
    return paginateOutreachCollection(
      mergeBundledOutreachLeads(discovered),
      query,
      userId,
      "leads",
      this.adminCursors
    );
  }

  async listOutreachLeads(userId: string) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.listOutreachLeads(userId));
    }
    return cloneAccountState((await this.readAccountState(userId, false)).state.discoveredLeads ?? []);
  }

  async getOutreachLead(userId: string, leadId: string) {
    const bundled = bundledOutreachLeads.find((lead) => lead.leadId === leadId);
    if (bundled) return cloneAccountState(bundled);
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.getOutreachLead(userId, leadId));
    }
    const lead = (await this.readAccountState(userId, false)).state.discoveredLeads
      ?.find((candidate) => candidate.leadId === leadId);
    return lead ? cloneAccountState(lead) : undefined;
  }

  async upsertOutreachLeads(userId: string, leads: OutreachLead[]) {
    if (this.workspaceMode !== "legacy") {
      return this.callWorkspace((workspace) => workspace.upsertOutreachLeads(userId, leads));
    }
    await this.mutateAccountState(userId, (state) => {
      state.discoveredLeads = mergeByKey(leads, state.discoveredLeads ?? [], (lead) => lead.leadId);
    });
  }

  async listOutreachDraftsPage(userId: string, query: PageQuery) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.listOutreachDraftsPage(userId, query));
    }
    const drafts = Object.values((await this.readAccountState(userId, false)).state.outreachDrafts ?? {})
      .sort((left, right) => left.leadId.localeCompare(right.leadId));
    return paginateOutreachCollection(drafts, query, userId, "drafts", this.adminCursors);
  }

  async listOutreachDrafts(userId: string) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.listOutreachDrafts(userId));
    }
    return cloneAccountState((await this.readAccountState(userId, false)).state.outreachDrafts ?? {});
  }

  async getOutreachDraft(userId: string, leadId: string) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.getOutreachDraft(userId, leadId));
    }
    const draft = (await this.readAccountState(userId, false)).state.outreachDrafts?.[leadId];
    return draft ? cloneAccountState(draft) : undefined;
  }

  async upsertOutreachDraft(userId: string, draft: OutreachDraft, expectedUpdatedAt?: string) {
    if (this.workspaceMode !== "legacy") {
      return this.callWorkspace((workspace) => workspace.upsertOutreachDraft(userId, draft, expectedUpdatedAt));
    }
    await this.mutateAccountState(userId, (state) => {
      const current = state.outreachDrafts?.[draft.leadId];
      if (expectedUpdatedAt !== undefined && current?.updatedAt !== expectedUpdatedAt) {
        throw new StoreError(409, "Outreach draft changed in another session.", "stale_outreach_draft");
      }
      state.outreachDrafts = { ...(state.outreachDrafts ?? {}), [draft.leadId]: cloneAccountState(draft) };
    });
  }

  async listLeadSearchRunsPage(userId: string, query: PageQuery) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.listLeadSearchRunsPage(userId, query));
    }
    const runs = [...((await this.readAccountState(userId, false)).state.leadSearchRuns ?? [])]
      .sort((left, right) => right.id.localeCompare(left.id));
    return paginateOutreachCollection(runs, query, userId, "runs", this.adminCursors);
  }

  async listLeadSearchRuns(userId: string) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.listLeadSearchRuns(userId));
    }
    return cloneAccountState((await this.readAccountState(userId, false)).state.leadSearchRuns ?? []);
  }

  async appendLeadSearchRun(userId: string, run: LeadSearchRun) {
    if (this.workspaceMode !== "legacy") {
      return this.callWorkspace((workspace) => workspace.appendLeadSearchRun(userId, run));
    }
    await this.mutateAccountState(userId, (state) => {
      state.leadSearchRuns = mergeById([run], state.leadSearchRuns ?? []);
    });
  }

  async listLeadWorkflowsPage(userId: string, query: PageQuery) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.listLeadWorkflowsPage(userId, query));
    }
    const workflows = Object.values((await this.readAccountState(userId, false)).state.leadWorkflows ?? {})
      .sort((left, right) => left.leadId.localeCompare(right.leadId));
    return paginateOutreachCollection(workflows, query, userId, "workflows", this.adminCursors);
  }

  async listLeadWorkflows(userId: string) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.listLeadWorkflows(userId));
    }
    return cloneAccountState((await this.readAccountState(userId, false)).state.leadWorkflows ?? {});
  }

  async getLeadWorkflow(userId: string, leadId: string) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.getLeadWorkflow(userId, leadId));
    }
    const workflow = (await this.readAccountState(userId, false)).state.leadWorkflows?.[leadId];
    return workflow ? cloneAccountState(workflow) : undefined;
  }

  async upsertLeadWorkflow(userId: string, workflow: LeadWorkflow, expectedUpdatedAt?: string) {
    if (this.workspaceMode !== "legacy") {
      return this.callWorkspace((workspace) => workspace.upsertLeadWorkflow(userId, workflow, expectedUpdatedAt));
    }
    await this.mutateAccountState(userId, (state) => {
      const current = state.leadWorkflows?.[workflow.leadId];
      if (expectedUpdatedAt !== undefined && current?.updatedAt !== expectedUpdatedAt) {
        throw new StoreError(409, "Lead workflow changed in another session.", "stale_lead_workflow");
      }
      state.leadWorkflows = { ...(state.leadWorkflows ?? {}), [workflow.leadId]: cloneAccountState(workflow) };
    });
  }

  async listOutreachJobsPage(userId: string, query: PageQuery) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.listOutreachJobsPage(userId, query));
    }
    const jobs = [...((await this.readAccountState(userId, false)).state.outreachJobs ?? [])]
      .sort((left, right) => right.id.localeCompare(left.id));
    return paginateOutreachCollection(jobs, query, userId, "jobs", this.adminCursors);
  }

  async listOutreachJobs(userId: string) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.listOutreachJobs(userId));
    }
    return cloneAccountState((await this.readAccountState(userId, false)).state.outreachJobs ?? []);
  }

  async getOutreachJob(userId: string, jobId: string) {
    if (await this.shouldUseNormalizedRead(userId)) {
      return this.callWorkspace((workspace) => workspace.getOutreachJob(userId, jobId));
    }
    const job = (await this.readAccountState(userId, false)).state.outreachJobs
      ?.find((candidate) => candidate.id === jobId);
    return job ? cloneAccountState(job) : undefined;
  }

  async upsertOutreachJob(userId: string, job: OutreachJob, expectedUpdatedAt?: string) {
    if (this.workspaceMode !== "legacy") {
      return this.callWorkspace((workspace) => workspace.upsertOutreachJob(userId, job, expectedUpdatedAt));
    }
    await this.mutateAccountState(userId, (state) => {
      const current = state.outreachJobs?.find((candidate) => candidate.id === job.id);
      if (expectedUpdatedAt !== undefined && current?.updatedAt !== expectedUpdatedAt) {
        throw new StoreError(409, "Outreach job changed in another session.", "stale_outreach_job");
      }
      state.outreachJobs = mergeById([job], state.outreachJobs ?? []);
    });
  }

  async upsertReview(userId: string, memo: MemoRecord) {
    this.requireLegacyAggregateAccess();
    await this.mutateAccountState(userId, (state) => {
      const securedMemo = ensureMemoIntegrity(memo);
      state.memos = [securedMemo, ...state.memos.filter((item) => item.id !== memo.id)];
      state.selectedMemoId = memo.id;
      const revisions = state.memoRevisions ??= {};
      revisions[memo.id] = mergeById(
        [memoRevisionFromRecord(securedMemo, securedMemo.createdBy ?? userId, "created")],
        revisions[memo.id] ?? []
      );
    });
  }

  async updateReview(userId: string, memo: MemoRecord) {
    this.requireLegacyAggregateAccess();
    await this.mutateAccountState(userId, (state) => {
      applyReviewUpdate(state, memo, userId);
    });
  }

  async findReview(userId: string, memoId: string) {
    return (await this.getReviewDetail(userId, memoId))?.review;
  }

  async setAnalysisResult(
    userId: string,
    memo: MemoRecord,
    result: ReviewResult,
    auditEvents?: AnalysisTransitionAuditEvents
  ) {
    if (this.workspaceMode !== "legacy") {
      return this.callWorkspace((workspace) =>
        workspace.setAnalysisResult(userId, memo, result, auditEvents));
    }
    return this.mutateAccountState(userId, (state) =>
      applyAnalysisTransition(
        state,
        userId,
        memo,
        result,
        auditEvents
      )
    );
  }

  async setDecision(
    userId: string,
    memoId: string,
    decision: ReviewerDecision,
    auditEvent: AuditEvent,
    expected: DecisionExpectedBindings
  ) {
    if (this.workspaceMode !== "legacy") {
      return this.callWorkspace((workspace) =>
        workspace.setDecision(userId, memoId, decision, auditEvent, expected));
    }
    return this.mutateAccountState(userId, (state) =>
      applyDecisionTransition(state, userId, memoId, decision, auditEvent, expected)
    );
  }

  async appendAuditEvent(userId: string, event: AuditEvent) {
    this.requireLegacyAggregateAccess();
    await this.mutateAccountState(userId, (state) => {
      state.auditEvents = mergeById([event], state.auditEvents);
    });
  }

  async appendChatMessages(userId: string, memoId: string, messages: MemoChatMessage[]) {
    this.requireLegacyAggregateAccess();
    return this.mutateAccountState(userId, (state) => {
      state.chatMessages[memoId] = mergeById(
        [...(state.chatMessages[memoId] ?? []), ...messages],
        []
      );
      return state.chatMessages[memoId];
    });
  }

  async recordUsage(event: UsageEvent) {
    const expiresAtEpoch = Math.floor(Date.now() / 1000) + USAGE_TTL_DAYS * 24 * 60 * 60;
    const key = usageKey(event.at, event.id);
    const digest = usageEventHash(event);
    let day: string;
    try {
      day = adminMetricsUtcDay(event.at);
    } catch (error) {
      if (error instanceof AdminMetricsIntegrityError) {
        throw new StoreError(400, error.message, "invalid_usage_event");
      }
      throw error;
    }
    for (let attempt = 0; attempt < MAX_AUTH_TRANSITION_RETRIES; attempt += 1) {
      const [existing, receipt, dailyAggregate] = await Promise.all([
        this.getAuthRecord<AggregatedUsageRecord>(key, true),
        this.getAuthRecord<UsageAggregationReceipt>(usageReceiptKey(event.id), true),
        this.getAdminDailyUsageAggregate(day, true)
      ]);
      if (receipt) {
        if (receipt.eventHash !== digest || receipt.eventKey !== key) {
          throw new StoreError(
            409,
            "Usage event id is already bound to different telemetry.",
            "usage_event_conflict"
          );
        }
        if (!existing || existing.adminAggregateVersion !== ADMIN_AGGREGATE_SCHEMA_VERSION) {
          throw new StoreError(
            503,
            "Usage aggregation receipt exists without its aggregated event.",
            "admin_aggregate_integrity_failed"
          );
        }
      }
      if (existing) {
        if (usageEventHash(existing) !== digest) {
          throw new StoreError(
            409,
            "Usage event key is already bound to different telemetry.",
            "usage_event_conflict"
          );
        }
        if (existing.adminMetricsAggregateVersion === ADMIN_METRICS_SCHEMA_VERSION) {
          if (!receipt || !dailyAggregate || !await this.getAdminUsageAggregate(event.userId, true)) {
            throw new StoreError(
              503,
              "Usage event aggregate receipts are incomplete.",
              "admin_aggregate_integrity_failed"
            );
          }
          return;
        }
        if (existing.adminAggregateVersion === ADMIN_AGGREGATE_SCHEMA_VERSION && !receipt) {
          throw new StoreError(
            503,
            "Usage aggregation receipt is missing for an already-aggregated event.",
            "admin_aggregate_integrity_failed"
          );
        }
      }
      const usageAlreadyAggregated = existing?.adminAggregateVersion === ADMIN_AGGREGATE_SCHEMA_VERSION;
      const aggregate = usageAlreadyAggregated
        ? undefined
        : await this.getAdminUsageAggregate(event.userId, true);
      const nextAggregate = usageAlreadyAggregated
        ? undefined
        : addUsageToAdminAggregate(aggregate, event);
      let nextDailyAggregate: AdminDailyUsageAggregate;
      try {
        nextDailyAggregate = addUsageToAdminDailyAggregate(dailyAggregate, event);
      } catch (error) {
        if (error instanceof AdminMetricsIntegrityError) {
          throw new StoreError(503, error.message, "admin_metrics_integrity_failed");
        }
        throw error;
      }
      const record: AggregatedUsageRecord = {
        ...event,
        expiresAtEpoch,
        adminAggregateVersion: ADMIN_AGGREGATE_SCHEMA_VERSION,
        adminMetricsAggregateVersion: ADMIN_METRICS_SCHEMA_VERSION,
        usageEventHash: digest
      };
      const transactItems: TransactionItem[] = [
        {
          Put: {
            TableName: this.authTable,
            Item: this.authItem(key, record),
            ConditionExpression: existing
              ? [
                  "attribute_not_exists(#record.#metricsVersion)",
                  usageAlreadyAggregated
                    ? "#record.#aggregateVersion = :aggregateVersion"
                    : "attribute_not_exists(#record.#aggregateVersion)"
                ].join(" AND ")
              : "attribute_not_exists(#pk)",
            ExpressionAttributeNames: existing
              ? {
                  "#record": "record",
                  "#aggregateVersion": "adminAggregateVersion",
                  "#metricsVersion": "adminMetricsAggregateVersion"
                }
              : { "#pk": "pk" },
            ExpressionAttributeValues: existing && usageAlreadyAggregated
              ? { ":aggregateVersion": ADMIN_AGGREGATE_SCHEMA_VERSION }
              : undefined
          }
        },
        this.adminDailyUsageAggregatePut(nextDailyAggregate, dailyAggregate)
      ];
      if (!receipt) {
        transactItems.push({
          Put: {
            TableName: this.authTable,
            Item: this.authItem(usageReceiptKey(event.id), {
              eventId: event.id,
              eventHash: digest,
              eventKey: key,
              expiresAtEpoch
            } satisfies UsageAggregationReceipt),
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" }
          }
        });
      }
      if (nextAggregate) transactItems.push(this.adminUsageAggregatePut(nextAggregate, aggregate));
      try {
        await this.doc.send(new TransactWriteCommand({ TransactItems: transactItems }));
        return;
      } catch (error) {
        if (isAuthStateConflict(error)) continue;
        throw error;
      }
    }
    throw new StoreError(503, "Usage aggregation changed too many times. Try again.");
  }

  async getUsage(rangeDays?: number) {
    const cutoff = rangeDaysCutoff(rangeDays);
    const items = await this.queryAuthRange(
      `USAGE#${new Date(cutoff).toISOString()}#`,
      "USAGE#\uffff"
    );
    return items
      .map((item) => item.record as UsageEvent)
      .filter((event) => event && Date.parse(event.at) >= cutoff);
  }

  async getAdminMetrics(rangeDays: AdminMetricsRangeDays): Promise<AdminMetrics> {
    if (!isAdminMetricsRangeDays(rangeDays)) {
      throw new StoreError(400, "Admin metrics support only 7, 30, or 90 days.", "invalid_metrics_range");
    }
    const marker = await this.getAuthRecord<AdminAggregateMarker>(ADMIN_AGGREGATE_MARKER_KEY, true);
    const accountTotalAsOf = new Date().toISOString();
    if (!isCompleteAdminMetricsMarker(marker)) {
      throw new StoreError(
        503,
        "Exact admin metrics are unavailable until the aggregate migration completes.",
        "admin_metrics_backfill_required"
      );
    }
    const metricsNowMs = Date.now();
    const window = adminMetricsWindow(rangeDays, metricsNowMs);
    const response = await this.doc.send(new QueryCommand({
      TableName: this.authTable,
      KeyConditionExpression: "#pk = :pk and #sk BETWEEN :startSk AND :endSk",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":pk": tenantKey(this.tenantId),
        ":startSk": adminMetricsDayKey(window.start),
        ":endSk": adminMetricsDayKey(window.end)
      },
      Limit: rangeDays,
      ConsistentRead: true
    }));
    if (response.LastEvaluatedKey || (response.Items?.length ?? 0) > rangeDays) {
      throw new StoreError(
        503,
        "Exact admin metrics exceed the bounded materialized query contract.",
        "admin_metrics_integrity_failed"
      );
    }
    const usageAsOf = new Date().toISOString();
    try {
      return buildMaterializedAdminMetrics({
        daily: (response.Items ?? []).map((item) => item.record as AdminDailyUsageAggregate),
        rangeDays,
        usersTotal: marker.usersTotal,
        aggregateCompletedAt: marker.completedAt,
        accountTotalAsOf,
        usageAsOf,
        nowMs: metricsNowMs
      });
    } catch (error) {
      if (error instanceof AdminMetricsIntegrityError) {
        throw new StoreError(503, error.message, "admin_metrics_integrity_failed");
      }
      throw error;
    }
  }

  async reserveAiUsage(request: AiUsageReservationRequest): Promise<AiUsageReservationResult> {
    const key = aiAdmissionKey(request.accountId);
    for (let attempt = 0; attempt < MAX_AI_ADMISSION_RETRIES; attempt += 1) {
      const existing = await this.getAuthRecord<AiAdmissionStateRecord>(key, true);
      const transition = reserveAiUsageTransition(existing, request);
      if (!transition.result.ok || !transition.state) return transition.result;
      try {
        await this.putAiAdmissionState(key, transition.state, existing?.version);
        return transition.result;
      } catch (error) {
        if (isAuthStateConflict(error)) continue;
        throw error;
      }
    }
    throw new StoreError(503, "AI workload admission is temporarily unavailable.");
  }

  async settleAiUsage(request: AiUsageSettlementRequest): Promise<AiUsageSettlementResult> {
    if (request.disposition === "retain") return "retained";
    const key = aiAdmissionKey(request.accountId);
    for (let attempt = 0; attempt < MAX_AI_ADMISSION_RETRIES; attempt += 1) {
      const existing = await this.getAuthRecord<AiAdmissionStateRecord>(key, true);
      const transition = settleAiUsageTransition(existing, request);
      if (!transition.state) return transition.result;
      try {
        await this.putAiAdmissionState(key, transition.state, existing?.version);
        return transition.result;
      } catch (error) {
        if (isAuthStateConflict(error)) continue;
        throw error;
      }
    }
    throw new StoreError(503, "AI workload settlement is temporarily unavailable.");
  }

  async createAiApproval(accountId: string, command: CreateAiApprovalCommand): Promise<AiApprovalRecord> {
    const subject = approvalValue(() => assertAiApprovalSubject(command.subject));
    const subjectState = command.purpose === "memo-chat"
      ? await this.aiApprovalRequestSubjectConditions({
          targetAccountId: accountId,
          subject,
          context: {
            kind: "memo-chat",
            pendingMessageHash: "0".repeat(64),
            historyHash: approvalValue(() =>
              assertSha256(command.memoChatHistoryHash, "Observed memo-chat history hash"))
          }
        })
      : {
          conditions: [await this.aiApprovalSubjectCondition(accountId, subject)].filter(
            (condition): condition is TransactionItem => Boolean(condition)
          )
        };
    const approval = prepareAiApproval(
      this.tenantId,
      accountId,
      command,
      Date.now(),
      subjectState.memoChatFence
    );
    const approvalKey = aiApprovalKey(accountId, approval.id);
    const existing = await this.getAuthRecord<AiApprovalRecord>(approvalKey, true);
    if (existing) return idempotentAiApproval(existing, approval);

    const pointerKey = aiApprovalPointerKey(accountId, approval.subject, approval.purpose);
    const currentPointer = await this.getAuthRecord<AiApprovalCurrentPointer>(pointerKey, true);
    const pointer: AiApprovalCurrentPointer = {
      accountId,
      identity: aiApprovalCurrentIdentity(approval.subject, approval.purpose),
      approvalId: approval.id,
      updatedAt: approval.approvedAt,
      expiresAtEpoch: approval.expiresAtEpoch
    };
    const counter: AiApprovalDispatchCounter = {
      accountId,
      approvalId: approval.id,
      version: 1,
      dispatchLimit: approval.dispatchLimit,
      dispatchesReserved: 0,
      providerRequestHashesReserved: [],
      expiresAtEpoch: approval.expiresAtEpoch
    };
    const pointerPut: TransactionItem = currentPointer
      ? {
          Put: {
            TableName: this.authTable,
            Item: this.authItem(pointerKey, pointer),
            ConditionExpression: "#record.#approvalId = :expectedApprovalId",
            ExpressionAttributeNames: { "#record": "record", "#approvalId": "approvalId" },
            ExpressionAttributeValues: { ":expectedApprovalId": currentPointer.approvalId }
          }
        }
      : {
          Put: {
            TableName: this.authTable,
            Item: this.authItem(pointerKey, pointer),
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" }
          }
        };
    const items: TransactionItem[] = [
      ...subjectState.conditions,
      {
        Put: {
          TableName: this.authTable,
          Item: this.authItem(approvalKey, approval),
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" }
        }
      },
      {
        Put: {
          TableName: this.authTable,
          Item: this.authItem(aiApprovalCounterKey(accountId, approval.id), counter),
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" }
        }
      },
      pointerPut
    ];
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: items }));
      return structuredClone(approval);
    } catch (error) {
      if (!isAuthStateConflict(error)) throw error;
      const winner = await this.getAuthRecord<AiApprovalRecord>(approvalKey, true);
      if (winner) return idempotentAiApproval(winner, approval);
      throw new StoreError(
        409,
        "The approval subject or current approval changed. Reload and approve the current content.",
        "ai_approval_stale_subject"
      );
    }
  }

  async getCurrentAiApproval(
    accountId: string,
    query: CurrentAiApprovalQuery
  ): Promise<AiApprovalStatus | undefined> {
    assertCurrentAiApprovalQuery(query);
    const pointer = await this.getAuthRecord<AiApprovalCurrentPointer>(aiApprovalPointerKey(
      accountId,
      { kind: query.subjectKind, id: query.subjectId },
      query.purpose
    ), true);
    if (!pointer) return undefined;
    return this.aiApprovalStatus(accountId, pointer.approvalId, pointer.approvalId);
  }

  async revokeAiApproval(
    accountId: string,
    approvalId: string,
    command: RevokeAiApprovalCommand
  ): Promise<AiApprovalStatus> {
    assertOfficer(command.revokedBy, "Only an export-control officer may revoke AI approval.");
    const approval = storedAiApproval(await this.getAuthRecord<AiApprovalRecord>(
      aiApprovalKey(accountId, approvalId),
      true
    ));
    if (approval.accountId !== accountId || approval.tenantId !== this.tenantId) {
      throw new StoreError(404, "AI approval not found.", "ai_approval_not_found");
    }
    const revocation = prepareAiApprovalRevocation(accountId, approvalId, command);
    const revocationKey = aiApprovalRevocationKey(accountId, approvalId);
    for (let attempt = 0; attempt < MAX_AUTH_TRANSITION_RETRIES; attempt += 1) {
      const [existing, pointer] = await Promise.all([
        this.getAuthRecord<AiApprovalRevocation>(revocationKey, true),
        this.getAuthRecord<AiApprovalCurrentPointer>(
          aiApprovalPointerKey(accountId, approval.subject, approval.purpose),
          true
        )
      ]);
      if (existing) {
        const validated = storedAiApprovalRevocation(existing);
        if (validated.commandHash !== revocation.commandHash) {
          throw new StoreError(409, "AI approval was already revoked.", "ai_approval_already_revoked");
        }
        return this.aiApprovalStatus(accountId, approvalId, undefined, validated);
      }
      const items: TransactionItem[] = [{
        Put: {
          TableName: this.authTable,
          Item: this.authItem(revocationKey, revocation),
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" }
        }
      }];
      if (pointer?.approvalId === approvalId) {
        items.push({
          Delete: {
            TableName: this.authTable,
            Key: { pk: tenantKey(this.tenantId), sk: aiApprovalPointerKey(accountId, approval.subject, approval.purpose) },
            ConditionExpression: "#record.#approvalId = :approvalId",
            ExpressionAttributeNames: { "#record": "record", "#approvalId": "approvalId" },
            ExpressionAttributeValues: { ":approvalId": approvalId }
          }
        });
      }
      try {
        await this.doc.send(new TransactWriteCommand({ TransactItems: items }));
        return this.aiApprovalStatus(accountId, approvalId, undefined, revocation);
      } catch (error) {
        if (isAuthStateConflict(error)) continue;
        throw error;
      }
    }
    throw new StoreError(503, "AI approval revocation changed too many times.", "ai_approval_state_unavailable");
  }

  async createAiApprovalRequest(
    requesterAccountId: string,
    command: CreateAiApprovalRequestCommand
  ): Promise<AiApprovalRequestStatus> {
    const nowMs = Date.now();
    const prepared = prepareAiApprovalRequest(this.tenantId, requesterAccountId, command, nowMs);
    const requestKey = aiApprovalRequestKey(requesterAccountId, prepared.id);
    const existing = await this.getAuthRecord<AiApprovalRequestRecord>(requestKey, true);
    if (existing) {
      return this.dynamoAiApprovalRequestStatus(idempotentAiApprovalRequest(existing, prepared));
    }
    const preview = prepareAiApprovalRequestPreview(prepared, command.pendingContent);
    const pendingKey = aiApprovalRequestPendingKey(requesterAccountId, prepared.dedupeHash);
    const pendingValue = await this.getAuthRecord<AiApprovalRequestPendingPointer>(pendingKey, true);
    const pending = pendingValue ? storedAiApprovalRequestPendingPointer(pendingValue) : undefined;
    if (pending) {
      const duplicateValue = await this.getAuthRecord<AiApprovalRequestRecord>(
        aiApprovalRequestKey(requesterAccountId, pending.approvalRequestId),
        true
      );
      if (duplicateValue) {
        const duplicate = storedAiApprovalRequest(duplicateValue);
        const duplicateDecision = await this.getAuthRecord<AiApprovalRequestDecision>(
          aiApprovalRequestDecisionKey(duplicate.id),
          true
        );
        if (duplicate.dedupeHash === prepared.dedupeHash && !duplicateDecision &&
            nowMs < Date.parse(duplicate.expiresAt)) {
          return this.dynamoAiApprovalRequestStatus(duplicate);
        }
      }
    }
    const subjectState = await this.aiApprovalRequestSubjectConditions(prepared);
    const index = approvalRequestIndexRecord(prepared, undefined, nowMs);
    const bucket = prepared.createdAt.slice(0, 10);
    const quotaExpiresAtEpoch = Math.floor(nowMs / 1_000) + 2 * 86_400;
    const quotaUpdate = (key: string, limit: number): TransactionItem => ({
      Update: {
        TableName: this.authTable,
        Key: { pk: tenantKey(this.tenantId), sk: key },
        UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, #expiresAtEpoch = :expiresAtEpoch",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
        ExpressionAttributeNames: { "#count": "count", "#expiresAtEpoch": "expiresAtEpoch" },
        ExpressionAttributeValues: {
          ":zero": 0,
          ":one": 1,
          ":limit": limit,
          ":expiresAtEpoch": quotaExpiresAtEpoch
        }
      }
    });
    const items: TransactionItem[] = [
      ...subjectState.conditions,
      {
        Put: {
          TableName: this.authTable,
          Item: this.authItem(requestKey, prepared),
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" }
        }
      },
      {
        Put: {
          TableName: this.authTable,
          Item: this.authItem(index.accountIndexKey, index),
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" }
        }
      },
      {
        Put: {
          TableName: this.authTable,
          Item: this.authItem(index.tenantIndexKey, index),
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" }
        }
      },
      ...(preview
        ? [{
            Put: {
              TableName: this.authTable,
              Item: this.authItem(aiApprovalRequestPreviewKey(prepared.id), preview),
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": "pk" }
            }
          } satisfies TransactionItem]
        : []),
      {
        Put: {
          TableName: this.authTable,
          Item: this.authItem(pendingKey, initialAiApprovalRequestPendingPointer(prepared)),
          ConditionExpression: pending
            ? "#record.#approvalRequestId = :expectedRequestId"
            : "attribute_not_exists(#pk)",
          ExpressionAttributeNames: pending
            ? { "#record": "record", "#approvalRequestId": "approvalRequestId" }
            : { "#pk": "pk" },
          ExpressionAttributeValues: pending
            ? { ":expectedRequestId": pending.approvalRequestId }
            : undefined
        }
      },
      quotaUpdate(aiApprovalRequestAccountQuotaKey(requesterAccountId, bucket), MAX_DAILY_AI_APPROVAL_REQUESTS_PER_ACCOUNT),
      quotaUpdate(aiApprovalRequestTenantQuotaKey(bucket), MAX_DAILY_AI_APPROVAL_REQUESTS_PER_TENANT)
    ];
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: items }));
      return this.dynamoAiApprovalRequestStatus(prepared);
    } catch (error) {
      if (!isAuthStateConflict(error)) throw error;
      const winner = await this.getAuthRecord<AiApprovalRequestRecord>(requestKey, true);
      if (winner) {
        return this.dynamoAiApprovalRequestStatus(idempotentAiApprovalRequest(winner, prepared));
      }
      const pointerWinnerValue = await this.getAuthRecord<AiApprovalRequestPendingPointer>(pendingKey, true);
      if (pointerWinnerValue) {
        const pointerWinner = storedAiApprovalRequestPendingPointer(pointerWinnerValue);
        const duplicateValue = await this.getAuthRecord<AiApprovalRequestRecord>(
          aiApprovalRequestKey(requesterAccountId, pointerWinner.approvalRequestId),
          true
        );
        if (duplicateValue) {
          const duplicate = storedAiApprovalRequest(duplicateValue);
          const duplicateDecision = await this.getAuthRecord<AiApprovalRequestDecision>(
            aiApprovalRequestDecisionKey(duplicate.id),
            true
          );
          if (duplicate.dedupeHash === prepared.dedupeHash && !duplicateDecision &&
              nowMs < Date.parse(duplicate.expiresAt)) {
            return this.dynamoAiApprovalRequestStatus(duplicate);
          }
        }
      }
      // Re-run the subject read to distinguish stale content from bounded
      // capacity; both fail closed and the transaction wrote nothing.
      await this.aiApprovalRequestSubjectConditions(prepared);
      throw new StoreError(
        429,
        "The daily AI approval request capacity has been reached.",
        "ai_approval_request_capacity"
      );
    }
  }

  async listAiApprovalRequests(
    accountId: string,
    query: AiApprovalRequestPageQuery
  ): Promise<CursorPage<AiApprovalRequestListItem>> {
    boundedAiIdentifier(accountId, "AI approval account ID", 512);
    return this.listDynamoAiApprovalRequests(aiApprovalRequestAccountIndexPrefix(accountId), query);
  }

  async getAiApprovalRequest(
    accountId: string,
    requestId: string
  ): Promise<AiApprovalRequestStatus | undefined> {
    boundedAiIdentifier(accountId, "AI approval account ID", 512);
    boundedAiIdentifier(requestId, "AI approval request ID", 160);
    const value = await this.getAuthRecord<AiApprovalRequestRecord>(aiApprovalRequestKey(accountId, requestId), true);
    if (!value) return undefined;
    const request = storedAiApprovalRequest(value);
    if (request.targetAccountId !== accountId) return undefined;
    return this.dynamoAiApprovalRequestStatus(request);
  }

  async cancelAiApprovalRequest(
    accountId: string,
    approvalRequestId: string,
    command: CancelAiApprovalRequestCommand
  ): Promise<AiApprovalRequestStatus> {
    const request = storedAiApprovalRequest(await this.getAuthRecord<AiApprovalRequestRecord>(
      aiApprovalRequestKey(accountId, approvalRequestId),
      true
    ));
    if (request.targetAccountId !== accountId || command.actor.id !== accountId) {
      throw new StoreError(404, "AI approval request not found.", "ai_approval_request_not_found");
    }
    return this.decideDynamoAiApprovalRequest(request, "cancelled", command);
  }

  async listTenantAiApprovalRequests(
    actor: AiApprovalRequestActor,
    query: AiApprovalRequestPageQuery
  ): Promise<CursorPage<AiApprovalRequestListItem>> {
    assertOfficer(actor, "Only an export-control officer may list tenant approval requests.");
    return this.listDynamoAiApprovalRequests(aiApprovalRequestTenantIndexPrefix(), query);
  }

  async getTenantAiApprovalRequest(
    actor: AiApprovalRequestActor,
    requestId: string
  ): Promise<AiApprovalRequestOfficerDetail | undefined> {
    assertOfficer(actor, "Only an export-control officer may inspect tenant approval requests.");
    boundedAiIdentifier(requestId, "AI approval request ID", 160);
    const value = await this.getAuthRecord<AiApprovalRequestRecord>(aiApprovalRequestKey("", requestId), true);
    if (!value) return undefined;
    const request = storedAiApprovalRequest(value);
    const status = await this.dynamoAiApprovalRequestStatus(request);
    const preview = request.purpose === "memo-chat" && status.status === "pending"
      ? await this.getAuthRecord<AiApprovalRequestEncryptedPreview>(aiApprovalRequestPreviewKey(request.id), true)
      : undefined;
    return {
      approvalRequest: status,
      ...(request.purpose === "memo-chat" && status.status === "pending"
        ? {
            pendingContent: {
              kind: "memo-chat" as const,
              text: decryptAiApprovalRequestPreview(request, preview)
            }
          }
        : {})
    };
  }

  async approveAiApprovalRequest(
    approvalRequestId: string,
    command: DecideAiApprovalRequestCommand
  ): Promise<AiApprovalRequestStatus> {
    assertOfficer(command.decidedBy, "Only an export-control officer may approve AI requests.");
    const request = storedAiApprovalRequest(await this.getAuthRecord<AiApprovalRequestRecord>(
      aiApprovalRequestKey("", approvalRequestId),
      true
    ));
    const nowMs = Date.now();
    const subjectState = await this.aiApprovalRequestSubjectConditions(request);
    const approval = prepareAiApproval(this.tenantId, request.targetAccountId, {
      requestId: queuedApprovalIdempotencyKey(request.id),
      purpose: request.purpose,
      subject: request.subject,
      payloadHash: request.payloadHash,
      providerRequestHashes: request.providerRequestHashes,
      dataClass: request.dataClass,
      policy: request.policy,
      ...(request.context.kind === "memo-chat"
        ? { memoChatHistoryHash: request.context.historyHash }
        : {}),
      approvedBy: command.decidedBy,
      dispatchLimit: 1
    }, nowMs, subjectState.memoChatFence);
    const decision = prepareAiApprovalRequestDecision(request, "approved", command, nowMs, approval.id);
    const decisionKey = aiApprovalRequestDecisionKey(request.id);
    const existingDecision = await this.getAuthRecord<AiApprovalRequestDecision>(decisionKey, true);
    if (existingDecision) {
      idempotentAiApprovalRequestDecision(existingDecision, decision);
      return this.dynamoAiApprovalRequestStatus(request);
    }
    if (nowMs >= Date.parse(request.expiresAt)) {
      throw new StoreError(409, "AI approval request expired.", "ai_approval_request_expired");
    }
    const preview = request.purpose === "memo-chat"
      ? await this.getAuthRecord<AiApprovalRequestEncryptedPreview>(aiApprovalRequestPreviewKey(request.id), true)
      : undefined;
    if (request.purpose === "memo-chat") decryptAiApprovalRequestPreview(request, preview, nowMs);
    const pointerKey = aiApprovalPointerKey(request.targetAccountId, approval.subject, approval.purpose);
    const currentPointer = await this.getAuthRecord<AiApprovalCurrentPointer>(pointerKey, true);
    const pointer = initialAiApprovalPointer(approval);
    const pointerPut: TransactionItem = currentPointer
      ? {
          Put: {
            TableName: this.authTable,
            Item: this.authItem(pointerKey, pointer),
            ConditionExpression: "#record.#approvalId = :expectedApprovalId",
            ExpressionAttributeNames: { "#record": "record", "#approvalId": "approvalId" },
            ExpressionAttributeValues: { ":expectedApprovalId": currentPointer.approvalId }
          }
        }
      : {
          Put: {
            TableName: this.authTable,
            Item: this.authItem(pointerKey, pointer),
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" }
          }
        };
    const index = approvalRequestIndexRecord(request, decision, nowMs);
    const pendingIndexPut = (key: string): TransactionItem => ({
      Put: {
        TableName: this.authTable,
        Item: this.authItem(key, index),
        ConditionExpression: "#record.#status = :pending AND #record.#requestKey = :requestKey",
        ExpressionAttributeNames: { "#record": "record", "#status": "status", "#requestKey": "requestKey" },
        ExpressionAttributeValues: { ":pending": "pending", ":requestKey": index.requestKey }
      }
    });
    const items: TransactionItem[] = [
      ...subjectState.conditions,
      {
        ConditionCheck: {
          TableName: this.authTable,
          Key: { pk: tenantKey(this.tenantId), sk: aiApprovalRequestKey(request.targetAccountId, request.id) },
          ConditionExpression: "#record.#commandHash = :commandHash AND #record.#validUntilEpoch > :nowEpoch",
          ExpressionAttributeNames: {
            "#record": "record",
            "#commandHash": "commandHash",
            "#validUntilEpoch": "validUntilEpoch"
          },
          ExpressionAttributeValues: {
            ":commandHash": request.commandHash,
            ":nowEpoch": Math.floor(nowMs / 1_000)
          }
        }
      },
      {
        Delete: {
          TableName: this.authTable,
          Key: {
            pk: tenantKey(this.tenantId),
            sk: aiApprovalRequestPendingKey(request.targetAccountId, request.dedupeHash)
          },
          ConditionExpression:
            "#record.#approvalRequestId = :approvalRequestId AND #record.#dedupeHash = :dedupeHash",
          ExpressionAttributeNames: {
            "#record": "record",
            "#approvalRequestId": "approvalRequestId",
            "#dedupeHash": "dedupeHash"
          },
          ExpressionAttributeValues: {
            ":approvalRequestId": request.id,
            ":dedupeHash": request.dedupeHash
          }
        }
      },
      ...(preview
        ? [{
            Delete: {
              TableName: this.authTable,
              Key: { pk: tenantKey(this.tenantId), sk: aiApprovalRequestPreviewKey(request.id) },
              ConditionExpression: "#record.#bindingHash = :bindingHash AND #record.#expiresAtEpoch > :nowEpoch",
              ExpressionAttributeNames: {
                "#record": "record",
                "#bindingHash": "bindingHash",
                "#expiresAtEpoch": "expiresAtEpoch"
              },
              ExpressionAttributeValues: {
                ":bindingHash": preview.bindingHash,
                ":nowEpoch": Math.floor(nowMs / 1_000)
              }
            }
          } satisfies TransactionItem]
        : []),
      {
        Put: {
          TableName: this.authTable,
          Item: this.authItem(decisionKey, decision),
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" }
        }
      },
      {
        Put: {
          TableName: this.authTable,
          Item: this.authItem(aiApprovalKey(request.targetAccountId, approval.id), approval),
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" }
        }
      },
      {
        Put: {
          TableName: this.authTable,
          Item: this.authItem(aiApprovalCounterKey(request.targetAccountId, approval.id), initialAiApprovalCounter(approval)),
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" }
        }
      },
      pointerPut,
      pendingIndexPut(index.accountIndexKey),
      pendingIndexPut(index.tenantIndexKey)
    ];
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: items }));
      return this.dynamoAiApprovalRequestStatus(request);
    } catch (error) {
      if (!isAuthStateConflict(error)) throw error;
      const winner = await this.getAuthRecord<AiApprovalRequestDecision>(decisionKey, true);
      if (winner) {
        idempotentAiApprovalRequestDecision(winner, decision);
        return this.dynamoAiApprovalRequestStatus(request);
      }
      throw new StoreError(
        409,
        "The approval request or its exact subject changed before approval.",
        "ai_approval_stale_subject"
      );
    }
  }

  async rejectAiApprovalRequest(
    approvalRequestId: string,
    command: DecideAiApprovalRequestCommand
  ): Promise<AiApprovalRequestStatus> {
    const request = storedAiApprovalRequest(await this.getAuthRecord<AiApprovalRequestRecord>(
      aiApprovalRequestKey("", approvalRequestId),
      true
    ));
    return this.decideDynamoAiApprovalRequest(request, "rejected", command);
  }

  async revokeAiApprovalRequestApproval(
    approvalRequestId: string,
    command: RevokeAiApprovalCommand
  ): Promise<AiApprovalRequestStatus> {
    assertOfficer(command.revokedBy, "Only an export-control officer may revoke queued AI approval.");
    const request = storedAiApprovalRequest(await this.getAuthRecord<AiApprovalRequestRecord>(
      aiApprovalRequestKey("", approvalRequestId),
      true
    ));
    const decision = storedAiApprovalRequestDecision(await this.getAuthRecord<AiApprovalRequestDecision>(
      aiApprovalRequestDecisionKey(request.id),
      true
    ));
    if (decision.decision !== "approved" || !decision.approvalId ||
        decision.targetAccountId !== request.targetAccountId) {
      throw new StoreError(409, "AI approval request was not approved.", "ai_approval_request_not_approved");
    }
    await this.revokeAiApproval(request.targetAccountId, decision.approvalId, command);
    return this.dynamoAiApprovalRequestStatus(request);
  }

  async reserveAiDispatch(request: ReserveAiDispatchRequest): Promise<ReserveAiDispatchResult> {
    const preparationApproval = request.approvalId
      ? storedAiApproval(await this.getAuthRecord<AiApprovalRecord>(
          aiApprovalKey(request.accountId, request.approvalId),
          true
        ))
      : undefined;
    const prepared = prepareAiDispatchReservation(request, preparationApproval?.memoChatFence);
    const dispatchKey = aiDispatchKey(request.accountId, request.dispatchId);
    const existingValue = await this.getAuthRecord<AiDispatchReceipt>(dispatchKey, true);
    let existing = existingValue ? storedAiDispatchReceipt(existingValue) : undefined;
    if (existing) {
      idempotentAiDispatch(existing, prepared);
      if (existing.status === "reserved" && existing.reservationExpiresAtEpoch <= Math.floor(request.nowMs / 1_000)) {
        await this.transitionAiDispatch({
          accountId: request.accountId,
          dispatchId: request.dispatchId,
          requestHash: prepared.requestHash,
          reservationToken: existing.reservationToken,
          transition: "release",
          nowMs: request.nowMs
        });
        existing = undefined;
      } else {
        return {
          replayed: true,
          requestHash: prepared.requestHash,
          reservationToken: existing.reservationToken
        };
      }
    }

    if (prepared.authorizationKind === "trusted-workflow") {
      try {
        await this.doc.send(new PutCommand({
          TableName: this.authTable,
          Item: this.authItem(dispatchKey, prepared),
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" }
        }));
        return {
          replayed: false,
          requestHash: prepared.requestHash,
          reservationToken: prepared.reservationToken
        };
      } catch (error) {
        if (!isAuthStateConflict(error)) throw error;
        const winnerValue = await this.getAuthRecord<AiDispatchReceipt>(dispatchKey, true);
        if (!winnerValue) throw error;
        return idempotentAiDispatch(storedAiDispatchReceipt(winnerValue), prepared);
      }
    }

    const approvalId = prepared.approvalId as string;
    for (let attempt = 0; attempt < MAX_AUTH_TRANSITION_RETRIES; attempt += 1) {
      const state = await this.assertDynamoAiDispatchApproved({
        ...request,
        ...(prepared.memoChatFence ? { memoChatFence: prepared.memoChatFence } : {})
      }, approvalId);
      if (state.counter.dispatchesReserved >= state.counter.dispatchLimit) {
        throw new StoreError(409, "AI approval dispatch limit was reached.", "ai_approval_dispatch_limit");
      }
      if (state.counter.providerRequestHashesReserved.includes(request.providerRequestHash)) {
        throw new StoreError(
          409,
          "This exact approved provider request was already reserved.",
          "ai_approval_provider_request_consumed"
        );
      }
      const nowEpoch = Math.floor(request.nowMs / 1_000);
      const nextCounter: AiApprovalDispatchCounter = {
        ...state.counter,
        version: state.counter.version + 1,
        dispatchesReserved: state.counter.dispatchesReserved + 1,
        providerRequestHashesReserved: [
          ...state.counter.providerRequestHashesReserved,
          request.providerRequestHash
        ]
      };
      const items: TransactionItem[] = [
        ...(state.subjectCondition ? [state.subjectCondition] : []),
        ...(state.memoChatCondition ? [state.memoChatCondition] : []),
        {
          ConditionCheck: {
            TableName: this.authTable,
            Key: { pk: tenantKey(this.tenantId), sk: aiApprovalKey(request.accountId, approvalId) },
            ConditionExpression:
              "#record.#commandHash = :commandHash AND #record.#validUntilEpoch > :nowEpoch",
            ExpressionAttributeNames: {
              "#record": "record",
              "#commandHash": "commandHash",
              "#validUntilEpoch": "validUntilEpoch"
            },
            ExpressionAttributeValues: {
              ":commandHash": state.approval.commandHash,
              ":nowEpoch": nowEpoch
            }
          }
        },
        {
          ConditionCheck: {
            TableName: this.authTable,
            Key: { pk: tenantKey(this.tenantId), sk: state.pointerKey },
            ConditionExpression: "#record.#approvalId = :approvalId",
            ExpressionAttributeNames: { "#record": "record", "#approvalId": "approvalId" },
            ExpressionAttributeValues: { ":approvalId": approvalId }
          }
        },
        {
          ConditionCheck: {
            TableName: this.authTable,
            Key: { pk: tenantKey(this.tenantId), sk: aiApprovalRevocationKey(request.accountId, approvalId) },
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" }
          }
        },
        {
          Put: {
            TableName: this.authTable,
            Item: this.authItem(aiApprovalCounterKey(request.accountId, approvalId), nextCounter),
            ConditionExpression:
              "#record.#version = :expectedVersion AND #record.#expiresAtEpoch > :nowEpoch",
            ExpressionAttributeNames: {
              "#record": "record",
              "#version": "version",
              "#expiresAtEpoch": "expiresAtEpoch"
            },
            ExpressionAttributeValues: {
              ":expectedVersion": state.counter.version,
              ":nowEpoch": nowEpoch
            }
          }
        },
        {
          Put: {
            TableName: this.authTable,
            Item: this.authItem(dispatchKey, prepared),
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" }
          }
        }
      ];
      try {
        await this.doc.send(new TransactWriteCommand({ TransactItems: items }));
        return {
          replayed: false,
          requestHash: prepared.requestHash,
          reservationToken: prepared.reservationToken
        };
      } catch (error) {
        if (!isAuthStateConflict(error)) throw error;
        const winnerValue = await this.getAuthRecord<AiDispatchReceipt>(dispatchKey, true);
        if (winnerValue) return idempotentAiDispatch(storedAiDispatchReceipt(winnerValue), prepared);
      }
    }
    throw new StoreError(503, "AI approval state changed too many times.", "ai_approval_state_unavailable");
  }

  async transitionAiDispatch(request: TransitionAiDispatchRequest): Promise<void> {
    validateAiDispatchTransition(request);
    const key = aiDispatchKey(request.accountId, request.dispatchId);
    const existingValue = await this.getAuthRecord<AiDispatchReceipt>(key, true);
    if (!existingValue) {
      if (request.transition === "mark-started") {
        throw new StoreError(409, "AI dispatch reservation is no longer owned by this caller.", "ai_dispatch_fenced");
      }
      return;
    }
    const existing = storedAiDispatchReceipt(existingValue);
    if (existing.requestHash !== request.requestHash) {
      throw new StoreError(409, "AI dispatch receipt binding changed.", "ai_dispatch_id_conflict");
    }
    if (existing.reservationToken !== request.reservationToken) {
      if (request.transition === "mark-started") {
        throw new StoreError(409, "AI dispatch reservation is no longer owned by this caller.", "ai_dispatch_fenced");
      }
      return;
    }
    if (request.transition === "release") {
      if (existing.status !== "reserved") return;
      for (let attempt = 0; attempt < MAX_AUTH_TRANSITION_RETRIES; attempt += 1) {
        const items: TransactionItem[] = [{
          Delete: {
            TableName: this.authTable,
            Key: { pk: tenantKey(this.tenantId), sk: key },
            ConditionExpression:
              "#record.#requestHash = :requestHash AND #record.#reservationToken = :reservationToken AND #record.#status = :reserved",
            ExpressionAttributeNames: {
              "#record": "record",
              "#requestHash": "requestHash",
              "#reservationToken": "reservationToken",
              "#status": "status"
            },
            ExpressionAttributeValues: {
              ":requestHash": request.requestHash,
              ":reservationToken": request.reservationToken,
              ":reserved": "reserved"
            }
          }
        }];
        if (existing.approvalId) {
          const counter = await this.getAuthRecord<AiApprovalDispatchCounter>(
            aiApprovalCounterKey(request.accountId, existing.approvalId),
            true
          );
          const approval = storedAiApproval(await this.getAuthRecord<AiApprovalRecord>(
            aiApprovalKey(request.accountId, existing.approvalId),
            true
          ));
          if (!validAiApprovalCounter(counter, approval) || counter.dispatchesReserved < 1 ||
              !counter.providerRequestHashesReserved.includes(existing.providerRequestHash)) {
            throw new StoreError(503, "AI approval dispatch state is invalid.", "ai_approval_state_invalid");
          }
          const nextCounter: AiApprovalDispatchCounter = {
            ...counter,
            version: counter.version + 1,
            dispatchesReserved: counter.dispatchesReserved - 1,
            providerRequestHashesReserved: counter.providerRequestHashesReserved.filter(
              (hash) => hash !== existing.providerRequestHash
            )
          };
          items.push({
            Put: {
              TableName: this.authTable,
              Item: this.authItem(
                aiApprovalCounterKey(request.accountId, existing.approvalId),
                nextCounter
              ),
              ConditionExpression: "#record.#version = :expectedVersion",
              ExpressionAttributeNames: { "#record": "record", "#version": "version" },
              ExpressionAttributeValues: { ":expectedVersion": counter.version }
            }
          });
        }
        try {
          await this.doc.send(new TransactWriteCommand({ TransactItems: items }));
          return;
        } catch (error) {
          if (!isAuthStateConflict(error)) throw error;
          const currentValue = await this.getAuthRecord<AiDispatchReceipt>(key, true);
          const current = currentValue ? storedAiDispatchReceipt(currentValue) : undefined;
          if (!current || current.status !== "reserved" ||
              current.reservationToken !== request.reservationToken) return;
        }
      }
      throw new StoreError(503, "AI dispatch release changed too many times.", "ai_approval_state_unavailable");
    }

    const targetStatus: AiDispatchStatus = request.transition === "mark-started"
      ? "started"
      : request.transition === "settle-succeeded"
        ? "succeeded"
        : "failed";
    const requiredStatus: AiDispatchStatus = request.transition === "mark-started" ? "reserved" : "started";
    if (existing.status === targetStatus) return;
    if (existing.status !== requiredStatus) return;
    try {
      if (request.transition === "mark-started" && existing.approvalId) {
        const dispatch = dispatchRequestFromReceipt(existing, request.nowMs);
        const state = await this.assertDynamoAiDispatchApproved(dispatch, existing.approvalId);
        const nowEpoch = Math.floor(request.nowMs / 1_000);
        const claimedAt = new Date(request.nowMs).toISOString();
        const claimExpiresAtEpoch = Math.floor((request.nowMs + AI_MEMO_CHAT_CLAIM_MS) / 1_000);
        const chatClaim = state.approval.purpose === "memo-chat" && this.workspaceMode !== "legacy"
          ? await this.callWorkspace((workspace) => workspace.aiApprovalChatClaimTransition(
              request.accountId,
              state.approval.subject.id,
              state.approval.memoChatFence!,
              {
                dispatchId: existing.dispatchId,
                requestHash: existing.requestHash,
                reservationToken: existing.reservationToken,
                expiresAtEpoch: claimExpiresAtEpoch
              },
              claimedAt,
              nowEpoch
            ))
          : undefined;
        await this.doc.send(new TransactWriteCommand({
          TransactItems: [
            ...(state.subjectCondition ? [state.subjectCondition] : []),
            ...(chatClaim ? [chatClaim] : state.memoChatCondition ? [state.memoChatCondition] : []),
            {
              ConditionCheck: {
                TableName: this.authTable,
                Key: {
                  pk: tenantKey(this.tenantId),
                  sk: aiApprovalKey(request.accountId, existing.approvalId)
                },
                ConditionExpression:
                  "#record.#commandHash = :commandHash AND #record.#validUntilEpoch > :nowEpoch",
                ExpressionAttributeNames: {
                  "#record": "record",
                  "#commandHash": "commandHash",
                  "#validUntilEpoch": "validUntilEpoch"
                },
                ExpressionAttributeValues: {
                  ":commandHash": state.approval.commandHash,
                  ":nowEpoch": nowEpoch
                }
              }
            },
            {
              ConditionCheck: {
                TableName: this.authTable,
                Key: { pk: tenantKey(this.tenantId), sk: state.pointerKey },
                ConditionExpression: "#record.#approvalId = :approvalId",
                ExpressionAttributeNames: { "#record": "record", "#approvalId": "approvalId" },
                ExpressionAttributeValues: { ":approvalId": existing.approvalId }
              }
            },
            {
              ConditionCheck: {
                TableName: this.authTable,
                Key: {
                  pk: tenantKey(this.tenantId),
                  sk: aiApprovalRevocationKey(request.accountId, existing.approvalId)
                },
                ConditionExpression: "attribute_not_exists(#pk)",
                ExpressionAttributeNames: { "#pk": "pk" }
              }
            },
            {
              Update: {
                TableName: this.authTable,
                Key: { pk: tenantKey(this.tenantId), sk: key },
                UpdateExpression: state.approval.purpose === "memo-chat"
                  ? "SET #record.#status = :target, #record.#updatedAt = :updatedAt, #record.#memoChatClaimedAt = :claimedAt, #record.#memoChatClaimExpiresAtEpoch = :claimExpiresAtEpoch"
                  : "SET #record.#status = :target, #record.#updatedAt = :updatedAt",
                ConditionExpression:
                  "#record.#requestHash = :requestHash AND #record.#reservationToken = :reservationToken AND #record.#status = :required AND #record.#reservationExpiresAtEpoch > :nowEpoch",
                ExpressionAttributeNames: {
                  "#record": "record",
                  "#status": "status",
                  "#requestHash": "requestHash",
                  "#reservationToken": "reservationToken",
                  "#reservationExpiresAtEpoch": "reservationExpiresAtEpoch",
                  "#updatedAt": "updatedAt",
                  ...(state.approval.purpose === "memo-chat"
                    ? {
                        "#memoChatClaimedAt": "memoChatClaimedAt",
                        "#memoChatClaimExpiresAtEpoch": "memoChatClaimExpiresAtEpoch"
                      }
                    : {})
                },
                ExpressionAttributeValues: {
                  ":target": targetStatus,
                  ":updatedAt": new Date(request.nowMs).toISOString(),
                  ":requestHash": request.requestHash,
                  ":reservationToken": request.reservationToken,
                  ":nowEpoch": nowEpoch,
                  ":required": requiredStatus,
                  ...(state.approval.purpose === "memo-chat"
                    ? { ":claimedAt": claimedAt, ":claimExpiresAtEpoch": claimExpiresAtEpoch }
                    : {})
                }
              }
            }
          ]
        }));
      } else if (request.transition === "settle-failed" && existing.memoChatFence &&
          existing.subject && this.workspaceMode !== "legacy") {
        const releaseClaim = await this.callWorkspace((workspace) => workspace.aiApprovalChatClaimRelease(
          request.accountId,
          existing.subject!.id,
          existing.memoChatFence!,
          {
            dispatchId: existing.dispatchId,
            requestHash: existing.requestHash,
            reservationToken: existing.reservationToken
          },
          new Date(request.nowMs).toISOString()
        ));
        await this.doc.send(new TransactWriteCommand({
          TransactItems: [
            releaseClaim,
            {
              Update: {
                TableName: this.authTable,
                Key: { pk: tenantKey(this.tenantId), sk: key },
                UpdateExpression: "SET #record.#status = :target, #record.#updatedAt = :updatedAt",
                ConditionExpression:
                  "#record.#requestHash = :requestHash AND #record.#reservationToken = :reservationToken AND #record.#status = :required",
                ExpressionAttributeNames: {
                  "#record": "record",
                  "#status": "status",
                  "#requestHash": "requestHash",
                  "#reservationToken": "reservationToken",
                  "#updatedAt": "updatedAt"
                },
                ExpressionAttributeValues: {
                  ":target": targetStatus,
                  ":updatedAt": new Date(request.nowMs).toISOString(),
                  ":requestHash": request.requestHash,
                  ":reservationToken": request.reservationToken,
                  ":required": requiredStatus
                }
              }
            }
          ]
        }));
      } else {
        await this.doc.send(new UpdateCommand({
          TableName: this.authTable,
          Key: { pk: tenantKey(this.tenantId), sk: key },
          UpdateExpression: "SET #record.#status = :target, #record.#updatedAt = :updatedAt",
          ConditionExpression: request.transition === "mark-started"
            ? "#record.#requestHash = :requestHash AND #record.#reservationToken = :reservationToken AND #record.#status = :required AND #record.#reservationExpiresAtEpoch > :nowEpoch"
            : "#record.#requestHash = :requestHash AND #record.#reservationToken = :reservationToken AND #record.#status = :required",
          ExpressionAttributeNames: {
            "#record": "record",
            "#status": "status",
            "#requestHash": "requestHash",
            "#reservationToken": "reservationToken",
            ...(request.transition === "mark-started"
              ? { "#reservationExpiresAtEpoch": "reservationExpiresAtEpoch" }
              : {}),
            "#updatedAt": "updatedAt"
          },
          ExpressionAttributeValues: {
            ":target": targetStatus,
            ":updatedAt": new Date(request.nowMs).toISOString(),
            ":requestHash": request.requestHash,
            ":reservationToken": request.reservationToken,
            ...(request.transition === "mark-started"
              ? { ":nowEpoch": Math.floor(request.nowMs / 1_000) }
              : {}),
            ":required": requiredStatus
          }
        }));
      }
    } catch (error) {
      if (!isAuthStateConflict(error)) throw error;
      const currentValue = await this.getAuthRecord<AiDispatchReceipt>(key, true);
      const current = currentValue ? storedAiDispatchReceipt(currentValue) : undefined;
      if (request.transition === "mark-started" && (
        !current || current.requestHash !== request.requestHash ||
        current.reservationToken !== request.reservationToken ||
        current.reservationExpiresAtEpoch <= Math.floor(request.nowMs / 1_000)
      )) {
        throw new StoreError(409, "AI dispatch reservation is no longer owned by this caller.", "ai_dispatch_fenced");
      }
      if (!current || current.requestHash !== request.requestHash ||
          current.reservationToken !== request.reservationToken) throw error;
      if (current.status === targetStatus || current.status !== requiredStatus) return;
      if (request.transition === "mark-started" && current.approvalId) {
        await this.assertDynamoAiDispatchApproved(
          dispatchRequestFromReceipt(current, request.nowMs),
          current.approvalId
        );
        throw new StoreError(
          409,
          "AI dispatch authorization changed before provider start.",
          "ai_dispatch_fenced"
        );
      }
      throw error;
    }
  }

  async listUsers() {
    const items = await this.queryAuthByPrefix("USER#");
    return items.map((item) => publicUser(item.record as UserRecord));
  }

  async listActiveSessions(): Promise<ActiveSessionSummary[]> {
    const items = await this.queryAuthByPrefix("SESSION#");
    return items
      .map((item) => item.record as SessionRecord)
      .filter((session) => session && !isExpired(session.expiresAt))
      .map((session) => ({ userId: session.userId, lastSeenAt: session.lastSeenAt }));
  }

  async listAdminUsersPage(query: PageQuery): Promise<CursorPage<UserAdminSummary>> {
    const limit = Math.min(MAX_ADMIN_USER_PAGE_SIZE, Math.max(1, Math.floor(query.limit)));
    if (!Number.isSafeInteger(query.limit) || query.limit !== limit) {
      throw new StoreError(400, `Page limit must be from 1 through ${MAX_ADMIN_USER_PAGE_SIZE}.`);
    }
    const marker = await this.getAuthRecord<AdminAggregateMarker>(ADMIN_AGGREGATE_MARKER_KEY, true);
    if (marker?.status !== "complete" || marker.schemaVersion !== ADMIN_AGGREGATE_SCHEMA_VERSION) {
      throw new StoreError(
        503,
        "Admin aggregates must be backfilled before account activity can be listed.",
        "admin_aggregate_backfill_required"
      );
    }
    const pk = tenantKey(this.tenantId);
    const prefix = "USER#";
    const queryHash = sha256Canonical({ schemaVersion: 1, limit });
    let exclusiveStartKey: Record<string, unknown> | undefined;
    if (query.cursor) {
      try {
        exclusiveStartKey = this.adminCursors.decode(query.cursor, { pk, prefix, queryHash }).lastEvaluatedKey;
      } catch (error) {
        if (error instanceof WorkspaceValidationError) {
          throw new StoreError(400, "Pagination cursor is invalid.", "invalid_cursor");
        }
        throw error;
      }
    }
    const response = await this.doc.send(new QueryCommand({
      TableName: this.authTable,
      KeyConditionExpression: "#pk = :pk and begins_with(#sk, :prefix)",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ExclusiveStartKey: exclusiveStartKey,
      Limit: limit,
      ConsistentRead: true
    }));
    const users = (response.Items ?? []).map((item) => publicUser(item.record as UserRecord));
    let summaries: UserAdminSummary[];
    try {
      summaries = await Promise.all(users.map(async (user) => {
        const [usage, sessions] = await Promise.all([
          this.getAdminUsageAggregate(user.id, true),
          this.getAdminSessionAggregate(user.id, true)
        ]);
        if (!usage || !sessions) {
          throw new AdminAggregateIntegrityError(
            "A completed admin backfill is missing an aggregate for this user."
          );
        }
        return summarizeAdminUser(user, usage, sessions);
      }));
    } catch (error) {
      if (error instanceof AdminAggregateIntegrityError) {
        throw new StoreError(503, error.message, "admin_aggregate_integrity_failed");
      }
      throw error;
    }
    const page: CursorPage<UserAdminSummary> = { items: summaries };
    if (response.LastEvaluatedKey) {
      page.nextCursor = this.adminCursors.encode({
        pk,
        prefix,
        queryHash,
        lastEvaluatedKey: response.LastEvaluatedKey
      });
    }
    return page;
  }

  async backfillAdminAggregates(): Promise<AdminAggregateBackfillResult> {
    const existingMarker = await this.getAuthRecord<AdminAggregateMarker>(ADMIN_AGGREGATE_MARKER_KEY, true);
    if (isCompleteAdminMetricsMarker(existingMarker)) {
      return {
        status: "complete",
        usageEventsProcessed: existingMarker.usageEventsProcessed ?? 0,
        sessionsProcessed: existingMarker.sessionsProcessed ?? 0,
        sessionsRevoked: existingMarker.sessionsRevoked ?? 0
      };
    }
    const nowEpoch = Math.floor(Date.now() / 1_000);
    if (
      existingMarker?.status === "building"
      && (existingMarker.leaseExpiresAtEpoch ?? 0) > nowEpoch
    ) {
      throw new StoreError(
        503,
        "Another admin aggregate backfill owns the active lease.",
        "admin_aggregate_backfill_in_progress"
      );
    }
    const startedAt = new Date().toISOString();
    const buildId = randomBytes(18).toString("base64url");
    const buildingMarker: AdminAggregateMarker = {
      schemaVersion: ADMIN_AGGREGATE_SCHEMA_VERSION,
      version: (existingMarker?.version ?? 0) + 1,
      status: "building",
      startedAt,
      buildId,
      leaseExpiresAtEpoch: nowEpoch + ADMIN_AGGREGATE_LEASE_SECONDS
    };
    try {
      await this.doc.send(new PutCommand({
        TableName: this.authTable,
        Item: this.authItem(ADMIN_AGGREGATE_MARKER_KEY, buildingMarker),
        ConditionExpression: existingMarker
          ? [
              "#record.#status = :expectedStatus",
              existingMarker.version === undefined
                ? "attribute_not_exists(#record.#version)"
                : "#record.#version = :expectedVersion"
            ].join(" AND ")
          : "attribute_not_exists(#pk)",
        ExpressionAttributeNames: existingMarker
          ? { "#record": "record", "#status": "status", "#version": "version" }
          : { "#pk": "pk" },
        ExpressionAttributeValues: existingMarker
          ? {
              ":expectedStatus": existingMarker.status,
              ...(existingMarker.version === undefined ? {} : { ":expectedVersion": existingMarker.version })
            }
          : undefined
      }));
    } catch (error) {
      if (!isAuthStateConflict(error)) throw error;
      const winner = await this.getAuthRecord<AdminAggregateMarker>(ADMIN_AGGREGATE_MARKER_KEY, true);
      if (isCompleteAdminMetricsMarker(winner)) {
        return {
          status: "complete",
          usageEventsProcessed: winner.usageEventsProcessed ?? 0,
          sessionsProcessed: winner.sessionsProcessed ?? 0,
          sessionsRevoked: winner.sessionsRevoked ?? 0
        };
      }
      throw new StoreError(
        503,
        "Another admin aggregate backfill acquired the lease.",
        "admin_aggregate_backfill_in_progress"
      );
    }

    const usageItems = await this.queryAuthByPrefix("USAGE#");
    let usageEventsProcessed = 0;
    for (const item of usageItems) {
      const event = item.record as AggregatedUsageRecord;
      await this.recordUsage(event);
      usageEventsProcessed += 1;
    }

    const sessionItems = await this.queryAuthByPrefix("SESSION#");
    const sessionsByUser = new Map<string, SessionRecord[]>();
    for (const item of sessionItems) {
      const session = item.record as SessionRecord;
      if (!session || isExpired(session.expiresAt)) {
        if (session?.tokenHash) await this.deleteSessionRecord(session);
        continue;
      }
      const sessions = sessionsByUser.get(session.userId) ?? [];
      sessions.push(session);
      sessionsByUser.set(session.userId, sessions);
    }
    let sessionsProcessed = 0;
    let sessionsRevoked = 0;
    for (const sessions of sessionsByUser.values()) {
      sessions.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
      for (const session of sessions.slice(MAX_TRACKED_ADMIN_SESSIONS)) {
        await this.deleteSessionRecord(session);
        sessionsRevoked += 1;
      }
      for (const session of sessions.slice(0, MAX_TRACKED_ADMIN_SESSIONS)) {
        await this.ensureSessionAggregated(session);
        sessionsProcessed += 1;
      }
    }
    const users = await this.queryAuthByPrefix("USER#");
    for (const item of users) {
      await this.ensureAdminUserAggregates((item.record as UserRecord).id);
    }
    const completedAt = new Date().toISOString();
    const marker: AdminAggregateMarker = {
      schemaVersion: ADMIN_AGGREGATE_SCHEMA_VERSION,
      version: buildingMarker.version! + 1,
      status: "complete",
      startedAt,
      completedAt,
      metricsSchemaVersion: ADMIN_METRICS_SCHEMA_VERSION,
      usersTotal: users.length,
      usageEventsProcessed,
      sessionsProcessed,
      sessionsRevoked
    };
    try {
      await this.doc.send(new PutCommand({
        TableName: this.authTable,
        Item: this.authItem(ADMIN_AGGREGATE_MARKER_KEY, marker),
        ConditionExpression: [
          "#record.#status = :building",
          "#record.#buildId = :buildId",
          "#record.#version = :expectedVersion"
        ].join(" AND "),
        ExpressionAttributeNames: {
          "#record": "record",
          "#status": "status",
          "#buildId": "buildId",
          "#version": "version"
        },
        ExpressionAttributeValues: {
          ":building": "building",
          ":buildId": buildId,
          ":expectedVersion": buildingMarker.version
        }
      }));
    } catch (error) {
      if (isAuthStateConflict(error)) {
        throw new StoreError(
          503,
          "Admin aggregate backfill ownership changed before completion.",
          "admin_aggregate_backfill_fenced"
        );
      }
      throw error;
    }
    return { status: "complete", usageEventsProcessed, sessionsProcessed, sessionsRevoked };
  }

  async getOutreachConfig(): Promise<StoredOutreachConfig> {
    for (let attempt = 0; attempt < MAX_AUTH_TRANSITION_RETRIES; attempt += 1) {
      const record = await this.getAuthRecord<Record<string, unknown>>("CONFIG#outreach", true);
      const sanitized = sanitizeOutreachConfig(record);
      if (!record || JSON.stringify(record) === JSON.stringify(sanitized)) return sanitized;
      try {
        await this.doc.send(new PutCommand({
          TableName: this.authTable,
          Item: this.authItem("CONFIG#outreach", sanitized),
          ConditionExpression: "#record.#provider = :expectedProvider",
          ExpressionAttributeNames: { "#record": "record", "#provider": "provider" },
          ExpressionAttributeValues: { ":expectedProvider": record.provider }
        }));
        return sanitized;
      } catch (error) {
        if (isAuthStateConflict(error)) continue;
        throw error;
      }
    }
    throw new StoreError(503, "Provider configuration changed too many times. Try again.");
  }

  async setOutreachConfig(config: StoredOutreachConfig): Promise<void> {
    await this.putAuthItem("CONFIG#outreach", sanitizeOutreachConfig(config));
  }

  private async dynamoAiApprovalRequestStatus(
    requestValue: AiApprovalRequestRecord
  ): Promise<AiApprovalRequestStatus> {
    const request = storedAiApprovalRequest(requestValue);
    const decisionValue = await this.getAuthRecord<AiApprovalRequestDecision>(
      aiApprovalRequestDecisionKey(request.id),
      true
    );
    const decision = decisionValue ? storedAiApprovalRequestDecision(decisionValue) : undefined;
    if (decision && (decision.requestId !== request.id || decision.targetAccountId !== request.targetAccountId)) {
      throw new StoreError(503, "AI approval request decision binding is invalid.", "ai_approval_state_invalid");
    }
    let approval: AiApprovalStatus | undefined;
    if (decision?.approvalId) {
      const approvalRecord = storedAiApproval(await this.getAuthRecord<AiApprovalRecord>(
        aiApprovalKey(request.targetAccountId, decision.approvalId),
        true
      ));
      const pointer = await this.getAuthRecord<AiApprovalCurrentPointer>(aiApprovalPointerKey(
        request.targetAccountId,
        approvalRecord.subject,
        approvalRecord.purpose
      ), true);
      approval = await this.aiApprovalStatus(
        request.targetAccountId,
        decision.approvalId,
        pointer?.approvalId
      );
    }
    return {
      request: structuredClone(request),
      status: approvalRequestStatusKind(request, decision),
      ...(decision ? { decision: structuredClone(decision) } : {}),
      ...(approval ? { approval } : {})
    };
  }

  private async listDynamoAiApprovalRequests(
    prefix: string,
    query: AiApprovalRequestPageQuery
  ): Promise<CursorPage<AiApprovalRequestListItem>> {
    const limit = validateAiApprovalRequestPageQuery(query);
    const pk = tenantKey(this.tenantId);
    const queryHash = sha256Canonical({ schemaVersion: 1, limit, status: query.status ?? null });
    let exclusiveStartKey: Record<string, unknown> | undefined;
    if (query.cursor) {
      try {
        exclusiveStartKey = this.adminCursors.decode(query.cursor, { pk, prefix, queryHash }).lastEvaluatedKey;
      } catch (error) {
        if (error instanceof WorkspaceValidationError) {
          throw new StoreError(400, "Pagination cursor is invalid.", "invalid_cursor");
        }
        throw error;
      }
    }
    const items: AiApprovalRequestListItem[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined = exclusiveStartKey;
    for (let page = 0; page < 200 && items.length < limit; page += 1) {
      const response = await this.doc.send(new QueryCommand({
        TableName: this.authTable,
        KeyConditionExpression: "#pk = :pk and begins_with(#sk, :prefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
        ExclusiveStartKey: lastEvaluatedKey,
        Limit: limit - items.length,
        ConsistentRead: true
      }));
      for (const raw of response.Items ?? []) {
        const index = storedAiApprovalRequestIndex(raw.record);
        const item: AiApprovalRequestListItem = {
          id: index.id,
          targetAccountId: index.targetAccountId,
          requestedBy: structuredClone(index.requestedBy),
          purpose: index.purpose,
          subject: structuredClone(index.subject),
          dataClass: index.dataClass,
          policy: structuredClone(index.policy),
          context: structuredClone(index.context),
          status: index.status === "pending" && Date.now() >= Date.parse(index.expiresAt)
            ? "expired"
            : index.status,
          createdAt: index.createdAt,
          expiresAt: index.expiresAt,
          ...(index.decidedAt ? { decidedAt: index.decidedAt } : {})
        };
        if (!query.status || item.status === query.status) items.push(item);
      }
      lastEvaluatedKey = response.LastEvaluatedKey;
      if (!lastEvaluatedKey) break;
    }
    const result: CursorPage<AiApprovalRequestListItem> = { items };
    if (lastEvaluatedKey) {
      result.nextCursor = this.adminCursors.encode({ pk, prefix, queryHash, lastEvaluatedKey });
    }
    return result;
  }

  private async decideDynamoAiApprovalRequest(
    requestValue: AiApprovalRequestRecord,
    decisionKind: "cancelled" | "rejected",
    command: CancelAiApprovalRequestCommand | DecideAiApprovalRequestCommand
  ): Promise<AiApprovalRequestStatus> {
    const request = storedAiApprovalRequest(requestValue);
    const nowMs = Date.now();
    const decision = prepareAiApprovalRequestDecision(request, decisionKind, command, nowMs);
    const decisionKey = aiApprovalRequestDecisionKey(request.id);
    const existing = await this.getAuthRecord<AiApprovalRequestDecision>(decisionKey, true);
    if (existing) {
      idempotentAiApprovalRequestDecision(existing, decision);
      return this.dynamoAiApprovalRequestStatus(request);
    }
    if (nowMs >= Date.parse(request.expiresAt)) {
      throw new StoreError(409, "AI approval request expired.", "ai_approval_request_expired");
    }
    const previewValue = request.purpose === "memo-chat"
      ? await this.getAuthRecord<AiApprovalRequestEncryptedPreview>(aiApprovalRequestPreviewKey(request.id), true)
      : undefined;
    const preview = previewValue ? storedAiApprovalRequestPreview(previewValue) : undefined;
    const index = approvalRequestIndexRecord(request, decision, nowMs);
    const updateIndex = (key: string): TransactionItem => ({
      Put: {
        TableName: this.authTable,
        Item: this.authItem(key, index),
        ConditionExpression: "#record.#status = :pending AND #record.#requestKey = :requestKey",
        ExpressionAttributeNames: { "#record": "record", "#status": "status", "#requestKey": "requestKey" },
        ExpressionAttributeValues: { ":pending": "pending", ":requestKey": index.requestKey }
      }
    });
    const items: TransactionItem[] = [
      {
        ConditionCheck: {
          TableName: this.authTable,
          Key: { pk: tenantKey(this.tenantId), sk: aiApprovalRequestKey(request.targetAccountId, request.id) },
          ConditionExpression: "#record.#commandHash = :commandHash AND #record.#validUntilEpoch > :nowEpoch",
          ExpressionAttributeNames: {
            "#record": "record",
            "#commandHash": "commandHash",
            "#validUntilEpoch": "validUntilEpoch"
          },
          ExpressionAttributeValues: {
            ":commandHash": request.commandHash,
            ":nowEpoch": Math.floor(nowMs / 1_000)
          }
        }
      },
      {
        Delete: {
          TableName: this.authTable,
          Key: {
            pk: tenantKey(this.tenantId),
            sk: aiApprovalRequestPendingKey(request.targetAccountId, request.dedupeHash)
          },
          ConditionExpression:
            "#record.#approvalRequestId = :approvalRequestId AND #record.#dedupeHash = :dedupeHash",
          ExpressionAttributeNames: {
            "#record": "record",
            "#approvalRequestId": "approvalRequestId",
            "#dedupeHash": "dedupeHash"
          },
          ExpressionAttributeValues: {
            ":approvalRequestId": request.id,
            ":dedupeHash": request.dedupeHash
          }
        }
      },
      {
        Put: {
          TableName: this.authTable,
          Item: this.authItem(decisionKey, decision),
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" }
        }
      },
      updateIndex(index.accountIndexKey),
      updateIndex(index.tenantIndexKey),
      ...(preview
        ? [{
            Delete: {
              TableName: this.authTable,
              Key: { pk: tenantKey(this.tenantId), sk: aiApprovalRequestPreviewKey(request.id) },
              ConditionExpression: "#record.#bindingHash = :bindingHash",
              ExpressionAttributeNames: { "#record": "record", "#bindingHash": "bindingHash" },
              ExpressionAttributeValues: { ":bindingHash": preview.bindingHash }
            }
          } satisfies TransactionItem]
        : [])
    ];
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: items }));
      return this.dynamoAiApprovalRequestStatus(request);
    } catch (error) {
      if (!isAuthStateConflict(error)) throw error;
      const winner = await this.getAuthRecord<AiApprovalRequestDecision>(decisionKey, true);
      if (winner) {
        idempotentAiApprovalRequestDecision(winner, decision);
        return this.dynamoAiApprovalRequestStatus(request);
      }
      throw new StoreError(409, "AI approval request changed before decision.", "ai_approval_request_decided");
    }
  }

  private async aiApprovalStatus(
    accountId: string,
    approvalId: string,
    expectedCurrentApprovalId?: string,
    suppliedRevocation?: AiApprovalRevocation
  ): Promise<AiApprovalStatus> {
    const [approvalValue, counter, revocationValue] = await Promise.all([
      this.getAuthRecord<AiApprovalRecord>(aiApprovalKey(accountId, approvalId), true),
      this.getAuthRecord<AiApprovalDispatchCounter>(aiApprovalCounterKey(accountId, approvalId), true),
      suppliedRevocation
        ? Promise.resolve(suppliedRevocation)
        : this.getAuthRecord<AiApprovalRevocation>(aiApprovalRevocationKey(accountId, approvalId), true)
    ]);
    const approval = storedAiApproval(approvalValue);
    if (approval.accountId !== accountId || approval.tenantId !== this.tenantId) {
      throw new StoreError(404, "AI approval not found.", "ai_approval_not_found");
    }
    const revocation = revocationValue ? storedAiApprovalRevocation(revocationValue) : undefined;
    if (!validAiApprovalCounter(counter, approval)) {
      throw new StoreError(503, "AI approval dispatch state is invalid.", "ai_approval_state_invalid");
    }
    return {
      approval: structuredClone(approval),
      current: expectedCurrentApprovalId === approvalId && !revocation && Date.parse(approval.expiresAt) > Date.now(),
      dispatchesReserved: validDispatchCount(counter.dispatchesReserved),
      ...(revocation ? { revocation: structuredClone(revocation) } : {})
    };
  }

  private async aiApprovalRequestSubjectConditions(
    request: Pick<AiApprovalRequestRecord, "targetAccountId" | "subject" | "context">
  ): Promise<{ conditions: TransactionItem[]; memoChatFence?: AiApprovalMemoChatFence }> {
    if (this.workspaceMode !== "legacy") {
      const conditions: TransactionItem[] = [];
      const subject = await this.aiApprovalSubjectCondition(request.targetAccountId, request.subject);
      if (subject) conditions.push(subject);
      const context = request.context;
      let memoChatFence: AiApprovalMemoChatFence | undefined;
      if (context.kind === "memo-chat") {
        const capture = await this.callWorkspace((workspace) => workspace.aiApprovalChatCondition(
          request.targetAccountId,
          request.subject.id,
          context.historyHash
        ));
        conditions.push(capture.condition);
        memoChatFence = capture.fence;
      }
      return { conditions, ...(memoChatFence ? { memoChatFence } : {}) };
    }
    const snapshot = await this.readAccountState(request.targetAccountId, true);
    if (request.subject.kind === "review") {
      assertReviewApprovalBinding(
        snapshot.state.memos.find((candidate) => candidate.id === request.subject.id),
        request.subject
      );
    } else {
      const session = snapshot.state.memoBuilder?.sessions?.find((candidate) => candidate.id === request.subject.id);
      const version = session
        ? legacyWorkspaceMetadata(snapshot.state).builderVersions[request.subject.id] ?? 1
        : undefined;
      assertBuilderApprovalBinding(
        session && version ? { session, version } : undefined,
        request.subject
      );
    }
    let memoChatFence: AiApprovalMemoChatFence | undefined;
    if (request.context.kind === "memo-chat") {
      const history = currentAiApprovalChatWindow(snapshot.state.chatMessages[request.subject.id] ?? []);
      const historyHash = hashAiApprovalChatHistory(history);
      if (historyHash !== request.context.historyHash) {
        throw new StoreError(
          409,
          "Memo-chat history changed before officer approval.",
          "ai_approval_stale_subject"
        );
      }
      const messages = snapshot.state.chatMessages[request.subject.id] ?? [];
      memoChatFence = messages.length === 0
        ? { historyHash, chatMeta: { exists: false } }
        : {
            historyHash,
            chatMeta: {
              exists: true,
              entityVersion: typeof snapshot.rawVersion === "number" &&
                Number.isSafeInteger(snapshot.rawVersion) && snapshot.rawVersion > 0
                ? snapshot.rawVersion
                : 1,
              nextSequence: messages.length
            }
          };
    }
    return { conditions: [{
      ConditionCheck: {
        TableName: this.accountTable,
        Key: { pk: accountKey(this.tenantId, request.targetAccountId) },
        ConditionExpression: snapshot.hasVersion
          ? "#state.#version = :expectedVersion"
          : "attribute_not_exists(#state.#version)",
        ExpressionAttributeNames: { "#state": "state", "#version": "version" },
        ExpressionAttributeValues: snapshot.hasVersion
          ? { ":expectedVersion": snapshot.rawVersion }
          : undefined
      }
    }], ...(memoChatFence ? { memoChatFence } : {}) };
  }

  private async aiApprovalSubjectCondition(
    accountId: string,
    subject: AiApprovalSubjectBinding
  ): Promise<TransactionItem | undefined> {
    if (subject.kind === "document") return undefined;
    if (this.workspaceMode !== "legacy") {
      return this.callWorkspace((workspace) => subject.kind === "review"
        ? workspace.aiApprovalReviewCondition(accountId, subject)
        : workspace.aiApprovalBuilderCondition(accountId, subject));
    }
    const snapshot = await this.readAccountState(accountId, true);
    if (subject.kind === "review") {
      assertReviewApprovalBinding(
        snapshot.state.memos.find((candidate) => candidate.id === subject.id),
        subject
      );
    } else {
      const session = snapshot.state.memoBuilder?.sessions?.find((candidate) => candidate.id === subject.id);
      const version = session
        ? legacyWorkspaceMetadata(snapshot.state).builderVersions[subject.id] ?? 1
        : undefined;
      assertBuilderApprovalBinding(
        session && version ? { session, version } : undefined,
        subject
      );
    }
    return {
      ConditionCheck: {
        TableName: this.accountTable,
        Key: { pk: accountKey(this.tenantId, accountId) },
        ConditionExpression: snapshot.hasVersion
          ? "#state.#version = :expectedVersion"
          : "attribute_not_exists(#state.#version)",
        ExpressionAttributeNames: { "#state": "state", "#version": "version" },
        ExpressionAttributeValues: snapshot.hasVersion
          ? { ":expectedVersion": snapshot.rawVersion }
          : undefined
      }
    };
  }

  private async assertDynamoAiDispatchApproved(
    request: ReserveAiDispatchRequest,
    approvalId: string
  ) {
    const approvalKey = aiApprovalKey(request.accountId, approvalId);
    const [approvalValue, pointer, revocation, counter] = await Promise.all([
      this.getAuthRecord<AiApprovalRecord>(approvalKey, true),
      request.subject
        ? this.getAuthRecord<AiApprovalCurrentPointer>(
            aiApprovalPointerKey(request.accountId, request.subject, request.purpose),
            true
          )
        : Promise.resolve(undefined),
      this.getAuthRecord<AiApprovalRevocation>(aiApprovalRevocationKey(request.accountId, approvalId), true),
      this.getAuthRecord<AiApprovalDispatchCounter>(aiApprovalCounterKey(request.accountId, approvalId), true)
    ]);
    const approval = storedAiApproval(approvalValue);
    assertAiDispatchMatchesApproval(request, approval, this.tenantId);
    const pointerKey = aiApprovalPointerKey(request.accountId, approval.subject, approval.purpose);
    if (pointer?.approvalId !== approval.id) {
      throw new StoreError(403, "AI approval is not the current subject approval.", "ai_approval_superseded");
    }
    if (revocation) {
      storedAiApprovalRevocation(revocation);
      throw new StoreError(403, "AI approval was revoked.", "ai_approval_revoked");
    }
    if (!validAiApprovalCounter(counter, approval)) {
      throw new StoreError(503, "AI approval dispatch state is invalid.", "ai_approval_state_invalid");
    }
    let subjectCondition: TransactionItem | undefined;
    let memoChatCondition: TransactionItem | undefined;
    if (approval.purpose === "memo-chat" && !approval.memoChatFence) {
      throw new StoreError(503, "Memo-chat approval fence is missing.", "ai_approval_state_invalid");
    }
    if (approval.purpose === "memo-chat" && this.workspaceMode === "legacy") {
      const snapshot = await this.readAccountState(request.accountId, true);
      const review = snapshot.state.memos.find((candidate) => candidate.id === approval.subject.id);
      assertReviewApprovalBinding(review, approval.subject);
      const messages = snapshot.state.chatMessages[approval.subject.id] ?? [];
      const currentFence: AiApprovalMemoChatFence = messages.length === 0
        ? {
            historyHash: hashAiApprovalChatHistory([]),
            chatMeta: { exists: false }
          }
        : {
            historyHash: hashAiApprovalChatHistory(currentAiApprovalChatWindow(messages)),
            chatMeta: {
              exists: true,
              entityVersion: typeof snapshot.rawVersion === "number" &&
                Number.isSafeInteger(snapshot.rawVersion) && snapshot.rawVersion > 0
                ? snapshot.rawVersion
                : 1,
              nextSequence: messages.length
            }
          };
      if (!sameAiApprovalMemoChatFence(currentFence, approval.memoChatFence!)) {
        throw new StoreError(409, "Memo-chat history changed after approval.", "ai_dispatch_fenced");
      }
      subjectCondition = {
        ConditionCheck: {
          TableName: this.accountTable,
          Key: { pk: accountKey(this.tenantId, request.accountId) },
          ConditionExpression: snapshot.hasVersion
            ? "#state.#version = :expectedVersion"
            : "attribute_not_exists(#state.#version)",
          ExpressionAttributeNames: { "#state": "state", "#version": "version" },
          ExpressionAttributeValues: snapshot.hasVersion
            ? { ":expectedVersion": snapshot.rawVersion }
            : undefined
        }
      };
    } else {
      subjectCondition = await this.aiApprovalSubjectCondition(request.accountId, approval.subject);
      if (approval.purpose === "memo-chat") {
        memoChatCondition = await this.callWorkspace((workspace) =>
          workspace.aiApprovalChatFenceCondition(
            request.accountId,
            approval.subject.id,
            approval.memoChatFence!
          ));
      }
    }
    return { approval, counter, pointerKey, subjectCondition, memoChatCondition };
  }

  private async createSession(user: UserRecord): Promise<AuthSession> {
    const session = createSessionMaterial(user);
    const expectedAuthGeneration = currentAuthGeneration(user);
    for (let attempt = 0; attempt < MAX_AUTH_TRANSITION_RETRIES; attempt += 1) {
      const aggregate = await this.getAdminSessionAggregate(user.id, true);
      let nextAggregate: AdminSessionAggregate;
      try {
        nextAggregate = upsertAdminSession(
          aggregate,
          user.id,
          session.record.tokenHash,
          adminSessionEntry(session.record)
        );
      } catch (error) {
        if (error instanceof AdminSessionCapacityError) {
          throw new StoreError(429, error.message, "active_session_limit_reached");
        }
        throw error;
      }
      try {
        await this.doc.send(new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.authTable,
                Key: { pk: tenantKey(this.tenantId), sk: userKey(user.email) },
                ConditionExpression:
                  `${authGenerationCondition(expectedAuthGeneration)} AND #record.#passwordHash = :passwordHash`,
                ExpressionAttributeNames: {
                  "#record": "record",
                  "#authGeneration": "authGeneration",
                  "#passwordHash": "passwordHash"
                },
                ExpressionAttributeValues: {
                  ":expectedAuthGeneration": expectedAuthGeneration,
                  ":passwordHash": user.passwordHash
                }
              }
            },
            {
              Put: {
                TableName: this.authTable,
                Item: this.authItem(sessionKey(session.record.tokenHash), session.record),
                ConditionExpression: "attribute_not_exists(#pk)",
                ExpressionAttributeNames: { "#pk": "pk" }
              }
            },
            this.adminSessionAggregatePut(nextAggregate, aggregate)
          ]
        }));
        return session.auth;
      } catch (error) {
        if (isAuthStateConflict(error)) {
          const currentUser = await this.findUserByEmail(user.email, true);
          if (
            !currentUser ||
            currentAuthGeneration(currentUser) !== expectedAuthGeneration ||
            currentUser.passwordHash !== user.passwordHash
          ) {
            throw error;
          }
          continue;
        }
        throw error;
      }
    }
    throw new StoreError(503, "Session state changed too many times. Try again.");
  }

  private async findUserByEmail(email: string, consistentRead = false) {
    return this.getAuthRecord<UserRecord>(userKey(email), consistentRead);
  }

  private async revokeUserSessions(userId: string) {
    const sessions = await this.queryAuthByPrefix("SESSION#");
    for (const session of sessions
      .map((item) => item.record as SessionRecord)
      .filter((candidate) => candidate.userId === userId)) {
      await this.deleteSessionRecord(session);
    }
  }

  private async getAdminUsageAggregate(userId: string, consistentRead: boolean) {
    const aggregate = await this.getAuthRecord<AdminUsageAggregate>(adminUsageKey(userId), consistentRead);
    assertAdminUsageAggregate(aggregate, userId);
    return aggregate;
  }

  private adminMetricsAccountCreationItem(
    marker: AdminAggregateMarker | undefined,
    createdAt: string
  ): TransactionItem {
    if (isCompleteAdminMetricsMarker(marker)) {
      return {
        Update: {
          TableName: this.authTable,
          Key: { pk: tenantKey(this.tenantId), sk: ADMIN_AGGREGATE_MARKER_KEY },
          UpdateExpression: [
            "SET #record.#usersTotal = #record.#usersTotal + :one",
            "#record.#version = if_not_exists(#record.#version, :zero) + :one",
            "#record.#lastUserChangeAt = :createdAt"
          ].join(", "),
          ConditionExpression: [
            "#record.#status = :complete",
            "#record.#metricsSchemaVersion = :metricsSchemaVersion",
            "attribute_exists(#record.#usersTotal)"
          ].join(" AND "),
          ExpressionAttributeNames: {
            "#record": "record",
            "#status": "status",
            "#metricsSchemaVersion": "metricsSchemaVersion",
            "#usersTotal": "usersTotal",
            "#version": "version",
            "#lastUserChangeAt": "lastUserChangeAt"
          },
          ExpressionAttributeValues: {
            ":complete": "complete",
            ":metricsSchemaVersion": ADMIN_METRICS_SCHEMA_VERSION,
            ":createdAt": createdAt,
            ":zero": 0,
            ":one": 1
          }
        }
      };
    }
    if (!marker) {
      return {
        ConditionCheck: {
          TableName: this.authTable,
          Key: { pk: tenantKey(this.tenantId), sk: ADMIN_AGGREGATE_MARKER_KEY },
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" }
        }
      };
    }
    return {
      ConditionCheck: {
        TableName: this.authTable,
        Key: { pk: tenantKey(this.tenantId), sk: ADMIN_AGGREGATE_MARKER_KEY },
        ConditionExpression: [
          "#record.#status = :expectedStatus",
          marker.metricsSchemaVersion === undefined
            ? "attribute_not_exists(#record.#metricsSchemaVersion)"
            : "#record.#metricsSchemaVersion = :expectedMetricsSchemaVersion"
        ].join(" AND "),
        ExpressionAttributeNames: {
          "#record": "record",
          "#status": "status",
          "#metricsSchemaVersion": "metricsSchemaVersion"
        },
        ExpressionAttributeValues: {
          ":expectedStatus": marker.status,
          ...(marker.metricsSchemaVersion === undefined
            ? {}
            : { ":expectedMetricsSchemaVersion": marker.metricsSchemaVersion })
        }
      }
    };
  }

  private async getAdminDailyUsageAggregate(day: string, consistentRead: boolean) {
    const aggregate = await this.getAuthRecord<AdminDailyUsageAggregate>(
      adminMetricsDayKey(day),
      consistentRead
    );
    assertAdminDailyUsageAggregate(aggregate, day);
    return aggregate;
  }

  private adminDailyUsageAggregatePut(
    aggregate: AdminDailyUsageAggregate,
    expected: AdminDailyUsageAggregate | undefined
  ): TransactionItem {
    return {
      Put: {
        TableName: this.authTable,
        Item: this.authItem(adminMetricsDayKey(aggregate.day), aggregate),
        ConditionExpression: expected
          ? "#record.#version = :expectedVersion"
          : "attribute_not_exists(#pk)",
        ExpressionAttributeNames: expected
          ? { "#record": "record", "#version": "version" }
          : { "#pk": "pk" },
        ExpressionAttributeValues: expected
          ? { ":expectedVersion": expected.version }
          : undefined
      }
    };
  }

  private adminUsageAggregatePut(
    aggregate: AdminUsageAggregate,
    expected: AdminUsageAggregate | undefined
  ): TransactionItem {
    return {
      Put: {
        TableName: this.authTable,
        Item: this.authItem(adminUsageKey(aggregate.userId), aggregate),
        ConditionExpression: expected
          ? "#record.#version = :expectedVersion"
          : "attribute_not_exists(#pk)",
        ExpressionAttributeNames: expected
          ? { "#record": "record", "#version": "version" }
          : { "#pk": "pk" },
        ExpressionAttributeValues: expected
          ? { ":expectedVersion": expected.version }
          : undefined
      }
    };
  }

  private async getAdminSessionAggregate(userId: string, consistentRead: boolean) {
    const aggregate = await this.getAuthRecord<AdminSessionAggregate>(adminSessionsKey(userId), consistentRead);
    assertAdminSessionAggregate(aggregate, userId);
    return aggregate;
  }

  private adminSessionAggregatePut(
    aggregate: AdminSessionAggregate,
    expected: AdminSessionAggregate | undefined
  ): TransactionItem {
    return {
      Put: {
        TableName: this.authTable,
        Item: this.authItem(adminSessionsKey(aggregate.userId), aggregate),
        ConditionExpression: expected
          ? "#record.#version = :expectedVersion"
          : "attribute_not_exists(#pk)",
        ExpressionAttributeNames: expected
          ? { "#record": "record", "#version": "version" }
          : { "#pk": "pk" },
        ExpressionAttributeValues: expected
          ? { ":expectedVersion": expected.version }
          : undefined
      }
    };
  }

  private async ensureAdminUserAggregates(userId: string) {
    for (let attempt = 0; attempt < MAX_AUTH_TRANSITION_RETRIES; attempt += 1) {
      const [usage, sessions] = await Promise.all([
        this.getAdminUsageAggregate(userId, true),
        this.getAdminSessionAggregate(userId, true)
      ]);
      if (usage && sessions) return;
      const transactItems: TransactionItem[] = [];
      if (!usage) transactItems.push(this.adminUsageAggregatePut(emptyAdminUsageAggregate(userId), undefined));
      if (!sessions) transactItems.push(this.adminSessionAggregatePut(emptyAdminSessionAggregate(userId), undefined));
      try {
        await this.doc.send(new TransactWriteCommand({ TransactItems: transactItems }));
        return;
      } catch (error) {
        if (isAuthStateConflict(error)) continue;
        throw error;
      }
    }
    throw new StoreError(503, "Admin aggregate initialization changed too many times.");
  }

  private async ensureSessionAggregated(session: SessionRecord) {
    let currentSession = session;
    for (let attempt = 0; attempt < MAX_AUTH_TRANSITION_RETRIES; attempt += 1) {
      const aggregate = await this.getAdminSessionAggregate(currentSession.userId, true);
      const existingEntry = aggregate?.sessions[currentSession.tokenHash];
      const entry = adminSessionEntry(currentSession);
      if (
        currentSession.adminAggregateVersion === ADMIN_AGGREGATE_SCHEMA_VERSION &&
        existingEntry &&
        sha256Canonical(existingEntry) === sha256Canonical(entry)
      ) {
        return;
      }
      let nextAggregate: AdminSessionAggregate;
      try {
        nextAggregate = upsertAdminSession(
          aggregate,
          currentSession.userId,
          currentSession.tokenHash,
          entry
        );
      } catch (error) {
        if (error instanceof AdminSessionCapacityError) {
          await this.deleteSessionRecord(currentSession);
          return;
        }
        throw error;
      }
      const updatedSession: SessionRecord = {
        ...currentSession,
        adminAggregateVersion: ADMIN_AGGREGATE_SCHEMA_VERSION
      };
      const expectedAuthGeneration = currentSessionGeneration(currentSession);
      const aggregateVersionCondition = currentSession.adminAggregateVersion === undefined
        ? "attribute_not_exists(#record.#aggregateVersion)"
        : "#record.#aggregateVersion = :expectedAggregateVersion";
      try {
        await this.doc.send(new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.authTable,
                Item: this.authItem(sessionKey(currentSession.tokenHash), updatedSession),
                ConditionExpression: [
                  "attribute_exists(#pk)",
                  "#record.#tokenHash = :tokenHash",
                  "#record.#lastSeenAt = :expectedLastSeenAt",
                  "#record.#expiresAt = :expectedExpiresAt",
                  authGenerationCondition(expectedAuthGeneration),
                  aggregateVersionCondition
                ].join(" AND "),
                ExpressionAttributeNames: {
                  "#pk": "pk",
                  "#record": "record",
                  "#tokenHash": "tokenHash",
                  "#lastSeenAt": "lastSeenAt",
                  "#expiresAt": "expiresAt",
                  "#authGeneration": "authGeneration",
                  "#aggregateVersion": "adminAggregateVersion"
                },
                ExpressionAttributeValues: {
                  ":tokenHash": currentSession.tokenHash,
                  ":expectedLastSeenAt": currentSession.lastSeenAt,
                  ":expectedExpiresAt": currentSession.expiresAt,
                  ":expectedAuthGeneration": expectedAuthGeneration,
                  ...(currentSession.adminAggregateVersion === undefined
                    ? {}
                    : { ":expectedAggregateVersion": currentSession.adminAggregateVersion })
                }
              }
            },
            this.adminSessionAggregatePut(nextAggregate, aggregate)
          ]
        }));
        return;
      } catch (error) {
        if (isAuthStateConflict(error)) {
          const refreshed = await this.getAuthRecord<SessionRecord>(
            sessionKey(currentSession.tokenHash),
            true
          );
          if (!refreshed) return;
          currentSession = refreshed;
          continue;
        }
        throw error;
      }
    }
    throw new StoreError(503, "Session aggregation changed too many times.");
  }

  private async deleteSessionRecord(session: SessionRecord) {
    for (let attempt = 0; attempt < MAX_AUTH_TRANSITION_RETRIES; attempt += 1) {
      const aggregate = await this.getAdminSessionAggregate(session.userId, true);
      if (!aggregate) {
        await this.deleteAuthItem(sessionKey(session.tokenHash));
        return;
      }
      const nextAggregate = removeAdminSession(aggregate, session.tokenHash);
      try {
        await this.doc.send(new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.authTable,
                Key: {
                  pk: tenantKey(this.tenantId),
                  sk: sessionKey(session.tokenHash)
                },
                ConditionExpression: "attribute_not_exists(#pk) OR #record.#tokenHash = :tokenHash",
                ExpressionAttributeNames: { "#pk": "pk", "#record": "record", "#tokenHash": "tokenHash" },
                ExpressionAttributeValues: { ":tokenHash": session.tokenHash }
              }
            },
            this.adminSessionAggregatePut(nextAggregate, aggregate)
          ]
        }));
        return;
      } catch (error) {
        if (isAuthStateConflict(error)) {
          if (!await this.getAuthRecord<SessionRecord>(sessionKey(session.tokenHash), true)) return;
          continue;
        }
        throw error;
      }
    }
    throw new StoreError(503, "Session revocation changed too many times.");
  }

  private async recordFailedLogin(user: UserRecord, expectedAuthGeneration: number) {
    const expectedFailedAttempts = user.failedAttempts ?? 0;
    const nextFailedAttempts = expectedFailedAttempts + 1;
    const locksNow = nextFailedAttempts >= MAX_FAILED_ATTEMPTS;
    await this.doc.send(new UpdateCommand({
      TableName: this.authTable,
      Key: { pk: tenantKey(this.tenantId), sk: userKey(user.email) },
      UpdateExpression: locksNow
        ? "SET #record.#failedAttempts = :nextFailedAttempts, #record.#lockedUntil = :lockedUntil"
        : "SET #record.#failedAttempts = :nextFailedAttempts",
      ConditionExpression: [
        authGenerationCondition(expectedAuthGeneration),
        "#record.#passwordHash = :passwordHash",
        failedAttemptsCondition(expectedFailedAttempts)
      ].join(" AND "),
      ExpressionAttributeNames: {
        "#record": "record",
        "#authGeneration": "authGeneration",
        "#passwordHash": "passwordHash",
        "#failedAttempts": "failedAttempts",
        "#lockedUntil": "lockedUntil"
      },
      ExpressionAttributeValues: {
        ":expectedAuthGeneration": expectedAuthGeneration,
        ":passwordHash": user.passwordHash,
        ":expectedFailedAttempts": expectedFailedAttempts,
        ":nextFailedAttempts": nextFailedAttempts,
        ...(locksNow
          ? { ":lockedUntil": new Date(Date.now() + LOCKOUT_MS).toISOString() }
          : {})
      }
    }));
  }

  private async clearFailedLoginState(user: UserRecord, expectedAuthGeneration: number) {
    const expectedFailedAttempts = user.failedAttempts ?? 0;
    await this.doc.send(new UpdateCommand({
      TableName: this.authTable,
      Key: { pk: tenantKey(this.tenantId), sk: userKey(user.email) },
      UpdateExpression: "SET #record.#failedAttempts = :zeroFailedAttempts REMOVE #record.#lockedUntil",
      ConditionExpression: [
        authGenerationCondition(expectedAuthGeneration),
        "#record.#passwordHash = :passwordHash",
        failedAttemptsCondition(expectedFailedAttempts)
      ].join(" AND "),
      ExpressionAttributeNames: {
        "#record": "record",
        "#authGeneration": "authGeneration",
        "#passwordHash": "passwordHash",
        "#failedAttempts": "failedAttempts",
        "#lockedUntil": "lockedUntil"
      },
      ExpressionAttributeValues: {
        ":expectedAuthGeneration": expectedAuthGeneration,
        ":passwordHash": user.passwordHash,
        ":expectedFailedAttempts": expectedFailedAttempts,
        ":zeroFailedAttempts": 0
      }
    }));
  }

  private async getAuthRecord<T>(key: string, consistentRead = false) {
    const response = await this.doc.send(new GetCommand({
      TableName: this.authTable,
      Key: { pk: tenantKey(this.tenantId), sk: key },
      ConsistentRead: consistentRead
    }));
    return response.Item?.record as T | undefined;
  }

  private async putAiAdmissionState(
    key: string,
    state: AiAdmissionStateRecord,
    expectedVersion: number | undefined
  ) {
    await this.doc.send(new PutCommand({
      TableName: this.authTable,
      Item: this.authItem(key, state),
      ConditionExpression: expectedVersion === undefined
        ? "attribute_not_exists(#pk)"
        : "#record.#version = :expectedVersion",
      ExpressionAttributeNames: expectedVersion === undefined
        ? { "#pk": "pk" }
        : { "#record": "record", "#version": "version" },
      ExpressionAttributeValues: expectedVersion === undefined
        ? undefined
        : { ":expectedVersion": expectedVersion }
    }));
  }

  private async putAuthItem(key: string, record: unknown) {
    await this.doc.send(new PutCommand({
      TableName: this.authTable,
      Item: this.authItem(key, record)
    }));
  }

  private authItem(key: string, record: unknown) {
    return {
      pk: tenantKey(this.tenantId),
      sk: key,
      record,
      expiresAtEpoch: isRecord(record) && typeof record.expiresAtEpoch === "number" ? record.expiresAtEpoch : undefined
    };
  }

  private async deleteAuthItem(key: string) {
    await this.doc.send(new DeleteCommand({
      TableName: this.authTable,
      Key: { pk: tenantKey(this.tenantId), sk: key }
    }));
  }

  private async queryAuthByPrefix(prefix: string) {
    const items: Record<string, any>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    let previousCursor: string | undefined;
    for (let page = 0; page < MAX_AUTH_QUERY_PAGES; page += 1) {
      const response = await this.doc.send(new QueryCommand({
        TableName: this.authTable,
        KeyConditionExpression: "#pk = :pk and begins_with(#sk, :prefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: { ":pk": tenantKey(this.tenantId), ":prefix": prefix },
        ExclusiveStartKey: exclusiveStartKey
      }));
      items.push(...(response.Items ?? []));
      if (items.length > MAX_AUTH_QUERY_ITEMS) {
        throw new StoreError(503, "Authentication data exceeds the safe query limit.");
      }
      if (!response.LastEvaluatedKey) return items;
      const cursor = JSON.stringify(response.LastEvaluatedKey);
      if (cursor === previousCursor) {
        throw new StoreError(503, "Authentication query pagination did not advance.");
      }
      previousCursor = cursor;
      exclusiveStartKey = response.LastEvaluatedKey;
    }
    throw new StoreError(503, "Authentication data exceeds the safe page limit.");
  }

  private async queryAuthRange(startSk: string, endSk: string) {
    const items: Record<string, any>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    let previousCursor: string | undefined;
    for (let page = 0; page < MAX_AUTH_QUERY_PAGES; page += 1) {
      const response = await this.doc.send(new QueryCommand({
        TableName: this.authTable,
        KeyConditionExpression: "#pk = :pk and #sk BETWEEN :startSk AND :endSk",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": tenantKey(this.tenantId),
          ":startSk": startSk,
          ":endSk": endSk
        },
        ExclusiveStartKey: exclusiveStartKey
      }));
      items.push(...(response.Items ?? []));
      if (items.length > MAX_AUTH_QUERY_ITEMS) {
        throw new StoreError(503, "Usage data exceeds the safe query limit.");
      }
      if (!response.LastEvaluatedKey) return items;
      const cursor = JSON.stringify(response.LastEvaluatedKey);
      if (cursor === previousCursor) {
        throw new StoreError(503, "Usage query pagination did not advance.");
      }
      previousCursor = cursor;
      exclusiveStartKey = response.LastEvaluatedKey;
    }
    throw new StoreError(503, "Usage data exceeds the safe page limit.");
  }

  private async readAccountState(
    userId: string,
    consistentRead: boolean
  ): Promise<AccountStateSnapshot> {
    const response = await this.doc.send(new GetCommand({
      TableName: this.accountTable,
      Key: { pk: accountKey(this.tenantId, userId) },
      ConsistentRead: consistentRead
    }));
    const rawState = response.Item?.state as Partial<AccountReviewState> | undefined;
    return {
      exists: Boolean(response.Item),
      hasVersion: Boolean(rawState && Object.prototype.hasOwnProperty.call(rawState, "version")),
      rawVersion: rawState?.version,
      state: normalizeAccountState(rawState)
    };
  }

  private async mutateAccountState<T>(
    userId: string,
    mutation: (state: AccountReviewState) => T
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_ACCOUNT_STATE_RETRIES; attempt += 1) {
      const snapshot = await this.readAccountState(userId, true);
      const current = cloneAccountState(snapshot.state);
      const result = mutation(current);
      current.version = (snapshot.state.version ?? 0) + 1;
      try {
        await this.putAccountState(userId, current, snapshot);
        return cloneMutationResult(result);
      } catch (error) {
        if (isAuthStateConflict(error)) continue;
        throw error;
      }
    }
    throw new StoreError(503, "Account state changed too many times. Try again.");
  }

  private async putAccountState(
    userId: string,
    state: AccountReviewState,
    expected?: AccountStateSnapshot
  ) {
    const condition = accountStateCondition(expected);
    await this.doc.send(new PutCommand({
      TableName: this.accountTable,
      Item: {
        pk: accountKey(this.tenantId, userId),
        tenantId: this.tenantId,
        userId,
        state: normalizeAccountState(state),
        updatedAt: new Date().toISOString()
      },
      ...condition
    }));
  }

  private requireLegacyAggregateAccess() {
    if (this.workspaceMode !== "legacy") {
      throw new StoreError(
        410,
        "Whole-account workspace state is unavailable after normalized-storage cutover. Use the scoped APIs.",
        "legacy_workspace_api_removed"
      );
    }
  }

  private async shouldUseNormalizedRead(userId: string) {
    if (this.workspaceMode === "legacy") return false;
    if (this.workspaceMode === "normalized") return true;
    const workspace = this.workspace;
    if (!workspace) {
      throw new StoreError(500, "Normalized workspace configuration is incomplete.", "workspace_config_invalid");
    }
    const meta = await workspace.repository.getMeta(userId, true);
    return meta?.migrationStatus === "complete";
  }

  private async callWorkspace<T>(
    operation: (workspace: NormalizedWorkspaceAccountAdapter) => T | Promise<T>
  ): Promise<T> {
    const workspace = this.workspace;
    if (!workspace) {
      throw new StoreError(500, "Normalized workspace configuration is incomplete.", "workspace_config_invalid");
    }
    try {
      return await operation(workspace);
    } catch (error) {
      if (isWorkspaceAdapterError(error)) {
        throw new StoreError(error.status, error.message, error.code);
      }
      throw error;
    }
  }
}

interface LegacyWorkspaceMetadata {
  preferenceVersion: number;
  builderVersions: Record<string, number>;
}

function legacyWorkspaceMetadata(state: AccountReviewState): LegacyWorkspaceMetadata {
  const raw = (state.preferences ?? {}) as AccountReviewState["preferences"] & {
    __rulixWorkspacePreferenceVersion?: unknown;
    __rulixBuilderSessionVersions?: unknown;
  };
  const preferenceVersion = Number.isSafeInteger(raw.__rulixWorkspacePreferenceVersion)
    && Number(raw.__rulixWorkspacePreferenceVersion) >= 0
    ? Number(raw.__rulixWorkspacePreferenceVersion)
    : 0;
  const builderVersions = isRecord(raw.__rulixBuilderSessionVersions)
    ? Object.fromEntries(Object.entries(raw.__rulixBuilderSessionVersions).filter(
        ([key, value]) => key.length > 0 && Number.isSafeInteger(value) && Number(value) > 0
      ).map(([key, value]) => [key, Number(value)]))
    : {};
  return { preferenceVersion, builderVersions };
}

function writeLegacyWorkspaceMetadata(state: AccountReviewState, metadata: LegacyWorkspaceMetadata) {
  state.preferences = {
    ...(state.preferences ?? {}),
    __rulixWorkspacePreferenceVersion: metadata.preferenceVersion,
    __rulixBuilderSessionVersions: metadata.builderVersions
  } as unknown as AccountReviewState["preferences"];
}

interface AccountStateSnapshot {
  exists: boolean;
  hasVersion: boolean;
  rawVersion: unknown;
  state: AccountReviewState;
}

export class StoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
}

export function createAccountStore(options?: CreateStoreOptions): AccountStore {
  if (process.env.RULIX_AUTH_TABLE?.trim() && process.env.RULIX_ACCOUNT_TABLE?.trim()) {
    const authTable = process.env.RULIX_AUTH_TABLE.trim();
    const accountTable = process.env.RULIX_ACCOUNT_TABLE.trim();
    let workspaceMode: WorkspaceMode;
    try {
      workspaceMode = parseWorkspaceMode(process.env.RULIX_WORKSPACE_MODE);
    } catch (error) {
      if (isWorkspaceAdapterError(error)) throw new StoreError(error.status, error.message, error.code);
      throw error;
    }
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true }
    });
    let cursors: WorkspaceCursorCodec;
    try {
      cursors = deploymentCursorCodec();
    } catch (error) {
      if (error instanceof StoreError) throw error;
      if (error instanceof SyntaxError || error instanceof WorkspaceValidationError) {
        throw new StoreError(500, "The deployment cursor key ring is invalid.", "workspace_config_invalid");
      }
      throw error;
    }
    if (workspaceMode === "legacy") {
      return new DynamoAccountStore(authTable, accountTable, { client, workspaceMode, adminCursors: cursors });
    }

    try {
      const workspaceTable = requiredWorkspaceEnvironment("RULIX_WORKSPACE_TABLE");
      const contentBucket = requiredWorkspaceEnvironment("RULIX_WORKSPACE_CONTENT_BUCKET");
      const kmsKeyArn = requiredWorkspaceEnvironment("RULIX_WORKSPACE_KMS_KEY_ARN");
      const repository = new NormalizedWorkspaceRepository(
        workspaceTable,
        process.env.RULIX_TENANT_ID?.trim() || DEFAULT_TENANT_ID,
        client,
        cursors
      );
      const workspace = new NormalizedWorkspaceAccountAdapter(
        repository,
        new S3WorkspaceContentStore(contentBucket, kmsKeyArn),
        normalizedWorkspaceTransitions()
      );
      return new DynamoAccountStore(authTable, accountTable, {
        client,
        workspaceMode,
        workspace,
        adminCursors: cursors,
        newAccountWorkspacePut: (userId) => workspace.newAccountWorkspacePut(userId)
      });
    } catch (error) {
      if (error instanceof StoreError) throw error;
      if (isWorkspaceAdapterError(error)) {
        throw new StoreError(error.status, error.message, "workspace_config_invalid");
      }
      if (error instanceof SyntaxError) {
        throw new StoreError(500, "Workspace cursor key ring is not valid JSON.", "workspace_config_invalid");
      }
      throw error;
    }
  }
  return new LocalAccountStore(options);
}

function requiredWorkspaceEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new StoreError(500, `${name} is required in normalized workspace mode.`, "workspace_config_invalid");
  return value;
}

function deploymentCursorCodec() {
  const activeKeyId = requiredWorkspaceEnvironment("RULIX_WORKSPACE_CURSOR_ACTIVE_KID");
  const rawKeys = JSON.parse(requiredWorkspaceEnvironment("RULIX_WORKSPACE_CURSOR_KEYS_JSON")) as unknown;
  if (!isRecord(rawKeys) || Object.values(rawKeys).some((key) => typeof key !== "string")) {
    throw new StoreError(500, "Cursor key ring must be a JSON object of string keys.", "workspace_config_invalid");
  }
  return new WorkspaceCursorCodec({
    activeKeyId,
    keys: rawKeys as Record<string, string>
  });
}

function normalizedWorkspaceTransitions(): WorkspaceStateTransitions {
  return {
    create: applyCreateReviewCommand,
    updateMemo: applyUpdateReviewMemoCommand,
    archive: applyArchiveReviewCommand,
    appendChat: applyAppendBoundChatCommand,
    applySuggestion: applyChatSuggestionCommand,
    analysis: applyAnalysisTransition,
    decision: applyDecisionTransition
  };
}

export function emptyAccountState(): AccountReviewState {
  return {
    schemaVersion: 2,
    version: 0,
    memos: [],
    decisions: {},
    auditEvents: [],
    analysisResults: {},
    chatMessages: {},
    memoRevisions: {},
    comments: {},
    notifications: [],
    memoBuilder: { messages: [] },
    outreachDrafts: {},
    discoveredLeads: [],
    leadSearchRuns: [],
    leadWorkflows: {},
    outreachJobs: []
  };
}

export function publicUser(user: UserRecord): UserProfile {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt
  };
}

export function sessionTtlMs() {
  return hoursToMs(readPositiveNumberEnv("AUTH_SESSION_TTL_HOURS", DEFAULT_SESSION_TTL_HOURS));
}

function inviteTtlMs() {
  return hoursToMs(readPositiveNumberEnv("AUTH_INVITE_TTL_HOURS", DEFAULT_INVITE_TTL_HOURS));
}

function resetTtlMs() {
  return readPositiveNumberEnv("AUTH_RESET_TTL_MINUTES", DEFAULT_RESET_TTL_MINUTES) * 60 * 1000;
}

function createUserRecord(email: string, name: string, role: UserProfile["role"], password: string): UserRecord {
  const salt = randomBytes(16).toString("base64url");
  return {
    id: `user-${randomBytes(12).toString("base64url")}`,
    email,
    name: normalizeName(name, email),
    role,
    createdAt: new Date().toISOString(),
    passwordHash: hashPassword(password, salt, PASSWORD_ITERATIONS),
    passwordSalt: salt,
    passwordIterations: PASSWORD_ITERATIONS,
    failedAttempts: 0,
    passwordResetGeneration: 0,
    authGeneration: 0
  };
}

function createSessionMaterial(user: UserRecord) {
  const rawToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + sessionTtlMs()).toISOString();
  const record: SessionRecord = {
    tokenHash: hashToken(rawToken),
    userId: user.id,
    userEmail: user.email,
    csrfToken,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    expiresAtEpoch: toEpochSeconds(expiresAt),
    authGeneration: currentAuthGeneration(user),
    adminAggregateVersion: ADMIN_AGGREGATE_SCHEMA_VERSION
  };
  return {
    record,
    auth: { rawToken, csrfToken, user: publicUser(user) } satisfies AuthSession
  };
}

export interface DecisionTransitionResult {
  review: MemoRecord;
  decision: ReviewerDecision;
  auditEvents: AuditEvent[];
}

export interface DecisionExpectedBindings {
  expectedVersion: number;
  expectedRevision: number;
  expectedHash: string;
  expectedAnalysisId: string;
  expectedAnalysisHash: string;
}

export interface DecisionCurrentBindings {
  version: number;
  revision: number;
  hash: string;
  analysisId?: string;
  analysisHash?: string;
}

export class DecisionBindingError extends ReviewPolicyError {
  constructor(
    code: Extract<ReviewPolicyCode, "stale_revision" | "analysis_binding_mismatch">,
    message: string,
    readonly current: DecisionCurrentBindings
  ) {
    super({ code, message, status: 409 });
    this.name = "DecisionBindingError";
  }
}

export interface AnalysisTransitionResult {
  review: MemoRecord;
  result: ReviewResult;
  decisionInvalidated: boolean;
  auditEvents: AuditEvent[];
}

export interface AnalysisTransitionAuditEvents {
  completion: AuditEvent;
  decisionInvalidation?: AuditEvent;
}

function setUserPassword(user: UserRecord, password: string) {
  const salt = randomBytes(16).toString("base64url");
  user.passwordHash = hashPassword(password, salt, PASSWORD_ITERATIONS);
  user.passwordSalt = salt;
  user.passwordIterations = PASSWORD_ITERATIONS;
}

function recordFailedAttempt(user: UserRecord) {
  user.failedAttempts += 1;
  if (user.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    user.lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
  }
}

function clearFailedAttempts(user: UserRecord) {
  user.failedAttempts = 0;
  user.lockedUntil = undefined;
}

function currentAuthGeneration(user: UserRecord) {
  return user.authGeneration ?? 0;
}

function currentSessionGeneration(session: SessionRecord) {
  return session.authGeneration ?? 0;
}

function sessionTouchDue(lastSeenAt: string, nowMs = Date.now()) {
  const lastSeenMs = Date.parse(lastSeenAt);
  return !Number.isFinite(lastSeenMs)
    || lastSeenMs > nowMs
    || nowMs - lastSeenMs >= SESSION_TOUCH_INTERVAL_MS;
}

function sameSessionAuthState(left: SessionRecord, right: SessionRecord) {
  return left.tokenHash === right.tokenHash
    && left.userId === right.userId
    && left.userEmail === right.userEmail
    && left.expiresAt === right.expiresAt
    && currentSessionGeneration(left) === currentSessionGeneration(right);
}

function authGenerationCondition(expectedAuthGeneration: number) {
  return expectedAuthGeneration === 0
    ? "(attribute_not_exists(#record.#authGeneration) OR #record.#authGeneration = :expectedAuthGeneration)"
    : "#record.#authGeneration = :expectedAuthGeneration";
}

function failedAttemptsCondition(expectedFailedAttempts: number) {
  return expectedFailedAttempts === 0
    ? "(attribute_not_exists(#record.#failedAttempts) OR #record.#failedAttempts = :expectedFailedAttempts)"
    : "#record.#failedAttempts = :expectedFailedAttempts";
}

function isAuthStateConflict(error: unknown) {
  return error instanceof Error
    && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");
}

function accountStateCondition(
  expected: AccountStateSnapshot | undefined
): Partial<Pick<PutCommandInput, "ConditionExpression" | "ExpressionAttributeNames" | "ExpressionAttributeValues">> {
  if (!expected) return {};
  if (!expected.exists) {
    return {
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeNames: { "#pk": "pk" }
    };
  }
  if (!expected.hasVersion) {
    return {
      ConditionExpression: "attribute_exists(#pk) AND attribute_not_exists(#state.#version)",
      ExpressionAttributeNames: { "#pk": "pk", "#state": "state", "#version": "version" }
    };
  }
  return {
    ConditionExpression: "#state.#version = :expectedVersion",
    ExpressionAttributeNames: { "#state": "state", "#version": "version" },
    ExpressionAttributeValues: { ":expectedVersion": expected.rawVersion }
  };
}

function reserveAiUsageTransition(
  existing: AiAdmissionStateRecord | undefined,
  request: AiUsageReservationRequest
): { result: AiUsageReservationResult; state?: AiAdmissionStateRecord } {
  validateAiAdmissionRequest(request);
  const state = normalizeAiAdmissionState(existing, request.nowMs);
  const duplicate = state.leases.find((lease) => lease.reservationId === request.reservationId);
  if (duplicate) {
    if (
      duplicate.expiresAtMs !== request.leaseExpiresAtMs
      || duplicate.reservedTokens !== request.estimatedTokens
      || Math.abs(duplicate.reservedCostUsd - request.estimatedCostUsd) > 1e-9
    ) {
      throw new StoreError(503, "AI workload reservation identity conflict.");
    }
    return {
      result: {
        ok: true,
        reservationId: duplicate.reservationId,
        leaseExpiresAtMs: duplicate.expiresAtMs,
        reservedTokens: duplicate.reservedTokens,
        reservedCostUsd: duplicate.reservedCostUsd
      }
    };
  }

  const limits = request.limits;
  if (request.estimatedTokens > limits.maxTokensPerCall) {
    return { result: { ok: false, reason: "call_tokens" } };
  }
  if (request.estimatedCostUsd > limits.maxCostUsdPerCall + 1e-9) {
    return { result: { ok: false, reason: "call_cost" } };
  }
  if (state.leases.length >= limits.maxConcurrentLeases) {
    const firstExpiry = Math.min(...state.leases.map((lease) => lease.expiresAtMs));
    return {
      result: {
        ok: false,
        reason: "concurrency",
        retryAfterMs: Math.max(1, firstExpiry - request.nowMs)
      }
    };
  }
  if (state.requestTimestamps.length >= limits.requestsPerMinute) {
    const oldest = Math.min(...state.requestTimestamps);
    return {
      result: {
        ok: false,
        reason: "request_rate",
        retryAfterMs: Math.max(1, oldest + 60_000 - request.nowMs)
      }
    };
  }
  if (state.tokensUsed + request.estimatedTokens > limits.tokensPerDay) {
    return {
      result: {
        ok: false,
        reason: "daily_tokens",
        retryAfterMs: millisecondsUntilNextUtcDay(request.nowMs)
      }
    };
  }
  if (state.spendUsd + request.estimatedCostUsd > limits.spendUsdPerDay + 1e-9) {
    return {
      result: {
        ok: false,
        reason: "daily_spend",
        retryAfterMs: millisecondsUntilNextUtcDay(request.nowMs)
      }
    };
  }

  const lease: AiAdmissionLeaseRecord = {
    reservationId: request.reservationId,
    expiresAtMs: request.leaseExpiresAtMs,
    reservedTokens: request.estimatedTokens,
    reservedCostUsd: request.estimatedCostUsd
  };
  return {
    state: {
      ...state,
      version: state.version + 1,
      tokensUsed: state.tokensUsed + request.estimatedTokens,
      spendUsd: state.spendUsd + request.estimatedCostUsd,
      requestTimestamps: [...state.requestTimestamps, request.nowMs],
      leases: [...state.leases, lease]
    },
    result: {
      ok: true,
      reservationId: lease.reservationId,
      leaseExpiresAtMs: lease.expiresAtMs,
      reservedTokens: lease.reservedTokens,
      reservedCostUsd: lease.reservedCostUsd
    }
  };
}

function settleAiUsageTransition(
  existing: AiAdmissionStateRecord | undefined,
  request: AiUsageSettlementRequest
): { result: AiUsageSettlementResult; state?: AiAdmissionStateRecord } {
  if (!request.accountId.trim() || !request.reservationId.trim() || !Number.isFinite(request.nowMs)) {
    throw new StoreError(503, "AI workload settlement is invalid.");
  }
  if (request.disposition === "retain") return { result: "retained" };
  const state = normalizeAiAdmissionState(existing, request.nowMs);
  const lease = state.leases.find((entry) => entry.reservationId === request.reservationId);
  if (!lease) return { result: "missing" };

  const actualTokens = request.disposition === "settle"
    ? finiteNonNegative(request.actualTokens, lease.reservedTokens)
    : 0;
  const actualCostUsd = request.disposition === "settle"
    ? finiteNonNegative(request.actualCostUsd, lease.reservedCostUsd)
    : 0;
  return {
    state: {
      ...state,
      version: state.version + 1,
      tokensUsed: Math.max(0, state.tokensUsed - lease.reservedTokens + actualTokens),
      spendUsd: Math.max(0, state.spendUsd - lease.reservedCostUsd + actualCostUsd),
      leases: state.leases.filter((entry) => entry.reservationId !== request.reservationId)
    },
    result: request.disposition === "settle" ? "settled" : "released"
  };
}

function normalizeAiAdmissionState(existing: AiAdmissionStateRecord | undefined, nowMs: number) {
  const currentDay = utcDay(nowMs);
  const source = existing ?? {
    version: 0,
    budgetDay: currentDay,
    tokensUsed: 0,
    spendUsd: 0,
    requestTimestamps: [],
    leases: []
  };
  const leases = Array.isArray(source.leases)
    ? source.leases.filter((lease) =>
        typeof lease?.reservationId === "string"
        && lease.reservationId.length > 0
        && Number.isFinite(lease.expiresAtMs)
        && lease.expiresAtMs > nowMs
        && Number.isFinite(lease.reservedTokens)
        && lease.reservedTokens >= 0
        && Number.isFinite(lease.reservedCostUsd)
        && lease.reservedCostUsd >= 0
      ).map((lease) => ({ ...lease }))
    : [];
  const requestTimestamps = Array.isArray(source.requestTimestamps)
    ? source.requestTimestamps.filter((timestamp) =>
        Number.isFinite(timestamp) && timestamp > nowMs - 60_000
      )
    : [];
  const activeReservedTokens = leases.reduce((total, lease) => total + lease.reservedTokens, 0);
  const activeReservedSpend = leases.reduce((total, lease) => total + lease.reservedCostUsd, 0);
  const sameDay = source.budgetDay === currentDay;
  return {
    version: Number.isSafeInteger(source.version) && source.version >= 0 ? source.version : 0,
    budgetDay: currentDay,
    tokensUsed: sameDay
      ? Math.max(finiteNonNegative(source.tokensUsed, 0), activeReservedTokens)
      : activeReservedTokens,
    spendUsd: sameDay
      ? Math.max(finiteNonNegative(source.spendUsd, 0), activeReservedSpend)
      : activeReservedSpend,
    requestTimestamps,
    leases
  } satisfies AiAdmissionStateRecord;
}

function validateAiAdmissionRequest(request: AiUsageReservationRequest) {
  const limits = request.limits;
  const positiveLimits = [
    limits.maxConcurrentLeases,
    limits.requestsPerMinute,
    limits.tokensPerDay,
    limits.spendUsdPerDay,
    limits.maxTokensPerCall,
    limits.maxCostUsdPerCall
  ];
  if (
    !request.accountId.trim()
    || !request.reservationId.trim()
    || !Number.isFinite(request.nowMs)
    || !Number.isFinite(request.leaseExpiresAtMs)
    || request.leaseExpiresAtMs <= request.nowMs
    || !Number.isSafeInteger(request.estimatedTokens)
    || request.estimatedTokens < 0
    || !Number.isFinite(request.estimatedCostUsd)
    || request.estimatedCostUsd < 0
    || positiveLimits.some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    throw new StoreError(503, "AI workload reservation is invalid.");
  }
}

function finiteNonNegative(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function utcDay(nowMs: number) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function millisecondsUntilNextUtcDay(nowMs: number) {
  const now = new Date(nowMs);
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, next - nowMs);
}

function validateInvite(invite: InviteRecord | undefined) {
  if (!invite) throw new StoreError(404, "Invite link is invalid or expired.");
  if (invite.status === "used") throw new StoreError(410, "Invite link has already been used.");
  if (invite.status === "expired" || isExpired(invite.expiresAt)) {
    invite.status = "expired";
    throw new StoreError(410, "Invite link is invalid or expired.");
  }
  return invite;
}

function validateReset(reset: ResetRecord | undefined) {
  if (!reset) throw new StoreError(404, "Password reset link is invalid or expired.");
  if (reset.status === "used") throw new StoreError(410, "Password reset link has already been used.");
  if (reset.status === "expired" || isExpired(reset.expiresAt)) {
    if (reset) reset.status = "expired";
    throw new StoreError(410, "Password reset link is invalid or expired.");
  }
  return reset;
}

function validateResetGeneration(reset: ResetRecord, user: UserRecord | undefined) {
  if (!user || (reset.generation ?? 0) !== (user.passwordResetGeneration ?? 0)) {
    throw new StoreError(410, "Password reset link is invalid or expired.");
  }
}

function summarizeInvite(invite: InviteRecord): InviteSummary {
  return {
    id: invite.id,
    email: invite.email,
    name: invite.name,
    role: invite.role,
    status: invite.status === "pending" && isExpired(invite.expiresAt) ? "expired" : invite.status,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    invitedBy: invite.invitedBy,
    usedAt: invite.usedAt
  };
}

function publicInviteInfo(invite: InviteRecord): InvitePublicInfo {
  return {
    email: invite.email,
    name: invite.name,
    role: invite.role,
    expiresAt: invite.expiresAt,
    status: invite.status
  };
}

function normalizeAccountState(state: Partial<AccountReviewState> | undefined): AccountReviewState {
  const memos = Array.isArray(state?.memos) ? state.memos.filter(isMemoRecord) : [];
  const memoIds = new Set(memos.map((memo) => memo.id));
  const selectedMemoId = state?.selectedMemoId && memoIds.has(state.selectedMemoId)
    ? state.selectedMemoId
    : memos[0]?.id;

  return {
    schemaVersion: 2,
    version: typeof state?.version === "number" && Number.isInteger(state.version) && state.version >= 0
      ? state.version
      : 0,
    organization: isRecord(state?.organization) ? state.organization as AccountReviewState["organization"] : undefined,
    policy: isRecord(state?.policy) ? state.policy as AccountReviewState["policy"] : undefined,
    preferences: isRecord(state?.preferences) ? state.preferences as AccountReviewState["preferences"] : undefined,
    memos,
    selectedMemoId,
    decisions: isRecord(state?.decisions) ? state.decisions as Record<string, ReviewerDecision> : {},
    auditEvents: Array.isArray(state?.auditEvents) ? state.auditEvents.filter(isAuditEvent) : [],
    analysisResults: isRecord(state?.analysisResults)
      ? state.analysisResults as Record<string, ReviewResult>
      : {},
    chatMessages: normalizeChatMessages(state?.chatMessages),
    reviewCreateReceipts: Array.isArray(state?.reviewCreateReceipts)
      ? state.reviewCreateReceipts
          .filter((receipt) => isRecord(receipt)
            && typeof receipt.requestId === "string"
            && typeof receipt.inputHash === "string"
            && typeof receipt.memoId === "string"
            && typeof receipt.createdAt === "string")
          .slice(0, 128)
      : [],
    memoBuilder: normalizeMemoBuilder(state?.memoBuilder),
    memoRevisions: normalizeMemoRevisions(state?.memoRevisions, memoIds),
    comments: isRecord(state?.comments) ? state.comments as NonNullable<AccountReviewState["comments"]> : {},
    notifications: Array.isArray(state?.notifications) ? state.notifications : [],
    outreachDrafts: isRecord(state?.outreachDrafts) ? state.outreachDrafts : {},
    discoveredLeads: Array.isArray(state?.discoveredLeads) ? state.discoveredLeads : [],
    leadSearchRuns: Array.isArray(state?.leadSearchRuns) ? state.leadSearchRuns : [],
    leadWorkflows: isRecord(state?.leadWorkflows) ? state.leadWorkflows : {},
    outreachJobs: Array.isArray(state?.outreachJobs) ? state.outreachJobs : []
  };
}

function normalizeMemoBuilder(value: AccountReviewState["memoBuilder"] | undefined): AccountReviewState["memoBuilder"] {
  if (!value || !isRecord(value)) return { messages: [] };
  const messages = Array.isArray(value.messages)
    ? value.messages.filter(isMemoBuildMessage).map((message) => ({ ...message }))
    : [];
  const sessions = Array.isArray(value.sessions)
    ? value.sessions.filter(isMemoBuilderSession).map((session) => cloneAccountState(session))
    : [];
  const activeSessionId = typeof value.activeSessionId === "string" && sessions.some((session) => session.id === value.activeSessionId)
    ? value.activeSessionId
    : sessions[0]?.id;
  return {
    activeSessionId,
    sessions,
    messages,
    draft: isRecord(value.draft) ? cloneAccountState(value.draft) : undefined
  } as AccountReviewState["memoBuilder"];
}

function isMemoBuildMessage(value: unknown): value is { role: "user" | "assistant"; content: string } {
  return isRecord(value) &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.content === "string";
}

function isMemoBuilderSession(value: unknown): value is NonNullable<NonNullable<AccountReviewState["memoBuilder"]>["sessions"]>[number] {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.messages) &&
    value.messages.every(isMemoBuildMessage);
}

function mergeAccountState(existing: AccountReviewState, incoming: AccountReviewState): AccountReviewState {
  const merged: AccountReviewState = {
    ...incoming,
    auditEvents: mergeById(incoming.auditEvents, existing.auditEvents),
    chatMessages: mergeChatMessages(existing.chatMessages, incoming.chatMessages),
    outreachDrafts: { ...(existing.outreachDrafts ?? {}), ...(incoming.outreachDrafts ?? {}) },
    discoveredLeads: mergeByKey(
      incoming.discoveredLeads ?? [],
      existing.discoveredLeads ?? [],
      (lead) => lead.leadId
    ),
    leadSearchRuns: mergeById(incoming.leadSearchRuns ?? [], existing.leadSearchRuns ?? []),
    leadWorkflows: { ...(existing.leadWorkflows ?? {}), ...(incoming.leadWorkflows ?? {}) },
    outreachJobs: mergeById(incoming.outreachJobs ?? [], existing.outreachJobs ?? [])
  };
  if ((incoming.version ?? 0) >= (existing.version ?? 0)) return merged;

  // A long-running outreach operation may submit an account snapshot after a
  // review command has already advanced the state version. Preserve the
  // server-owned review graph from the newer snapshot while still merging the
  // explicitly additive outreach fields above.
  return {
    ...merged,
    organization: existing.organization,
    policy: existing.policy,
    preferences: existing.preferences,
    memos: existing.memos,
    selectedMemoId: existing.selectedMemoId,
    decisions: existing.decisions,
    analysisResults: existing.analysisResults,
    memoRevisions: existing.memoRevisions,
    comments: existing.comments,
    notifications: existing.notifications,
    memoBuilder: existing.memoBuilder
  };
}

function replaceStateContents(target: AccountReviewState, replacement: AccountReviewState) {
  for (const key of Object.keys(target) as Array<keyof AccountReviewState>) {
    delete target[key];
  }
  Object.assign(target, replacement);
}

function mergeById<T extends { id: string }>(preferred: T[], preserved: T[]) {
  return mergeByKey(preferred, preserved, (item) => item.id);
}

function dedupeUsageEvents(events: UsageEvent[]) {
  const byId = new Map<string, UsageEvent>();
  for (const event of events) {
    const existing = byId.get(event.id);
    if (!existing) {
      byId.set(event.id, event);
      continue;
    }
    if (usageEventHash(existing) !== usageEventHash(event)) {
      throw new StoreError(
        503,
        "Conflicting legacy usage telemetry must be reconciled before admin reporting.",
        "admin_aggregate_integrity_failed"
      );
    }
  }
  return Array.from(byId.values());
}

function mergeByKey<T>(preferred: T[], preserved: T[], keyOf: (item: T) => string) {
  const seen = new Set<string>();
  const merged: T[] = [];
  [...preferred, ...preserved].forEach((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });
  return merged;
}

function reviewSummary(memo: MemoRecord): ReviewSummary {
  const { memoText: _memoText, attachments: _attachments, ...summary } = memo;
  return summary;
}

function paginate<T>(items: T[], query: PageQuery): CursorPage<T> {
  const limit = Math.min(50, Math.max(1, Math.floor(query.limit)));
  const offset = decodeCursor(query.cursor);
  if (offset > items.length) {
    throw new StoreError(400, "Pagination cursor is invalid.", "invalid_cursor");
  }
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    items: cloneAccountState(page),
    ...(nextOffset < items.length ? { nextCursor: encodeCursor(nextOffset) } : {})
  };
}

function paginateOutreachCollection<T>(
  values: T[],
  query: PageQuery,
  userId: string,
  collection: "leads" | "drafts" | "runs" | "workflows" | "jobs",
  cursors: WorkspaceCursorCodec
): CursorPage<T> {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 50) {
    throw new StoreError(400, "Outreach page limit must be from 1 through 50.", "invalid_outreach_page");
  }
  const pk = `OUTREACH#${sha256Canonical({ userId })}`;
  const prefix = `COLLECTION#${collection}`;
  const queryHash = sha256Canonical({ schemaVersion: 1, collection, limit: query.limit });
  let offset = 0;
  if (query.cursor) {
    try {
      const key = cursors.decode(query.cursor, { pk, prefix, queryHash }).lastEvaluatedKey;
      const match = typeof key.sk === "string" ? /^ITEM#([A-Za-z0-9_-]+)$/.exec(key.sk) : undefined;
      if (!match) throw new Error("invalid");
      const lastIdentity = Buffer.from(match[1], "base64url").toString("utf8");
      const lastIndex = values.findIndex((value) => outreachCollectionIdentity(value, collection) === lastIdentity);
      if (lastIndex < 0) throw new Error("invalid");
      offset = lastIndex + 1;
    } catch {
      throw new StoreError(400, "Outreach pagination cursor is invalid or does not match this collection.", "invalid_outreach_cursor");
    }
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > values.length) {
    throw new StoreError(400, "Outreach pagination cursor is invalid.", "invalid_outreach_cursor");
  }
  const items = values.slice(offset, offset + query.limit).map((item) => cloneAccountState(item));
  const nextOffset = offset + items.length;
  const lastIdentity = items.length > 0
    ? outreachCollectionIdentity(items[items.length - 1], collection)
    : undefined;
  return {
    items,
    ...(nextOffset < values.length && lastIdentity
      ? {
          nextCursor: cursors.encode({
            pk,
            prefix,
            queryHash,
            lastEvaluatedKey: { pk, sk: `ITEM#${Buffer.from(lastIdentity, "utf8").toString("base64url")}` }
          })
        }
      : {})
  };
}

function outreachCollectionIdentity(
  value: unknown,
  collection: "leads" | "drafts" | "runs" | "workflows" | "jobs"
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StoreError(500, `Stored outreach ${collection} item is invalid.`, "outreach_item_invalid");
  }
  const record = value as Record<string, unknown>;
  const identity = collection === "leads" || collection === "drafts" || collection === "workflows"
    ? record.leadId
    : record.id;
  if (typeof identity !== "string" || !identity || Buffer.byteLength(identity, "utf8") > 256) {
    throw new StoreError(500, `Stored outreach ${collection} identity is invalid.`, "outreach_item_invalid");
  }
  return identity;
}

function mergeBundledOutreachLeads(discovered: OutreachLead[]) {
  const seenIds = new Set<string>();
  const seenEmails = new Set<string>();
  const seenOrganizations = new Set<string>();
  return [...bundledOutreachLeads, ...discovered].filter((lead) => {
    const id = lead.leadId.trim().toLowerCase();
    const email = lead.email.trim().toLowerCase();
    const organization = lead.organization.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!id || seenIds.has(id) || (email && seenEmails.has(email)) ||
        (organization && seenOrganizations.has(organization))) return false;
    seenIds.add(id);
    if (email) seenEmails.add(email);
    if (organization) seenOrganizations.add(organization);
    return true;
  });
}

async function paginateNormalizedOutreachLeads(
  userId: string,
  query: PageQuery,
  cursors: WorkspaceCursorCodec,
  readStoredPage: (query: PageQuery) => Promise<CursorPage<OutreachLead>>
): Promise<CursorPage<OutreachLead>> {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 50) {
    throw new StoreError(400, "Outreach page limit must be from 1 through 50.", "invalid_outreach_page");
  }
  const pk = `OUTREACH#${sha256Canonical({ userId })}`;
  const prefix = "COLLECTION#leads";
  const queryHash = sha256Canonical({ schemaVersion: 1, collection: "leads", limit: query.limit });
  let phase: "catalog" | "stored" = "catalog";
  let catalogOffset = 0;
  let storedCursor: string | undefined;
  if (query.cursor) {
    try {
      const key = cursors.decode(query.cursor, { pk, prefix, queryHash }).lastEvaluatedKey;
      const sk = typeof key.sk === "string" ? key.sk : "";
      const catalog = /^CATALOG#([0-9]+)$/.exec(sk);
      if (catalog) {
        catalogOffset = Number(catalog[1]);
      } else if (sk === "STORED") {
        phase = "stored";
      } else if (sk.startsWith("STORED#")) {
        phase = "stored";
        storedCursor = sk.slice("STORED#".length);
        if (!storedCursor) throw new Error("invalid");
      } else {
        throw new Error("invalid");
      }
    } catch {
      throw new StoreError(400, "Outreach pagination cursor is invalid or does not match this collection.", "invalid_outreach_cursor");
    }
  }
  if (!Number.isSafeInteger(catalogOffset) || catalogOffset < 0 || catalogOffset > bundledOutreachLeads.length) {
    throw new StoreError(400, "Outreach pagination cursor is invalid.", "invalid_outreach_cursor");
  }
  if (phase === "catalog") {
    const items = bundledOutreachLeads
      .slice(catalogOffset, catalogOffset + query.limit)
      .map((lead) => cloneAccountState(lead));
    const nextOffset = catalogOffset + items.length;
    let nextSk: string | undefined;
    if (nextOffset < bundledOutreachLeads.length) {
      nextSk = `CATALOG#${nextOffset}`;
    } else {
      const firstStored = await readStoredPage({ limit: 1 });
      if (firstStored.items.length > 0) nextSk = "STORED";
    }
    return {
      items,
      ...(nextSk
        ? {
            nextCursor: cursors.encode({
              pk,
              prefix,
              queryHash,
              lastEvaluatedKey: { pk, sk: nextSk }
            })
          }
        : {})
    };
  }
  const storedPage = await readStoredPage({
    limit: query.limit,
    ...(storedCursor ? { cursor: storedCursor } : {})
  });
  const bundledEmails = new Set(bundledOutreachLeads
    .map((lead) => lead.email.trim().toLowerCase()).filter(Boolean));
  const bundledOrganizations = new Set(bundledOutreachLeads
    .map((lead) => lead.organization.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean));
  const items = storedPage.items.filter((lead) => {
    const email = lead.email.trim().toLowerCase();
    const organization = lead.organization.toLowerCase().replace(/[^a-z0-9]/g, "");
    return (!email || !bundledEmails.has(email)) && (!organization || !bundledOrganizations.has(organization));
  });
  return {
    items,
    ...(storedPage.nextCursor
      ? {
          nextCursor: cursors.encode({
            pk,
            prefix,
            queryHash,
            lastEvaluatedKey: { pk, sk: `STORED#${storedPage.nextCursor}` }
          })
        }
      : {})
  };
}

function paginateAiApprovalRequests(
  values: AiApprovalRequestListItem[],
  query: AiApprovalRequestPageQuery,
  scope: string
): CursorPage<AiApprovalRequestListItem> {
  const limit = validateAiApprovalRequestPageQuery(query);
  const items = values
    .filter((item) => !query.status || item.status === query.status)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  const pk = `LOCAL#${DEFAULT_TENANT_ID}`;
  const prefix = `AI_APPROVAL_REQUEST#${scope}`;
  const queryHash = sha256Canonical({ schemaVersion: 1, limit, status: query.status ?? null });
  let offset = 0;
  if (query.cursor) {
    try {
      const key = EPHEMERAL_ADMIN_CURSOR_CODEC.decode(query.cursor, { pk, prefix, queryHash }).lastEvaluatedKey;
      if (!Number.isSafeInteger(key.offset) || (key.offset as number) < 0) throw new Error("invalid");
      offset = key.offset as number;
    } catch {
      throw new StoreError(400, "Pagination cursor is invalid.", "invalid_cursor");
    }
  }
  if (offset > items.length) throw new StoreError(400, "Pagination cursor is invalid.", "invalid_cursor");
  const pageItems = items.slice(offset, offset + limit).map((item) => structuredClone(item));
  const nextOffset = offset + pageItems.length;
  return {
    items: pageItems,
    ...(nextOffset < items.length
      ? {
          nextCursor: EPHEMERAL_ADMIN_CURSOR_CODEC.encode({
            pk,
            prefix,
            queryHash,
            lastEvaluatedKey: { offset: nextOffset }
          })
        }
      : {})
  };
}

function validateAiApprovalRequestPageQuery(query: AiApprovalRequestPageQuery) {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > MAX_AI_APPROVAL_REQUEST_PAGE_SIZE ||
      (query.status !== undefined && query.status !== "pending" && query.status !== "approved" &&
       query.status !== "rejected" && query.status !== "cancelled" && query.status !== "expired")) {
    throw new StoreError(400, "AI approval request page query is invalid.", "ai_approval_binding_invalid");
  }
  return query.limit;
}

function encodeCursor(offset: number) {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    if (!Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0) throw new Error("invalid");
    return parsed.offset as number;
  } catch {
    throw new StoreError(400, "Pagination cursor is invalid.", "invalid_cursor");
  }
}

function compareByDateThenId(leftDate: string, leftId: string, rightDate: string, rightId: string) {
  return leftDate.localeCompare(rightDate) || leftId.localeCompare(rightId);
}

function mergeChatMessages(
  existing: AccountReviewState["chatMessages"],
  incoming: AccountReviewState["chatMessages"]
) {
  const memoIds = new Set([...Object.keys(existing), ...Object.keys(incoming)]);
  return Object.fromEntries(
    Array.from(memoIds).map((memoId) => [
      memoId,
      mergeById(incoming[memoId] ?? [], existing[memoId] ?? [])
    ])
  );
}

function ensureMemoIntegrity(memo: MemoRecord): MemoRecord {
  const secured = cloneAccountState(memo);
  secured.revision = Number.isSafeInteger(secured.revision) && (secured.revision ?? 0) > 0
    ? secured.revision
    : 1;
  secured.version = Number.isSafeInteger(secured.version) && (secured.version ?? 0) > 0
    ? secured.version
    : secured.revision;
  secured.createdAt ??= new Date().toISOString();
  secured.lifecycleStage ??= secured.status === "signed-off" ? "approved" : "draft";
  secured.priority ??= "normal";
  secured.contentHash = hashMemoContent(secured);
  return secured;
}

function ensureAnalysisIntegrity(result: ReviewResult, memo: MemoRecord, userId: string): ReviewResult {
  const bound: ReviewResult = {
    ...cloneAccountState(result),
    id: result.id ?? `analysis-${randomBytes(12).toString("base64url")}`,
    memoRevision: memo.revision ?? 1,
    inputHash: memo.contentHash ?? hashMemoContent(memo),
    createdBy: result.createdBy ?? userId,
    promptVersion: result.promptVersion ?? "rulix-council-v2"
  };
  bound.resultHash = hashReviewResult(bound);
  return bound;
}

function applyAnalysisTransition(
  state: AccountReviewState,
  userId: string,
  expectedMemo: MemoRecord,
  proposedResult: ReviewResult,
  proposedAuditEvents?: AnalysisTransitionAuditEvents
): AnalysisTransitionResult {
  const currentMemo = state.memos.find((item) => item.id === expectedMemo.id);
  if (!currentMemo) throw new StoreError(404, "Review not found");
  const expected = ensureMemoIntegrity(expectedMemo);
  const currentRevision = currentMemo.revision ?? 1;
  const currentVersion = currentMemo.version ?? currentRevision;
  const currentHash = currentMemo.contentHash ?? hashMemoContent(currentMemo);
  if (
    (expected.revision ?? 1) !== currentRevision
    || (expected.version ?? expected.revision ?? 1) !== currentVersion
    || (expected.contentHash ?? hashMemoContent(expected)) !== currentHash
    || proposedResult.memoId !== currentMemo.id
    || (proposedResult.memoRevision !== undefined && proposedResult.memoRevision !== currentRevision)
    || (proposedResult.inputHash !== undefined && proposedResult.inputHash !== currentHash)
  ) {
    throw new StoreError(
      409,
      "The review changed while analysis was running. The stale result was discarded; run analysis again.",
      "stale_revision"
    );
  }

  const result = ensureAnalysisIntegrity(proposedResult, currentMemo, userId);
  const previousResult = state.analysisResults[currentMemo.id];
  const analysisUnchanged = Boolean(
    previousResult
    && previousResult.id === result.id
    && (previousResult.resultHash ?? hashReviewResult(previousResult)) === result.resultHash
  );
  const existingDecision = state.decisions[currentMemo.id];
  const decisionBindingUnchanged = Boolean(
    existingDecision
    && analysisUnchanged
    && existingDecision.memoRevision === currentRevision
    && existingDecision.memoHash === currentHash
    && existingDecision.analysisId === result.id
    && existingDecision.analysisHash === result.resultHash
  );
  const decisionInvalidated = Boolean(existingDecision && !decisionBindingUnchanged);
  if (decisionInvalidated) {
    delete state.decisions[currentMemo.id];
    const auditEvent = proposedAuditEvents?.decisionInvalidation ?? {
      id: `audit-decision-invalidated-${result.id ?? result.resultHash?.slice(0, 16)}`,
      memoId: currentMemo.id,
      at: new Date().toISOString(),
      actor: userId,
      action: "Reviewer decision invalidated",
      detail: "A new analysis run requires a fresh reviewer decision.",
      severity: "review" as const
    };
    state.auditEvents = mergeById([
      {
        ...cloneAccountState(auditEvent),
        memoId: currentMemo.id,
        metadata: {
          ...auditEvent.metadata,
          invalidatedDecisionId: existingDecision?.id,
          previousAnalysisId: existingDecision?.analysisId,
          replacementAnalysisId: result.id
        }
      }
    ], state.auditEvents);
  }

  const completionAuditEvent = proposedAuditEvents?.completion ?? {
    id: `audit-analysis-completed-${result.id ?? result.resultHash?.slice(0, 16)}`,
    memoId: currentMemo.id,
    at: new Date().toISOString(),
    actor: userId,
    action: "Analysis completed",
    detail: result.provider.message,
    severity: result.provider.live ? "info" as const : "review" as const
  };
  state.auditEvents = mergeById([
    {
      ...cloneAccountState(completionAuditEvent),
      memoId: currentMemo.id,
      metadata: {
        ...completionAuditEvent.metadata,
        analysisId: result.id,
        memoRevision: currentRevision
      }
    }
  ], state.auditEvents);

  const effectiveDecision = decisionBindingUnchanged ? existingDecision : undefined;
  const status = deriveReviewStatus(result, effectiveDecision);
  const review = ensureMemoIntegrity({
    ...currentMemo,
    status,
    lifecycleStage: effectiveDecision
      ? currentMemo.lifecycleStage
      : analysisLifecycleStage(status)
  });
  state.memos = state.memos.map((item) => (item.id === currentMemo.id ? review : item));
  state.analysisResults[currentMemo.id] = result;
  return {
    review,
    result,
    decisionInvalidated,
    auditEvents: state.auditEvents.filter((event) => event.memoId === currentMemo.id)
  };
}

function analysisLifecycleStage(status: MemoRecord["status"]): NonNullable<MemoRecord["lifecycleStage"]> {
  if (status === "ready") return "ready-for-decision";
  if (status === "needs-info") return "needs-information";
  if (status === "conflict") return "in-review";
  return "in-review";
}

function applyCreateReviewCommand(
  state: AccountReviewState,
  userId: string,
  command: CreateReviewCommand
): CreateReviewResult {
  const receipts = state.reviewCreateReceipts ?? [];
  const existingReceipt = receipts.find((receipt) => receipt.requestId === command.requestId);
  if (existingReceipt) {
    if (existingReceipt.inputHash !== command.inputHash) {
      throw new StoreError(
        409,
        "This review request ID was already used for different content.",
        "idempotency_conflict"
      );
    }
    const existingReview = state.memos.find((memo) => memo.id === existingReceipt.memoId);
    if (!existingReview) {
      throw new StoreError(409, "The original idempotent review record is unavailable.", "idempotency_record_missing");
    }
    return {
      review: existingReview,
      auditEvents: auditEventsFor(state, existingReview.id),
      replayed: true
    };
  }

  if (state.memos.some((memo) => memo.id === command.memo.id)) {
    throw new StoreError(409, "Review ID collision. Retry the request.", "review_id_conflict");
  }
  const review = ensureMemoIntegrity(command.memo);
  state.memos = [review, ...state.memos];
  const revisions = state.memoRevisions ??= {};
  revisions[review.id] = [memoRevisionFromRecord(review, review.createdBy ?? userId, "created")];
  state.auditEvents = mergeById([
    { ...cloneAccountState(command.auditEvent), memoId: review.id }
  ], state.auditEvents);
  state.reviewCreateReceipts = [
    {
      requestId: command.requestId,
      inputHash: command.inputHash,
      memoId: review.id,
      createdAt: new Date().toISOString()
    },
    ...receipts
  ].slice(0, 128);
  return { review, auditEvents: auditEventsFor(state, review.id), replayed: false };
}

function applyUpdateReviewMemoCommand(
  state: AccountReviewState,
  userId: string,
  memoId: string,
  command: UpdateReviewMemoCommand
): ReviewCommandResult {
  const current = requireExpectedReview(state, memoId, command);
  const memoText = command.memoText.trim();
  if (!memoText) throw new StoreError(400, "Memo text is required.", "memo_text_required");
  const review = ensureMemoIntegrity({
    ...current,
    memoText,
    revision: (current.revision ?? 1) + 1,
    version: (current.version ?? current.revision ?? 1) + 1,
    updatedAt: new Date().toISOString().slice(0, 10),
    status: "draft",
    lifecycleStage: "draft"
  });
  applyReviewUpdate(state, review, userId, "edited");
  state.auditEvents = mergeById([
    { ...cloneAccountState(command.auditEvent), memoId }
  ], state.auditEvents);
  return { review, auditEvents: auditEventsFor(state, memoId) };
}

function applyArchiveReviewCommand(
  state: AccountReviewState,
  memoId: string,
  command: ArchiveReviewCommand
): ReviewCommandResult {
  const current = requireExpectedReview(state, memoId, command);
  const now = new Date().toISOString();
  const review: MemoRecord = {
    ...current,
    version: (current.version ?? current.revision ?? 1) + 1,
    updatedAt: now.slice(0, 10),
    ...(command.archived
      ? { archivedAt: now, archivedBy: command.actor }
      : { archivedAt: undefined, archivedBy: undefined })
  };
  state.memos = state.memos.map((memo) => memo.id === memoId ? review : memo);
  state.auditEvents = mergeById([
    { ...cloneAccountState(command.auditEvent), memoId }
  ], state.auditEvents);
  return { review, auditEvents: auditEventsFor(state, memoId) };
}

function applyAppendBoundChatCommand(
  state: AccountReviewState,
  memoId: string,
  command: AppendBoundChatCommand
): ChatCommandResult {
  const review = requireExpectedReview(state, memoId, command);
  const revision = review.revision ?? 1;
  const version = review.version ?? revision;
  const hash = review.contentHash ?? hashMemoContent(review);
  for (const message of command.messages) {
    if (message.memoId !== memoId) {
      throw new StoreError(400, "Chat message review binding is invalid.", "chat_binding_required");
    }
    if (message.proposedMemoText && (
      message.memoRevision !== revision
      || message.memoVersion !== version
      || message.memoHash !== hash
    )) {
      throw new StoreError(409, "Chat suggestion was generated for a stale review revision.", "stale_revision");
    }
  }
  state.chatMessages[memoId] = mergeById(
    [...(state.chatMessages[memoId] ?? []), ...command.messages],
    []
  );
  if (command.auditEvent) {
    state.auditEvents = mergeById([
      { ...cloneAccountState(command.auditEvent), memoId }
    ], state.auditEvents);
  }
  return {
    review,
    messages: state.chatMessages[memoId],
    auditEvents: auditEventsFor(state, memoId)
  };
}

function applyChatSuggestionCommand(
  state: AccountReviewState,
  userId: string,
  memoId: string,
  command: ApplyChatSuggestionCommand
): ChatCommandResult {
  const current = state.memos.find((memo) => memo.id === memoId);
  if (!current) throw new StoreError(404, "Review not found.");
  const revision = current.revision ?? 1;
  const version = current.version ?? revision;
  const hash = current.contentHash ?? hashMemoContent(current);
  if (version !== command.expectedVersion || hash !== command.expectedHash) {
    throw new StoreError(409, "The review changed before this suggestion could be applied.", "stale_revision");
  }
  const thread = state.chatMessages[memoId] ?? [];
  const suggestion = thread.find((message) => message.id === command.messageId);
  if (!suggestion?.proposedMemoText) {
    throw new StoreError(404, "Chat suggestion not found.", "chat_suggestion_not_found");
  }
  if (suggestion.applied) {
    throw new StoreError(409, "This chat suggestion was already applied.", "chat_suggestion_applied");
  }
  if (
    suggestion.memoRevision !== revision
    || suggestion.memoVersion !== version
    || suggestion.memoHash !== hash
  ) {
    throw new StoreError(409, "This chat suggestion targets an older review revision.", "stale_revision");
  }
  const review = ensureMemoIntegrity({
    ...current,
    memoText: suggestion.proposedMemoText,
    revision: revision + 1,
    version: version + 1,
    updatedAt: new Date().toISOString().slice(0, 10),
    status: "draft",
    lifecycleStage: "draft"
  });
  applyReviewUpdate(state, review, userId, "suggestion-applied");
  state.chatMessages[memoId] = thread.map((message) =>
    message.id === suggestion.id ? { ...message, applied: true } : message
  );
  state.auditEvents = mergeById([
    { ...cloneAccountState(command.auditEvent), memoId }
  ], state.auditEvents);
  return {
    review,
    messages: state.chatMessages[memoId],
    auditEvents: auditEventsFor(state, memoId)
  };
}

function requireExpectedReview(
  state: AccountReviewState,
  memoId: string,
  expected: ReviewExpectedBindings
) {
  const review = state.memos.find((memo) => memo.id === memoId);
  if (!review) throw new StoreError(404, "Review not found.");
  const revision = review.revision ?? 1;
  const version = review.version ?? revision;
  const hash = review.contentHash ?? hashMemoContent(review);
  if (
    version !== expected.expectedVersion
    || revision !== expected.expectedRevision
    || hash !== expected.expectedHash
  ) {
    throw new StoreError(409, "The review changed in another session. Reload and try again.", "stale_revision");
  }
  return review;
}

function auditEventsFor(state: AccountReviewState, memoId: string) {
  return state.auditEvents.filter((event) => event.memoId === memoId);
}

function applyReviewUpdate(
  state: AccountReviewState,
  memo: MemoRecord,
  userId: string,
  reason: MemoRevision["reason"] = "edited"
) {
  const previous = state.memos.find((item) => item.id === memo.id);
  if (!previous) throw new StoreError(404, "Review not found");
  const securedMemo = ensureMemoIntegrity(memo);
  const expectedRevision = (previous.revision ?? 1) + 1;
  const expectedVersion = (previous.version ?? previous.revision ?? 1) + 1;
  if (securedMemo.revision !== expectedRevision || securedMemo.version !== expectedVersion) {
    throw new StoreError(
      409,
      "The review changed before this edit could be saved. Reload and try again.",
      "stale_revision"
    );
  }
  state.memos = state.memos.map((item) => (item.id === memo.id ? securedMemo : item));
  if (reviewContentChanged(previous, securedMemo)) {
    delete state.analysisResults[memo.id];
    delete state.decisions[memo.id];
    const revisions = state.memoRevisions ??= {};
    revisions[memo.id] = mergeById(
      [memoRevisionFromRecord(securedMemo, securedMemo.createdBy ?? userId, reason)],
      revisions[memo.id] ?? []
    );
  }
}

function applyDecisionTransition(
  state: AccountReviewState,
  userId: string,
  memoId: string,
  proposedDecision: ReviewerDecision,
  proposedAuditEvent: AuditEvent,
  expected: DecisionExpectedBindings
): DecisionTransitionResult {
  const memo = state.memos.find((item) => item.id === memoId);
  if (!memo) throw new StoreError(404, "Review not found");
  const result = state.analysisResults[memoId];
  const memoRevision = memo.revision ?? 1;
  const memoVersion = memo.version ?? memoRevision;
  const memoHash = memo.contentHash ?? hashMemoContent(memo);
  const analysisHash = result?.resultHash ?? (result ? hashReviewResult(result) : undefined);
  const current: DecisionCurrentBindings = {
    version: memoVersion,
    revision: memoRevision,
    hash: memoHash,
    analysisId: result?.id,
    analysisHash
  };
  if (
    expected.expectedVersion !== memoVersion
    || expected.expectedRevision !== memoRevision
    || expected.expectedHash !== memoHash
  ) {
    throw new DecisionBindingError(
      "stale_revision",
      "The review changed before this decision could be recorded. Reload and review the current revision.",
      current
    );
  }
  if (
    !result
    || expected.expectedAnalysisId !== result.id
    || expected.expectedAnalysisHash !== analysisHash
  ) {
    throw new DecisionBindingError(
      "analysis_binding_mismatch",
      "The analysis changed before this decision could be recorded. Reload and review the current analysis.",
      current
    );
  }
  const revision = decisionRevisionBinding(memo, state);
  const analysis = result ? decisionAnalysisBinding(memo, result, state) : undefined;

  assertDecisionAllowed(
    {
      action: proposedDecision.action,
      notes: proposedDecision.notes,
      analysisRunId: result?.id
    },
    revision,
    analysis
  );

  const decision: ReviewerDecision = {
    ...cloneAccountState(proposedDecision),
    id: proposedDecision.id ?? `decision-${randomBytes(12).toString("base64url")}`,
    memoRevision,
    memoHash,
    analysisId: result?.id,
    analysisHash,
    corpusId: result?.corpusId,
    corpusChecksum: result?.corpusChecksum
  };
  const statusResult = result ?? analyzeMemo(memo);
  const updatedMemo = ensureMemoIntegrity({
    ...memo,
    status: deriveReviewStatus(statusResult, decision),
    lifecycleStage: decision.action === "accept"
      ? "approved"
      : decision.action === "request-info"
        ? "needs-information"
        : "changes-requested"
  });
  const auditEvent: AuditEvent = {
    ...cloneAccountState(proposedAuditEvent),
    memoId,
    metadata: {
      ...proposedAuditEvent.metadata,
      decisionId: decision.id,
      memoRevision: decision.memoRevision,
      analysisId: decision.analysisId
    }
  };

  state.decisions[memoId] = decision;
  state.memos = state.memos.map((item) => (item.id === memoId ? updatedMemo : item));
  state.auditEvents = mergeById([auditEvent], state.auditEvents);
  return {
    review: updatedMemo,
    decision,
    auditEvents: [cloneAccountState(auditEvent)]
  };
}

function decisionRevisionBinding(
  memo: MemoRecord,
  state: AccountReviewState
): RevisionBinding {
  const revisionNumber = memo.revision ?? 1;
  const contentHash = memo.contentHash ?? hashMemoContent(memo);
  const revision = state.memoRevisions?.[memo.id]?.find(
    (candidate) => candidate.revision === revisionNumber && candidate.contentHash === contentHash
  );
  return {
    id: revision?.id ?? `revision-${memo.id}-${revisionNumber}`,
    version: memo.version ?? revisionNumber,
    contentHash
  };
}

function decisionAnalysisBinding(
  memo: MemoRecord,
  result: ReviewResult,
  state: AccountReviewState
): AnalysisDecisionBinding {
  const revisionNumber = result.memoRevision ?? 0;
  const revision = state.memoRevisions?.[memo.id]?.find(
    (candidate) =>
      candidate.revision === revisionNumber && candidate.contentHash === result.inputHash
  );
  return {
    id: result.id ?? "",
    revisionId: revision?.id ?? `revision-${memo.id}-${revisionNumber}`,
    contentHash: result.inputHash ?? "",
    status: "completed",
    live: result.provider.live,
    findings: result.findings
  };
}

function reviewContentChanged(previous: MemoRecord, next: MemoRecord) {
  return (previous.contentHash ?? hashMemoContent(previous)) !== (next.contentHash ?? hashMemoContent(next));
}

function memoRevisionFromRecord(
  memo: MemoRecord,
  createdBy: string,
  reason: MemoRevision["reason"]
): MemoRevision {
  const revision = memo.revision ?? 1;
  return {
    id: `revision-${memo.id}-${revision}`,
    memoId: memo.id,
    revision,
    contentHash: memo.contentHash ?? hashMemoContent(memo),
    memoText: memo.memoText,
    title: memo.title,
    itemFamily: memo.itemFamily,
    manufacturer: memo.manufacturer,
    intendedUse: memo.intendedUse,
    dataClass: memo.dataClass ?? "proprietary",
    sourcePath: memo.sourcePath,
    createdAt: new Date().toISOString(),
    createdBy,
    reason
  };
}

function normalizeMemoRevisions(
  value: AccountReviewState["memoRevisions"] | undefined,
  memoIds: Set<string>
): NonNullable<AccountReviewState["memoRevisions"]> {
  if (!isRecord(value)) return {};
  const output: NonNullable<AccountReviewState["memoRevisions"]> = {};
  for (const [memoId, revisions] of Object.entries(value)) {
    if (!memoIds.has(memoId) || !Array.isArray(revisions)) continue;
    output[memoId] = revisions
      .filter(isMemoRevision)
      .sort((a, b) => b.revision - a.revision);
  }
  return output;
}

function isMemoRevision(value: unknown): value is MemoRevision {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.memoId === "string" &&
    typeof value.revision === "number" &&
    typeof value.contentHash === "string" &&
    typeof value.memoText === "string" &&
    typeof value.title === "string" &&
    typeof value.itemFamily === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.createdBy === "string";
}

function cloneAccountState<T>(state: T): T {
  return JSON.parse(JSON.stringify(state)) as T;
}

function cloneMutationResult<T>(result: T): T {
  return result === undefined ? result : cloneAccountState(result);
}

function normalizeChatMessages(value: unknown) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, messages]) => Array.isArray(messages))
      .map(([memoId, messages]) => [
        memoId,
        (messages as unknown[]).filter(isMemoChatMessage)
      ])
  );
}

function isMemoRecord(value: unknown): value is MemoRecord {
  return Boolean(
    value &&
      typeof value === "object" &&
      "id" in value &&
      typeof value.id === "string" &&
      "memoText" in value &&
      typeof value.memoText === "string"
  );
}

function isAuditEvent(value: unknown): value is AuditEvent {
  return Boolean(
    value &&
      typeof value === "object" &&
      "id" in value &&
      typeof value.id === "string" &&
      "memoId" in value &&
      typeof value.memoId === "string"
  );
}

function isMemoChatMessage(value: unknown): value is MemoChatMessage {
  return Boolean(
    value &&
      typeof value === "object" &&
      "id" in value &&
      typeof value.id === "string" &&
      "memoId" in value &&
      typeof value.memoId === "string" &&
      "text" in value &&
      typeof value.text === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeEmail(email: string) {
  if (typeof email !== "string") {
    throw new StoreError(400, "Enter a valid email address.");
  }
  const normalized = email.trim().toLowerCase();
  if (
    Buffer.byteLength(normalized, "utf8") > MAX_EMAIL_UTF8_BYTES
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new StoreError(400, "Enter a valid email address.");
  }
  return normalized;
}

function normalizeName(name: string, email: string) {
  if (typeof name !== "string") {
    throw new StoreError(400, "Enter a valid name.");
  }
  const normalized = name.trim() || email.split("@")[0] || "Reviewer";
  if (
    Buffer.byteLength(normalized, "utf8") > MAX_NAME_UTF8_BYTES
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new StoreError(400, "Enter a valid name.");
  }
  return normalized;
}

function validatePassword(password: string) {
  if (
    typeof password !== "string"
    || Buffer.byteLength(password, "utf8") > MAX_PASSWORD_UTF8_BYTES
  ) {
    throw new StoreError(
      400,
      "Use 12 to 1,024 UTF-8 bytes with a mix of letters, numbers, and symbols."
    );
  }
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  if (password.length < 12 || [hasUpper, hasLower, hasNumber, hasSymbol].filter(Boolean).length < 3) {
    throw new StoreError(
      400,
      "Use 12 to 1,024 UTF-8 bytes with a mix of letters, numbers, and symbols."
    );
  }
}

function validateAuthenticationPassword(password: string) {
  if (
    typeof password !== "string"
    || password.length === 0
    || Buffer.byteLength(password, "utf8") > MAX_PASSWORD_UTF8_BYTES
  ) {
    throw invalidCredentials();
  }
}

function invalidCredentials() {
  return new StoreError(401, "Invalid email or password.");
}

function hashPassword(password: string, salt: string, iterations: number) {
  return pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("base64url");
}

function verifyPassword(password: string, user: UserRecord) {
  const expected = Buffer.from(user.passwordHash, "base64url");
  const actual = Buffer.from(
    hashPassword(password, user.passwordSalt, user.passwordIterations),
    "base64url"
  );
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

function isExpired(value: string) {
  return Date.parse(value) <= Date.now();
}

function toEpochSeconds(value: string) {
  return Math.floor(Date.parse(value) / 1000);
}

function readPositiveNumberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  const value = raw ? Number(raw) : fallback;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function hoursToMs(hours: number) {
  return hours * 60 * 60 * 1000;
}

function appBaseUrl() {
  return (process.env.APP_BASE_URL || "http://127.0.0.1:5173").replace(/\/+$/, "");
}

function inviteLink(rawToken: string) {
  return `${appBaseUrl()}/#invite=${encodeURIComponent(rawToken)}`;
}

function resetLink(rawToken: string) {
  return `${appBaseUrl()}/#reset=${encodeURIComponent(rawToken)}`;
}

const AI_DISPATCH_AUDIT_TTL_DAYS = 90;
const AI_DISPATCH_RESERVATION_LEASE_MS = 2 * 60 * 1_000;
const DEFAULT_AI_APPROVAL_REQUEST_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_AI_APPROVAL_REQUEST_TTL_MS = 72 * 60 * 60 * 1_000;
const MAX_AI_APPROVAL_REQUEST_PAGE_SIZE = 50;
const MAX_DAILY_AI_APPROVAL_REQUESTS_PER_ACCOUNT = 25;
const MAX_DAILY_AI_APPROVAL_REQUESTS_PER_TENANT = 1_000;

function assertLocalAiApprovalRequestQuota(
  requests: Iterable<AiApprovalRequestRecord>,
  accountId: string,
  nowMs: number
) {
  const bucket = new Date(nowMs).toISOString().slice(0, 10);
  let accountCount = 0;
  let tenantCount = 0;
  for (const value of requests) {
    const request = storedAiApprovalRequest(value);
    if (request.createdAt.slice(0, 10) !== bucket) continue;
    tenantCount += 1;
    if (request.targetAccountId === accountId) accountCount += 1;
  }
  if (accountCount >= MAX_DAILY_AI_APPROVAL_REQUESTS_PER_ACCOUNT ||
      tenantCount >= MAX_DAILY_AI_APPROVAL_REQUESTS_PER_TENANT) {
    throw new StoreError(
      429,
      "The daily AI approval request capacity has been reached.",
      "ai_approval_request_capacity"
    );
  }
}

function prepareAiApprovalRequest(
  tenantId: string,
  requesterAccountId: string,
  command: CreateAiApprovalRequestCommand,
  nowMs: number
): AiApprovalRequestRecord {
  const targetAccountId = boundedAiIdentifier(requesterAccountId, "AI approval target account", 512);
  if (command.requestedBy?.id !== targetAccountId || !isUserRoleValue(command.requestedBy?.role)) {
    throw new StoreError(
      403,
      "AI approval requests may target only the authenticated requester's account.",
      "ai_approval_request_account_mismatch"
    );
  }
  const requestId = boundedAiIdentifier(command.requestId, "AI approval request idempotency key", 160);
  if (command.purpose !== "council" && command.purpose !== "memo-chat" && command.purpose !== "memo-builder") {
    throw new StoreError(400, "AI approval request purpose is invalid.", "ai_approval_binding_invalid");
  }
  const subject = approvalValue(() => assertAiApprovalSubject(command.subject));
  const context = approvalValue(() => assertAiApprovalRequestContext(command.context));
  const validPurpose = command.purpose === "council"
    ? subject.kind === "review" && context.kind === "council"
    : command.purpose === "memo-chat"
      ? subject.kind === "review" && context.kind === "memo-chat"
      : subject.kind === "memo-builder" && context.kind === "memo-builder";
  if (!validPurpose) {
    throw new StoreError(403, "AI approval request subject and purpose do not match.", "ai_approval_purpose_not_allowed");
  }
  const payloadHash = approvalValue(() => assertSha256(command.payloadHash, "AI approval request payload hash"));
  if (!Array.isArray(command.providerRequestHashes) || command.providerRequestHashes.length !== 1) {
    throw new StoreError(
      400,
      "AI approval requests must bind exactly one provider request body.",
      "ai_approval_provider_request_required"
    );
  }
  const providerRequestHashes = command.providerRequestHashes.map((hash) =>
    approvalValue(() => assertSha256(hash, "AI approval request provider hash")));
  if (!isDataClass(command.dataClass)) {
    throw new StoreError(400, "AI approval request data class is invalid.", "ai_approval_binding_invalid");
  }
  const policy = approvalValue(() => assertAiApprovalPolicy(command.policy));
  if (policy.mode !== "approved") {
    throw new StoreError(403, "Current deployment policy does not approve this AI workload.", "ai_policy_not_approved");
  }
  if (!Number.isFinite(nowMs)) {
    throw new StoreError(500, "AI approval request clock is invalid.", "ai_approval_state_invalid");
  }
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = command.expiresAt ?? new Date(nowMs + DEFAULT_AI_APPROVAL_REQUEST_TTL_MS).toISOString();
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || new Date(expiresAtMs).toISOString() !== expiresAt ||
      expiresAtMs <= nowMs || expiresAtMs - nowMs > MAX_AI_APPROVAL_REQUEST_TTL_MS) {
    throw new StoreError(
      400,
      "AI approval request expiry must be a canonical future time within 72 hours.",
      "ai_approval_request_expiry_invalid"
    );
  }
  const normalizedTenant = boundedAiIdentifier(tenantId, "AI approval request tenant", 160);
  const dedupeHash = hashAiApprovalPayload({
    tenantId: normalizedTenant,
    targetAccountId,
    purpose: command.purpose,
    subject,
    payloadHash,
    providerRequestHashes,
    dataClass: command.dataClass,
    policy,
    context
  });
  const commandHash = hashAiApprovalPayload({
    dedupeHash,
    requestId,
    requestedBy: command.requestedBy,
    requestedExpiresAt: command.expiresAt ?? null
  });
  return approvalValue(() => assertAiApprovalRequestRecord({
    schemaVersion: AI_APPROVAL_REQUEST_SCHEMA_VERSION,
    id: createAiApprovalRequestId(targetAccountId, requestId),
    requestId,
    commandHash,
    dedupeHash,
    tenantId: normalizedTenant,
    targetAccountId,
    requestedBy: command.requestedBy,
    purpose: command.purpose,
    subject,
    payloadHash,
    providerRequestHashes,
    dataClass: command.dataClass,
    policy,
    context,
    createdAt,
    expiresAt,
    validUntilEpoch: Math.floor(expiresAtMs / 1_000),
    expiresAtEpoch: Math.floor(nowMs / 1_000) + AI_DISPATCH_AUDIT_TTL_DAYS * 86_400
  }));
}

function prepareAiApprovalRequestPreview(
  request: AiApprovalRequestRecord,
  pendingContent: CreateAiApprovalRequestCommand["pendingContent"]
): AiApprovalRequestEncryptedPreview | undefined {
  if (request.purpose !== "memo-chat") {
    if (pendingContent !== undefined) {
      throw new StoreError(400, "Pending content is not allowed for this request.", "ai_approval_binding_invalid");
    }
    return undefined;
  }
  const text = pendingContent?.kind === "memo-chat" ? pendingContent.text : undefined;
  if (typeof text !== "string" || normalizeMemoChatMessage(text) !== text ||
      Buffer.byteLength(text, "utf8") > MEMO_CHAT_TEXT_MAX_BYTES) {
    throw new StoreError(
      400,
      "Memo-chat approval requires exact pending content of at most 8,000 Unicode characters and 32 KB.",
      "ai_approval_request_preview_required"
    );
  }
  if (request.context.kind !== "memo-chat" ||
      request.context.pendingMessageHash !== hashAiApprovalPayload(text)) {
    throw new StoreError(
      409,
      "Pending memo-chat content does not match its immutable request hash.",
      "ai_approval_binding_mismatch"
    );
  }
  const ring = aiApprovalPreviewKeyRing();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ring.keys.get(ring.activeKeyId) as Buffer, iv);
  cipher.setAAD(aiApprovalPreviewAad(request));
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return {
    schemaVersion: "rulix.ai-approval-request-preview/v1",
    requestId: request.id,
    targetAccountId: request.targetAccountId,
    bindingHash: hashAiApprovalPayload({
      requestId: request.id,
      commandHash: request.commandHash,
      pendingMessageHash: request.context.pendingMessageHash
    }),
    keyId: ring.activeKeyId,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    // The plaintext is short-lived; audit metadata is retained separately.
    expiresAtEpoch: request.validUntilEpoch
  };
}

function decryptAiApprovalRequestPreview(
  request: AiApprovalRequestRecord,
  value: unknown,
  nowMs = Date.now()
) {
  const preview = storedAiApprovalRequestPreview(value);
  const expectedBinding = request.context.kind === "memo-chat"
    ? hashAiApprovalPayload({
        requestId: request.id,
        commandHash: request.commandHash,
        pendingMessageHash: request.context.pendingMessageHash
      })
    : "";
  if (request.purpose !== "memo-chat" || request.context.kind !== "memo-chat" ||
      preview.requestId !== request.id || preview.targetAccountId !== request.targetAccountId ||
      preview.bindingHash !== expectedBinding || preview.expiresAtEpoch !== request.validUntilEpoch ||
      nowMs >= preview.expiresAtEpoch * 1_000) {
    throw new StoreError(409, "AI approval request preview is stale.", "ai_approval_request_preview_stale");
  }
  const ring = aiApprovalPreviewKeyRing();
  const key = ring.keys.get(preview.keyId);
  if (!key) {
    throw new StoreError(503, "AI approval preview key is unavailable.", "ai_approval_request_preview_unavailable");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(preview.iv, "base64url"));
    decipher.setAAD(aiApprovalPreviewAad(request));
    decipher.setAuthTag(Buffer.from(preview.authTag, "base64url"));
    const text = Buffer.concat([
      decipher.update(Buffer.from(preview.ciphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
    if (hashAiApprovalPayload(text) !== request.context.pendingMessageHash) {
      throw new Error("hash mismatch");
    }
    return text;
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError(503, "AI approval preview could not be authenticated.", "ai_approval_state_invalid");
  }
}

function storedAiApprovalRequestPreview(value: unknown): AiApprovalRequestEncryptedPreview {
  if (!isRecord(value) || value.schemaVersion !== "rulix.ai-approval-request-preview/v1" ||
      typeof value.requestId !== "string" || typeof value.targetAccountId !== "string" ||
      typeof value.bindingHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.bindingHash) ||
      typeof value.keyId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(value.keyId) ||
      typeof value.iv !== "string" || !/^[A-Za-z0-9_-]{16}$/u.test(value.iv) ||
      typeof value.authTag !== "string" || !/^[A-Za-z0-9_-]{22}$/u.test(value.authTag) ||
      typeof value.ciphertext !== "string" || value.ciphertext.length < 2 || value.ciphertext.length > 43_000 ||
      !/^[A-Za-z0-9_-]+$/u.test(value.ciphertext) || !Number.isSafeInteger(value.expiresAtEpoch)) {
    throw new StoreError(503, "Persisted AI approval preview is invalid.", "ai_approval_state_invalid");
  }
  return value as unknown as AiApprovalRequestEncryptedPreview;
}

function aiApprovalPreviewAad(request: AiApprovalRequestRecord) {
  return Buffer.from(`${request.id}\u0000${request.commandHash}`, "utf8");
}

function aiApprovalPreviewKeyRing() {
  const activeKeyId = process.env.RULIX_AI_APPROVAL_PREVIEW_ACTIVE_KEY_ID;
  const rawJson = process.env.RULIX_AI_APPROVAL_PREVIEW_KEYS_JSON;
  if (!activeKeyId || !/^[A-Za-z0-9._-]{1,64}$/u.test(activeKeyId) || !rawJson) {
    throw new StoreError(
      503,
      "Encrypted AI approval previews are not configured.",
      "ai_approval_request_preview_unconfigured"
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new StoreError(503, "AI approval preview key ring is invalid.", "ai_approval_request_preview_unconfigured");
  }
  if (!isRecord(parsed)) {
    throw new StoreError(503, "AI approval preview key ring is invalid.", "ai_approval_request_preview_unconfigured");
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(keyId) || typeof encoded !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(encoded)) {
      throw new StoreError(503, "AI approval preview key ring is invalid.", "ai_approval_request_preview_unconfigured");
    }
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== 32 || key.toString("base64url") !== encoded) {
      throw new StoreError(503, "AI approval preview key ring is invalid.", "ai_approval_request_preview_unconfigured");
    }
    keys.set(keyId, key);
  }
  if (!keys.has(activeKeyId)) {
    throw new StoreError(503, "AI approval preview active key is missing.", "ai_approval_request_preview_unconfigured");
  }
  return { activeKeyId, keys };
}

function prepareAiApprovalRequestDecision(
  request: AiApprovalRequestRecord,
  decision: "approved" | "cancelled" | "rejected",
  command: DecideAiApprovalRequestCommand | CancelAiApprovalRequestCommand,
  nowMs: number,
  approvalId?: string
): AiApprovalRequestDecision {
  const actor = "decidedBy" in command ? command.decidedBy : command.actor;
  const decisionRequestId = boundedAiIdentifier(command.requestId, "AI approval decision request ID", 160);
  if (!isUserRoleValue(actor?.role)) {
    throw new StoreError(403, "AI approval decision actor is invalid.", "ai_approval_role_required");
  }
  if ((decision === "approved" || decision === "rejected") && actor.role !== "export-control-officer") {
    throw new StoreError(403, "Only an export-control officer may decide approval requests.", "ai_approval_role_required");
  }
  if (decision === "cancelled" && actor.id !== request.requestedBy.id) {
    throw new StoreError(403, "Only the original requester may cancel this request.", "ai_approval_request_account_mismatch");
  }
  const reason = typeof command.reason === "string" ? command.reason.trim() : "";
  if (decision === "approved" ? reason.length > 0 : reason.length < 1 || reason.length > 500) {
    throw new StoreError(400, "AI approval decision reason is invalid.", "ai_approval_binding_invalid");
  }
  if (decision === "approved" ? !approvalId : approvalId !== undefined) {
    throw new StoreError(500, "AI approval decision state is invalid.", "ai_approval_state_invalid");
  }
  const commandHash = hashAiApprovalPayload({
    approvalRequestId: request.id,
    approvalRequestHash: request.commandHash,
    decisionRequestId,
    decision,
    actor,
    reason: reason || null,
    approvalId: approvalId ?? null
  });
  return approvalValue(() => assertAiApprovalRequestDecision({
    schemaVersion: AI_APPROVAL_REQUEST_DECISION_SCHEMA_VERSION,
    requestId: request.id,
    targetAccountId: request.targetAccountId,
    decisionRequestId,
    commandHash,
    decision,
    decidedBy: actor,
    decidedAt: new Date(nowMs).toISOString(),
    ...(reason ? { reason } : {}),
    ...(approvalId ? { approvalId } : {}),
    expiresAtEpoch: Math.max(
      request.expiresAtEpoch,
      Math.floor(nowMs / 1_000) + AI_DISPATCH_AUDIT_TTL_DAYS * 86_400
    )
  }));
}

function createAiApprovalRequestId(accountId: string, requestId: string) {
  const digest = createHash("sha256").update(`${accountId}\u0000${requestId}`, "utf8").digest("hex");
  return `air-${digest.slice(0, 40)}`;
}

function initialAiApprovalRequestPendingPointer(
  request: AiApprovalRequestRecord
): AiApprovalRequestPendingPointer {
  return {
    schemaVersion: "rulix.ai-approval-request-pending/v1",
    targetAccountId: request.targetAccountId,
    dedupeHash: request.dedupeHash,
    approvalRequestId: request.id,
    validUntilEpoch: request.validUntilEpoch,
    expiresAtEpoch: request.validUntilEpoch
  };
}

function storedAiApprovalRequestPendingPointer(value: unknown): AiApprovalRequestPendingPointer {
  if (!isRecord(value) || value.schemaVersion !== "rulix.ai-approval-request-pending/v1" ||
      typeof value.targetAccountId !== "string" || typeof value.dedupeHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.dedupeHash) || typeof value.approvalRequestId !== "string" ||
      !Number.isSafeInteger(value.validUntilEpoch) || !Number.isSafeInteger(value.expiresAtEpoch) ||
      value.expiresAtEpoch !== value.validUntilEpoch) {
    throw new StoreError(503, "Persisted pending approval pointer is invalid.", "ai_approval_state_invalid");
  }
  return value as unknown as AiApprovalRequestPendingPointer;
}

function queuedApprovalIdempotencyKey(approvalRequestId: string) {
  return boundedAiIdentifier(`queue-${approvalRequestId}`, "Queued AI approval idempotency key", 160);
}

function initialAiApprovalCounter(approval: AiApprovalRecord): AiApprovalDispatchCounter {
  return {
    accountId: approval.accountId,
    approvalId: approval.id,
    version: 1,
    dispatchLimit: approval.dispatchLimit,
    dispatchesReserved: 0,
    providerRequestHashesReserved: [],
    expiresAtEpoch: approval.expiresAtEpoch
  };
}

function initialAiApprovalPointer(approval: AiApprovalRecord): AiApprovalCurrentPointer {
  return {
    accountId: approval.accountId,
    identity: aiApprovalCurrentIdentity(approval.subject, approval.purpose),
    approvalId: approval.id,
    updatedAt: approval.approvedAt,
    expiresAtEpoch: approval.expiresAtEpoch
  };
}

function storedAiApprovalRequest(value: unknown): AiApprovalRequestRecord {
  if (value === undefined) {
    throw new StoreError(404, "AI approval request not found.", "ai_approval_request_not_found");
  }
  try {
    return assertAiApprovalRequestRecord(value);
  } catch (error) {
    if (error instanceof AiApprovalValidationError) {
      throw new StoreError(503, error.message, "ai_approval_state_invalid");
    }
    throw error;
  }
}

function storedAiApprovalRequestDecision(value: unknown): AiApprovalRequestDecision {
  try {
    return assertAiApprovalRequestDecision(value);
  } catch (error) {
    if (error instanceof AiApprovalValidationError) {
      throw new StoreError(503, error.message, "ai_approval_state_invalid");
    }
    throw error;
  }
}

function idempotentAiApprovalRequest(existingValue: unknown, proposed: AiApprovalRequestRecord) {
  const existing = storedAiApprovalRequest(existingValue);
  if (existing.commandHash !== proposed.commandHash) {
    throw new StoreError(
      409,
      "This AI approval request ID is already bound to different content.",
      "ai_approval_request_idempotency_conflict"
    );
  }
  return existing;
}

function idempotentAiApprovalRequestDecision(
  existingValue: unknown,
  proposed: AiApprovalRequestDecision
) {
  const existing = storedAiApprovalRequestDecision(existingValue);
  if (existing.commandHash !== proposed.commandHash) {
    throw new StoreError(409, "This AI approval request was already decided.", "ai_approval_request_decided");
  }
  return existing;
}

function approvalRequestStatusKind(
  request: AiApprovalRequestRecord,
  decision: AiApprovalRequestDecision | undefined,
  nowMs = Date.now()
): AiApprovalRequestStatusKind {
  return decision?.decision ?? (nowMs >= Date.parse(request.expiresAt) ? "expired" : "pending");
}

function currentAiApprovalChatWindow(messages: MemoChatMessage[]) {
  return [...messages]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    .slice(0, 200);
}

function sameAiApprovalMemoChatFence(
  left: AiApprovalMemoChatFence,
  right: AiApprovalMemoChatFence
) {
  return left.historyHash === right.historyHash &&
    left.chatMeta.exists === right.chatMeta.exists &&
    (!left.chatMeta.exists || !right.chatMeta.exists || (
      left.chatMeta.entityVersion === right.chatMeta.entityVersion &&
      left.chatMeta.nextSequence === right.chatMeta.nextSequence
    ));
}

function assertMemoChatAppendReceipt(
  receipt: AiDispatchReceipt,
  accountId: string,
  memoId: string,
  nowMs: number
) {
  if (receipt.accountId !== accountId || receipt.purpose !== "memo-chat" ||
      receipt.subject?.id !== memoId || !receipt.memoChatFence || receipt.memoChatCommittedAt ||
      receipt.memoChatAbandonedAt ||
      (receipt.status !== "succeeded" && receipt.status !== "failed")) {
    throw new StoreError(409, "Memo-chat append has no completed matching dispatch.", "ai_dispatch_fenced");
  }
  if (receipt.status === "succeeded" &&
      (receipt.memoChatClaimExpiresAtEpoch ?? 0) <= Math.floor(nowMs / 1_000)) {
    throw new StoreError(409, "Memo-chat provider-start claim expired before append.", "ai_dispatch_fenced");
  }
}

function approvalRequestListItem(
  request: AiApprovalRequestRecord,
  decision?: AiApprovalRequestDecision,
  nowMs = Date.now()
): AiApprovalRequestListItem {
  return {
    id: request.id,
    targetAccountId: request.targetAccountId,
    requestedBy: structuredClone(request.requestedBy),
    purpose: request.purpose,
    subject: {
      kind: request.subject.kind,
      id: request.subject.id,
      version: request.subject.version,
      ...(request.subject.revision === undefined ? {} : { revision: request.subject.revision })
    },
    dataClass: request.dataClass,
    policy: structuredClone(request.policy),
    context: structuredClone(request.context),
    status: approvalRequestStatusKind(request, decision, nowMs),
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    ...(decision ? { decidedAt: decision.decidedAt } : {})
  };
}

function approvalRequestIndexRecord(
  request: AiApprovalRequestRecord,
  decision?: AiApprovalRequestDecision,
  nowMs = Date.now()
): AiApprovalRequestIndexRecord {
  const sort = aiApprovalRequestSortValue(request.createdAt);
  return {
    schemaVersion: "rulix.ai-approval-request-index/v1",
    ...approvalRequestListItem(request, decision, nowMs),
    requestKey: aiApprovalRequestKey(request.targetAccountId, request.id),
    accountIndexKey: aiApprovalRequestAccountIndexKey(request.targetAccountId, sort, request.id),
    tenantIndexKey: aiApprovalRequestTenantIndexKey(sort, request.id),
    expiresAtEpoch: request.expiresAtEpoch
  };
}

function storedAiApprovalRequestIndex(value: unknown): AiApprovalRequestIndexRecord {
  if (!isRecord(value) || value.schemaVersion !== "rulix.ai-approval-request-index/v1" ||
      !isRecord(value.requestedBy) || !isUserRoleValue(value.requestedBy.role) ||
      !isRecord(value.subject) ||
      (value.purpose !== "council" && value.purpose !== "memo-chat" && value.purpose !== "memo-builder") ||
      !isDataClass(value.dataClass) ||
      (value.status !== "pending" && value.status !== "approved" && value.status !== "rejected" &&
       value.status !== "cancelled" && value.status !== "expired")) {
    throw new StoreError(503, "Persisted AI approval request index is invalid.", "ai_approval_state_invalid");
  }
  const id = boundedAiIdentifier(value.id, "AI approval request index ID", 160);
  const targetAccountId = boundedAiIdentifier(value.targetAccountId, "AI approval request index account", 512);
  const createdAt = canonicalAiDate(value.createdAt, "AI approval request index creation time");
  const expiresAt = canonicalAiDate(value.expiresAt, "AI approval request index expiry");
  const subjectKind = value.subject.kind;
  const subjectId = boundedAiIdentifier(value.subject.id, "AI approval request index subject", 512);
  const subjectVersion = value.subject.version;
  const subjectRevision = value.subject.revision;
  if ((subjectKind !== "review" && subjectKind !== "memo-builder") ||
      !Number.isSafeInteger(subjectVersion) || (subjectVersion as number) < 1 ||
      (subjectKind === "review"
        ? !Number.isSafeInteger(subjectRevision) || (subjectRevision as number) < 1
        : subjectRevision !== undefined)) {
    throw new StoreError(503, "Persisted AI approval request index subject is invalid.", "ai_approval_state_invalid");
  }
  const context = approvalValue(() => assertAiApprovalRequestContext(value.context));
  const policy = approvalValue(() => assertAiApprovalPolicy(value.policy));
  const sort = aiApprovalRequestSortValue(createdAt);
  const expectedRequestKey = aiApprovalRequestKey(targetAccountId, id);
  const expectedAccountIndexKey = aiApprovalRequestAccountIndexKey(targetAccountId, sort, id);
  const expectedTenantIndexKey = aiApprovalRequestTenantIndexKey(sort, id);
  if (value.requestKey !== expectedRequestKey || value.accountIndexKey !== expectedAccountIndexKey ||
      value.tenantIndexKey !== expectedTenantIndexKey || !Number.isSafeInteger(value.expiresAtEpoch)) {
    throw new StoreError(503, "Persisted AI approval request index binding is invalid.", "ai_approval_state_invalid");
  }
  const decidedAt = value.decidedAt === undefined
    ? undefined
    : canonicalAiDate(value.decidedAt, "AI approval request index decision time");
  return {
    schemaVersion: "rulix.ai-approval-request-index/v1",
    id,
    targetAccountId,
    requestedBy: {
      id: boundedAiIdentifier(value.requestedBy.id, "AI approval request index requester", 512),
      role: value.requestedBy.role
    },
    purpose: value.purpose,
    subject: {
      kind: subjectKind,
      id: subjectId,
      version: subjectVersion as number,
      ...(subjectRevision === undefined ? {} : { revision: subjectRevision as number })
    },
    dataClass: value.dataClass,
    policy,
    context,
    status: value.status,
    createdAt,
    expiresAt,
    ...(decidedAt ? { decidedAt } : {}),
    requestKey: expectedRequestKey,
    accountIndexKey: expectedAccountIndexKey,
    tenantIndexKey: expectedTenantIndexKey,
    expiresAtEpoch: value.expiresAtEpoch as number
  };
}

function canonicalAiDate(value: unknown, label: string) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new StoreError(503, `${label} is invalid.`, "ai_approval_state_invalid");
  }
  return value;
}

function isUserRoleValue(value: unknown): value is UserProfile["role"] {
  return value === "export-control-officer" || value === "reviewer" || value === "submitter" || value === "counsel";
}

function prepareAiApproval(
  tenantId: string,
  accountId: string,
  command: CreateAiApprovalCommand,
  nowMs: number,
  memoChatFence?: AiApprovalMemoChatFence
): AiApprovalRecord {
  const normalizedTenant = boundedAiIdentifier(tenantId, "AI approval tenant ID", 160);
  const normalizedAccount = boundedAiIdentifier(accountId, "AI approval account ID", 512);
  const requestId = boundedAiIdentifier(command.requestId, "AI approval request ID", 160);
  if (!isAiApprovalPurpose(command.purpose)) {
    throw new StoreError(400, "AI approval purpose is invalid.", "ai_approval_binding_invalid");
  }
  const subject = approvalValue(() => assertAiApprovalSubject(command.subject));
  assertHumanAiApprovalPurpose(command.purpose, subject.kind);
  const payloadHash = approvalValue(() => assertSha256(command.payloadHash, "AI approval payload hash"));
  if (!isDataClass(command.dataClass)) {
    throw new StoreError(400, "AI approval data class is invalid.", "ai_approval_binding_invalid");
  }
  const policy = approvalValue(() => assertAiApprovalPolicy(command.policy));
  if (policy.mode !== "approved") {
    throw new StoreError(403, "Current deployment policy does not approve this AI workload.", "ai_policy_not_approved");
  }
  assertOfficer(command.approvedBy, "Only an export-control officer may create AI approval.");
  const normalizedChatFence = memoChatFence
    ? approvalValue(() => assertAiApprovalMemoChatFence(memoChatFence))
    : undefined;
  if ((command.purpose === "memo-chat") !== Boolean(normalizedChatFence)) {
    throw new StoreError(
      409,
      "Memo-chat approval requires an authoritative server-owned history fence.",
      "ai_approval_stale_subject"
    );
  }
  if (command.purpose === "memo-chat") {
    const observedHistoryHash = approvalValue(() =>
      assertSha256(command.memoChatHistoryHash, "Observed memo-chat history hash"));
    if (observedHistoryHash !== normalizedChatFence!.historyHash) {
      throw new StoreError(409, "Memo-chat history changed before approval.", "ai_approval_stale_subject");
    }
  } else if (command.memoChatHistoryHash !== undefined) {
    throw new StoreError(400, "Only memo-chat approval may carry a history hash.", "ai_approval_binding_invalid");
  }
  if (!Number.isFinite(nowMs)) {
    throw new StoreError(500, "AI approval clock is invalid.", "ai_approval_state_invalid");
  }
  const approvedAt = new Date(nowMs).toISOString();
  const expiresAt = command.expiresAt ?? new Date(nowMs + DEFAULT_AI_APPROVAL_TTL_MS).toISOString();
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || new Date(expiresAtMs).toISOString() !== expiresAt ||
      expiresAtMs <= nowMs || expiresAtMs - nowMs > MAX_AI_APPROVAL_TTL_MS) {
    throw new StoreError(
      400,
      "AI approval expiry must be a canonical future time within one hour.",
      "ai_approval_expiry_invalid"
    );
  }
  const requestedLimit = command.dispatchLimit ?? 1;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_AI_APPROVAL_DISPATCHES ||
      (subject.kind !== "document" && requestedLimit !== 1)) {
    throw new StoreError(
      400,
      "AI approval dispatch limit is invalid for this subject.",
      "ai_approval_dispatch_limit_invalid"
    );
  }
  if (!Array.isArray(command.providerRequestHashes) || command.providerRequestHashes.length !== requestedLimit) {
    throw new StoreError(
      400,
      "AI approval must bind one exact provider request hash per dispatch.",
      "ai_approval_provider_request_required"
    );
  }
  const providerRequestHashes = command.providerRequestHashes.map((value) =>
    approvalValue(() => assertSha256(value, "AI approval provider request hash")));
  if (new Set(providerRequestHashes).size !== providerRequestHashes.length) {
    throw new StoreError(
      400,
      "AI approval provider request hashes must be unique.",
      "ai_approval_provider_request_invalid"
    );
  }
  const commandHash = hashAiApprovalPayload({
    tenantId: normalizedTenant,
    accountId: normalizedAccount,
    requestId,
    purpose: command.purpose,
    subject,
    payloadHash,
    providerRequestHashes,
    dataClass: command.dataClass,
    policy,
    memoChatFence: normalizedChatFence ?? null,
    approvedBy: { id: command.approvedBy.id, role: "export-control-officer" },
    requestedExpiresAt: command.expiresAt ?? null,
    dispatchLimit: requestedLimit
  });
  return approvalValue(() => assertAiApprovalRecord({
    schemaVersion: AI_APPROVAL_SCHEMA_VERSION,
    id: createAiApprovalId(normalizedAccount, requestId),
    requestId,
    commandHash,
    tenantId: normalizedTenant,
    accountId: normalizedAccount,
    purpose: command.purpose,
    subject,
    payloadHash,
    providerRequestHashes,
    dataClass: command.dataClass,
    policy,
    ...(normalizedChatFence ? { memoChatFence: normalizedChatFence } : {}),
    approvedBy: {
      id: boundedAiIdentifier(command.approvedBy.id, "AI approval officer ID", 512),
      role: "export-control-officer"
    },
    approvedAt,
    expiresAt,
    validUntilEpoch: Math.floor(expiresAtMs / 1_000),
    expiresAtEpoch: Math.floor(nowMs / 1_000) + AI_DISPATCH_AUDIT_TTL_DAYS * 86_400,
    dispatchLimit: requestedLimit
  }));
}

function prepareAiApprovalRevocation(
  accountId: string,
  approvalId: string,
  command: RevokeAiApprovalCommand
): AiApprovalRevocation {
  const revokedAt = command.revokedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(revokedAt)) || new Date(revokedAt).toISOString() !== revokedAt) {
    throw new StoreError(400, "AI approval revocation timestamp is invalid.", "ai_approval_binding_invalid");
  }
  const reason = typeof command.reason === "string" ? command.reason.trim() : "";
  if (!reason || reason.length > 500) {
    throw new StoreError(400, "AI approval revocation reason is required.", "ai_approval_binding_invalid");
  }
  const requestId = boundedAiIdentifier(command.requestId, "AI approval revocation request ID", 160);
  const commandHash = hashAiApprovalPayload({
    accountId,
    approvalId,
    requestId,
    revokedBy: command.revokedBy.id,
    reason,
    requestedRevokedAt: command.revokedAt ?? null
  });
  return approvalValue(() => assertAiApprovalRevocation({
    schemaVersion: AI_APPROVAL_REVOCATION_SCHEMA_VERSION,
    approvalId,
    accountId,
    requestId,
    commandHash,
    revokedBy: command.revokedBy.id,
    revokedAt,
    reason
  }));
}

function prepareAiDispatchReservation(
  request: ReserveAiDispatchRequest,
  memoChatFence?: AiApprovalMemoChatFence
): AiDispatchReceipt {
  const accountId = boundedAiIdentifier(request.accountId, "AI dispatch account ID", 512);
  const dispatchId = boundedAiIdentifier(request.dispatchId, "AI dispatch ID", 160);
  if (!Number.isFinite(request.nowMs)) {
    throw new StoreError(500, "AI dispatch clock is invalid.", "ai_approval_state_invalid");
  }
  if (!isAiApprovalPurpose(request.purpose) || !isDataClass(request.dataClass)) {
    throw new StoreError(400, "AI dispatch binding is invalid.", "ai_approval_binding_invalid");
  }
  const payloadHash = approvalValue(() => assertSha256(request.payloadHash, "AI dispatch payload hash"));
  const providerRequestHash = approvalValue(() =>
    assertSha256(request.providerRequestHash, "AI provider request hash"));
  const policy = approvalValue(() => assertAiApprovalPolicy(request.policy));
  if (policy.mode !== "approved") {
    throw new StoreError(403, "Current deployment policy does not approve this AI workload.", "ai_policy_not_approved");
  }
  const hasApproval = request.approvalId !== undefined || request.subject !== undefined;
  const hasTrusted = request.trustedWorkflow !== undefined || request.trustedSubjectId !== undefined;
  if (hasApproval === hasTrusted) {
    throw new StoreError(403, "Exactly one AI authorization binding is required.", "ai_approval_required");
  }

  const base = {
    accountId,
    dispatchId,
    purpose: request.purpose,
    payloadHash,
    providerRequestHash,
    dataClass: request.dataClass,
    policy
  };
  let authorization:
    | { authorizationKind: "approval"; approvalId: string; subject: AiApprovalSubjectBinding }
    | {
        authorizationKind: "trusted-workflow";
        trustedWorkflow: "lead-search" | "outreach-personalization" | "outreach-writer";
        trustedSubjectId: string;
      };
  if (hasApproval) {
    const approvalId = boundedAiIdentifier(request.approvalId, "AI approval ID", 160);
    const subject = approvalValue(() => assertAiApprovalSubject(request.subject));
    assertHumanAiApprovalPurpose(request.purpose, subject.kind);
    authorization = { authorizationKind: "approval", approvalId, subject };
  } else {
    const workflow = request.trustedWorkflow;
    if (workflow !== "lead-search" && workflow !== "outreach-personalization" && workflow !== "outreach-writer" ||
        workflow !== request.purpose) {
      throw new StoreError(403, "Trusted AI workflow binding is invalid.", "ai_trusted_workflow_invalid");
    }
    authorization = {
      authorizationKind: "trusted-workflow",
      trustedWorkflow: workflow,
      trustedSubjectId: boundedAiIdentifier(request.trustedSubjectId, "Trusted AI workflow subject", 512)
    };
  }
  const normalizedChatFence = memoChatFence
    ? approvalValue(() => assertAiApprovalMemoChatFence(memoChatFence))
    : undefined;
  if ((request.purpose === "memo-chat") !== Boolean(normalizedChatFence) ||
      (normalizedChatFence && authorization.authorizationKind !== "approval")) {
    throw new StoreError(503, "Memo-chat dispatch fence is missing or invalid.", "ai_dispatch_state_invalid");
  }
  const canonical = {
    ...base,
    ...authorization,
    ...(normalizedChatFence ? { memoChatFence: normalizedChatFence } : {})
  };
  const requestHash = canonicalAiDispatchRequestHash(canonical);
  const createdAt = new Date(request.nowMs).toISOString();
  return {
    schemaVersion: "rulix.ai-dispatch/v1",
    ...base,
    ...authorization,
    ...(normalizedChatFence ? { memoChatFence: normalizedChatFence } : {}),
    requestHash,
    reservationToken: randomBytes(24).toString("base64url"),
    status: "reserved",
    createdAt,
    updatedAt: createdAt,
    reservationExpiresAtEpoch: Math.floor((request.nowMs + AI_DISPATCH_RESERVATION_LEASE_MS) / 1_000),
    expiresAtEpoch: Math.floor(request.nowMs / 1_000) + AI_DISPATCH_AUDIT_TTL_DAYS * 86_400
  };
}

function canonicalAiDispatchRequestHash(value: Pick<
  AiDispatchReceipt,
  "accountId" | "dispatchId" | "purpose" | "payloadHash" | "providerRequestHash" |
  "dataClass" | "policy" | "authorizationKind"
> & Partial<Pick<
  AiDispatchReceipt,
  "approvalId" | "subject" | "trustedWorkflow" | "trustedSubjectId" | "memoChatFence"
>>) {
  return hashAiApprovalPayload({
    accountId: value.accountId,
    dispatchId: value.dispatchId,
    purpose: value.purpose,
    payloadHash: value.payloadHash,
    providerRequestHash: value.providerRequestHash,
    dataClass: value.dataClass,
    policy: value.policy,
    authorizationKind: value.authorizationKind,
    approvalId: value.approvalId ?? null,
    subject: value.subject ?? null,
    trustedWorkflow: value.trustedWorkflow ?? null,
    trustedSubjectId: value.trustedSubjectId ?? null,
    memoChatFence: value.memoChatFence ?? null
  });
}

/** Reconstructs the exact authorization request from a durable receipt. This is
 * intentionally the only path used by the final provider-start fence so the
 * reserve and start checks cannot drift apart. */
function dispatchRequestFromReceipt(
  receipt: AiDispatchReceipt,
  nowMs: number
): ReserveAiDispatchRequest {
  return {
    accountId: receipt.accountId,
    dispatchId: receipt.dispatchId,
    purpose: receipt.purpose,
    payloadHash: receipt.payloadHash,
    providerRequestHash: receipt.providerRequestHash,
    dataClass: receipt.dataClass,
    policy: structuredClone(receipt.policy),
    ...(receipt.memoChatFence ? { memoChatFence: structuredClone(receipt.memoChatFence) } : {}),
    nowMs,
    ...(receipt.authorizationKind === "approval"
      ? {
          approvalId: receipt.approvalId,
          subject: receipt.subject ? structuredClone(receipt.subject) : undefined
        }
      : {
          trustedWorkflow: receipt.trustedWorkflow,
          trustedSubjectId: receipt.trustedSubjectId
        })
  };
}

function assertAiDispatchMatchesApproval(
  request: ReserveAiDispatchRequest,
  approvalValue: AiApprovalRecord,
  tenantId: string
) {
  const approval = storedAiApproval(approvalValue);
  const subject = approvalValueOrThrow(() => assertAiApprovalSubject(request.subject));
  if (approval.tenantId !== tenantId || approval.accountId !== request.accountId) {
    throw new StoreError(403, "AI approval belongs to a different account or tenant.", "ai_approval_account_mismatch");
  }
  if (approval.id !== request.approvalId || approval.purpose !== request.purpose ||
      approval.payloadHash !== request.payloadHash || approval.dataClass !== request.dataClass ||
      !approval.providerRequestHashes.includes(request.providerRequestHash) ||
      !sameAiApprovalSubject(approval.subject, subject) ||
      !sameAiApprovalPolicy(approval.policy, request.policy)) {
    throw new StoreError(403, "AI approval does not match this exact dispatch.", "ai_approval_binding_mismatch");
  }
  if (approval.purpose === "memo-chat") {
    if (!approval.memoChatFence || !request.memoChatFence ||
        !sameAiApprovalMemoChatFence(approval.memoChatFence, request.memoChatFence)) {
      throw new StoreError(403, "Memo-chat dispatch fence does not match approval.", "ai_approval_binding_mismatch");
    }
  } else if (request.memoChatFence !== undefined) {
    throw new StoreError(403, "Non-chat dispatch contains a chat fence.", "ai_approval_binding_mismatch");
  }
  if (approval.policy.mode !== "approved") {
    throw new StoreError(403, "AI approval policy is no longer active.", "ai_policy_not_approved");
  }
  if (request.nowMs >= Date.parse(approval.expiresAt)) {
    throw new StoreError(403, "AI approval expired.", "ai_approval_expired");
  }
  assertHumanAiApprovalPurpose(approval.purpose, approval.subject.kind);
}

function assertReviewApprovalBinding(
  review: MemoRecord | undefined,
  subject: AiApprovalSubjectBinding
) {
  if (!review) throw new StoreError(404, "Review not found.", "ai_approval_subject_not_found");
  const revision = review.revision ?? 1;
  const version = review.version ?? revision;
  const contentHash = review.contentHash ?? hashMemoContent(review);
  if (subject.kind !== "review" || subject.revision !== revision || subject.version !== version ||
      subject.contentHash !== contentHash || subject.id !== review.id) {
    throw new StoreError(
      409,
      "Review changed before AI approval was recorded.",
      "ai_approval_stale_subject"
    );
  }
}

function assertBuilderApprovalBinding(
  builder: StoredMemoBuilderSession | undefined,
  subject: AiApprovalSubjectBinding
) {
  if (!builder) {
    throw new StoreError(404, "Memo-builder session not found.", "ai_approval_subject_not_found");
  }
  if (subject.kind !== "memo-builder" || subject.id !== builder.session.id ||
      subject.version !== builder.version || subject.contentHash !== hashAiBuilderSession(builder.session)) {
    throw new StoreError(
      409,
      "Memo-builder session changed before AI approval was recorded.",
      "ai_approval_stale_subject"
    );
  }
}

function assertHumanAiApprovalPurpose(
  purpose: AiApprovalPurpose,
  subjectKind: AiApprovalSubjectBinding["kind"]
) {
  const allowed = subjectKind === "review"
    ? purpose === "council" || purpose === "memo-chat"
    : subjectKind === "document"
      ? purpose === "document-extraction"
      : purpose === "memo-builder";
  if (!allowed) {
    throw new StoreError(
      403,
      "This AI purpose cannot be authorized for that subject type.",
      "ai_approval_purpose_not_allowed"
    );
  }
}

function assertOfficer(
  actor: { id: string; role: UserProfile["role"] },
  message: string
) {
  boundedAiIdentifier(actor.id, "AI approval officer ID", 512);
  if (actor.role !== "export-control-officer") {
    throw new StoreError(403, message, "ai_approval_role_required");
  }
}

function assertCurrentAiApprovalQuery(query: CurrentAiApprovalQuery) {
  if (!isAiApprovalPurpose(query.purpose) ||
      (query.subjectKind !== "review" && query.subjectKind !== "document" && query.subjectKind !== "memo-builder")) {
    throw new StoreError(400, "AI approval query is invalid.", "ai_approval_binding_invalid");
  }
  boundedAiIdentifier(query.subjectId, "AI approval subject ID", 512);
  assertHumanAiApprovalPurpose(query.purpose, query.subjectKind);
}

function validateAiDispatchTransition(request: TransitionAiDispatchRequest) {
  boundedAiIdentifier(request.accountId, "AI dispatch account ID", 512);
  boundedAiIdentifier(request.dispatchId, "AI dispatch ID", 160);
  boundedAiIdentifier(request.reservationToken, "AI dispatch reservation token", 160);
  approvalValue(() => assertSha256(request.requestHash, "AI dispatch request hash"));
  if (!Number.isFinite(request.nowMs) ||
      (request.transition !== "mark-started" && request.transition !== "release" &&
       request.transition !== "settle-failed" && request.transition !== "settle-succeeded")) {
    throw new StoreError(400, "AI dispatch transition is invalid.", "ai_dispatch_state_invalid");
  }
}

function idempotentAiApproval(existingValue: AiApprovalRecord, proposed: AiApprovalRecord) {
  const existing = storedAiApproval(existingValue);
  if (existing.commandHash !== proposed.commandHash) {
    throw new StoreError(
      409,
      "This AI approval request ID is already bound to different content.",
      "ai_approval_idempotency_conflict"
    );
  }
  return structuredClone(existing);
}

function storedAiDispatchReceipt(value: unknown): AiDispatchReceipt {
  try {
    if (!isRecord(value) || value.schemaVersion !== "rulix.ai-dispatch/v1") {
      throw new Error("Persisted AI dispatch schema is not recognized.");
    }
    const allowedKeys = new Set([
      "schemaVersion", "accountId", "dispatchId", "requestHash", "reservationToken", "purpose",
      "subject", "authorizationKind", "approvalId", "trustedWorkflow", "trustedSubjectId",
      "payloadHash", "providerRequestHash", "dataClass", "policy", "memoChatFence",
      "memoChatClaimedAt", "memoChatClaimExpiresAtEpoch", "memoChatCommittedAt", "memoChatAbandonedAt",
      "status", "createdAt", "updatedAt",
      "reservationExpiresAtEpoch", "expiresAtEpoch"
    ]);
    if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
      throw new Error("Persisted AI dispatch contains unrecognized fields.");
    }
    const accountId = boundedAiIdentifier(value.accountId, "AI dispatch account ID", 512);
    const dispatchId = boundedAiIdentifier(value.dispatchId, "AI dispatch ID", 160);
    const requestHash = approvalValueOrThrow(() => assertSha256(value.requestHash, "AI dispatch request hash"));
    const reservationToken = boundedAiIdentifier(value.reservationToken, "AI dispatch reservation token", 160);
    if (!isAiApprovalPurpose(value.purpose) || !isDataClass(value.dataClass)) {
      throw new Error("Persisted AI dispatch purpose or data class is invalid.");
    }
    const purpose = value.purpose;
    const payloadHash = approvalValueOrThrow(() => assertSha256(value.payloadHash, "AI dispatch payload hash"));
    const providerRequestHash = approvalValueOrThrow(() =>
      assertSha256(value.providerRequestHash, "AI provider request hash"));
    const policy = approvalValueOrThrow(() => assertAiApprovalPolicy(value.policy));
    if (policy.mode !== "approved") throw new Error("Persisted AI dispatch policy is not approved.");
    if (value.status !== "reserved" && value.status !== "started" &&
        value.status !== "failed" && value.status !== "succeeded") {
      throw new Error("Persisted AI dispatch status is invalid.");
    }
    const createdAt = canonicalAiDate(value.createdAt, "AI dispatch creation time");
    const updatedAt = canonicalAiDate(value.updatedAt, "AI dispatch update time");
    if (Date.parse(updatedAt) < Date.parse(createdAt)) {
      throw new Error("Persisted AI dispatch timestamps are inconsistent.");
    }
    const reservationExpiresAtEpoch = typeof value.reservationExpiresAtEpoch === "number"
      ? value.reservationExpiresAtEpoch
      : Number.NaN;
    const expiresAtEpoch = typeof value.expiresAtEpoch === "number"
      ? value.expiresAtEpoch
      : Number.NaN;
    if (!Number.isSafeInteger(reservationExpiresAtEpoch) || reservationExpiresAtEpoch < 1 ||
        !Number.isSafeInteger(expiresAtEpoch) || expiresAtEpoch <= reservationExpiresAtEpoch ||
        reservationExpiresAtEpoch !== Math.floor((Date.parse(createdAt) + AI_DISPATCH_RESERVATION_LEASE_MS) / 1_000) ||
        expiresAtEpoch !== Math.floor(Date.parse(createdAt) / 1_000) + AI_DISPATCH_AUDIT_TTL_DAYS * 86_400) {
      throw new Error("Persisted AI dispatch expiry is invalid.");
    }

    let authorization:
      | { authorizationKind: "approval"; approvalId: string; subject: AiApprovalSubjectBinding }
      | {
          authorizationKind: "trusted-workflow";
          trustedWorkflow: "lead-search" | "outreach-personalization" | "outreach-writer";
          trustedSubjectId: string;
        };
    if (value.authorizationKind === "approval") {
      if (value.trustedWorkflow !== undefined || value.trustedSubjectId !== undefined) {
        throw new Error("Approval dispatch contains trusted-workflow fields.");
      }
      const approvalId = boundedAiIdentifier(value.approvalId, "AI approval ID", 160);
      const subject = approvalValueOrThrow(() => assertAiApprovalSubject(value.subject));
      assertHumanAiApprovalPurpose(purpose, subject.kind);
      authorization = { authorizationKind: "approval", approvalId, subject };
    } else if (value.authorizationKind === "trusted-workflow") {
      if (value.approvalId !== undefined || value.subject !== undefined ||
          (value.trustedWorkflow !== "lead-search" &&
           value.trustedWorkflow !== "outreach-personalization" &&
           value.trustedWorkflow !== "outreach-writer") || value.trustedWorkflow !== purpose) {
        throw new Error("Trusted AI dispatch authorization is invalid.");
      }
      authorization = {
        authorizationKind: "trusted-workflow",
        trustedWorkflow: value.trustedWorkflow,
        trustedSubjectId: boundedAiIdentifier(value.trustedSubjectId, "Trusted AI workflow subject", 512)
      };
    } else {
      throw new Error("Persisted AI dispatch authorization kind is invalid.");
    }

    const memoChatFence = value.memoChatFence === undefined
      ? undefined
      : approvalValueOrThrow(() => assertAiApprovalMemoChatFence(value.memoChatFence));
    if ((purpose === "memo-chat") !== Boolean(memoChatFence) ||
        (memoChatFence && authorization.authorizationKind !== "approval")) {
      throw new Error("Persisted memo-chat dispatch fence is missing or invalid.");
    }
    const memoChatClaimedAt = value.memoChatClaimedAt === undefined
      ? undefined
      : canonicalAiDate(value.memoChatClaimedAt, "Memo-chat claim time");
    const memoChatClaimExpiresAtEpoch = typeof value.memoChatClaimExpiresAtEpoch === "number"
      ? value.memoChatClaimExpiresAtEpoch
      : undefined;
    if (value.memoChatClaimExpiresAtEpoch !== undefined && memoChatClaimExpiresAtEpoch === undefined) {
      throw new Error("Persisted memo-chat claim expiry is invalid.");
    }
    if ((memoChatClaimedAt === undefined) !== (memoChatClaimExpiresAtEpoch === undefined) ||
        memoChatClaimExpiresAtEpoch !== undefined &&
        (!memoChatFence || !Number.isSafeInteger(memoChatClaimExpiresAtEpoch) || memoChatClaimExpiresAtEpoch < 1 ||
         memoChatClaimExpiresAtEpoch !== Math.floor((Date.parse(memoChatClaimedAt!) + AI_MEMO_CHAT_CLAIM_MS) / 1_000))) {
      throw new Error("Persisted memo-chat claim expiry is invalid.");
    }
    const memoChatCommittedAt = value.memoChatCommittedAt === undefined
      ? undefined
      : canonicalAiDate(value.memoChatCommittedAt, "Memo-chat commit time");
    const memoChatAbandonedAt = value.memoChatAbandonedAt === undefined
      ? undefined
      : canonicalAiDate(value.memoChatAbandonedAt, "Memo-chat abandon time");
    if ((memoChatCommittedAt || memoChatAbandonedAt) && !memoChatFence ||
        memoChatCommittedAt && memoChatAbandonedAt) {
      throw new Error("Non-chat dispatch contains a chat commit marker.");
    }
    if (!memoChatFence && (memoChatClaimedAt || memoChatClaimExpiresAtEpoch !== undefined ||
        memoChatCommittedAt || memoChatAbandonedAt)) {
      throw new Error("Non-chat dispatch contains memo-chat lifecycle state.");
    }
    if (memoChatFence) {
      const createdAtMs = Date.parse(createdAt);
      const updatedAtMs = Date.parse(updatedAt);
      const claimedAtMs = memoChatClaimedAt ? Date.parse(memoChatClaimedAt) : undefined;
      const completionAt = memoChatCommittedAt ?? memoChatAbandonedAt;
      if (value.status === "reserved") {
        if (memoChatClaimedAt || memoChatClaimExpiresAtEpoch !== undefined || completionAt ||
            updatedAt !== createdAt) {
          throw new Error("Reserved memo-chat dispatch contains provider-start state.");
        }
      } else {
        if (claimedAtMs === undefined || memoChatClaimExpiresAtEpoch === undefined ||
            claimedAtMs < createdAtMs || claimedAtMs >= (reservationExpiresAtEpoch + 1) * 1_000 ||
            updatedAtMs < claimedAtMs) {
          throw new Error("Memo-chat provider-start lifecycle is invalid.");
        }
        if (value.status === "started" && (updatedAt !== memoChatClaimedAt || completionAt)) {
          throw new Error("Started memo-chat dispatch contains invalid terminal state.");
        }
        if (completionAt && (value.status !== "succeeded" && value.status !== "failed" ||
            completionAt !== updatedAt || Date.parse(completionAt) < claimedAtMs)) {
          throw new Error("Memo-chat completion lifecycle is invalid.");
        }
      }
    }

    const receipt: AiDispatchReceipt = {
      schemaVersion: "rulix.ai-dispatch/v1",
      accountId,
      dispatchId,
      requestHash,
      reservationToken,
      purpose,
      ...authorization,
      payloadHash,
      providerRequestHash,
      dataClass: value.dataClass,
      policy,
      ...(memoChatFence ? { memoChatFence } : {}),
      ...(memoChatClaimedAt ? { memoChatClaimedAt } : {}),
      ...(memoChatClaimExpiresAtEpoch === undefined ? {} : { memoChatClaimExpiresAtEpoch }),
      ...(memoChatCommittedAt ? { memoChatCommittedAt } : {}),
      ...(memoChatAbandonedAt ? { memoChatAbandonedAt } : {}),
      status: value.status,
      createdAt,
      updatedAt,
      reservationExpiresAtEpoch,
      expiresAtEpoch
    };
    if (canonicalAiDispatchRequestHash(receipt) !== requestHash) {
      throw new Error("Persisted AI dispatch request hash does not match its canonical binding.");
    }
    return receipt;
  } catch (error) {
    if (error instanceof StoreError && error.code === "ai_dispatch_state_invalid") throw error;
    throw new StoreError(
      503,
      error instanceof Error ? error.message : "Persisted AI dispatch is invalid.",
      "ai_dispatch_state_invalid"
    );
  }
}

function idempotentAiDispatch(existing: AiDispatchReceipt, proposed: AiDispatchReceipt): ReserveAiDispatchResult {
  const validated = storedAiDispatchReceipt(existing);
  if (validated.requestHash !== proposed.requestHash) {
    throw new StoreError(
      409,
      "This AI dispatch ID is already bound to a different request.",
      "ai_dispatch_id_conflict"
    );
  }
  return {
    replayed: true,
    requestHash: proposed.requestHash,
    reservationToken: validated.reservationToken
  };
}

function storedAiApproval(value: unknown): AiApprovalRecord {
  if (value === undefined) throw new StoreError(404, "AI approval not found.", "ai_approval_not_found");
  try {
    return assertAiApprovalRecord(value);
  } catch (error) {
    if (error instanceof AiApprovalValidationError) {
      throw new StoreError(503, error.message, "ai_approval_state_invalid");
    }
    throw error;
  }
}

function storedAiApprovalRevocation(value: unknown): AiApprovalRevocation {
  try {
    return assertAiApprovalRevocation(value);
  } catch (error) {
    if (error instanceof AiApprovalValidationError) {
      throw new StoreError(503, error.message, "ai_approval_state_invalid");
    }
    throw error;
  }
}

function approvalValue<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof AiApprovalValidationError) {
      throw new StoreError(400, error.message, "ai_approval_binding_invalid");
    }
    throw error;
  }
}

function approvalValueOrThrow<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof AiApprovalValidationError) {
      throw new StoreError(403, error.message, "ai_approval_binding_mismatch");
    }
    throw error;
  }
}

function validDispatchCount(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_AI_APPROVAL_DISPATCHES) {
    throw new StoreError(503, "AI approval dispatch state is invalid.", "ai_approval_state_invalid");
  }
  return value as number;
}

function validAiApprovalCounter(
  value: AiApprovalDispatchCounter | undefined,
  approval: AiApprovalRecord
): value is AiApprovalDispatchCounter {
  if (!value || value.accountId !== approval.accountId || value.approvalId !== approval.id ||
      !Number.isSafeInteger(value.version) || value.version < 1 ||
      value.dispatchLimit !== approval.dispatchLimit ||
      !Number.isSafeInteger(value.dispatchesReserved) || value.dispatchesReserved < 0 ||
      value.dispatchesReserved > value.dispatchLimit ||
      value.expiresAtEpoch !== approval.expiresAtEpoch ||
      !Array.isArray(value.providerRequestHashesReserved) ||
      value.providerRequestHashesReserved.length !== value.dispatchesReserved) {
    return false;
  }
  const unique = new Set(value.providerRequestHashesReserved);
  return unique.size === value.providerRequestHashesReserved.length &&
    value.providerRequestHashesReserved.every((hash) =>
      typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash) &&
      approval.providerRequestHashes.includes(hash));
}

function boundedAiIdentifier(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum ||
      value !== value.trim() || !/^[A-Za-z0-9._:@/-]+$/u.test(value)) {
    throw new StoreError(400, `${label} is invalid.`, "ai_approval_binding_invalid");
  }
  return value;
}

function aiAccountDigest(accountId: string) {
  return createHash("sha256").update(accountId, "utf8").digest("hex");
}

function aiSubjectDigest(subject: Pick<AiApprovalSubjectBinding, "kind" | "id">) {
  return createHash("sha256").update(`${subject.kind}\u0000${subject.id}`, "utf8").digest("hex");
}

function aiApprovalKey(accountId: string, approvalId: string) {
  return `AI_APPROVAL#${aiAccountDigest(accountId)}#${approvalId}`;
}

function aiApprovalCounterKey(accountId: string, approvalId: string) {
  return `AI_APPROVAL_COUNTER#${aiAccountDigest(accountId)}#${approvalId}`;
}

function aiApprovalRevocationKey(accountId: string, approvalId: string) {
  return `AI_APPROVAL_REVOKED#${aiAccountDigest(accountId)}#${approvalId}`;
}

function aiApprovalPointerKey(
  accountId: string,
  subject: Pick<AiApprovalSubjectBinding, "kind" | "id">,
  purpose: AiApprovalPurpose
) {
  return `AI_APPROVAL_CURRENT#${aiAccountDigest(accountId)}#${aiSubjectDigest(subject)}#${purpose}`;
}

function aiDispatchKey(accountId: string, dispatchId: string) {
  const digest = createHash("sha256").update(dispatchId, "utf8").digest("hex");
  return `AI_DISPATCH#${aiAccountDigest(accountId)}#${digest}`;
}

function aiApprovalRequestKey(_accountId: string, requestId: string) {
  return `AI_APPROVAL_REQUEST#${requestId}`;
}

function aiApprovalRequestDecisionKey(requestId: string) {
  return `AI_APPROVAL_REQUEST_DECISION#${requestId}`;
}

function aiApprovalRequestPreviewKey(requestId: string) {
  return `AI_APPROVAL_REQUEST_PREVIEW#${requestId}`;
}

function aiApprovalRequestPendingKey(accountId: string, dedupeHash: string) {
  return `AI_APPROVAL_REQUEST_PENDING#${aiAccountDigest(accountId)}#${dedupeHash}`;
}

function aiApprovalRequestAccountQuotaKey(accountId: string, bucket: string) {
  return `AI_APPROVAL_REQUEST_QUOTA_ACCOUNT#${aiAccountDigest(accountId)}#${bucket}`;
}

function aiApprovalRequestTenantQuotaKey(bucket: string) {
  return `AI_APPROVAL_REQUEST_QUOTA_TENANT#${bucket}`;
}

function aiApprovalRequestSortValue(createdAt: string) {
  const time = Date.parse(createdAt);
  if (!Number.isFinite(time)) {
    throw new StoreError(503, "AI approval request timestamp is invalid.", "ai_approval_state_invalid");
  }
  return String(9_999_999_999_999 - time).padStart(13, "0");
}

function aiApprovalRequestAccountIndexPrefix(accountId: string) {
  return `AI_APPROVAL_REQUEST_ACCOUNT#${aiAccountDigest(accountId)}#`;
}

function aiApprovalRequestAccountIndexKey(accountId: string, sort: string, requestId: string) {
  return `${aiApprovalRequestAccountIndexPrefix(accountId)}${sort}#${requestId}`;
}

function aiApprovalRequestTenantIndexPrefix() {
  return "AI_APPROVAL_REQUEST_TENANT#";
}

function aiApprovalRequestTenantIndexKey(sort: string, requestId: string) {
  return `${aiApprovalRequestTenantIndexPrefix()}${sort}#${requestId}`;
}

function localAiApprovalKey(accountId: string, approvalId: string) {
  return `${accountId}\u0000${approvalId}`;
}

function localAiApprovalPointerKey(
  accountId: string,
  subject: Pick<AiApprovalSubjectBinding, "kind" | "id">,
  purpose: AiApprovalPurpose
) {
  return `${accountId}\u0000${aiApprovalCurrentIdentity(
    { kind: subject.kind, id: subject.id },
    purpose
  )}`;
}

function localAiDispatchKey(accountId: string, dispatchId: string) {
  return `${accountId}\u0000${dispatchId}`;
}

function localAiApprovalRequestPendingKey(accountId: string, dedupeHash: string) {
  return `${accountId}\u0000${dedupeHash}`;
}

function tenantKey(tenantId: string) {
  return `TENANT#${tenantId}`;
}

function userKey(email: string) {
  return `USER#${email}`;
}

function inviteKey(tokenHash: string) {
  return `INVITE#${tokenHash}`;
}

function inviteEmailKey(email: string) {
  return `INVITE_EMAIL#${email}`;
}

function resetKey(tokenHash: string) {
  return `RESET#${tokenHash}`;
}

function sessionKey(tokenHash: string) {
  return `SESSION#${tokenHash}`;
}

function lockoutKey(email: string) {
  return `LOCKOUT#${email}`;
}

function usageKey(at: string, id: string) {
  return `USAGE#${at}#${id}`;
}

function usageReceiptKey(id: string) {
  return `USAGE_RECEIPT#${createHash("sha256").update(id).digest("hex")}`;
}

function adminMetricsDayKey(day: string) {
  return `ADMIN_METRICS_DAY#${day}`;
}

function isCompleteAdminMetricsMarker(
  marker: AdminAggregateMarker | undefined
): marker is AdminAggregateMarker & { completedAt: string; usersTotal: number } {
  return marker?.status === "complete"
    && marker.schemaVersion === ADMIN_AGGREGATE_SCHEMA_VERSION
    && marker.metricsSchemaVersion === ADMIN_METRICS_SCHEMA_VERSION
    && typeof marker.completedAt === "string"
    && Number.isFinite(Date.parse(marker.completedAt))
    && typeof marker.usersTotal === "number"
    && Number.isSafeInteger(marker.usersTotal)
    && marker.usersTotal >= 0;
}

function adminUsageKey(userId: string) {
  return `ADMIN_USAGE#${createHash("sha256").update(userId).digest("hex")}`;
}

function adminSessionsKey(userId: string) {
  return `ADMIN_SESSIONS#${createHash("sha256").update(userId).digest("hex")}`;
}

function adminSessionEntry(session: SessionRecord): AdminSessionEntry {
  return {
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    authGeneration: currentSessionGeneration(session)
  };
}

function aiAdmissionKey(accountId: string) {
  return `AI_ADMISSION#${createHash("sha256").update(accountId).digest("hex")}`;
}

function rangeDaysCutoff(rangeDays?: number) {
  const days = rangeDays && rangeDays > 0 ? rangeDays : 365;
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function accountKey(tenantId: string, userId: string) {
  return `TENANT#${tenantId}#USER#${userId}`;
}

function defaultStorePath() {
  if (process.env.RULIX_STORE_PATH) return process.env.RULIX_STORE_PATH;
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return "/tmp/rulix-store.json";
  return path.resolve(fileURLToPath(new URL("../data/rulix-store.json", import.meta.url)));
}
