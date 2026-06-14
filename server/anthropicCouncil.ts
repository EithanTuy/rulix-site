import Anthropic from "@anthropic-ai/sdk";
import { officialCorpus } from "../src/data/corpus";
import { analyzeMemo } from "../src/lib/eccnReview";
import type {
  AgentRole,
  AnalysisProviderStatus,
  ClassificationCandidate,
  CouncilAgentRun,
  EvidenceFinding,
  EvidenceStatus,
  JurisdictionFinding,
  MemoRecord,
  ReviewResult
} from "../src/types";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

interface CouncilOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

type AiCouncilPayload = Partial<
  Pick<
    ReviewResult,
    "jurisdiction" | "recommended" | "alternatives" | "findings" | "infoRequests" | "agents"
  >
>;

const AGENT_ROLES: AgentRole[] = [
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

const SYSTEM_PROMPT = `You are an export-control classification memo review assistant for research facilities.
You are not a lawyer and must not present a final legal determination.
Act as a council of seven bounded subagents: memo-parser, jurisdiction-gate, eccn-candidate, evidence-mapper, citation-verifier, risk-reviewer, and report-writer.
Review the memo against the supplied official-source corpus excerpts and the deterministic baseline.
Use the record_eccn_review tool to return structured results.`;

const AI_REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["jurisdiction", "recommended", "findings", "infoRequests", "agents"],
  properties: {
    jurisdiction: {
      type: "object",
      additionalProperties: false,
      required: ["outcome", "summary", "rationale", "sourceChunkIds"],
      properties: {
        outcome: { type: "string", enum: ["ear-likely", "itar-risk", "insufficient-info"] },
        summary: { type: "string" },
        rationale: { type: "string" },
        sourceChunkIds: { type: "array", items: { type: "string" } }
      }
    },
    recommended: {
      type: "object",
      additionalProperties: false,
      required: ["eccn", "label", "confidence", "risk", "summary", "sourceChunkIds"],
      properties: {
        eccn: { type: "string" },
        label: { type: "string" },
        confidence: { type: "number" },
        risk: { type: "string", enum: ["low", "medium", "high"] },
        summary: { type: "string" },
        sourceChunkIds: { type: "array", items: { type: "string" } }
      }
    },
    alternatives: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["eccn", "label", "confidence", "risk", "summary", "sourceChunkIds"],
        properties: {
          eccn: { type: "string" },
          label: { type: "string" },
          confidence: { type: "number" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          summary: { type: "string" },
          sourceChunkIds: { type: "array", items: { type: "string" } }
        }
      }
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status", "title", "claim", "rationale", "sourceChunkIds", "agent", "severity"],
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["strong", "weak", "missing", "conflict"] },
          title: { type: "string" },
          claim: { type: "string" },
          rationale: { type: "string" },
          excerpt: { type: "string" },
          sourceChunkIds: { type: "array", items: { type: "string" } },
          agent: { type: "string", enum: AGENT_ROLES },
          severity: { type: "string", enum: ["info", "review", "escalate"] }
        }
      }
    },
    infoRequests: { type: "array", items: { type: "string" } },
    agents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "label", "status", "summary"],
        properties: {
          role: { type: "string", enum: AGENT_ROLES },
          label: { type: "string" },
          status: { type: "string", enum: ["complete", "blocked"] },
          summary: { type: "string" }
        }
      }
    }
  }
} as const;

export function getAnthropicRuntime() {
  return {
    configured: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    model: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL
  };
}

export async function runCouncilAnalysis(
  memo: MemoRecord,
  options: CouncilOptions = {}
): Promise<ReviewResult> {
  const localResult = analyzeMemo(memo);
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;

  if (!apiKey?.trim()) {
    return withProvider(localResult, {
      source: "local-rules",
      label: "Local rules council",
      model: "local-rule-engine-v1",
      live: false,
      message: "No Anthropic key is configured on the backend, so the deterministic council is displayed.",
      checkedAt: new Date().toISOString()
    });
  }

  const startedAt = Date.now();
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model,
      max_tokens: options.maxTokens ?? 2600,
      system: SYSTEM_PROMPT,
      tools: [
        {
          name: "record_eccn_review",
          description:
            "Return the ECCN memo review as normalized structured data for the Rulix reviewer UI.",
          input_schema: AI_REVIEW_SCHEMA
        }
      ],
      tool_choice: { type: "tool", name: "record_eccn_review" },
      messages: [
        {
          role: "user",
          content: buildCouncilPrompt(memo, localResult)
        }
      ]
    });

    const toolBlock = response.content.find(
      (block) => block.type === "tool_use" && block.name === "record_eccn_review"
    );
    const rawText = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    const payload = toolBlock ? (toolBlock.input as AiCouncilPayload) : parseJsonPayload(rawText);
    const checkedAt = new Date().toISOString();

    return withProvider(mergeAiPayload(memo, localResult, payload), {
      source: "anthropic",
      label: "Claude Sonnet council",
      model,
      live: true,
      message:
        "Live Anthropic analysis was used, then citation IDs and memo highlights were validated by the backend.",
      checkedAt,
      latencyMs: Date.now() - startedAt
    });
  } catch (error) {
    const checkedAt = new Date().toISOString();
    return withProvider(localResult, {
      source: "fallback",
      label: "Local fallback council",
      model,
      live: false,
      message: `Live Anthropic analysis failed (${safeError(error, apiKey)}). Showing deterministic backend fallback.`,
      checkedAt,
      latencyMs: Date.now() - startedAt
    });
  }
}

function buildCouncilPrompt(memo: MemoRecord, localResult: ReviewResult) {
  const corpus = officialCorpus.chunks.map((chunk) => ({
    id: chunk.id,
    locator: chunk.locator,
    title: chunk.title,
    text: chunk.text,
    tags: chunk.tags
  }));

  const schema = {
    jurisdiction: {
      outcome: "ear-likely | itar-risk | insufficient-info",
      summary: "short summary",
      rationale: "grounded rationale",
      sourceChunkIds: ["chunk-id"]
    },
    recommended: {
      eccn: "candidate ECCN or review path",
      label: "short label",
      confidence: 0.62,
      risk: "low | medium | high",
      summary: "why this recommendation agrees or disagrees with memo",
      sourceChunkIds: ["chunk-id"]
    },
    alternatives: [
      {
        eccn: "alternate candidate",
        label: "short label",
        confidence: 0.35,
        risk: "low | medium | high",
        summary: "why it remains plausible",
        sourceChunkIds: ["chunk-id"]
      }
    ],
    findings: [
      {
        id: "stable-id",
        status: "strong | weak | missing | conflict",
        title: "finding title",
        claim: "claim or missing-info request",
        rationale: "why this is good, bad, or needs more information",
        excerpt: "exact memo text to highlight when available",
        sourceChunkIds: ["chunk-id"],
        agent: "evidence-mapper",
        severity: "info | review | escalate"
      }
    ],
    infoRequests: ["specific technical evidence to request"],
    agents: [
      {
        role: "memo-parser",
        label: "Memo Parser",
        status: "complete | blocked",
        summary: "subagent outcome"
      }
    ]
  };

  return JSON.stringify(
    {
      task:
        "Review whether the memo's ECCN classification is supported. Highlight good evidence, bad reasoning, conflicts, and missing information. Prefer precise source chunk IDs from the corpus.",
      memo,
      officialCorpus: corpus,
      deterministicBaseline: localResult,
      requiredJsonSchema: schema
    },
    null,
    2
  );
}

function parseJsonPayload(rawText: string): AiCouncilPayload {
  const withoutFence = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("Claude response did not contain a JSON object");
  }

  return JSON.parse(withoutFence.slice(start, end + 1)) as AiCouncilPayload;
}

function mergeAiPayload(
  memo: MemoRecord,
  localResult: ReviewResult,
  payload: AiCouncilPayload
): ReviewResult {
  const findings = Array.isArray(payload.findings)
    ? payload.findings
        .map((finding, index) =>
          normalizeFinding(memo.memoText, finding, localResult.findings[index], index)
        )
        .filter((finding): finding is EvidenceFinding => Boolean(finding))
    : [];

  const mergedFindings = findings.length > 0 ? findings : localResult.findings;
  const infoRequests = sanitizeStringArray(payload.infoRequests).slice(0, 10);

  return {
    ...localResult,
    generatedAt: new Date().toISOString(),
    modelPolicy:
      "Claude Sonnet council with deterministic citation/range validation; human export-control signoff required.",
    jurisdiction: normalizeJurisdiction(payload.jurisdiction, localResult.jurisdiction),
    recommended: normalizeCandidate(payload.recommended, localResult.recommended),
    alternatives: Array.isArray(payload.alternatives)
      ? payload.alternatives
          .map((candidate, index) => normalizeCandidate(candidate, localResult.alternatives[index]))
          .filter((candidate): candidate is ClassificationCandidate => Boolean(candidate))
      : localResult.alternatives,
    findings: mergedFindings,
    infoRequests: infoRequests.length > 0 ? infoRequests : buildInfoRequests(mergedFindings),
    agents: normalizeAgents(payload.agents, localResult.agents)
  };
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

  return {
    eccn: asString(input.eccn, fallback?.eccn ?? "Review needed"),
    label: asString(input.label, fallback?.label ?? "Classification review needed"),
    confidence: asConfidence(input.confidence, fallback?.confidence ?? 0.5),
    risk: input.risk === "low" || input.risk === "medium" || input.risk === "high"
      ? input.risk
      : fallback?.risk ?? "medium",
    summary: asString(input.summary, fallback?.summary ?? "Additional reviewer analysis is required."),
    sourceChunkIds: normalizeChunkIds(input.sourceChunkIds, fallback?.sourceChunkIds ?? ["chunk-eccn-method"])
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

  const excerpt = asString(input.excerpt, fallback?.excerpt ?? "");
  const range = locateExcerpt(memoText, excerpt);
  const status = EVIDENCE_STATUSES.includes(input.status as EvidenceStatus)
    ? (input.status as EvidenceStatus)
    : fallback?.status ?? "weak";
  const agent = AGENT_ROLES.includes(input.agent as AgentRole)
    ? (input.agent as AgentRole)
    : fallback?.agent ?? "risk-reviewer";
  const severity =
    input.severity === "info" || input.severity === "review" || input.severity === "escalate"
      ? input.severity
      : fallback?.severity ?? (status === "conflict" ? "escalate" : "review");

  return {
    id: asString(input.id, fallback?.id ?? `ai-finding-${index + 1}`),
    status,
    title: asString(input.title, fallback?.title ?? "Review finding"),
    claim: asString(input.claim, fallback?.claim ?? (excerpt || "Review supporting evidence.")),
    rationale: asString(input.rationale, fallback?.rationale ?? "Reviewer should verify this claim."),
    excerpt: excerpt || fallback?.excerpt,
    start: range?.start ?? fallback?.start,
    end: range?.end ?? fallback?.end,
    sourceChunkIds: normalizeChunkIds(input.sourceChunkIds, fallback?.sourceChunkIds ?? ["chunk-eccn-method"]),
    agent,
    severity
  };
}

function normalizeAgents(value: unknown, fallback: CouncilAgentRun[]): CouncilAgentRun[] {
  const inputs = Array.isArray(value) ? value.map(asRecord).filter(Boolean) : [];
  return fallback.map((agent) => {
    const input = inputs.find((item) => item?.role === agent.role);
    if (!input) return agent;

    return {
      role: agent.role,
      label: asString(input.label, agent.label),
      status: input.status === "blocked" || input.status === "complete" ? input.status : agent.status,
      summary: asString(input.summary, agent.summary)
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

function withProvider(result: ReviewResult, provider: AnalysisProviderStatus): ReviewResult {
  return {
    ...result,
    generatedAt: provider.checkedAt,
    provider
  };
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
  return Math.max(0, Math.min(0.99, numberValue));
}

function safeError(error: unknown, apiKey?: string) {
  const message = error instanceof Error ? error.message : "unknown provider error";
  return apiKey ? message.replaceAll(apiKey, "[redacted]") : message;
}
