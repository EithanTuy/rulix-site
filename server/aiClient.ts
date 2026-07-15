export interface StoredOutreachConfig {
  provider: "bedrock" | "anthropic";
}

export function defaultOutreachConfig(): StoredOutreachConfig {
  return { provider: deploymentOutreachProvider() };
}

/** Allow-list persisted configuration so legacy plaintext credentials are discarded. */
export function sanitizeOutreachConfig(value: unknown): StoredOutreachConfig {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const provider = (value as { provider?: unknown }).provider;
    if (provider === "bedrock" || provider === "anthropic") return { provider };
  }
  return defaultOutreachConfig();
}

export function outreachProviderReady(config: StoredOutreachConfig): boolean {
  const approvedProvider = process.env.RULIX_APPROVED_PROVIDER?.trim().toLowerCase() || "amazon-bedrock";
  const approvedRegion = process.env.RULIX_APPROVED_REGION?.trim().toLowerCase();
  if (approvedProvider === "anthropic-direct") {
    return config.provider === "anthropic" &&
      approvedRegion === "global" &&
      Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  }
  const actualRegion = process.env.AWS_REGION?.trim().toLowerCase() ||
    process.env.AWS_DEFAULT_REGION?.trim().toLowerCase();
  return config.provider === "bedrock" &&
    approvedProvider === "amazon-bedrock" &&
    process.env.BEDROCK_ENABLED?.trim().toLowerCase() === "true" &&
    Boolean(actualRegion) &&
    (!approvedRegion || approvedRegion === actualRegion);
}

export function deploymentOutreachProvider(): StoredOutreachConfig["provider"] {
  return process.env.RULIX_APPROVED_PROVIDER?.trim().toLowerCase() === "anthropic-direct"
    ? "anthropic"
    : "bedrock";
}

export function outreachDeploymentStatus(config: StoredOutreachConfig) {
  const deploymentProvider = deploymentOutreachProvider();
  const credentialConfigured = deploymentProvider === "anthropic"
    ? Boolean(process.env.ANTHROPIC_API_KEY?.trim())
    : process.env.BEDROCK_ENABLED?.trim().toLowerCase() === "true" &&
      Boolean(process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim());
  return {
    provider: config.provider,
    deploymentProvider,
    credentialConfigured,
    ready: outreachProviderReady(config)
  };
}

// Strips Bedrock regional prefix and version suffix so the model ID is valid
// for the direct Anthropic API.
// e.g. "global.anthropic.claude-sonnet-4-6" → "claude-sonnet-4-6"
//      "us.anthropic.claude-opus-4-6-v1"    → "claude-opus-4-6"
export function resolveModel(bedrockModelId: string, config: StoredOutreachConfig): string {
  if (config.provider !== "anthropic") return bedrockModelId;
  return bedrockModelId
    .replace(/^(?:global|us|eu|apac|jp)\.anthropic\./, "")
    .replace(/-v\d+(?::\d+)?$/, "");
}
