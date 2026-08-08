import { createHash } from "node:crypto";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import type {
  AdversarialChallengeResult,
  CandidateAnalysisResult,
  CandidateResearchResult,
  CaseEvidence,
  CitationAuditResult,
  ClassificationCandidate,
  EvidenceAssessment,
  EvidenceFinding,
  FormatCheck,
  JurisdictionFinding,
  RegulatoryCitation
} from "../src/types";

export interface SynthesisAgentOutput {
  schemaVersion: "rulix.synthesis/v1";
  outcome: "classification-recommendation" | "ear99-recommendation" | "jurisdiction-escalation" | "unresolved";
  jurisdiction: JurisdictionFinding;
  recommended: ClassificationCandidate;
  alternatives: ClassificationCandidate[];
  findings: EvidenceFinding[];
  infoRequests: string[];
  formatChecks: FormatCheck[];
  confidenceExplanation: string;
  evidenceAssessment: EvidenceAssessment;
  decisionReadiness: {
    status: "ready-for-reviewer-signoff" | "blocked";
    summary: string;
    blockerFindingIds: string[];
  };
}

export interface ReportWritingAgentOutput {
  schemaVersion: "rulix.report-writing/v1";
  narrative: string;
}

export type AgentOutput =
  | CaseEvidence
  | JurisdictionFinding
  | CandidateResearchResult
  | CandidateAnalysisResult
  | AdversarialChallengeResult
  | CitationAuditResult
  | SynthesisAgentOutput
  | ReportWritingAgentOutput;

export type AgentOutputKind =
  | "intake-evidence"
  | "jurisdiction"
  | "candidate-research"
  | "candidate-analysis"
  | "adversarial-challenge"
  | "citation-verification"
  | "synthesis"
  | "report-writing";

export interface AgentOutputBindingContext {
  memoText: string;
  memoId: string;
  memoRevision: number;
  memoHash: string;
  allowedEvidenceIds?: Set<string>;
  allowedSourceIds?: Set<string>;
  allowedCandidateIds?: Set<string>;
  citationAuditPassed?: boolean;
  priorClaimIds?: Set<string>;
  regulatorySources?: RegulatoryCitation[];
}

const stringArray = (maxItems: number, maxLength = 1200) => ({
  type: "array",
  maxItems,
  items: { type: "string", minLength: 1, maxLength }
});

const citationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sourceId", "locator", "sourceDate", "contentHash", "exactText"],
  properties: {
    sourceId: { type: "string", minLength: 1, maxLength: 240 },
    locator: { type: "string", minLength: 1, maxLength: 500 },
    sourceDate: { type: "string", minLength: 8, maxLength: 40 },
    contentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    exactText: { type: "string", minLength: 1, maxLength: 12000 }
  }
} as const;

const candidateResearchItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "classification", "label", "scope", "inclusionReason", "factualQuestions", "regulatoryCitations"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 180 },
    classification: { type: "string", minLength: 1, maxLength: 180 },
    label: { type: "string", minLength: 1, maxLength: 300 },
    scope: { type: "string", enum: ["commodity", "software", "technology", "jurisdiction", "ear99"] },
    inclusionReason: { type: "string", minLength: 1, maxLength: 1800 },
    factualQuestions: stringArray(16, 800),
    regulatoryCitations: { type: "array", minItems: 1, maxItems: 24, items: citationSchema }
  }
} as const;

const classificationCandidateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["eccn", "label", "risk", "summary", "sourceChunkIds"],
  properties: {
    eccn: { type: "string", minLength: 1, maxLength: 180 },
    label: { type: "string", minLength: 1, maxLength: 300 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    supportingFacts: stringArray(20, 900),
    weakeningFacts: stringArray(20, 900),
    unresolvedFacts: stringArray(20, 900),
    rankingChangeFacts: stringArray(20, 900),
    comparison: { type: "string", maxLength: 1800 },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    summary: { type: "string", minLength: 1, maxLength: 2400 },
    sourceChunkIds: stringArray(40, 240)
  }
} as const;

const findingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "status", "title", "claim", "rationale", "sourceChunkIds", "agent", "severity"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 180 },
    status: { type: "string", enum: ["strong", "weak", "missing", "conflict"] },
    title: { type: "string", minLength: 1, maxLength: 900 },
    claim: { type: "string", minLength: 1, maxLength: 1800 },
    rationale: { type: "string", minLength: 1, maxLength: 2400 },
    excerpt: { type: "string", maxLength: 4000 },
    start: { type: "integer", minimum: 0 },
    end: { type: "integer", minimum: 0 },
    sourceChunkIds: stringArray(40, 240),
    agent: { type: "string", enum: [
      "intake-evidence", "jurisdiction", "candidate-research", "candidate-analysis",
      "adversarial-challenge", "citation-verification", "synthesis", "report-writing"
    ] },
    severity: { type: "string", enum: ["info", "review", "escalate"] },
    remediationKind: { type: "string", enum: ["editorial", "missing-fact", "missing-evidence", "reviewer-judgment"] },
    suggestedResolution: { type: "string", maxLength: 1800 },
    suggestedReplacement: { type: "string", maxLength: 12000 }
  }
} as const;

const jurisdictionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary", "rationale", "sourceChunkIds"],
  properties: {
    outcome: { type: "string", enum: ["ear-likely", "itar-risk", "other-agency-risk", "insufficient-info"] },
    summary: { type: "string", minLength: 1, maxLength: 1800 },
    rationale: { type: "string", minLength: 1, maxLength: 4000 },
    sourceChunkIds: stringArray(40, 240),
    evidenceIds: stringArray(40, 240),
    uncertainty: { type: "string", maxLength: 1800 }
  }
} as const;

const criterionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "locator", "criterion", "disposition", "explanation", "evidenceIds", "regulatoryCitations", "missingInformationQuestions"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 180 },
    locator: { type: "string", minLength: 1, maxLength: 500 },
    criterion: { type: "string", minLength: 1, maxLength: 4000 },
    disposition: { type: "string", enum: ["supported", "not-supported", "unresolved", "not-applicable"] },
    explanation: { type: "string", minLength: 1, maxLength: 4000 },
    evidenceIds: stringArray(40, 240),
    regulatoryCitations: { type: "array", maxItems: 30, items: citationSchema },
    missingInformationQuestions: stringArray(20, 900)
  }
} as const;

const schemas: Record<AgentOutputKind, object> = {
  "intake-evidence": {
    type: "object", additionalProperties: false,
    required: ["schemaVersion", "memoId", "memoRevision", "memoHash", "item", "evidence", "conflicts", "missingOrUnreadableRegions"],
    properties: {
      schemaVersion: { const: "rulix.case-evidence/v1" },
      memoId: { type: "string", minLength: 1, maxLength: 240 },
      memoRevision: { type: "integer", minimum: 1 },
      memoHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      item: {
        type: "object", additionalProperties: false,
        required: ["name", "components", "software", "firmware", "technology", "statedUses"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 500 }, model: { type: "string", maxLength: 300 },
          manufacturer: { type: "string", maxLength: 300 }, origin: { type: "string", maxLength: 300 },
          components: stringArray(40), software: stringArray(40), firmware: stringArray(40),
          technology: stringArray(40), statedUses: stringArray(40)
        }
      },
      evidence: {
        type: "array", maxItems: 240,
        items: {
          type: "object", additionalProperties: false,
          required: ["id", "documentId", "documentTitle", "evidenceKind", "subject", "value", "excerpt", "location", "contentHash"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 180 }, documentId: { type: "string", minLength: 1, maxLength: 240 },
            documentTitle: { type: "string", minLength: 1, maxLength: 500 },
            evidenceKind: { type: "string", enum: ["documented-fact", "user-assertion", "assumption", "conflict", "unreadable-region"] },
            subject: { type: "string", minLength: 1, maxLength: 500 }, value: { type: "string", minLength: 1, maxLength: 1800 },
            units: { type: "string", maxLength: 100 }, excerpt: { type: "string", minLength: 1, maxLength: 8000 },
            location: {
              type: "object", additionalProperties: false, required: ["kind", "label"],
              properties: { kind: { type: "string", enum: ["character-range", "page", "section"] }, start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 0 }, label: { type: "string", minLength: 1, maxLength: 500 } }
            },
            contentHash: { type: "string", pattern: "^[a-f0-9]{64}$" }
          }
        }
      },
      conflicts: stringArray(50, 1800), missingOrUnreadableRegions: stringArray(50, 1800)
    }
  },
  jurisdiction: jurisdictionSchema,
  "candidate-research": {
    type: "object", additionalProperties: false,
    required: ["schemaVersion", "searchSummary", "orderOfReviewApplied", "candidates", "ear99SearchComplete"],
    properties: {
      schemaVersion: { const: "rulix.candidate-research/v1" }, searchSummary: { type: "string", minLength: 1, maxLength: 4000 },
      orderOfReviewApplied: { type: "string", minLength: 1, maxLength: 4000 },
      candidates: { type: "array", maxItems: 16, items: candidateResearchItemSchema },
      ear99SearchComplete: { type: "boolean" }, noCandidateReason: { type: "string", maxLength: 1800 }
    }
  },
  "candidate-analysis": {
    type: "object", additionalProperties: false,
    required: ["schemaVersion", "candidateId", "classification", "outcome", "summary", "criteria", "exclusionsAndNotes", "missingInformationQuestions"],
    properties: {
      schemaVersion: { const: "rulix.candidate-analysis/v1" }, candidateId: { type: "string", minLength: 1, maxLength: 180 },
      classification: { type: "string", minLength: 1, maxLength: 180 }, outcome: { type: "string", enum: ["supported", "not-supported", "unresolved"] },
      summary: { type: "string", minLength: 1, maxLength: 4000 },
      criteria: { type: "array", minItems: 1, maxItems: 80, items: criterionSchema },
      exclusionsAndNotes: { type: "array", maxItems: 80, items: criterionSchema }, missingInformationQuestions: stringArray(30, 900)
    }
  },
  "adversarial-challenge": {
    type: "object", additionalProperties: false,
    required: ["schemaVersion", "summary", "concreteDefectFound", "challenges", "additionalCandidates", "inconsistentFactUses"],
    properties: {
      schemaVersion: { const: "rulix.adversarial-challenge/v1" }, summary: { type: "string", minLength: 1, maxLength: 4000 },
      concreteDefectFound: { type: "boolean" },
      challenges: {
        type: "array", maxItems: 30, items: {
          type: "object", additionalProperties: false,
          required: ["id", "severity", "summary", "affectedCandidateIds", "evidenceIds", "regulatoryCitations"],
          properties: { id: { type: "string", minLength: 1, maxLength: 180 }, severity: { type: "string", enum: ["material", "non-material"] }, summary: { type: "string", minLength: 1, maxLength: 3000 }, affectedCandidateIds: stringArray(20, 180), evidenceIds: stringArray(40, 240), regulatoryCitations: { type: "array", maxItems: 30, items: citationSchema } }
        }
      },
      additionalCandidates: { type: "array", maxItems: 8, items: candidateResearchItemSchema }, inconsistentFactUses: stringArray(30, 1800)
    }
  },
  "citation-verification": {
    type: "object", additionalProperties: false,
    required: ["schemaVersion", "passed", "summary", "claims"],
    properties: {
      schemaVersion: { const: "rulix.citation-audit/v1" }, passed: { type: "boolean" }, summary: { type: "string", minLength: 1, maxLength: 3000 },
      claims: { type: "array", maxItems: 500, items: { type: "object", additionalProperties: false, required: ["claimId", "status", "explanation", "citationIds"], properties: { claimId: { type: "string", minLength: 1, maxLength: 240 }, status: { type: "string", enum: ["verified", "unsupported", "inexact-quotation", "locator-mismatch", "too-general"] }, explanation: { type: "string", minLength: 1, maxLength: 2400 }, citationIds: stringArray(30, 240) } } }
    }
  },
  synthesis: {
    type: "object", additionalProperties: false,
    required: ["schemaVersion", "outcome", "jurisdiction", "recommended", "alternatives", "findings", "infoRequests", "formatChecks", "confidenceExplanation", "evidenceAssessment", "decisionReadiness"],
    properties: {
      schemaVersion: { const: "rulix.synthesis/v1" }, outcome: { type: "string", enum: ["classification-recommendation", "ear99-recommendation", "jurisdiction-escalation", "unresolved"] },
      jurisdiction: jurisdictionSchema, recommended: classificationCandidateSchema,
      alternatives: { type: "array", maxItems: 16, items: classificationCandidateSchema }, findings: { type: "array", maxItems: 160, items: findingSchema },
      infoRequests: stringArray(40, 900),
      formatChecks: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, required: ["key", "label", "pass"], properties: { key: { type: "string", minLength: 1, maxLength: 120 }, label: { type: "string", minLength: 1, maxLength: 300 }, pass: { type: "boolean" }, note: { type: "string", maxLength: 1200 } } } },
      confidenceExplanation: { type: "string", minLength: 1, maxLength: 2400 },
      evidenceAssessment: { type: "object", additionalProperties: false, required: ["level", "summary", "materialGaps", "nonMaterialGaps", "verifiedDispositiveFacts", "supportingSourceIds"], properties: { level: { type: "string", enum: ["strong", "partial", "weak"] }, summary: { type: "string", minLength: 1, maxLength: 2400 }, materialGaps: stringArray(40, 900), nonMaterialGaps: stringArray(40, 900), verifiedDispositiveFacts: stringArray(80, 900), supportingSourceIds: stringArray(80, 240) } },
      decisionReadiness: { type: "object", additionalProperties: false, required: ["status", "summary", "blockerFindingIds"], properties: { status: { type: "string", enum: ["ready-for-reviewer-signoff", "blocked"] }, summary: { type: "string", minLength: 1, maxLength: 1800 }, blockerFindingIds: stringArray(80, 180) } }
    }
  },
  "report-writing": { type: "object", additionalProperties: false, required: ["schemaVersion", "narrative"], properties: { schemaVersion: { const: "rulix.report-writing/v1" }, narrative: { type: "string", minLength: 1, maxLength: 30000 } } }
};

const ajv = new Ajv({ allErrors: true, strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
const validators = Object.fromEntries(
  Object.entries(schemas).map(([kind, schema]) => [kind, ajv.compile(schema)])
) as Record<AgentOutputKind, ValidateFunction>;

export class AgentOutputValidationError extends Error {
  readonly code = "agent_output_invalid";
  constructor(
    readonly kind: AgentOutputKind,
    readonly problems: string[]
  ) {
    super(`${kind} output is invalid: ${problems.join("; ")}`);
    this.name = "AgentOutputValidationError";
  }
}

export function validateAgentOutput<T extends AgentOutput>(
  kind: AgentOutputKind,
  value: unknown,
  context: AgentOutputBindingContext
): T {
  const validator = validators[kind];
  if (!validator(value)) throw new AgentOutputValidationError(kind, formatErrors(validator.errors));
  const output = value as T;
  const problems = validateBindings(kind, output, context);
  if (problems.length) throw new AgentOutputValidationError(kind, problems);
  return output;
}

export function schemaForAgent(kind: AgentOutputKind) {
  return schemas[kind];
}

function validateBindings(kind: AgentOutputKind, output: AgentOutput, context: AgentOutputBindingContext) {
  const problems: string[] = [];
  if (kind === "intake-evidence") {
    const evidence = output as CaseEvidence;
    if (evidence.memoId !== context.memoId || evidence.memoRevision !== context.memoRevision || evidence.memoHash !== context.memoHash) {
      problems.push("The evidence ledger is not bound to the approved memo snapshot.");
    }
    for (const item of evidence.evidence) {
      if (item.documentId !== `memo:${context.memoId}`) {
        problems.push(`Evidence ${item.id} is not bound to the approved case document.`);
      }
      if (sha256(item.excerpt) !== item.contentHash) {
        problems.push(`Evidence ${item.id} content hash does not match its exact memo excerpt.`);
      }
      const start = item.location.start;
      const end = item.location.end;
      if (item.location.kind === "character-range") {
        if (start === undefined || end === undefined || end <= start || context.memoText.slice(start, end) !== item.excerpt) {
          problems.push(`Evidence ${item.id} does not match the exact memo character range.`);
        }
      } else if (!context.memoText.includes(item.excerpt)) {
        problems.push(`Evidence ${item.id} excerpt does not exist in the approved memo.`);
      }
    }
  }

  for (const sourceId of sourceIds(output)) {
    if (context.allowedSourceIds && !context.allowedSourceIds.has(sourceId)) problems.push(`Unknown regulatory source ID ${sourceId}.`);
  }
  for (const citation of regulatoryCitations(output)) {
    if (!context.regulatorySources?.some((source) =>
      source.sourceId === citation.sourceId
      && source.locator === citation.locator
      && source.sourceDate === citation.sourceDate
      && source.contentHash === citation.contentHash
      && source.exactText === citation.exactText
    )) {
      problems.push(`Regulatory citation ${citation.sourceId} is not an exact result returned by an approved corpus tool.`);
    }
  }
  for (const evidenceId of evidenceIds(output)) {
    if (context.allowedEvidenceIds && !context.allowedEvidenceIds.has(evidenceId)) problems.push(`Unknown case evidence ID ${evidenceId}.`);
  }
  for (const candidateId of candidateIds(kind, output)) {
    if (context.allowedCandidateIds && !context.allowedCandidateIds.has(candidateId)) problems.push(`Unknown candidate ID ${candidateId}.`);
  }
  if (kind === "citation-verification" && context.priorClaimIds) {
    for (const item of (output as CitationAuditResult).claims) {
      if (!context.priorClaimIds.has(item.claimId)) problems.push(`Citation audit references unknown claim ${item.claimId}.`);
    }
  }
  if (kind === "synthesis" && context.citationAuditPassed === false && (output as SynthesisAgentOutput).outcome !== "unresolved") {
    problems.push("Synthesis must remain unresolved when the citation audit failed.");
  }
  return [...new Set(problems)];
}

function sourceIds(output: AgentOutput) {
  const ids: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.sourceId === "string") ids.push(record.sourceId);
    if (Array.isArray(record.sourceChunkIds)) ids.push(...record.sourceChunkIds.filter((item): item is string => typeof item === "string"));
    Object.values(record).forEach(visit);
  };
  visit(output);
  return ids;
}

function regulatoryCitations(output: AgentOutput) {
  const citations: RegulatoryCitation[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (
      typeof record.sourceId === "string"
      && typeof record.locator === "string"
      && typeof record.sourceDate === "string"
      && typeof record.contentHash === "string"
      && typeof record.exactText === "string"
    ) citations.push(record as unknown as RegulatoryCitation);
    Object.values(record).forEach(visit);
  };
  visit(output);
  return citations;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceIds(output: AgentOutput) {
  const ids: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.evidenceIds)) ids.push(...record.evidenceIds.filter((item): item is string => typeof item === "string"));
    Object.values(record).forEach(visit);
  };
  visit(output);
  return ids;
}

function candidateIds(kind: AgentOutputKind, output: AgentOutput) {
  if (kind === "candidate-analysis") return [(output as CandidateAnalysisResult).candidateId];
  if (kind === "adversarial-challenge") return (output as AdversarialChallengeResult).challenges.flatMap((item) => item.affectedCandidateIds);
  return [];
}

function formatErrors(errors: ErrorObject[] | null | undefined) {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
}
