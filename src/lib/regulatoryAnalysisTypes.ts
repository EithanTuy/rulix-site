export type TruthValue = "met" | "not_met" | "unknown" | "not_applicable";

export type RegulatoryJurisdiction =
  | "EAR"
  | "ITAR"
  | "OTHER"
  | "OUTSIDE_SCOPE"
  | "UNRESOLVED";

export type ScopeKind =
  | "SYSTEM"
  | "EQUIPMENT"
  | "ASSEMBLY"
  | "COMPONENT"
  | "PART"
  | "ACCESSORY"
  | "ATTACHMENT"
  | "MATERIAL"
  | "FIRMWARE"
  | "SOFTWARE"
  | "SOURCE_CODE"
  | "TECHNOLOGY"
  | "TECHNICAL_DATA"
  | "SERVICE"
  | "UNKNOWN";

export type AnalysisWorkflowState =
  | "EVIDENCE_INCOMPLETE"
  | "CANDIDATES_IDENTIFIED"
  | "RULE_EVALUATION_UNRESOLVED"
  | "READY_FOR_EXPERT_REVIEW"
  | "HUMAN_APPROVED"
  | "ESCALATION_REQUIRED"
  | "CORPUS_UPDATE_REQUIRED";

export interface RegulatorySourceSnapshot {
  id: string;
  jurisdiction: RegulatoryJurisdiction;
  issuingAuthority: string;
  title: string;
  citation: string;
  canonicalUrl: string;
  apiUrl?: string;
  retrievedAt: string;
  publicationDate?: string;
  amendmentDate?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  currentThrough?: string;
  pointInTimeDate: string;
  mimeType: string;
  rawByteHash: string;
  byteLength: number;
  parserVersion: string;
  corpusBuildVersion: string;
  supersedesSnapshotId?: string;
  verificationStatus: "pending_review" | "verified" | "failed" | "superseded";
}

export interface RegulatorySourceLocator {
  sourceSnapshotId: string;
  citation: string;
  title: string;
  part?: string;
  supplement?: string;
  eccn?: string;
  paragraph?: string;
  note?: string;
  sectionTitle?: string;
  blockIndex?: number;
  normalizedTextHash?: string;
}

export interface EvidenceFact {
  id: string;
  scopeItemId: string;
  field: string;
  originalText: string;
  normalizedValue?: string | number | boolean;
  originalValue?: string | number | boolean;
  originalUnit?: string;
  normalizedUnit?: string;
  sourceDocumentId: string;
  page?: number;
  locator?: string;
  extractionMethod: "document-text" | "document-model" | "reviewer" | "import";
  extractionConfidence?: "high" | "medium" | "low";
  reviewerStatus: "unreviewed" | "confirmed" | "rejected" | "conflicting";
  conflictState: "none" | "potential" | "confirmed";
  negated: boolean;
  analysisEligible: boolean;
  observedAt: string;
  sourceHash: string;
}

export interface ScopeItem {
  id: string;
  parentScopeItemId?: string;
  name: string;
  kind: ScopeKind;
  manufacturer?: string;
  model?: string;
  version?: string;
  configuration?: string;
  evidenceFactIds: string[];
  status: "identified" | "potential" | "unsupported";
}

export type RuleOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "greater_than_or_equal"
  | "less_than"
  | "less_than_or_equal"
  | "between"
  | "contains"
  | "defined_term"
  | "specially_designed_branch";

export type RuleExpression =
  | { type: "all"; children: RuleExpression[] }
  | { type: "any"; children: RuleExpression[] }
  | { type: "not"; child: RuleExpression }
  | { type: "predicate"; predicateId: string }
  | { type: "reference"; ruleId: string };

export interface RulePredicate {
  id: string;
  field: string;
  operator: RuleOperator;
  expectedValue?: string | number | boolean;
  upperValue?: string | number;
  unit?: string;
  sourceLocator: RegulatorySourceLocator;
  missingFactQuestion: string;
}

export interface RegulatoryRule {
  id: string;
  jurisdiction: RegulatoryJurisdiction;
  classification: string;
  paragraph: string;
  category?: string;
  productGroup?: string;
  heading: string;
  sourceLocator: RegulatorySourceLocator;
  expression: RuleExpression;
  predicates: RulePredicate[];
  notes: RegulatorySourceLocator[];
  exclusions: RegulatorySourceLocator[];
  crossReferences: RegulatorySourceLocator[];
  validationStatus: "expert_validated" | "parser_generated_unreviewed" | "unsupported";
  validationRecordId?: string;
}

export interface ElementEvaluation {
  predicateId: string;
  label: string;
  result: TruthValue;
  evidenceFactIds: string[];
  sourceLocator: RegulatorySourceLocator;
  explanation: string;
  missingFactQuestion?: string;
  conversion?: string;
}

export interface CandidateEvaluation {
  scopeItemId: string;
  ruleId: string;
  classification: string;
  paragraph: string;
  heading: string;
  retrievalReasons: string[];
  status: "supported" | "rejected" | "unresolved" | "unsupported_product_scope";
  elementEvaluations: ElementEvaluation[];
  blockingIssues: string[];
  alternativeRuleIds: string[];
  sourceLocator: RegulatorySourceLocator;
  authoritativeText?: string;
  authoritativeTextStatus: "exact_snapshot_text" | "unavailable";
}

export interface AnalysisBlocker {
  id: string;
  code:
    | "CORPUS_UNAVAILABLE"
    | "CORPUS_PENDING_REVIEW"
    | "CORPUS_STALE"
    | "SOURCE_INTEGRITY_FAILED"
    | "QUOTATION_INTEGRITY_FAILED"
    | "SUPPORT_INTEGRITY_FAILED"
    | "CANDIDATE_SET_INCOMPLETE"
    | "MISSING_REQUIRED_FACT"
    | "CONFLICTING_EVIDENCE"
    | "JURISDICTION_UNRESOLVED"
    | "UNSUPPORTED_PRODUCT_GROUP"
    | "SPECIALLY_DESIGNED_UNRESOLVED"
    | "ENCRYPTION_ESCALATION_REQUIRED"
    | "MODEL_OUTPUT_INVALID"
    | "RULE_ENGINE_FAILED"
    | "LEGACY_REANALYSIS_REQUIRED";
  title: string;
  detail: string;
  severity: "blocking" | "warning";
  scopeItemId?: string;
  ruleId?: string;
  predicateId?: string;
}

export interface CitationIntegrityResult {
  sourceIntegrity: "passed" | "failed" | "pending_review";
  quotationIntegrity: "passed" | "failed" | "not_checked";
  supportIntegrity: "passed" | "failed" | "not_checked";
  detail: string[];
}

export interface JurisdictionAnalysis {
  outcome: RegulatoryJurisdiction;
  regimesConsidered: RegulatoryJurisdiction[];
  evidenceFactIds: string[];
  applicableRuleLocators: RegulatorySourceLocator[];
  unresolvedQuestions: string[];
  escalationRecommendation?: string;
  summary: string;
}

export interface ClassificationOutcome {
  kind: "recommendation" | "ear99" | "abstention";
  classification?: string;
  paragraph?: string;
  statement: string;
  supportedCandidateRuleIds: string[];
  blockerIds: string[];
}

export interface TransactionAnalysis {
  status: "not_started" | "incomplete" | "ready_for_review";
  separateFromClassification: true;
  statement: string;
  fields: Array<{
    field: string;
    value?: string;
    state: "known" | "unknown" | "not_in_scope";
  }>;
}

export interface DefensibleClassificationAnalysis {
  schemaVersion: "rulix.classification-analysis/v1";
  analysisMethod: "evidence-and-rules" | "legacy-keyword-model";
  analysisId: string;
  createdAt: string;
  analysisDate: string;
  revision: number;
  workflowState: AnalysisWorkflowState;
  corpus: {
    version: string;
    checksum: string;
    currentThrough?: string;
    verificationStatus: "pending_review" | "verified" | "failed" | "unavailable";
    parserVersion: string;
    workflowVersion: string;
    reportTemplateVersion: string;
  };
  scopeItems: ScopeItem[];
  evidenceFacts: EvidenceFact[];
  jurisdiction: JurisdictionAnalysis;
  candidates: CandidateEvaluation[];
  blockers: AnalysisBlocker[];
  outcome: ClassificationOutcome;
  missingInformationQuestions: string[];
  alternativesAndCounterarguments: string[];
  speciallyDesignedTrace: Array<{
    regime: "EAR" | "ITAR";
    state: TruthValue;
    steps: ElementEvaluation[];
  }>;
  transactionAnalysis: TransactionAnalysis;
  citationIntegrity: CitationIntegrityResult;
  legacy?: {
    originalMethod: string;
    reanalysisRequired: true;
    priorRecommendationPreservedForAudit?: string;
  };
}
