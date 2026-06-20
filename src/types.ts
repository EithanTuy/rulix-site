export type EvidenceStatus = "strong" | "weak" | "missing" | "conflict";

export type ReviewStatus =
  | "draft"
  | "ready"
  | "needs-info"
  | "conflict"
  | "signed-off";

export type DataClass = "public" | "proprietary" | "export-controlled" | "itar-risk" | "cui";

export type AppView = "reviews" | "controls" | "evidence" | "corpus" | "users" | "settings";

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
}

export interface SourceChunk {
  id: string;
  documentId: string;
  title: string;
  locator: string;
  url: string;
  text: string;
  tags: string[];
}

export interface CorpusSnapshot {
  id: string;
  label: string;
  generatedAt: string;
  checksum: string;
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
}

export interface ReviewerDecision {
  action: "accept" | "request-info" | "override";
  notes: string;
  signedBy?: string;
  signedAt?: string;
}

export interface AuditEvent {
  id: string;
  memoId: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
  severity: "info" | "review" | "escalate";
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  role: "export-control-officer" | "reviewer" | "submitter" | "counsel";
  createdAt: string;
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
  email: string;
  persona: string;
  segment: string;
  city: string;
  state: string;
  outreachAngle: string;
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
}

export interface AccountReviewState {
  memos: MemoRecord[];
  selectedMemoId?: string;
  decisions: Record<string, ReviewerDecision>;
  auditEvents: AuditEvent[];
  analysisResults: Record<string, ReviewResult>;
  chatMessages: Record<string, MemoChatMessage[]>;
  outreachDrafts?: Record<string, OutreachDraft>;
}

export interface NewReviewInput {
  title: string;
  itemFamily: string;
  manufacturer: string;
  intendedUse: string;
  dataClass: DataClass;
  sourcePath: MemoRecord["sourcePath"];
  memoText: string;
  attachments: string[];
}

export type UsageCallType = "council" | "memo-chat" | "public-draft" | "outreach-writer";

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
  calls: number;
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
