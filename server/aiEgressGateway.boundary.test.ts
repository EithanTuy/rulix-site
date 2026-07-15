// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  directConstructor: vi.fn(),
  bedrockConstructor: vi.fn(),
  create: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }], usage: {} }))
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(function DirectClient(options: unknown) {
    sdk.directConstructor(options);
    return { messages: { create: sdk.create } };
  })
}));

vi.mock("@anthropic-ai/bedrock-sdk", () => ({
  default: vi.fn(function BedrockClient(options: unknown) {
    sdk.bedrockConstructor(options);
    return { messages: { create: sdk.create } };
  })
}));

import {
  dispatchAuthorizedAiRequest,
  issueTrustedAiWorkflowGrant,
  resolveBedrockLane,
  type AiDispatchAdmissionHook,
  type AiDispatchAuthorizationHook,
  type AiProviderLane
} from "./aiEgressGateway";

const ORIGINAL_ENV = { ...process.env };
const MODEL = "claude-approved-model";

describe("AI egress credential boundary", () => {
  beforeEach(() => {
    sdk.directConstructor.mockClear();
    sdk.bedrockConstructor.mockClear();
    sdk.create.mockClear();
    process.env.RULIX_AI_DATA_CLASS = "proprietary";
    process.env.RULIX_AI_POLICY_VERSION = "policy-v1";
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.RULIX_CONTROLLED_DATA_MODE = "blocked";
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
  });

  it("pins the direct Anthropic endpoint despite a hostile SDK override environment", async () => {
    process.env.RULIX_APPROVED_PROVIDER = "anthropic-direct";
    process.env.RULIX_APPROVED_REGION = "global";
    process.env.ANTHROPIC_BASE_URL = "https://attacker.invalid/direct";
    await dispatch("anthropic-direct", "global");
    expect(sdk.directConstructor).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: "https://api.anthropic.com"
    }));
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it("pins Bedrock to the exact approved regional runtime endpoint", async () => {
    process.env.RULIX_APPROVED_PROVIDER = "amazon-bedrock";
    process.env.RULIX_APPROVED_REGION = "us-east-1";
    process.env.AWS_REGION = "us-east-1";
    process.env.ANTHROPIC_BEDROCK_BASE_URL = "https://attacker.invalid/bedrock";
    await dispatch("amazon-bedrock", "us-east-1");
    expect(sdk.bedrockConstructor).toHaveBeenCalledWith(expect.objectContaining({
      awsRegion: "us-east-1",
      baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com"
    }));
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    "US-EAST-1",
    " us-east-1",
    "us-east-1 ",
    "us.east-1",
    "us-east-1/evil",
    "user@us-east-1",
    "https://attacker.invalid"
  ])("rejects malformed AWS Region identity %s before client construction", (region) => {
    process.env.BEDROCK_ENABLED = "true";
    process.env.AWS_REGION = region;
    expect(() => resolveBedrockLane(MODEL)).toThrow(/Region identity is invalid/);
    expect(sdk.bedrockConstructor).not.toHaveBeenCalled();
  });

  it("rejects a provider body model that differs from the authorized lane before any hook or client", async () => {
    const authorization = vi.fn();
    const admission = vi.fn();
    const lane: AiProviderLane = { provider: "anthropic-direct", region: "global", model: MODEL };
    await expect(dispatchAuthorizedAiRequest(
      trustedContext(),
      lane,
      { model: "different-model", max_tokens: 64, messages: [] },
      undefined,
      undefined,
      admission,
      authorization
    )).rejects.toMatchObject({ code: "ai_provider_model_mismatch" });
    expect(authorization).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
    expect(sdk.directConstructor).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("does not construct a provider client when the final durable start fence denies", async () => {
    process.env.RULIX_APPROVED_PROVIDER = "anthropic-direct";
    process.env.RULIX_APPROVED_REGION = "global";
    const authorizationSettle = vi.fn();
    const admissionSettle = vi.fn();
    const authorization: AiDispatchAuthorizationHook = vi.fn(async () => ({
      replayed: false,
      markProviderStarted: vi.fn(async () => {
        throw new Error("fenced");
      }),
      settle: authorizationSettle
    }));
    const admission: AiDispatchAdmissionHook = vi.fn(async () => ({ settle: admissionSettle }));
    await expect(dispatchAuthorizedAiRequest(
      trustedContext(),
      { provider: "anthropic-direct", region: "global", model: MODEL },
      { model: MODEL, max_tokens: 64, messages: [] },
      undefined,
      undefined,
      admission,
      authorization
    )).rejects.toThrow("fenced");
    expect(sdk.directConstructor).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
    expect(authorizationSettle).toHaveBeenCalledWith({ status: "released" });
    expect(admissionSettle).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("releases an approval without consuming the start fence when direct-provider credentials are already missing", async () => {
    process.env.RULIX_APPROVED_PROVIDER = "anthropic-direct";
    process.env.RULIX_APPROVED_REGION = "global";
    delete process.env.ANTHROPIC_API_KEY;
    const markProviderStarted = vi.fn();
    const authorizationSettle = vi.fn();
    const admissionSettle = vi.fn();
    const authorization: AiDispatchAuthorizationHook = vi.fn(async () => ({
      replayed: false,
      markProviderStarted,
      settle: authorizationSettle
    }));
    const admission: AiDispatchAdmissionHook = vi.fn(async () => ({ settle: admissionSettle }));

    await expect(dispatchAuthorizedAiRequest(
      trustedContext(),
      { provider: "anthropic-direct", region: "global", model: MODEL },
      { model: MODEL, max_tokens: 64, messages: [] },
      undefined,
      undefined,
      admission,
      authorization
    )).rejects.toMatchObject({ code: "ai_provider_unavailable", status: 503 });

    expect(markProviderStarted).not.toHaveBeenCalled();
    expect(sdk.directConstructor).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
    expect(authorizationSettle).toHaveBeenCalledWith({ status: "released" });
    expect(admissionSettle).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("rechecks direct-provider credentials after the durable start fence before constructing a client", async () => {
    process.env.RULIX_APPROVED_PROVIDER = "anthropic-direct";
    process.env.RULIX_APPROVED_REGION = "global";
    const entered = deferred<void>();
    const release = deferred<void>();
    const authorizationSettle = vi.fn();
    const admissionSettle = vi.fn();
    const markProviderStarted = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const authorization: AiDispatchAuthorizationHook = vi.fn(async () => ({
      replayed: false,
      markProviderStarted,
      settle: authorizationSettle
    }));
    const admission: AiDispatchAdmissionHook = vi.fn(async () => ({ settle: admissionSettle }));

    const pending = dispatchAuthorizedAiRequest(
      trustedContext(),
      { provider: "anthropic-direct", region: "global", model: MODEL },
      { model: MODEL, max_tokens: 64, messages: [] },
      undefined,
      undefined,
      admission,
      authorization
    );
    await entered.promise;
    delete process.env.ANTHROPIC_API_KEY;
    release.resolve();

    await expect(pending).rejects.toMatchObject({ code: "ai_provider_unavailable", status: 503 });
    expect(markProviderStarted).toHaveBeenCalledTimes(1);
    expect(sdk.directConstructor).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
    expect(authorizationSettle).toHaveBeenCalledWith({ status: "failed" });
    expect(admissionSettle).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });
});

async function dispatch(provider: AiProviderLane["provider"], region: string) {
  const lane = provider === "anthropic-direct"
    ? { provider, region: "global" as const, model: MODEL }
    : { provider, region, model: MODEL };
  const authorization: AiDispatchAuthorizationHook = async () => ({
    replayed: false,
    markProviderStarted: async () => undefined,
    settle: async () => undefined
  });
  const admission: AiDispatchAdmissionHook = async () => ({ settle: async () => undefined });
  return dispatchAuthorizedAiRequest(
    trustedContext(),
    lane,
    { model: MODEL, max_tokens: 64, messages: [] },
    undefined,
    undefined,
    admission,
    authorization
  );
}

function trustedContext() {
  return {
    accountId: "account-security",
    dataClass: "proprietary" as const,
    payload: { exact: "payload" },
    purpose: "outreach-writer" as const,
    dispatchId: "dispatch-security",
    trustedWorkflowGrant: issueTrustedAiWorkflowGrant("outreach-writer", "subject-security")
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
