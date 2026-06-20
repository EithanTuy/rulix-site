import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import type { OutreachDraft, OutreachLead } from "../src/types";
import type { UsageSample } from "./bedrockCouncil";

export const DEFAULT_OUTREACH_MODEL = "us.anthropic.claude-opus-4-6-v1";

const SYSTEM_PROMPT = `You write concise founder outreach for Rulix.
Return one calm, direct, conversational email. Personalization is optional and minimal. In most cases, the organization and relevant department are enough.

Rulix helps export-control, research-security, and research-compliance teams review the reasoning and source support behind internal memos and decisions. It supports human reviewers and does not replace legal judgment or make final classifications.

Requirements:
- 75 to 110 words in the body.
- Three or four short paragraphs.
- Mention Rulix exactly once.
- Explain the review workflow plainly.
- Say the founder is looking for a small number of potential pilot users.
- Ask for one 15-minute conversation to determine whether a small pilot is worth exploring.
- No offer to send a sample.
- No forced personal hook, hype, flattery, buzzwords, em dashes, signature, or multiple calls to action.
- End exactly with: If this is not relevant, I will not follow up.
- Subject is 3 to 7 words, sentence case, under 55 characters.

Use the record_outreach_email tool.`;

const TOOL = {
  name: "record_outreach_email",
  description: "Return the subject and body for one Rulix outreach email.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["subject", "body"],
    properties: {
      subject: { type: "string" },
      body: { type: "string" }
    }
  }
} as const;

export function outreachModel() {
  return process.env.BEDROCK_OUTREACH_MODEL?.trim() || DEFAULT_OUTREACH_MODEL;
}

export function outreachReady() {
  return process.env.BEDROCK_ENABLED === "true";
}

export async function generateOutreachDraft(
  lead: OutreachLead,
  direction = "",
  onUsage?: (sample: UsageSample) => void
): Promise<OutreachDraft> {
  if (!outreachReady()) throw new Error("Amazon Bedrock is not enabled for this deployment.");
  const model = outreachModel();
  const startedAt = Date.now();
  const client = new AnthropicBedrock();
  const response = await client.messages.create(
    {
      model,
      max_tokens: 700,
      temperature: 0.35,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            organization: lead.organization,
            recipientDepartment: lead.persona,
            recipientEmail: lead.email,
            segment: lead.segment,
            location: [lead.city, lead.state].filter(Boolean).join(", "),
            outreachContext: lead.outreachAngle,
            founderDirection: direction.trim() || undefined
          })
        }
      ]
    },
    {
      signal: AbortSignal.timeout(55_000),
      maxRetries: 0
    }
  );

  const usage = response.usage as unknown as Record<string, unknown>;
  onUsage?.({
    model,
    callType: "outreach-writer",
    inputTokens: numberValue(usage.input_tokens),
    outputTokens: numberValue(usage.output_tokens),
    cacheReadTokens: numberValue(usage.cache_read_input_tokens),
    cacheWriteTokens: numberValue(usage.cache_creation_input_tokens),
    latencyMs: Date.now() - startedAt
  });

  const block = response.content.find(
    (item) => item.type === "tool_use" && item.name === TOOL.name
  );
  if (!block || block.type !== "tool_use") throw new Error("Bedrock did not return a structured outreach draft.");
  const payload = block.input as Record<string, unknown>;
  const subject = clean(String(payload.subject ?? "")).slice(0, 80);
  const body = clean(String(payload.body ?? ""));
  if (!subject || !body) throw new Error("Bedrock returned an empty subject or body.");
  if (body.includes("—")) throw new Error("Bedrock returned an em dash. Generate again.");
  if (!body.endsWith("If this is not relevant, I will not follow up.")) {
    throw new Error("Bedrock did not include the required opt-out sentence.");
  }

  const now = new Date().toISOString();
  return {
    leadId: lead.leadId,
    organization: lead.organization,
    email: lead.email,
    subject,
    body,
    model,
    generatedAt: now,
    updatedAt: now
  };
}

function clean(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
