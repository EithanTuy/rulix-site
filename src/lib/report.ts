import { getSourceChunk, officialCorpus } from "../data/corpus";
import type { AuditEvent, MemoRecord, ReviewerDecision, ReviewResult } from "../types";

export function buildReviewReport(
  memo: MemoRecord,
  result: ReviewResult,
  decision?: ReviewerDecision,
  auditEvents: AuditEvent[] = []
) {
  const citations = [
    ...new Set([
      ...result.jurisdiction.sourceChunkIds,
      ...result.recommended.sourceChunkIds,
      ...result.findings.flatMap((finding) => finding.sourceChunkIds)
    ])
  ]
    .map((id) => getSourceChunk(id))
    .filter(Boolean);

  const findings = result.findings
    .map(
      (finding) =>
        `- [${finding.status.toUpperCase()}] ${finding.title}: ${finding.rationale}`
    )
    .join("\n");

  const citationLines = citations
    .map((chunk) => `- ${chunk!.locator}: ${chunk!.title} (${chunk!.url})`)
    .join("\n");
  const auditLines = auditEvents.length
    ? auditEvents
        .map((event) => `- ${event.at} | ${event.actor} | ${event.action}: ${event.detail}`)
        .join("\n")
    : "- No audit events recorded.";
  const agentLines = result.agents
    .map((agent) => `- ${agent.label}: ${agent.status} - ${agent.summary}`)
    .join("\n");

  const corpusLabel =
    result.corpusId === officialCorpus.id ? `${officialCorpus.label} (${result.corpusId})` : result.corpusId;

  return `# ECCN Review Report

Document: ${memo.title}
Code: ${memo.documentCode}
Corpus: ${corpusLabel}
Generated: ${result.generatedAt}
Provider: ${result.provider.label} (${result.provider.model})
Depth: ${result.provider.depth ?? "standard"}

## AI Classification Recommendation
${result.recommended.eccn} - ${result.recommended.label}
Confidence: ${Math.round(result.recommended.confidence * 100)}%
Risk: ${result.recommended.risk}

${result.recommended.summary}

## Jurisdiction Gate
${result.jurisdiction.summary}
${result.jurisdiction.rationale}

## Evidence Findings
${findings}

## Requested Information
${result.infoRequests.length ? result.infoRequests.map((item) => `- ${item}`).join("\n") : "- None"}

## AI Council
${agentLines}

## Human Review
Action: ${decision?.action ?? "pending"}
Notes: ${decision?.notes ?? "pending"}
Signed By: ${decision?.signedBy ?? "pending"}
Signed At: ${decision?.signedAt ?? "pending"}

## Audit Trail
${auditLines}

## Citations
${citationLines}

This output is an AI-generated classification recommendation package. It is not legal advice, is not a BIS/DDTC/CCATS/CJ determination, and requires qualified human export-control signoff before reliance.`;
}
