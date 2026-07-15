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
  proposedMemoText?: string;
  applied?: boolean;
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

export type UsageCallType =
  | "council"
  | "memo-chat"
  | "public-draft"
  | "outreach-writer"
  | "outreach-personalization"
  | "lead-search"
  | "memo-builder"
  | "document-extraction";

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

export interface AdminMetrics {
  generatedAt: string;
  rangeDays: number;
  totals: MetricTotals;
  byModel: MetricBucket[];
  byCallType: MetricBucket[];
  daily: MetricBucket[];
  monthlyByModel: CostTimelinePoint[];
  monthlyByCallType: CostTimelinePoint[];
  pricing: ModelPricingSummary[];
  topUsers: UserUsageSummary[];
  users: { total: number; online: number };
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
