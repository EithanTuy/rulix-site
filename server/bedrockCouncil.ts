import Anthropic from "@anthropic-ai/sdk";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import { officialCorpus } from "../src/data/corpus";
import { analyzeMemo } from "../src/lib/eccnReview";
import {
  COUNCIL_AGENT_ROLES,
  mergeCouncilPayload,
  type AiCouncilPayload
} from "./councilQuality";
import type {
  DataClass,
  AnalysisProviderStatus,
  MemoChatMessage,
  MemoRecord,
  ReviewResult,
  UsageCallType
} from "../src/types";

export const DEFAULT_BEDROCK_MODEL = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
export const DEFAULT_DEEP_BEDROCK_MODEL = "global.anthropic.claude-sonnet-4-6";
export type CouncilDepth = "standard" | "deep";

export class LiveCouncilUnavailableError extends Error {
  readonly status = 503;
  readonly code = "live_council_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "LiveCouncilUnavailableError";
  }
}

// Emitted (best-effort) after each live Bedrock call so callers can record
// token usage for the admin dashboard. Never fires when live analysis is unavailable.
export interface UsageSample {
  model: string;
  callType: UsageCallType;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
}

export interface CouncilProviderResponseBlock {
  type: string;
  name?: string;
  input?: unknown;
  text?: string;
}

export interface CouncilProviderResponse {
  content: CouncilProviderResponseBlock[];
  usage?: unknown;
}

export interface CouncilProviderClient {
  messages: {
    create: (body: unknown, options?: unknown) => Promise<CouncilProviderResponse>;
  };
}

interface CouncilOptions {
  depth?: CouncilDepth;
  maxTokens?: number;
  timeoutMs?: number;
  onUsage?: (sample: UsageSample) => void;
  providerClient?: CouncilProviderClient;
}

interface MemoChatOptions {
  model?: string;
  maxTokens?: number;
  onUsage?: (sample: UsageSample) => void;
}

export interface MemoChatAiResult {
  source: "bedrock";
  model: string;
  text: string;
  proposedMemoText?: string;
  latencyMs: number;
}

export interface PublicMemoDraftResult {
  title: string;
  memoText: string;
  sources: Array<{ title: string; url: string }>;
  provider: {
    configured: boolean;
    model: string;
    live: boolean;
    message: string;
  };
}

const SYSTEM_PROMPT = `You are an export-control classification memo review assistant for research facilities.
You are not a lawyer and must not present a final legal determination.
Act as a council of seven bounded subagents: memo-parser, jurisdiction-gate, eccn-candidate, evidence-mapper, citation-verifier, risk-reviewer, and report-writer.
Review the memo against the supplied official-source corpus excerpts and the deterministic baseline.
Each subagent must be represented in the agents array exactly once with either complete or blocked status.
Prefer useful, reviewer-actionable blockers over vague caution. Do not block ready memos unless a concrete source-backed gap remains.
Treat the deterministic baseline as a broad-category guardrail. Do not move to a different ECCN family unless the memo text itself contains source-supported facts for that family. Quantum/RF control pulses are not laser pulses.
Role rubrics:
- memo-parser extracts item identity, performance parameters, software/firmware facts, data class, use, end use, and explicit omissions from the memo only.
- jurisdiction-gate evaluates EAR/ITAR posture and order-of-review issues without treating end use as classification proof.
- eccn-candidate proposes the best supported ECCN family and alternatives, and lowers confidence when facts are incomplete.
- evidence-mapper links memo claims and omissions to exact sourceChunkIds from the supplied official corpus.
- citation-verifier rejects unsupported sourceChunkIds and identifies claims that are not grounded in corpus excerpts.
- risk-reviewer produces only actionable blockers tied to missing facts, conflicts, or jurisdiction risk.
- report-writer summarizes only the structured outputs from the prior agents and must not invent new facts.
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
          agent: { type: "string", enum: COUNCIL_AGENT_ROLES },
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
          role: { type: "string", enum: COUNCIL_AGENT_ROLES },
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

const PUBLIC_MEMO_DRAFT_PROMPT = `You are Rulix public-source memo drafting assistant.
Draft a cautious ECCN self-classification memo for the requested item from general model knowledge only.
Amazon Bedrock does not provide server-side public web search here. Do not claim live research was performed, do not invent URLs, and do not cite sources as verified.
Do not make a final legal determination. Clearly list the manufacturer, official, and public-source facts that must be independently verified before relying on the memo.
Return only valid JSON with title, memoText, and sources.
The sources array must be empty.
The memoText must be markdown and include: item, owner placeholder, proposed classification/review path, item description, unverified background assumptions, performance parameters to verify, software/technical data notes, use/end-use assumptions, order-of-review notes, self-classification rationale, information still needed, and verification checklist.`;

export function getBedrockRuntime() {
  return {
    configured: process.env.BEDROCK_ENABLED?.trim().toLowerCase() === "true",
    model: process.env.BEDROCK_MODEL?.trim() || DEFAULT_BEDROCK_MODEL,
    deepModel: process.env.BEDROCK_DEEP_MODEL?.trim() || DEFAULT_DEEP_BEDROCK_MODEL
  };
}

export function councilModelForDepth(
  depth: CouncilDepth,
  runtime = getBedrockRuntime()
) {
  return depth === "deep" ? runtime.deepModel : runtime.model;
}

export async function runCouncilAnalysis(
  memo: MemoRecord,
  options: CouncilOptions = {}
): Promise<ReviewResult> {
  const runtime = getBedrockRuntime();
  const depth = options.depth ?? "standard";
  const model = councilModelForDepth(depth, runtime);

  if (!runtime.configured) {
    throw new LiveCouncilUnavailableError(
      "Live AI analysis is not configured. No deterministic analysis was recorded."
    );
  }

  const localResult = analyzeMemo(memo);
  const startedAt = Date.now();
  try {
    const client = options.providerClient ?? (new AnthropicBedrock() as CouncilProviderClient);
    const response = await client.messages.create(
      {
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
      },
      {
        signal: AbortSignal.timeout(options.timeoutMs ?? bedrockDeadlineMs()),
        maxRetries: 0
      }
    );
    emitUsage(options.onUsage, model, "council", response.usage, Date.now() - startedAt);

    const toolBlock = response.content.find(
      (block) => block.type === "tool_use" && block.name === "record_eccn_review"
    );
    const rawText = response.content
      .filter((block) => block.type === "text")
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .join("\n")
      .trim();
    const payload = toolBlock ? (toolBlock.input as AiCouncilPayload) : parseJsonPayload(rawText);
    const checkedAt = new Date().toISOString();

    return withProvider(mergeCouncilPayload(memo, localResult, payload, {
      providerLabel: providerLabel(model),
      depth
    }), {
      source: "bedrock",
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
    throw new LiveCouncilUnavailableError(
      `Live AI analysis failed (${safeError(error)}). No deterministic analysis was recorded.`
    );
  }
}

export async function runMemoChatWithHaiku(
  memo: MemoRecord,
  reviewerMessage: string,
  history: MemoChatMessage[] = [],
  options: MemoChatOptions = {}
): Promise<MemoChatAiResult | undefined> {
  const runtime = getBedrockRuntime();
  const model = options.model ?? runtime.model;
  if (!runtime.configured) return undefined;

  const startedAt = Date.now();
  const client = new AnthropicBedrock();
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
  emitUsage(options.onUsage, model, "memo-chat", response.usage, Date.now() - startedAt);

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
    source: "bedrock",
    model,
    text: proposedMemoText
      ? responseText
      : `${responseText} (${providerLabel(model)})`,
    proposedMemoText,
    latencyMs: Date.now() - startedAt
  };
}

export async function draftMemoFromPublicWeb(
  item: string,
  options: MemoChatOptions = {}
): Promise<PublicMemoDraftResult> {
  const runtime = getBedrockRuntime();
  const model = options.model ?? runtime.model;
  if (!runtime.configured) {
    return {
      title: `Public-source memo draft - ${item}`,
      memoText: buildOfflinePublicDraft(item),
      sources: [],
      provider: {
        configured: false,
        model: "local-template",
        live: false,
        message: "Bedrock is not enabled, so a public-source draft could not be generated."
      }
    };
  }

  const client = new AnthropicBedrock();
  const startedAt = Date.now();
  try {
    const response = await client.messages.create({
      model,
      max_tokens: options.maxTokens ?? 3200,
      system: PUBLIC_MEMO_DRAFT_PROMPT,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            item,
            task:
              "Draft a cautious ECCN self-classification memo from model knowledge only. Do not claim web research was performed. Return sources as an empty array and list facts that must be independently verified."
          })
        }
      ]
    });
    emitUsage(options.onUsage, model, "public-draft", response.usage, Date.now() - startedAt);
    const rawText = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    const payload = parseJsonPayload(rawText) as Record<string, unknown>;
    return {
      title: asString(payload.title, `Public-source memo draft - ${item}`),
      memoText: asLongString(payload.memoText, buildOfflinePublicDraft(item), 12000),
      sources: [],
      provider: {
        configured: true,
        model,
        live: true,
        message:
          "Drafted on Bedrock from model knowledge; public web search is unavailable on Bedrock, so all facts must be verified against manufacturer and official sources."
      }
    };
  } catch (error) {
    return {
      title: `Public-source memo draft - ${item}`,
      memoText: buildOfflinePublicDraft(item),
      sources: [],
      provider: {
        configured: true,
        model,
        live: false,
        message: `Public draft failed (${safeError(error)}).`
      }
    };
  }
}

function buildOfflinePublicDraft(item: string) {
  return `# ECCN Public-Source Draft - ${item}

**Item:** ${item}
**Owner:** [Add owner]
**Proposed Classification:** Review required

## Drafting Note

Live Bedrock drafting was unavailable or failed in this backend session. Add public manufacturer documentation, datasheets, manuals, and official classification guidance before relying on this memo.

## Information Needed

- Manufacturer and exact model number
- Datasheet and user manual
- Performance parameters relevant to the Commerce Control List
- Software, firmware, source code, technical data, and encryption details
- Intended end use, end user, destination, and restricted-party screening
`;
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
      fullCouncilRoles: COUNCIL_AGENT_ROLES,
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

function providerLabel(model: string) {
  const normalized = model.toLowerCase();
  if (normalized.includes("haiku")) return "Claude Haiku council via Bedrock";
  if (normalized.includes("sonnet")) return "Claude Sonnet council via Bedrock";
  if (normalized.includes("opus")) return "Claude Opus council via Bedrock";
  return "Claude council via Bedrock";
}

function bedrockDeadlineMs() {
  const configured = Number(process.env.RULIX_BEDROCK_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 5_000
    ? Math.min(configured, 52_000)
    : 50_000;
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

function asLongString(value: unknown, fallback: string, maxLength: number) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "unknown provider error";
  return message;
}

function emitUsage(
  onUsage: ((sample: UsageSample) => void) | undefined,
  model: string,
  callType: UsageCallType,
  usage: unknown,
  latencyMs: number
) {
  if (!onUsage) return;
  const record = asRecord(usage) ?? {};
  try {
    onUsage({
      model,
      callType,
      inputTokens: usageNumber(record.input_tokens),
      outputTokens: usageNumber(record.output_tokens),
      cacheReadTokens: usageNumber(record.cache_read_input_tokens),
      cacheWriteTokens: usageNumber(record.cache_creation_input_tokens),
      latencyMs
    });
  } catch {
    // Usage accounting is best-effort and must never break a request.
  }
}

function usageNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// ── Memo Builder ──────────────────────────────────────────────────────────────

const MEMO_BUILDER_SYSTEM_PROMPT = `You are Rulix Memo Builder, an expert that helps create ECCN export-control classification memos through guided conversation.

Your goal is to gather facts and produce a complete self-classification memo. Ask focused, concise follow-up questions — one or two at a time. Collect:
1. Item name, model/part number
2. Manufacturer and country of origin
3. Key technical specifications that drive ECCN classification (frequencies, power levels, materials, encryption, etc.)
4. Intended use and end-user type (research lab, commercial, defense, etc.)
5. Whether information is publicly available or proprietary
6. Any attached datasheets or reference documents

Do NOT rush to finish_draft — gather the minimum facts for a meaningful memo first. Ask for missing critical details before finishing.

If the user provides sections labeled "Attached source documents", treat them as primary source material. Preserve model numbers, manufacturer names, technical limits, units, and source document names. Do not invent specifications. If attachments provide enough facts, call finish_draft directly.

REQUIRED MEMO FORMAT — the memoText MUST follow this exact structure:

# Export control analysis for "[item name]"
**Date issued:** [YYYY-MM-DD]
**Scope analyzed:** "[item name, model, manufacturer]"

## ECCNs/ITAR considered
- [List every ECCN/ITAR entry evaluated, e.g. EAR99, ECCN 3A001, USML Category XI(c)]

## Description from ECCN/ITAR
For each entry considered, include the EXACT verbatim quoted text from the regulation and the version date:

> "[Exact quoted description text from the ECCN or ITAR entry]"
— *[Regulation citation, e.g. EAR 15 CFR Part 774, Supplement No. 1], as of [date]*

## Analysis

For each ECCN/ITAR entry, include a subsection with this structure:

### [ECCN/ITAR entry]
**Is the scope subject to [entry]?**

[If NOT subject, for each relevant subcategory:]
Not subject — [Subcategory letter/number]: [Specific explanation of why the item does not meet this criterion based on its specifications]

[If SUBJECT:]
**Scope is subject to ECCN/ITAR: "[entry]"**
[Explanation grounded in the item's documented specifications]

## Revision History
| Date | Change |
|------|--------|
| [YYYY-MM-DD] | Initial draft |

## Reference Documents
[List all datasheets, manufacturer documents, and source materials used]
- [Document name] — [manufacturer/source]

Never claim a final legal determination. Always present as a draft requiring reviewer signoff and independent verification.`;

const MEMO_BUILDER_QUALITY_APPENDIX = `

Memo Builder quality requirements:
- Produce a complete, copy-ready memo following the required format exactly.
- Include EXACT verbatim quotations from the applicable ECCN/ITAR regulation text, with the version/date of the regulation cited.
- For every ECCN/ITAR considered, explain subcategory by subcategory why the item is or is not subject.
- List all datasheets and reference documents provided in the Reference Documents section.
- Include a Revision History table with at least the initial draft entry.
- The memoText should usually be 600-1400 words when source material is available.
- Do not return filler language, one-paragraph memos, or fake certainty.
- If a specification is missing, name the exact missing field rather than guessing.
- In qualityChecks, list 2-5 short checks the draft satisfies.
- In missingFacts, list critical fields the reviewer still needs (empty array if none).
- In sourceNotes, list the source basis and any caveats, especially when drafting from attachments.
- Never claim final legal determination; present as a draft requiring reviewer signoff.`;

const MEMO_BUILDER_PROVIDER_TIMEOUT_MS = 115000;

const MEMO_BUILDER_DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "itemFamily", "dataClass", "memoText"],
  properties: {
    title: { type: "string" },
    itemFamily: { type: "string" },
    manufacturer: { type: "string" },
    intendedUse: { type: "string" },
    dataClass: { type: "string", enum: ["public", "proprietary", "export-controlled", "itar-risk", "cui"] },
    memoText: { type: "string" },
    qualityChecks: { type: "array", items: { type: "string" } },
    missingFacts: { type: "array", items: { type: "string" } },
    sourceNotes: { type: "array", items: { type: "string" } }
  }
} as const;

export interface MemoBuildChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface MemoBuildDraft {
  title: string;
  itemFamily: string;
  manufacturer?: string;
  intendedUse?: string;
  dataClass: DataClass;
  memoText: string;
  qualityChecks?: string[];
  missingFacts?: string[];
  sourceNotes?: string[];
}

export interface MemoBuildChatResult {
  reply: string;
  draft?: MemoBuildDraft;
}

export async function runMemoBuildChat(
  messages: MemoBuildChatMessage[],
  options: { onUsage?: (sample: UsageSample) => void } = {}
): Promise<MemoBuildChatResult> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const runtime = getBedrockRuntime();

  let client: Anthropic;
  let model: string;

  if (anthropicKey) {
    client = new Anthropic({ apiKey: anthropicKey });
    model = "claude-sonnet-4-6";
  } else if (runtime.configured) {
    client = new AnthropicBedrock() as unknown as Anthropic;
    model = runtime.deepModel;
  } else {
    throw new Error("No AI provider configured. Set ANTHROPIC_API_KEY or enable Bedrock.");
  }

  const startedAt = Date.now();
  let response: Awaited<ReturnType<Anthropic["messages"]["create"]>>;
  try {
    response = await client.messages.create(
      {
        model,
        max_tokens: 3200,
        system: `${MEMO_BUILDER_SYSTEM_PROMPT}${MEMO_BUILDER_QUALITY_APPENDIX}`,
        tools: [
          {
            name: "finish_draft",
            description: "Call when you have gathered enough information to produce a complete memo draft.",
            input_schema: MEMO_BUILDER_DRAFT_SCHEMA as Parameters<Anthropic["messages"]["create"]>[0]["tools"][number]["input_schema"]
          }
        ],
        messages: messages.map((m) => ({ role: m.role, content: m.content }))
      },
      {
        timeout: MEMO_BUILDER_PROVIDER_TIMEOUT_MS,
        maxRetries: 0
      }
    );
  } catch (error) {
    const message = safeError(error);
    if (/timeout|timed? out|abort/i.test(message)) {
      throw new Error("Memo Builder took too long. Try again with a shorter prompt or fewer/lighter attachments.");
    }
    throw error;
  }

  emitUsage(options.onUsage, model, "memo-builder", response.usage, Date.now() - startedAt);

  const toolBlock = response.content.find(
    (block) => block.type === "tool_use" && block.name === "finish_draft"
  );
  const textBlock = response.content.find((block) => block.type === "text");
  const replyText = textBlock?.type === "text" ? textBlock.text.trim() : "";

  if (toolBlock?.type === "tool_use") {
    const input = toolBlock.input as Record<string, unknown>;
    return {
      reply: replyText || "Your memo draft is ready. Review it below, then choose how to add it to your queue.",
      draft: {
        title: asString(input.title, "AI-drafted ECCN Memo"),
        itemFamily: asString(input.itemFamily, "AI-drafted item"),
        manufacturer: typeof input.manufacturer === "string" && input.manufacturer.trim() ? input.manufacturer.trim() : undefined,
        intendedUse: typeof input.intendedUse === "string" && input.intendedUse.trim() ? input.intendedUse.trim() : undefined,
        dataClass: isValidDataClass(input.dataClass) ? input.dataClass : "proprietary",
        memoText: asLongString(input.memoText, "", 16000),
        qualityChecks: stringArray(input.qualityChecks, 5),
        missingFacts: stringArray(input.missingFacts, 8),
        sourceNotes: stringArray(input.sourceNotes, 6)
      }
    };
  }

  return {
    reply: replyText || "Could you tell me more about the item you need to classify?"
  };
}

function isValidDataClass(value: unknown): value is DataClass {
  return (
    value === "public" ||
    value === "proprietary" ||
    value === "export-controlled" ||
    value === "itar-risk" ||
    value === "cui"
  );
}

function stringArray(value: unknown, maxItems: number) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        .map((item) => item.trim().slice(0, 240))
        .slice(0, maxItems)
    : undefined;
}
