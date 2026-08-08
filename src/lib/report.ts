import type {
  AuditEvent,
  MemoRecord,
  RegulatoryCitation,
  ReviewerDecision,
  ReviewResult
} from "../types";

export function buildReviewReport(
  memo: MemoRecord,
  result: ReviewResult,
  decision?: ReviewerDecision,
  auditEvents: AuditEvent[] = []
) {
  const findings = result.findings.length
    ? result.findings.map((finding) => [
        `### ${finding.title}`,
        `- Status: ${finding.status}`,
        `- Severity: ${finding.severity}`,
        `- Claim: ${finding.claim}`,
        `- Rationale: ${finding.rationale}`,
        finding.excerpt ? `- Memo excerpt: ${quote(finding.excerpt)}` : ""
      ].filter(Boolean).join("\n")).join("\n\n")
    : "- No evidence findings were published.";
  const evidence = result.caseEvidence?.evidence.length
    ? result.caseEvidence.evidence.map((record) => [
        `### ${record.id}: ${record.subject}`,
        `- Kind: ${record.evidenceKind}`,
        `- Value: ${record.value}${record.units ? ` ${record.units}` : ""}`,
        `- Exact memo excerpt: ${quote(record.excerpt)}`,
        `- Location: ${record.location.label}`,
        `- Content hash: ${record.contentHash}`
      ].join("\n")).join("\n\n")
    : "- No case-evidence artifact was published.";
  const candidates = result.candidateResearch?.candidates.length
    ? result.candidateResearch.candidates.map((candidate) => [
        `### ${candidate.classification}: ${candidate.label}`,
        `- Candidate ID: ${candidate.id}`,
        `- Scope: ${candidate.scope}`,
        `- Inclusion reason: ${candidate.inclusionReason}`,
        `- Factual questions:\n${bullets(candidate.factualQuestions)}`,
        `- Regulatory citations:\n${citationList(candidate.regulatoryCitations)}`
      ].join("\n")).join("\n\n")
    : "- No candidate-research artifact was published.";
  const analyses = result.candidateAnalyses?.length
    ? result.candidateAnalyses.map((analysis) => [
        `### ${analysis.classification} (${analysis.outcome})`,
        analysis.summary,
        ...[...analysis.criteria, ...analysis.exclusionsAndNotes].map((criterion) => [
          `#### ${criterion.locator}: ${criterion.criterion}`,
          `- Disposition: ${criterion.disposition}`,
          `- Explanation: ${criterion.explanation}`,
          `- Case evidence IDs: ${criterion.evidenceIds.join(", ") || "none"}`,
          `- Missing-information questions:\n${bullets(criterion.missingInformationQuestions)}`,
          `- Regulatory citations:\n${citationList(criterion.regulatoryCitations)}`
        ].join("\n")),
        `#### Candidate-level missing information\n${bullets(analysis.missingInformationQuestions)}`
      ].join("\n\n")).join("\n\n")
    : "- No candidate-analysis artifacts were published.";
  const challenge = result.adversarialChallenge
    ? [
        result.adversarialChallenge.summary,
        `- Concrete defect found: ${result.adversarialChallenge.concreteDefectFound}`,
        `- Inconsistent fact uses:\n${bullets(result.adversarialChallenge.inconsistentFactUses)}`,
        ...result.adversarialChallenge.challenges.map((item) => [
          `### ${item.id}: ${item.severity}`,
          item.summary,
          `- Affected candidate IDs: ${item.affectedCandidateIds.join(", ") || "none"}`,
          `- Evidence IDs: ${item.evidenceIds.join(", ") || "none"}`,
          `- Regulatory citations:\n${citationList(item.regulatoryCitations)}`
        ].join("\n")),
        result.adversarialChallenge.additionalCandidates.length
          ? `### Additional candidates raised\n${result.adversarialChallenge.additionalCandidates.map((candidate) => `- ${candidate.classification} (${candidate.id}): ${candidate.inclusionReason}`).join("\n")}`
          : "### Additional candidates raised\n- None"
      ].join("\n\n")
    : "- No adversarial-challenge artifact was published.";
  const citationAudit = result.citationAudit
    ? [
        `Passed: ${result.citationAudit.passed}`,
        result.citationAudit.summary,
        ...result.citationAudit.claims.map((claim) =>
          `- ${claim.claimId}: ${claim.status} - ${claim.explanation} (citations: ${claim.citationIds.join(", ") || "none"})`
        )
      ].join("\n")
    : "- No citation-audit artifact was published.";
  const invocations = result.workflowInvocations?.length
    ? result.workflowInvocations.map((invocation) => [
        `### ${invocation.role}${invocation.candidateId ? ` / ${invocation.candidateId}` : ""}`,
        `- Invocation ID: ${invocation.invocationId}`,
        `- Status: ${invocation.status}`,
        `- Model: ${invocation.model}`,
        `- Prompt version: ${invocation.promptVersion}`,
        `- Attempt: ${invocation.attempt}`,
        `- Provider calls: ${invocation.providerCallCount ?? "unavailable"}`,
        `- Token usage: ${invocation.usage?.totalTokens ?? "unavailable"}`,
        `- Input artifact hashes: ${invocation.inputArtifactHashes.join(", ") || "none"}`,
        `- Output artifact: ${invocation.outputArtifactId ?? "unavailable"}`,
        `- Output artifact hash: ${invocation.outputArtifactHash ?? "unavailable"}`,
        `- Tool calls: ${invocation.toolCalls?.map((call) => `${call.tool}:${call.resultHash}`).join(", ") || "none"}`
      ].join("\n")).join("\n\n")
    : "- No invocation records were published.";
  const exactCitations = citationList(uniqueRegulatoryCitations(result));
  const auditLines = auditEvents.length
    ? auditEvents.map((event) => `- ${event.at} | ${event.actor} | ${event.action}: ${event.detail}`).join("\n")
    : "- No audit events recorded.";

  return `# ECCN Multi-Agent Review Report

Document: ${memo.title}
Code: ${memo.documentCode}
Generated: ${result.generatedAt}
Result ID: ${result.id ?? "unavailable"}
Result hash: ${result.resultHash ?? "unavailable"}

## Reproducibility Bindings

- Exact memo revision: ${result.memoRevision ?? memo.revision ?? "unknown"}
- Memo content hash: ${memo.contentHash ?? "unavailable"}
- AI input hash: ${result.inputHash ?? "unavailable"}
- Workflow run ID: ${result.workflowId ?? "unavailable"}
- Workflow version: ${result.workflowVersion ?? "unavailable"}
- Corpus snapshot ID: ${result.corpusId}
- Corpus checksum: ${result.corpusChecksum ?? "unavailable"}
- Provider: ${result.provider.label}
- Model: ${result.provider.model}
- Model policy: ${result.modelPolicy}
- Analysis depth: ${result.provider.depth ?? "standard"}
- Data class: ${memo.dataClass ?? "unclassified"}

These bindings identify the exact memo, corpus, workflow, models, agent invocations, and immutable artifact hashes used for this recommendation.

## AI Recommendation

- Outcome: ${result.outcome ?? "unresolved"}
- Classification: ${result.recommended.eccn} - ${result.recommended.label}
- Risk: ${result.recommended.risk}
- Decision readiness: ${result.decisionReadiness?.status ?? "blocked"}
- Readiness summary: ${result.decisionReadiness?.summary ?? "Unavailable"}
- Confidence explanation: ${result.confidenceExplanation ?? "Unavailable"}

${result.recommended.summary}

## Report Writer Narrative

${result.reportNarrative ?? "No report-writer narrative was published."}

## Jurisdiction Agent Output

- Outcome: ${result.jurisdiction.outcome}
- Summary: ${result.jurisdiction.summary}
- Rationale: ${result.jurisdiction.rationale}

## Intake Evidence Ledger

${evidence}

## Candidate Research

${result.candidateResearch ? `Search summary: ${result.candidateResearch.searchSummary}\n\nOrder of review: ${result.candidateResearch.orderOfReviewApplied}\n\nEAR99 search complete: ${result.candidateResearch.ear99SearchComplete}\n\n` : ""}${candidates}

## Element-by-Element Candidate Analyses

${analyses}

## Adversarial Challenge

${challenge}

## Citation Verification

${citationAudit}

## Evidence Assessment

- Level: ${result.evidenceAssessment?.level ?? "unavailable"}
- Summary: ${result.evidenceAssessment?.summary ?? "Unavailable"}
- Verified dispositive facts:\n${bullets(result.evidenceAssessment?.verifiedDispositiveFacts ?? [])}
- Material gaps:\n${bullets(result.evidenceAssessment?.materialGaps ?? [])}
- Non-material gaps:\n${bullets(result.evidenceAssessment?.nonMaterialGaps ?? [])}

## Evidence Findings

${findings}

## Missing Information Requests

${bullets(result.infoRequests)}

## Agent Invocation Ledger

${invocations}

## Exact Regulatory Citations

${exactCitations}

## Human Review and Signoff

- Action: ${decision?.action ?? "pending"}
- Notes: ${decision?.notes ?? "pending"}
- Signed by: ${decision?.signedBy ?? "pending"}
- Signed at: ${decision?.signedAt ?? "pending"}
- Signed memo revision: ${decision?.memoRevision ?? "pending"}
- Signed memo hash: ${decision?.memoHash ?? "pending"}
- Signed analysis ID: ${decision?.analysisId ?? "pending"}
- Signed analysis hash: ${decision?.analysisHash ?? "pending"}

## Audit Trail

${auditLines}

This output is an AI-generated classification recommendation package. It is not legal advice, is not a BIS, DDTC, CCATS, or commodity-jurisdiction determination, and requires qualified human export-control signoff before reliance.`;
}

function bullets(items: string[]) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

function citationList(citations: RegulatoryCitation[]) {
  return citations.length
    ? citations.map((citation) => [
        `- Source ID: ${citation.sourceId}`,
        `  - Locator: ${citation.locator}`,
        `  - Source date: ${citation.sourceDate}`,
        `  - Content hash: ${citation.contentHash}`,
        `  - Exact text: ${quote(citation.exactText)}`
      ].join("\n")).join("\n")
    : "- None";
}

function quote(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueRegulatoryCitations(result: ReviewResult) {
  const citations: RegulatoryCitation[] = [
    ...(result.candidateResearch?.candidates.flatMap((candidate) => candidate.regulatoryCitations) ?? []),
    ...(result.candidateAnalyses?.flatMap((analysis) => [
      ...analysis.criteria.flatMap((criterion) => criterion.regulatoryCitations),
      ...analysis.exclusionsAndNotes.flatMap((criterion) => criterion.regulatoryCitations)
    ]) ?? []),
    ...(result.adversarialChallenge?.challenges.flatMap((item) => item.regulatoryCitations) ?? []),
    ...(result.adversarialChallenge?.additionalCandidates.flatMap((candidate) => candidate.regulatoryCitations) ?? [])
  ];
  return [...new Map(citations.map((citation) => [
    `${citation.sourceId}:${citation.locator}:${citation.contentHash}:${citation.exactText}`,
    citation
  ])).values()];
}
