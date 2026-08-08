import type {
  DataClass,
  MemoChatMessage,
  MemoRecord,
  UsageCallType
} from "../src/types";
import {
  AiEgressPolicyError,
  dispatchAuthorizedAiRequest,
  resolveBedrockLane,
  resolveMemoBuilderLane,
  type AiEgressContext,
  type AiProviderClient,
  type AiProviderLane,
  type AiProviderResponse,
  type AiProviderResponseBlock
} from "./aiEgressGateway";

export const DEFAULT_BEDROCK_MODEL = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
export const DEFAULT_DEEP_BEDROCK_MODEL = "global.anthropic.claude-sonnet-4-6";
export type CouncilDepth = "standard" | "deep";

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

export type CouncilProviderResponseBlock = AiProviderResponseBlock;
export type CouncilProviderResponse = AiProviderResponse;
export type CouncilProviderClient = AiProviderClient;

export type AiEgressCallerContext = Pick<
  AiEgressContext,
  "accountId" | "approvalId" | "dataClass" | "dispatchId" | "subject" | "trustedWorkflowGrant"
>;

export function memoChatApprovalPayload(
  memo: MemoRecord,
  reviewerMessage: string,
  history: MemoChatMessage[]
) {
  return { memo, reviewerMessage, history };
}

export function memoBuilderApprovalPayload(messages: MemoBuildChatMessage[]) {
  return { messages };
}

interface MemoChatOptions {
  model?: string;
  maxTokens?: number;
  onUsage?: (sample: UsageSample) => void;
  providerClient?: CouncilProviderClient;
  egress?: AiEgressCallerContext;
}

export interface MemoChatAiResult {
  source: "bedrock";
  model: string;
  text: string;
  proposedMemoText?: string;
  latencyMs: number;
}

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

export function getBedrockRuntime() {
  const model = process.env.BEDROCK_MODEL?.trim() || DEFAULT_BEDROCK_MODEL;
  const lane = resolveBedrockLane(model);
  return {
    configured: Boolean(lane),
    model,
    deepModel: process.env.BEDROCK_DEEP_MODEL?.trim() || DEFAULT_DEEP_BEDROCK_MODEL,
    provider: "amazon-bedrock" as const,
    region: lane?.region
  };
}

export function buildMemoChatProviderRequest(
  memo: MemoRecord,
  reviewerMessage: string,
  history: MemoChatMessage[],
  model: string,
  maxTokens = 1400
) {
  return {
    model,
    max_tokens: maxTokens,
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
  };
}

export async function runMemoChatWithHaiku(
  memo: MemoRecord,
  reviewerMessage: string,
  history: MemoChatMessage[] = [],
  options: MemoChatOptions = {}
): Promise<MemoChatAiResult | undefined> {
  const runtime = getBedrockRuntime();
  const model = options.model ?? runtime.model;
  const lane = resolveBedrockLane(model);
  if (!runtime.configured || !lane) return undefined;

  const startedAt = Date.now();
  const response = await dispatchAuthorizedAiRequest(
    requireEgressContext(
      options.egress,
      "memo-chat",
      memoChatApprovalPayload(memo, reviewerMessage, history)
    ),
    lane,
    buildMemoChatProviderRequest(
      memo,
      reviewerMessage,
      history,
      model,
      options.maxTokens ?? 1400
    ),
    undefined,
    options.providerClient
  );
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

function parseJsonPayload(rawText: string): Record<string, unknown> {
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

  return JSON.parse(withoutFence.slice(start, end + 1)) as Record<string, unknown>;
}

function providerLabel(model: string) {
  const normalized = model.toLowerCase();
  if (normalized.includes("haiku")) return "Claude Haiku via Bedrock";
  if (normalized.includes("sonnet")) return "Claude Sonnet via Bedrock";
  if (normalized.includes("opus")) return "Claude Opus via Bedrock";
  return "Claude via Bedrock";
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

// â”€â”€ Memo Builder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const MEMO_BUILDER_SYSTEM_PROMPT = `You are Rulix Memo Builder, an expert that helps create ECCN export-control classification memos through guided conversation.

Your goal is to gather facts and produce a complete self-classification memo. Ask focused, concise follow-up questions â€” one or two at a time. Collect:
1. Item name, model/part number
2. Manufacturer and country of origin
3. Key technical specifications that drive ECCN classification (frequencies, power levels, materials, encryption, etc.)
4. Intended use and end-user type (research lab, commercial, defense, etc.)
5. Whether information is publicly available or proprietary
6. Any attached datasheets or reference documents

Do NOT rush to finish_draft â€” gather the minimum facts for a meaningful memo first. Ask for missing critical details before finishing.

If the user provides sections labeled "Attached source documents", treat them as primary source material. Preserve model numbers, manufacturer names, technical limits, units, and source document names. Do not invent specifications. If attachments provide enough facts, call finish_draft directly.

REQUIRED MEMO FORMAT â€” the memoText MUST follow this exact structure:

# Export control analysis for "[item name]"
**Date issued:** [YYYY-MM-DD]
**Scope analyzed:** "[item name, model, manufacturer]"

## ECCNs/ITAR considered
- [List every ECCN/ITAR entry evaluated, e.g. EAR99, ECCN 3A001, USML Category XI(c)]

## Description from ECCN/ITAR
For each entry considered, include the EXACT verbatim quoted text from the regulation and the version date:

> "[Exact quoted description text from the ECCN or ITAR entry]"
â€” *[Regulation citation, e.g. EAR 15 CFR Part 774, Supplement No. 1], as of [date]*

## Analysis

For each ECCN/ITAR entry, include a subsection with this structure:

### [ECCN/ITAR entry]
**Is the scope subject to [entry]?**

[If NOT subject, for each relevant subcategory:]
Not subject â€” [Subcategory letter/number]: [Specific explanation of why the item does not meet this criterion based on its specifications]

[If SUBJECT:]
**Scope is subject to ECCN/ITAR: "[entry]"**
[Explanation grounded in the item's documented specifications]

## Revision History
| Date | Change |
|------|--------|
| [YYYY-MM-DD] | Initial draft |

## Reference Documents
[List all datasheets, manufacturer documents, and source materials used]
- [Document name] â€” [manufacturer/source]

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

export function buildMemoBuilderProviderRequest(
  messages: MemoBuildChatMessage[],
  model: string
) {
  return {
    model,
    max_tokens: 3200,
    system: `${MEMO_BUILDER_SYSTEM_PROMPT}${MEMO_BUILDER_QUALITY_APPENDIX}`,
    tools: [
      {
        name: "finish_draft",
        description: "Call when you have gathered enough information to produce a complete memo draft.",
        input_schema: MEMO_BUILDER_DRAFT_SCHEMA
      }
    ],
    messages: messages.map((message) => ({ role: message.role, content: message.content }))
  };
}

export async function runMemoBuildChat(
  messages: MemoBuildChatMessage[],
  options: {
    onUsage?: (sample: UsageSample) => void;
    providerClient?: CouncilProviderClient;
    egress?: AiEgressCallerContext;
  } = {}
): Promise<MemoBuildChatResult> {
  const lane = resolveMemoBuilderProviderLane();
  if (!lane) {
    throw new Error("No AI provider configured. Set ANTHROPIC_API_KEY or enable Bedrock.");
  }
  const model = lane.model;

  const startedAt = Date.now();
  let response: CouncilProviderResponse;
  try {
    response = await dispatchAuthorizedAiRequest(
      requireEgressContext(options.egress, "memo-builder", memoBuilderApprovalPayload(messages)),
      lane,
      buildMemoBuilderProviderRequest(messages, model),
      {
        timeout: MEMO_BUILDER_PROVIDER_TIMEOUT_MS
      },
      options.providerClient
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
  const replyText = textBlock?.type === "text" ? textBlock.text?.trim() ?? "" : "";

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

export function resolveMemoBuilderProviderLane(): AiProviderLane | undefined {
  const runtime = getBedrockRuntime();
  return resolveMemoBuilderLane({
    anthropicModel: "claude-sonnet-4-6",
    bedrockModel: runtime.deepModel
  });
}

function requireEgressContext(
  caller: AiEgressCallerContext | undefined,
  purpose: AiEgressContext["purpose"],
  payload: unknown
): AiEgressContext {
  if (!caller) {
    throw new AiEgressPolicyError(
      "ai_egress_context_required",
      "A server-owned AI egress context is required for this content."
    );
  }
  return { ...caller, purpose, payload };
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
