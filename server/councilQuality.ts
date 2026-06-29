import { officialCorpus } from "../src/data/corpus";
import { detectFormatChecks } from "../src/lib/eccnReview";
import type {
  AgentRole,
  ClassificationCandidate,
  CouncilAgentRun,
  EvidenceFinding,
  EvidenceStatus,
  FormatCheck,
  JurisdictionFinding,
  MemoRecord,
  ReviewResult
} from "../src/types";

export type CouncilDepth = NonNullable<ReviewResult["provider"]["depth"]>;

export type AiCouncilPayload = Partial<
  Pick<
    ReviewResult,
    "jurisdiction" | "recommended" | "alternatives" | "findings" | "infoRequests" | "agents" | "formatChecks"
  >
>;

export const COUNCIL_AGENT_ROLES: AgentRole[] = [
  "memo-parser",
  "jurisdiction-gate",
  "eccn-candidate",
  "evidence-mapper",
  "citation-verifier",
  "risk-reviewer",
  "report-writer"
];

const EVIDENCE_STATUSES: EvidenceStatus[] = ["strong", "weak", "missing", "conflict"];
const SOURCE_IDS = new Set(officialCorpus.chunks.map((chunk) => chunk.id));

export interface MergeCouncilPayloadOptions {
  providerLabel: string;
  depth: CouncilDepth;
}

export function mergeCouncilPayload(
  memo: MemoRecord,
  localResult: ReviewResult,
  payload: AiCouncilPayload,
  options: MergeCouncilPayloadOptions
): ReviewResult {
  const findings = Array.isArray(payload.findings)
    ? payload.findings
        .map((finding, index) =>
          normalizeFinding(memo.memoText, finding, localResult.findings[index], index)
        )
        .filter((finding): finding is EvidenceFinding => Boolean(finding))
    : [];

  const mergedFindings = mergeFindings(findings, localResult.findings);
  const infoRequests = sanitizeStringArray(payload.infoRequests).slice(0, 10);
  const mergedInfoRequests = uniqueStrings([...infoRequests, ...buildInfoRequests(mergedFindings)]).slice(0, 10);
  const recommended = capCandidateConfidence(
    normalizeRecommendedCandidate(memo.memoText, payload.recommended, localResult.recommended),
    mergedFindings
  );

  return {
    ...localResult,
    generatedAt: new Date().toISOString(),
    modelPolicy: `${options.providerLabel} ${options.depth} full-council review with deterministic citation/range validation; human export-control signoff required.`,
    jurisdiction: normalizeJurisdiction(payload.jurisdiction, localResult.jurisdiction),
    recommended,
    alternatives: Array.isArray(payload.alternatives)
      ? payload.alternatives
          .map((candidate, index) => normalizeCandidate(candidate, localResult.alternatives[index]))
          .filter((candidate): candidate is ClassificationCandidate => Boolean(candidate))
      : localResult.alternatives,
    findings: mergedFindings,
    infoRequests: mergedInfoRequests,
    agents: normalizeAgents(payload.agents, localResult.agents, mergedFindings),
    formatChecks: mergeFormatChecks(memo.memoText, payload.formatChecks)
  };
}

export function mergeFindings(aiFindings: EvidenceFinding[], localFindings: EvidenceFinding[]) {
  if (aiFindings.length === 0) return localFindings;
  const localGuardrails = localFindings.filter(
    (finding) => finding.status === "missing" || finding.status === "conflict"
  );
  return [
    ...aiFindings,
    ...localGuardrails.filter((localFinding) =>
      !aiFindings.some((aiFinding) => isSimilarFinding(aiFinding, localFinding))
    )
  ].sort(sortMergedFindings);
}

function isSimilarFinding(a: EvidenceFinding, b: EvidenceFinding) {
  const sameTitle = a.title.trim().toLowerCase() === b.title.trim().toLowerCase();
  const sharedSource = a.sourceChunkIds.some((id) => b.sourceChunkIds.includes(id));
  return sameTitle || (sharedSource && a.agent === b.agent && a.status === b.status);
}

function sortMergedFindings(a: EvidenceFinding, b: EvidenceFinding) {
  const weight = { conflict: 0, missing: 1, weak: 2, strong: 3 };
  if (weight[a.status] !== weight[b.status]) return weight[a.status] - weight[b.status];
  return (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER);
}

function normalizeRecommendedCandidate(
  memoText: string,
  value: unknown,
  fallback: ClassificationCandidate
) {
  const candidate = normalizeCandidate(value, fallback) ?? fallback;
  if (isUnsupportedFamilyShift(memoText, candidate, fallback)) {
    return fallback;
  }
  return candidate;
}

function capCandidateConfidence(
  candidate: ClassificationCandidate,
  findings: EvidenceFinding[]
): ClassificationCandidate {
  let cap = 1;
  const hasStrongSupport = findings.some(
    (finding) =>
      finding.status === "strong" &&
      finding.sourceChunkIds.some((id) => candidate.sourceChunkIds.includes(id))
  );
  const hasBlocker = findings.some(
    (finding) => finding.status === "missing" || finding.status === "conflict"
  );

  if (!hasStrongSupport) cap = Math.min(cap, 0.74);
  if (hasBlocker) cap = Math.min(cap, 0.82);

  if (candidate.confidence <= cap) return candidate;
  return {
    ...candidate,
    confidence: cap,
    summary: `${candidate.summary} Backend validation capped confidence because source support or blockers require reviewer verification.`
  };
}

function isUnsupportedFamilyShift(
  memoText: string,
  candidate: ClassificationCandidate,
  fallback: ClassificationCandidate
) {
  const candidateFamily = candidateCategory(candidate);
  const fallbackFamily = candidateCategory(fallback);
  return Boolean(
    candidateFamily &&
      fallbackFamily &&
      candidateFamily !== fallbackFamily &&
      !memoSupportsCategory(memoText, candidateFamily)
  );
}

function candidateCategory(candidate: ClassificationCandidate) {
  const text = `${candidate.eccn} ${candidate.label} ${candidate.summary}`.toLowerCase();
  if (/6a005|laser|femtosecond|wavelength/.test(text)) return "laser";
  if (/6a003|camera|imaging|sensor/.test(text)) return "camera";
  if (/cryogenic|cryostat|low-temperature|3a001\.a\.5/.test(text)) return "cryogenic";
  if (/3d001|quantum|\brf\b|microwave|electronics|firmware|software/.test(text)) return "electronics";
  if (/ear99|no specific ccl|classification path/.test(text)) return "ear99";
  return undefined;
}

function memoSupportsCategory(memoText: string, category: string) {
  const text = memoText.toLowerCase();
  if (category === "laser") return /laser|femtosecond|wavelength|pulse energy|beam quality/.test(text);
  if (category === "camera") return /camera|imaging|cmos|frames per second|fps|sensor/.test(text);
  if (category === "cryogenic") return /cryogenic|cryostat|pulse tube|joule-thomson|dewar|1\.2 k/.test(text);
  if (category === "electronics") return /quantum|microwave|\brf\b|waveform|qubit|firmware|software|electronics/.test(text);
  if (category === "ear99") return /manufacturer classification|ccl screening|no listed performance|ear99/.test(text);
  return false;
}

function normalizeJurisdiction(
  value: unknown,
  fallback: JurisdictionFinding
): JurisdictionFinding {
  const input = asRecord(value);
  if (!input) return fallback;

  const outcome =
    input.outcome === "ear-likely" ||
    input.outcome === "itar-risk" ||
    input.outcome === "insufficient-info"
      ? input.outcome
      : fallback.outcome;

  return {
    outcome,
    summary: asString(input.summary, fallback.summary),
    rationale: asString(input.rationale, fallback.rationale),
    sourceChunkIds: normalizeChunkIds(input.sourceChunkIds, fallback.sourceChunkIds)
  };
}

function normalizeCandidate(
  value: unknown,
  fallback?: ClassificationCandidate
): ClassificationCandidate | undefined {
  const input = asRecord(value);
  if (!input && !fallback) return undefined;
  if (!input) return fallback;

  const validSourceIds = normalizeChunkIds(input.sourceChunkIds, []);
  const hasValidSourceIds = validSourceIds.length > 0;
  const sourceChunkIds = hasValidSourceIds
    ? validSourceIds
    : normalizeChunkIds(fallback?.sourceChunkIds, ["chunk-eccn-method"]);

  return {
    eccn: asString(input.eccn, fallback?.eccn ?? "Review needed"),
    label: asString(input.label, fallback?.label ?? "Classification review needed"),
    confidence: hasValidSourceIds
      ? asConfidence(input.confidence, fallback?.confidence ?? 0.5)
      : Math.min(asConfidence(input.confidence, fallback?.confidence ?? 0.5), 0.55),
    risk: input.risk === "low" || input.risk === "medium" || input.risk === "high"
      ? input.risk
      : fallback?.risk ?? "medium",
    summary: asString(input.summary, fallback?.summary ?? "Additional reviewer analysis is required."),
    sourceChunkIds
  };
}

function normalizeFinding(
  memoText: string,
  value: unknown,
  fallback: EvidenceFinding | undefined,
  index: number
): EvidenceFinding | undefined {
  const input = asRecord(value);
  if (!input && !fallback) return undefined;
  if (!input) return fallback;

  const sourceChunkIds = normalizeChunkIds(input.sourceChunkIds, []);
  if (sourceChunkIds.length === 0) return undefined;

  const excerpt = asString(input.excerpt, fallback?.excerpt ?? "");
  const range = locateExcerpt(memoText, excerpt);
  const status = EVIDENCE_STATUSES.includes(input.status as EvidenceStatus)
    ? (input.status as EvidenceStatus)
    : fallback?.status ?? "weak";
  const agent = COUNCIL_AGENT_ROLES.includes(input.agent as AgentRole)
    ? (input.agent as AgentRole)
    : fallback?.agent ?? "risk-reviewer";
  const severity =
    input.severity === "info" || input.severity === "review" || input.severity === "escalate"
      ? input.severity
      : fallback?.severity ?? (status === "conflict" ? "escalate" : "review");

  const normalized: EvidenceFinding = {
    id: asString(input.id, fallback?.id ?? `ai-finding-${index + 1}`),
    status,
    title: asString(input.title, fallback?.title ?? "Review finding"),
    claim: asString(input.claim, fallback?.claim ?? (excerpt || "Review supporting evidence.")),
    rationale: asString(input.rationale, fallback?.rationale ?? "Reviewer should verify this claim."),
    excerpt: excerpt || fallback?.excerpt,
    start: range?.start ?? fallback?.start,
    end: range?.end ?? fallback?.end,
    sourceChunkIds,
    agent,
    severity
  };

  return softenLowRiskProceduralBlocker(memoText, normalized);
}

function softenLowRiskProceduralBlocker(memoText: string, finding: EvidenceFinding) {
  const findingText = `${finding.title} ${finding.claim} ${finding.rationale}`;
  if (
    (finding.status === "missing" || finding.status === "conflict") &&
    isLowRiskEar99Memo(memoText) &&
    !/pulse energy|spectral sensitivity|cooling capacity|timing resolution|source code|firmware.*provided|software.*provided|radiation hardening present|encryption present/i.test(findingText)
  ) {
    return {
      ...finding,
      status: "weak" as const,
      severity: finding.severity === "escalate" ? "review" as const : finding.severity,
      rationale: `${finding.rationale} Backend validation downgraded this to procedural guidance because the memo documents an EAR99-style item with no affirmative defense indicators or concrete controlled-parameter gap.`
    };
  }
  return finding;
}

function isLowRiskEar99Memo(memoText: string) {
  const text = memoText.toLowerCase();
  const hasEar99Path = /ear99|manufacturer classification|ccl screening|no listed performance/.test(text);
  const hasAffirmativeDefenseCue = /weapon|missile|defense|usml|nuclear|military end-use|military application/.test(text);
  return hasEar99Path && !hasAffirmativeDefenseCue;
}

function normalizeAgents(
  value: unknown,
  fallback: CouncilAgentRun[],
  findings: EvidenceFinding[]
): CouncilAgentRun[] {
  const inputs = Array.isArray(value) ? value.map(asRecord).filter(Boolean) : [];
  return fallback.map((agent) => {
    const input = inputs.find((item) => item?.role === agent.role);
    const roleFindings = findings.filter((finding) => finding.agent === agent.role);
    const blockers = roleFindings.filter(
      (finding) => finding.status === "missing" || finding.status === "conflict"
    );
    const validatedStatus = blockers.length > 0 ? "blocked" : "complete";
    if (!input) {
      return {
        ...agent,
        status: validatedStatus
      };
    }

    return {
      role: agent.role,
      label: asString(input.label, agent.label),
      status: validatedStatus,
      summary:
        input.status === "blocked" && validatedStatus === "complete"
          ? "No blocking issue found after backend validation."
          : asString(input.summary, agent.summary)
    };
  });
}

function buildInfoRequests(findings: EvidenceFinding[]) {
  return findings
    .filter((finding) => finding.status === "missing" || finding.status === "weak")
    .map((finding) => finding.claim);
}

function normalizeChunkIds(value: unknown, fallback: string[]) {
  const ids = sanitizeStringArray(value).filter((id) => SOURCE_IDS.has(id));
  return ids.length > 0 ? ids : fallback.filter((id) => SOURCE_IDS.has(id));
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function sanitizeStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function locateExcerpt(memoText: string, excerpt: string) {
  if (!excerpt.trim()) return undefined;
  const index = memoText.toLowerCase().indexOf(excerpt.trim().toLowerCase());
  if (index < 0) return undefined;
  return { start: index, end: index + excerpt.trim().length };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 900) : fallback;
}

function asConfidence(value: unknown, fallback: number) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(0, Math.min(1, numberValue));
}

function mergeFormatChecks(memoText: string, aiChecks: FormatCheck[] | undefined): FormatCheck[] {
  const deterministic = detectFormatChecks(memoText);
  if (!Array.isArray(aiChecks) || aiChecks.length === 0) return deterministic;
  const aiMap = new Map(aiChecks.map((c) => [c.key, c]));
  const merged = deterministic.map((det) => aiMap.get(det.key) ?? det);
  for (const aiCheck of aiChecks) {
    if (!deterministic.some((d) => d.key === aiCheck.key)) merged.push(aiCheck);
  }
  return merged;
}
