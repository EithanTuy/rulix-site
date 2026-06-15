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
  MemoChatMessage,
  MemoRecord,
  ReviewResult
} from "../src/types";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";
export const LEGACY_HAIKU_35_MODEL = "claude-3-5-haiku-20241022";
export type CouncilDepth = "standard" | "deep";

interface CouncilOptions {
  apiKey?: string;
  model?: string;
  depth?: CouncilDepth;
  maxTokens?: number;
}

interface MemoChatOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

export interface MemoChatAiResult {
  source: "anthropic";
  model: string;
  text: string;
  proposedMemoText?: string;
  latencyMs: number;
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
Each subagent must be represented in the agents array exactly once with either complete or blocked status.
Prefer useful, reviewer-actionable blockers over vague caution. Do not block ready memos unless a concrete source-backed gap remains.
Treat the deterministic baseline as a broad-category guardrail. Do not move to a different ECCN family unless the memo text itself contains source-supported facts for that family. Quantum/RF control pulses are not laser pulses.
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

const MEMO_CHAT_SYSTEM_PROMPT = `You are Rulix memo chat, an export-control memo assistant.
You help reviewers understand and improve the selected memo.
Decide whether the reviewer is asking for a normal chat answer or asking you to edit/draft memo language.
Use action "edit" only when the reviewer clearly asks to add, revise, clarify, insert, change, rewrite, or update memo text.
For action "edit", return the complete updated memo text in proposedMemoText.
For action "reply", do not return proposedMemoText.
Do not claim final legal authority, do not invent facts, and say when the memo does not contain enough support.`;

const MEMO_CHAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "response"],
  properties: {
    action: { type: "string", enum: ["reply", "edit"] },
    response: { type: "string" },
    proposedMemoText: { type: "string" }
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
  const depth = options.depth ?? "standard";

  if (!apiKey?.trim()) {
    return withProvider(localResult, {
      source: "local-rules",
      label: "Local rules council",
      model: "local-rule-engine-v1",
      depth,
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
          content: buildCouncilPrompt(memo, localResult, depth)
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

    return withProvider(mergeAiPayload(memo, localResult, payload, { model, depth }), {
      source: "anthropic",
      label: providerLabel(model),
      model,
      depth,
      live: true,
      message:
        `Live ${providerLabel(model)} analysis completed as a ${depth === "deep" ? "deep" : "standard"} full-council pass; citation IDs and memo highlights were validated by the backend.`,
      checkedAt,
      latencyMs: Date.now() - startedAt
    });
  } catch (error) {
    const checkedAt = new Date().toISOString();
    return withProvider(localResult, {
      source: "fallback",
      label: "Local fallback council",
      model,
      depth,
      live: false,
      message: `Live Anthropic analysis failed (${safeError(error, apiKey)}). Showing deterministic backend fallback.`,
      checkedAt,
      latencyMs: Date.now() - startedAt
    });
  }
}

export async function runMemoChatWithHaiku(
  memo: MemoRecord,
  reviewerMessage: string,
  history: MemoChatMessage[] = [],
  options: MemoChatOptions = {}
): Promise<MemoChatAiResult | undefined> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
  if (!apiKey?.trim()) return undefined;

  const startedAt = Date.now();
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: options.maxTokens ?? 1400,
    system: MEMO_CHAT_SYSTEM_PROMPT,
    tools: [
      {
        name: "record_memo_chat_response",
        description:
          "Choose whether to answer the reviewer or draft an updated memo, then return the response.",
        input_schema: MEMO_CHAT_SCHEMA
      }
    ],
    tool_choice: { type: "tool", name: "record_memo_chat_response" },
    messages: [
      {
        role: "user",
        content: buildMemoChatPrompt(memo, reviewerMessage, history)
      }
    ]
  });

  const toolBlock = response.content.find(
    (block) => block.type === "tool_use" && block.name === "record_memo_chat_response"
  );
  const rawText = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  const payload = toolBlock
    ? (toolBlock.input as Record<string, unknown>)
    : parseJsonPayload(rawText) as Record<string, unknown>;

  const responseText = asString(
    payload.response,
    "I reviewed the selected memo, but I need a more specific question or edit instruction."
  );
  const proposedMemoText = payload.action === "edit"
    ? normalizeProposedMemoText(memo.memoText, payload.proposedMemoText)
    : undefined;

  return {
    source: "anthropic",
    model,
    text: proposedMemoText
      ? responseText
      : `${responseText} (${providerLabel(model)})`,
    proposedMemoText,
    latencyMs: Date.now() - startedAt
  };
}

function buildMemoChatPrompt(
  memo: MemoRecord,
  reviewerMessage: string,
  history: MemoChatMessage[]
) {
  return JSON.stringify(
    {
      task:
        "Answer the reviewer about the selected memo, or draft an updated memo only if the reviewer asked for an edit.",
      memo: {
        id: memo.id,
        title: memo.title,
        documentCode: memo.documentCode,
        itemFamily: memo.itemFamily,
        dataClass: memo.dataClass,
        sourcePath: memo.sourcePath,
        memoText: memo.memoText
      },
      recentChat: history.slice(-8).map((message) => ({
        role: message.role,
        text: message.text
      })),
      reviewerMessage,
      outputContract: {
        reply:
          "Use action='reply' for questions, explanations, checks, or discussion. response should be concise and grounded in the memo.",
        edit:
          "Use action='edit' only for explicit edit requests. response should summarize the change, and proposedMemoText must be the complete updated memo text."
      }
    },
    null,
    2
  );
}

function normalizeProposedMemoText(currentMemoText: string, value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const proposed = value.trim();
  if (proposed.length < Math.max(80, currentMemoText.trim().length * 0.45)) {
    return undefined;
  }
  return `${proposed}\n`;
}

function buildCouncilPrompt(memo: MemoRecord, localResult: ReviewResult, depth: CouncilDepth) {
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
        depth === "deep"
          ? "Run a deep full-council review of whether the memo's ECCN classification is supported. In addition to evidence, bad reasoning, conflicts, and missing information, identify anything that would make a reviewer unhappy: ambiguous blocker wording, missing next action, unsupported confidence, overblocking a ready memo, or underblocking a risky memo. Prefer precise source chunk IDs from the corpus."
          : "Run a full-council review of whether the memo's ECCN classification is supported. Highlight good evidence, bad reasoning, conflicts, and missing information. Prefer precise source chunk IDs from the corpus.",
      analysisDepth: depth,
      fullCouncilRoles: AGENT_ROLES,
      blockerPolicy:
        "Mark an agent blocked only when the memo cannot support reviewer signoff without a specific missing fact, conflict, or jurisdiction issue. Make each info request actionable.",
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
  payload: AiCouncilPayload,
  runtime: { model: string; depth: CouncilDepth }
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

  return {
    ...localResult,
    generatedAt: new Date().toISOString(),
    modelPolicy: `${providerLabel(runtime.model)} ${runtime.depth} full-council review with deterministic citation/range validation; human export-control signoff required.`,
    jurisdiction: normalizeJurisdiction(payload.jurisdiction, localResult.jurisdiction),
    recommended: normalizeRecommendedCandidate(memo.memoText, payload.recommended, localResult.recommended),
    alternatives: Array.isArray(payload.alternatives)
      ? payload.alternatives
          .map((candidate, index) => normalizeCandidate(candidate, localResult.alternatives[index]))
          .filter((candidate): candidate is ClassificationCandidate => Boolean(candidate))
      : localResult.alternatives,
    findings: mergedFindings,
    infoRequests: mergedInfoRequests,
    agents: normalizeAgents(payload.agents, localResult.agents, mergedFindings)
  };
}

function mergeFindings(aiFindings: EvidenceFinding[], localFindings: EvidenceFinding[]) {
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

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
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

function providerLabel(model: string) {
  const normalized = model.toLowerCase();
  if (normalized.includes("haiku")) return "Claude Haiku council";
  if (normalized.includes("opus")) return "Claude Opus council";
  return "Claude council";
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

  const normalized: EvidenceFinding = {
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
