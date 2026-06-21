import Anthropic from "@anthropic-ai/sdk";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";

export function isAnthropicDirect() {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

// Ready if either the direct Anthropic API key or Bedrock is configured.
export function outreachProviderReady() {
  return isAnthropicDirect() || process.env.BEDROCK_ENABLED === "true";
}

// Returns a client compatible with the Anthropic messages API.
// Uses the direct Anthropic API when ANTHROPIC_API_KEY is set, otherwise Bedrock.
export function createAIClient(): Anthropic {
  if (isAnthropicDirect()) {
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return new AnthropicBedrock() as unknown as Anthropic;
}

// Strips Bedrock regional prefix and version suffix so the model ID is valid
// for the direct Anthropic API.
// e.g. "global.anthropic.claude-sonnet-4-6" → "claude-sonnet-4-6"
//      "us.anthropic.claude-opus-4-6-v1"    → "claude-opus-4-6"
export function resolveModel(bedrockModelId: string): string {
  if (!isAnthropicDirect()) return bedrockModelId;
  return bedrockModelId
    .replace(/^(?:global|us)\.anthropic\./, "")
    .replace(/-v\d+(?::\d+)?$/, "");
}
