export type EvidenceStatus = "strong" | "weak" | "missing" | "conflict";

export type ReviewStatus =
  | "draft"
  | "ready"
  | "needs-info"
  | "conflict"
  | "signed-off"
  | "in-review"
  | "changes-requested"
  | "approved"
  | "rejected"
  | "superseded"
  | "archived";

export type DataClass = "public" | "proprietary" | "export-controlled" | "itar-risk" | "cui";

/** Every credential-bearing AI workload. Kept shared so approvals, usage, and
 * provider dispatch cannot drift onto subtly different purpose vocabularies. */
export type AiApprovalPurpose =
  | "council"
  | "memo-chat"
  | "public-draft"
  | "outreach-writer"
  | "outreach-personalization"
  | "lead-search"
  | "memo-builder"
  | "document-extraction";

export type AiApprovalSubjectKind = "review" | "document" | "memo-builder";

/**
 * An approval names the exact server-owned subject snapshot. `contentHash`
 * is always a lowercase SHA-256 digest; no prompt or document bytes are
 * persisted in approval or dispatch records.
 */
export interface AiApprovalSubjectBinding {
  kind: AiApprovalSubjectKind;
  id: string;
  version: number;
  revision?: number;
  contentHash: string;
}

export interface AiApprovalPolicyBinding {
  version: string;
  mode: "blocked" | "approved";
  provider: "amazon-bedrock" | "anthropic-direct";
  clientRegion: string;
  model: string;
}

/** Server-captured, durable binding to the authoritative memo-chat window.
 * An absent meta item is represented explicitly so an empty thread cannot be
 * confused with a corrupt or legacy approval that omitted its fence. */
export interface AiApprovalMemoChatFence {
  historyHash: string;
  chatMeta:
    | { exists: false }
    | { exists: true; entityVersion: number; nextSequence: number };
}

export interface AiApprovalRecord {
  schemaVersion: "rulix.ai-approval/v1";
  id: string;
  requestId: string;
  commandHash: string;
  tenantId: string;
  accountId: string;
  purpose: AiApprovalPurpose;
  subject: AiApprovalSubjectBinding;
  /** SHA-256 over the canonical, exact semantic payload passed to the gateway. */
  payloadHash: string;
  /** Exact canonical provider request bodies authorized for this operation. */
  providerRequestHashes: string[];
  dataClass: DataClass;
  policy: AiApprovalPolicyBinding;
  /** Required exactly for memo-chat approvals; captured by the server. */
  memoChatFence?: AiApprovalMemoChatFence;
  approvedBy: {
    id: string;
    role: "export-control-officer";
  };
  approvedAt: string;
  expiresAt: string;
  /** Authorization validity; must exactly match `expiresAt`. */
  validUntilEpoch: number;
  /** Storage retention TTL, intentionally later than authorization validity. */
  expiresAtEpoch: number;
  /** Maximum unique provider attempts authorized by this approval. */
  dispatchLimit: number;
}

export interface AiApprovalRevocation {
  schemaVersion: "rulix.ai-approval-revocation/v1";
  approvalId: string;
  accountId: string;
  requestId: string;
  commandHash: string;
  revokedBy: string;
  revokedAt: string;
  reason: string;
}

export interface AiApprovalStatus {
  approval: AiApprovalRecord;
  current: boolean;
  dispatchesReserved: number;
  revocation?: AiApprovalRevocation;
}

export type AiApprovalRequestContext =
  | { kind: "council"; depth: "standard" | "deep" }
  /** Metadata only: request records never retain prospective chat content. */
  | { kind: "memo-chat"; pendingMessageHash: string; historyHash: string }
  | { kind: "memo-builder" };

export type AiApprovalRequestDecisionKind = "approved" | "cancelled" | "rejected";
export type AiApprovalRequestStatusKind = AiApprovalRequestDecisionKind | "expired" | "pending";

/** Immutable tenant-scoped request. Target account is supplied by the server,
 * never by an officer decision body. */
export interface AiApprovalRequestRecord {
  schemaVersion: "rulix.ai-approval-request/v1";
  id: string;
  requestId: string;
  commandHash: string;
  /** Canonical exact-pending fingerprint excluding client idempotency/time. */
  dedupeHash: string;
  tenantId: string;
  targetAccountId: string;
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
  createdAt: string;
  expiresAt: string;
  validUntilEpoch: number;
  /** Storage retention TTL; intentionally later than request validity. */
  expiresAtEpoch: number;
}

export interface AiApprovalRequestDecision {
  schemaVersion: "rulix.ai-approval-request-decision/v1";
  requestId: string;
  targetAccountId: string;
  decisionRequestId: string;
  commandHash: string;
  decision: AiApprovalRequestDecisionKind;
  decidedBy: {
    id: string;
    role: UserProfile["role"];
  };
  decidedAt: string;
  reason?: string;
  approvalId?: string;
  expiresAtEpoch: number;
}

export interface AiApprovalRequestStatus {
  request: AiApprovalRequestRecord;
  status: AiApprovalRequestStatusKind;
  decision?: AiApprovalRequestDecision;
  approval?: AiApprovalStatus;
}

/** Bounded queue projection. Exact payload/provider hashes stay on the detail
 * record and memo/document bytes are never stored in the authorization queue. */
export interface AiApprovalRequestListItem {
  id: string;
  targetAccountId: string;
  requestedBy: AiApprovalRequestRecord["requestedBy"];
  purpose: AiApprovalRequestRecord["purpose"];
  subject: Pick<AiApprovalSubjectBinding, "kind" | "id" | "version" | "revision">;
  dataClass: DataClass;
  policy: AiApprovalPolicyBinding;
  context: AiApprovalRequestContext;
  status: AiApprovalRequestStatusKind;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
}

export interface AiApprovalRequestOfficerDetail {
  approvalRequest: AiApprovalRequestStatus;
  /** Decrypted only for an authorized officer detail view and never listed or
   * retained after a decision/expiry. */
  pendingContent?: { kind: "memo-chat"; text: string };
}

export type ReviewLifecycleStage =
  | "draft"
  | "needs-information"
  | "ready-for-analysis"
  | "in-review"
  | "changes-requested"
  | "ready-for-decision"
  | "approved"
  | "rejected"
  | "superseded"
  | "archived";

export type CasePriority = "low" | "normal" | "high" | "urgent";

export type AppView = "reviews" | "controls" | "evidence" | "corpus" | "users" | "settings" | "memo-builder";

export type AgentRole =
  | "memo-parser"
  | "jurisdiction-gate"
  | "eccn-candidate"
  | "evidence-mapper"
  | "citation-verifier"
  | "risk-reviewer"
  | "report-writer";

export interface SourceDocument {
  id: string;
  title: string;
  authority: "EAR" | "ITAR" | "BIS" | "ITA";
  url: string;
  snapshotDate: string;
  retrievedAt?: string;
  effectiveAt?: string;
  contentHash?: string;
  parserVersion?: string;
  approvalStatus?: "pending" | "approved" | "superseded" | "withdrawn";
  approvedAt?: string;
  approvedBy?: string;
  supersedesDocumentId?: string;
}

export interface SourceChunk {
  id: string;
  documentId: string;
  title: string;
  locator: string;
  url: string;
  text: string;
  tags: string[];
  textHash?: string;
  exactQuote?: boolean;
  approvalStatus?: "pending" | "approved" | "superseded" | "withdrawn";
}

export interface CorpusSnapshot {
  id: string;
  label: string;
  generatedAt: string;
  checksum: string;
  schemaVersion?: number;
  sourceKind?: "verified-primary" | "reference" | "seed";
  approvalStatus?: "pending" | "approved" | "superseded" | "withdrawn";
  approvedAt?: string;
  approvedBy?: string;
  documents: SourceDocument[];
  chunks: SourceChunk[];
}

export interface MemoRecord {
  id: string;
  title: string;
  itemFamily: string;
  owner: string;
  updatedAt: string;
  documentCode: string;
  status: ReviewStatus;
  memoText: string;
  attachments: string[];
  dataClass?: DataClass;
  manufacturer?: string;
  sourcePath?: "manufacturer" | "self-classification" | "ccats" | "cj" | "unknown";
  intendedUse?: string;
  archivedAt?: string;
  archivedBy?: string;
  revision?: number;
  contentHash?: string;
  createdAt?: string;
  createdBy?: string;
  ownerId?: string;
  lifecycleStage?: ReviewLifecycleStage;
  priority?: CasePriority;
  assignedTo?: string;
  dueAt?: string;
  tags?: string[];
  version?: number;
}

export interface ClassificationCandidate {
  eccn: string;
  label: string;
  confidence: number;
  risk: "low" | "medium" | "high";
  summary: string;
  sourceChunkIds: string[];
}

export interface EvidenceFinding {
  id: string;
  status: EvidenceStatus;
  title: string;
  claim: string;
  rationale: string;
  excerpt?: string;
  start?: number;
  end?: number;
  sourceChunkIds: string[];
  agent: AgentRole;
  severity: "info" | "review" | "escalate";
}

export interface JurisdictionFinding {
  outcome: "ear-likely" | "itar-risk" | "insufficient-info";
  summary: string;
  rationale: string;
  sourceChunkIds: string[];
}

export interface CouncilAgentRun {
  role: AgentRole;
  label: string;
  status: "complete" | "blocked";
  summary: string;
}

export type AnalysisSource = "bedrock" | "local-rules" | "fallback";

export interface AnalysisProviderStatus {
  source: AnalysisSource;
  label: string;
  model: string;
  depth?: "standard" | "deep";
  live: boolean;
  message: string;
  checkedAt: string;
  latencyMs?: number;
}

export interface FormatCheck {
  key: string;
  label: string;
  pass: boolean;
  note?: string;
}

export interface ReviewResult {
  memoId: string;
  generatedAt: string;
  corpusId: string;
  modelPolicy: string;
  provider: AnalysisProviderStatus;
  jurisdiction: JurisdictionFinding;
  recommended: ClassificationCandidate;
  alternatives: ClassificationCandidate[];
  findings: EvidenceFinding[];
  infoRequests: string[];
  agents: CouncilAgentRun[];
  formatChecks?: FormatCheck[];
  id?: string;
  memoRevision?: number;
  inputHash?: string;
  resultHash?: string;
  corpusChecksum?: string;
  promptVersion?: string;
  createdBy?: string;
}

export interface ReviewerDecision {
  id?: string;
  action: "accept" | "request-info" | "override";
  notes: string;
  signedBy?: string;
  signedAt?: string;
  signerId?: string;
  memoRevision?: number;
  memoHash?: string;
  analysisId?: string;
  analysisHash?: string;
  corpusId?: string;
  corpusChecksum?: string;
  createdAt?: string;
}

export interface AuditEvent {
  id: string;
  memoId: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
  severity: "info" | "review" | "escalate";
  actorId?: string;
  organizationId?: string;
  previousHash?: string;
  eventHash?: string;
  metadata?: Record<string, string | number | boolean | undefined>;
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  role: "export-control-officer" | "reviewer" | "submitter" | "counsel";
  createdAt: string;
  organizationId?: string;
  organizationName?: string;
}

export interface OrganizationProfile {
  id: string;
  name: string;
  createdAt: string;
}

export interface OrganizationPolicy {
  allowedDataClasses: DataClass[];
  controlledDataMode: "blocked" | "approved";
  approvedProvider?: string;
  approvedRegion?: string;
  retentionDays: number;
  requireLiveAnalysisForSignoff: boolean;
  updatedAt: string;
  updatedBy?: string;
}

export interface MemoRevision {
  id: string;
  memoId: string;
  revision: number;
  contentHash: string;
  memoText: string;
  title: string;
  itemFamily: string;
  manufacturer?: string;
  intendedUse?: string;
  dataClass: DataClass;
  sourcePath?: MemoRecord["sourcePath"];
  createdAt: string;
  createdBy: string;
  reason: "created" | "edited" | "suggestion-applied" | "restored" | "migration";
}

export interface CaseComment {
  id: string;
  memoId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  mentions: string[];
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface WorkspaceNotification {
  id: string;
  userId: string;
  memoId?: string;
  kind: "assignment" | "mention" | "request-info" | "decision" | "due-date" | "system";
  title: string;
  detail: string;
  createdAt: string;
  readAt?: string;
}

export interface WorkspacePreferences {
  selectedMemoId?: string;
  onboardingCompletedAt?: string;
  dismissedHelp?: string[];
  savedReviewFilter?: string;
}

export interface MemoChatMessage {
  id: string;
  memoId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  /** Server-owned, per-review chronological order for stable paged rendering. */
  sequence?: number;
  proposedMemoText?: string;
  /** The exact authoritative review snapshot the suggestion was generated from. */
  memoRevision?: number;
  memoVersion?: number;
  memoHash?: string;
  applied?: boolean;
}

export interface ReviewCreateReceipt {
  requestId: string;
  inputHash: string;
  memoId: string;
  createdAt: string;
}

export interface OutreachLead {
  leadId: string;
  organization: string;
  organizationType: string;
  segment: string;
  website: string;
  domain: string;
  city: string;
  state: string;
  source: string;
  sourceUrl: string;
  fitScore: number;
  priority: string;
  email: string;
  status: string;
  outreachAngle: string;
  owner: string;
  notes: string;
  persona: string;
  discoveredAt?: string;
}

export interface LeadSearchActivity {
  at: string;
  message: string;
}

export interface LeadSearchRun {
  id: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  model: string;
  status: "completed" | "failed";
  addedLeadIds: string[];
  activity: LeadSearchActivity[];
  error?: string;
}

export type LeadReviewStatus =
  | "new"
  | "pending-review"
  | "approved"
  | "rejected"
  | "needs-research"
  | "ready-to-send";

export type OutreachLifecycleStatus =
  | "not-contacted"
  | "drafted"
  | "personalized"
  | "approved"
  | "sent"
  | "replied"
  | "follow-up-due"
  | "closed"
  | "opted-out";

export interface LeadWorkflow {
  leadId: string;
  reviewStatus: LeadReviewStatus;
  lifecycleStatus: OutreachLifecycleStatus;
  assignedOwner?: string;
  notes?: string;
  lastContactedAt?: string;
  followUpAt?: string;
  replyStatus?: string;
  updatedAt: string;
}

export type OutreachJobType = "draft-missing" | "personalize-all" | "lead-search";
export type OutreachJobStatus = "queued" | "running" | "paused" | "completed" | "failed" | "terminated";

export interface OutreachJobLog {
  at: string;
  message: string;
  level: "info" | "success" | "warning" | "error";
}

export interface OutreachJob {
  id: string;
  type: OutreachJobType;
  status: OutreachJobStatus;
  itemIds: string[];
  cursor: number;
  completedCount: number;
  failedCount: number;
  retryCount: number;
  maxRetries: number;
  maxCostUsd: number;
  estimatedCostUsd: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  direction?: string;
  searchDurationSeconds?: number;
  error?: string;
  logs: OutreachJobLog[];
}

export interface OutreachDraft {
  leadId: string;
  organization: string;
  email: string;
  subject: string;
  body: string;
  model: string;
  updatedAt: string;
  generatedAt?: string;
  sentAt?: string;
  personalizationStatus?: "generic" | "personalized" | "needs-research";
  personalizationDetail?: string;
  personalizationRelevance?: string;
  personalizationSourceTitle?: string;
  personalizationSourceUrl?: string;
  personalizationVerifiedAt?: string;
  personalizationConfidence?: number;
}

export interface AccountReviewState {
  schemaVersion?: number;
  version?: number;
  organization?: OrganizationProfile;
  policy?: OrganizationPolicy;
  preferences?: WorkspacePreferences;
  memos: MemoRecord[];
  selectedMemoId?: string;
  decisions: Record<string, ReviewerDecision>;
  auditEvents: AuditEvent[];
  analysisResults: Record<string, ReviewResult>;
  chatMessages: Record<string, MemoChatMessage[]>;
  memoRevisions?: Record<string, MemoRevision[]>;
  /** Bounded, server-owned idempotency receipts for POST /api/reviews. */
  reviewCreateReceipts?: ReviewCreateReceipt[];
  comments?: Record<string, CaseComment[]>;
  notifications?: WorkspaceNotification[];
  memoBuilder?: {
    activeSessionId?: string;
    sessions?: MemoBuilderSession[];
    /**
     * Legacy single-thread builder state. Kept so older saved accounts migrate cleanly.
     */
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    draft?: {
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
    };
  };
  outreachDrafts?: Record<string, OutreachDraft>;
  discoveredLeads?: OutreachLead[];
  leadSearchRuns?: LeadSearchRun[];
  leadWorkflows?: Record<string, LeadWorkflow>;
  outreachJobs?: OutreachJob[];
}

export interface MemoBuilderSession {
  id: string;
  title: string;
  /** Persisted server-owned classification used for every builder dispatch. */
  dataClass: DataClass;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  updatedAt: string;
  starterPrompt?: string;
  contextMemoId?: string;
  pendingInput?: string;
  pendingAttachments?: Array<{
    id: string;
    name: string;
    content: string;
    status: "ready" | "warning";
    detail: string;
  }>;
  draft?: {
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
  };
}

export type MemoBuilderDraftSource = "chat" | "attachments" | "sample" | "review-improvement";

export interface NewReviewInput {
  title: string;
  itemFamily: string;
  manufacturer: string;
  intendedUse: string;
  dataClass: DataClass;
  sourcePath: MemoRecord["sourcePath"];
  memoText: string;
  attachments: string[];
  priority?: CasePriority;
  assignedTo?: string;
  dueAt?: string;
  tags?: string[];
}

export type UsageCallType = AiApprovalPurpose;

// A single billed Bedrock model invocation. Token counts are stored raw; the
// dollar cost is derived at aggregation time so price-table changes apply
// consistently (see server/bedrockPricing.ts + server/metrics.ts).
export interface UsageEvent {
  id: string;
  userId: string;
  userEmail?: string;
  at: string;
  model: string;
  callType: UsageCallType;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs?: number;
}

export interface MetricTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
  avgLatencyMs: number;
}

export interface MetricBucket {
  key: string;
  label: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
}

export interface ModelPricingSummary {
  key: string;
  label: string;
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
  cacheWritePer1M: number;
}

export interface CostTimelinePoint {
  period: string;
  label: string;
  segments: Array<{ key: string; label: string; costUsd: number }>;
}

export interface UserUsageSummary {
  userId: string;
  email: string;
  name: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface AdminMetricAvailability {
  status: "available" | "unavailable";
  exact: boolean;
  asOf?: string;
  reason?: string;
}

export interface AdminMetricsAvailability {
  status: "complete" | "partial";
  usage: AdminMetricAvailability;
  accountTotal: AdminMetricAvailability;
  onlineUsers: AdminMetricAvailability;
  topUsers: AdminMetricAvailability;
}

export interface AdminMetrics {
  generatedAt: string;
  rangeDays: number;
  /** The inclusive UTC calendar-day window represented by every usage bucket. */
  rangeStart: string;
  rangeEnd: string;
  availability: AdminMetricsAvailability;
  totals: MetricTotals;
  byModel: MetricBucket[];
  byCallType: MetricBucket[];
  daily: MetricBucket[];
  monthlyByModel: CostTimelinePoint[];
  monthlyByCallType: CostTimelinePoint[];
  pricing: ModelPricingSummary[];
  topUsers: UserUsageSummary[];
  users: { total: number; online: number | null };
}

export interface UserAdminSummary {
  id: string;
  email: string;
  name: string;
  role: UserProfile["role"];
  createdAt: string;
  lastSeenAt?: string;
  online: boolean;
  usage: { costUsd: number; inputTokens: number; outputTokens: number; calls: number };
}
