import Anthropic from "@anthropic-ai/sdk";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";

export interface StoredOutreachConfig {
  provider: "bedrock" | "anthropic";
  anthropicApiKey?: string;
}

export function defaultOutreachConfig(): StoredOutreachConfig {
  return { provider: "bedrock" };
}

export function outreachProviderReady(config: StoredOutreachConfig): boolean {
  if (config.provider === "anthropic") {
    return Boolean(config.anthropicApiKey?.trim());
  }
  return process.env.BEDROCK_ENABLED === "true";
}

// Returns a client compatible with the Anthropic messages API.
// Uses the direct Anthropic API when provider is "anthropic", otherwise Bedrock.
export function createAIClient(config: StoredOutreachConfig): Anthropic {
  if (config.provider === "anthropic" && config.anthropicApiKey?.trim()) {
    return new Anthropic({ apiKey: config.anthropicApiKey.trim() });
  }
  if (!outreachProviderReady(config)) {
    throw new Error(
      config.provider === "anthropic"
        ? "An Anthropic API key is not configured. Set one in the dashboard Settings tab."
        : "Amazon Bedrock is not enabled for this deployment."
    );
  }
  return new AnthropicBedrock() as unknown as Anthropic;
}

// Strips Bedrock regional prefix and version suffix so the model ID is valid
// for the direct Anthropic API.
// e.g. "global.anthropic.claude-sonnet-4-6" → "claude-sonnet-4-6"
//      "us.anthropic.claude-opus-4-6-v1"    → "claude-opus-4-6"
export function resolveModel(bedrockModelId: string, config: StoredOutreachConfig): string {
  if (config.provider !== "anthropic") return bedrockModelId;
  return bedrockModelId
    .replace(/^(?:global|us)\.anthropic\./, "")
    .replace(/-v\d+(?::\d+)?$/, "");
}

export function maskApiKey(key: string): string {
  if (key.length <= 12) return "****";
  return `${key.slice(0, 8)}${"*".repeat(Math.min(20, key.length - 12))}${key.slice(-4)}`;
}
