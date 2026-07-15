// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiEgressPolicyError,
  dispatchAuthorizedAiRequest,
  resolveBedrockLane,
  resolveMemoBuilderLane,
  setAiDispatchAdmissionHook,
  setAiDispatchAuthorizationHook,
  type AiProviderClient
} from "./aiEgressGateway";
import { hashAiApprovalPayload } from "./domain/aiApproval";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.BEDROCK_ENABLED = "true";
  process.env.AWS_REGION = "us-east-1";
  process.env.RULIX_APPROVED_PROVIDER = "amazon-bedrock";
  process.env.RULIX_APPROVED_REGION = "us-east-1";
  process.env.RULIX_AI_DATA_CLASS = "proprietary";
  delete process.env.RULIX_CONTROLLED_DATA_MODE;
  delete process.env.RULIX_APPROVED_MODEL_IDS;
  delete process.env.ANTHROPIC_API_KEY;
  setAiDispatchAuthorizationHook(async () => ({
    replayed: false,
    markProviderStarted: async () => undefined,
    settle: async () => undefined
  }));
});

afterEach(() => {
  setAiDispatchAdmissionHook(undefined);
  setAiDispatchAuthorizationHook(undefined);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("AI egress gateway", () => {
  it("rejects a caller-controlled benign class below the deployment-owned floor before provider use", async () => {
    const { client, create } = providerSpy();
    const lane = resolveBedrockLane("test-model")!;

    await expect(dispatchAuthorizedAiRequest(
      {
        ...approvalBindings(),
        accountId: "account-1",
        dataClass: "public",
        payload: { memo: "controlled-looking content" },
        purpose: "council"
      },
      lane,
      { model: lane.model, max_tokens: 100, messages: [] },
      undefined,
      client
    )).rejects.toMatchObject({ code: "ai_data_class_below_floor" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects provider-region drift before provider use", async () => {
    const { client, create } = providerSpy();
    const lane = resolveBedrockLane("test-model")!;
    process.env.RULIX_APPROVED_REGION = "us-west-2";

    await expect(dispatchAuthorizedAiRequest(
      {
        ...approvalBindings(),
        accountId: "account-1",
        dataClass: "proprietary",
        payload: { memo: "approved content" },
        purpose: "council"
      },
      lane,
      { model: lane.model, max_tokens: 100, messages: [] },
      undefined,
      client
    )).rejects.toMatchObject({ code: "ai_egress_lane_mismatch" });
    expect(create).not.toHaveBeenCalled();
  });

  it("fails closed on an invalid deployment classification", async () => {
    const { client, create } = providerSpy();
    const lane = resolveBedrockLane("test-model")!;
    process.env.RULIX_AI_DATA_CLASS = "unknown";

    await expect(dispatchAuthorizedAiRequest(
      {
        ...approvalBindings(),
        accountId: "account-1",
        dataClass: "proprietary",
        payload: {},
        purpose: "memo-chat"
      },
      lane,
      { model: lane.model, max_tokens: 100, messages: [] },
      undefined,
      client
    )).rejects.toMatchObject({ code: "ai_data_class_invalid", status: 503 });
    expect(create).not.toHaveBeenCalled();
  });

  it("fails closed on an unrecognized approved provider before admission or provider use", async () => {
    const admission = vi.fn();
    setAiDispatchAdmissionHook(admission);
    const { client, create } = providerSpy();
    const lane = resolveBedrockLane("test-model")!;
    process.env.RULIX_APPROVED_PROVIDER = "typo-provider";

    await expect(dispatchAuthorizedAiRequest(
      {
        ...approvalBindings(),
        accountId: "account-1",
        dataClass: "proprietary",
        payload: {},
        purpose: "council"
      },
      lane,
      { model: lane.model, max_tokens: 100, messages: [] },
      undefined,
      client
    )).rejects.toMatchObject({ code: "ai_egress_policy_invalid", status: 503 });
    expect(admission).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("selects the approved Bedrock lane even when a direct Anthropic key is present", () => {
    process.env.ANTHROPIC_API_KEY = "direct-key-that-must-not-shadow-policy";

    expect(resolveMemoBuilderLane({
      anthropicModel: "direct-model",
      bedrockModel: "bedrock-model"
    })).toEqual({
      provider: "amazon-bedrock",
      region: "us-east-1",
      model: "bedrock-model"
    });
  });

  it("rejects controlled content through the non-regional direct provider", async () => {
    process.env.ANTHROPIC_API_KEY = "direct-key";
    process.env.RULIX_APPROVED_PROVIDER = "anthropic-direct";
    process.env.RULIX_APPROVED_REGION = "global";
    process.env.RULIX_CONTROLLED_DATA_MODE = "approved";
    process.env.RULIX_AI_DATA_CLASS = "cui";
    const lane = resolveMemoBuilderLane({
      anthropicModel: "direct-model",
      bedrockModel: "bedrock-model"
    })!;
    const { client, create } = providerSpy();

    await expect(dispatchAuthorizedAiRequest(
      {
        ...approvalBindings(),
        accountId: "account-1",
        dataClass: "cui",
        payload: { messages: [] },
        purpose: "memo-builder"
      },
      lane,
      { model: lane.model, max_tokens: 100, messages: [] },
      undefined,
      client
    )).rejects.toMatchObject({ code: "ai_egress_lane_mismatch" });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    "global.anthropic.claude-sonnet-4-6",
    "us.anthropic.claude-sonnet-4-6",
    "eu.anthropic.claude-sonnet-4-6",
    "apac.anthropic.claude-sonnet-4-6",
    "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/opaque-profile"
  ])("rejects controlled content through cross-Region inference profile %s", async (model) => {
    enableControlledModelPolicy([model]);
    const admission = vi.fn(async () => ({ settle: vi.fn() }));
    setAiDispatchAdmissionHook(admission);
    const { client, create } = providerSpy();

    await expect(controlledDispatch(model, client)).rejects.toMatchObject({
      code: "ai_model_cross_region_not_allowed"
    });
    expect(admission).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a regional controlled-data model that is not exactly allowlisted", async () => {
    enableControlledModelPolicy(["anthropic.claude-haiku-4-5-20251001-v1:0"]);
    const admission = vi.fn(async () => ({ settle: vi.fn() }));
    setAiDispatchAdmissionHook(admission);
    const { client, create } = providerSpy();

    await expect(controlledDispatch("anthropic.claude-sonnet-4-6", client)).rejects.toMatchObject({
      code: "ai_model_not_approved"
    });
    expect(admission).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    "anthropic.claude-sonnet-4-6",
    "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6"
  ])("dispatches controlled content through exactly approved regional model %s", async (model) => {
    enableControlledModelPolicy([model]);
    const settlement = vi.fn();
    const admission = vi.fn(async () => ({ settle: settlement }));
    setAiDispatchAdmissionHook(admission);
    const { client, create } = providerSpy();

    await expect(controlledDispatch(model, client)).resolves.toMatchObject({ content: [] });
    expect(admission).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(settlement).toHaveBeenCalledWith(expect.objectContaining({ status: "succeeded" }));
  });

  it.each([
    ["missing", undefined],
    ["malformed JSON", "not-json"],
    ["empty", "[]"],
    ["malformed model identity", JSON.stringify(["anthropic.claude sonnet"])],
    ["cross-Region entry", JSON.stringify(["global.anthropic.claude-sonnet-4-6"])],
    [
      "wrong-Region ARN",
      JSON.stringify(["arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6"])
    ]
  ])("fails controlled model policy closed when the allowlist is %s", async (_label, raw) => {
    process.env.RULIX_AI_DATA_CLASS = "cui";
    process.env.RULIX_CONTROLLED_DATA_MODE = "approved";
    if (raw === undefined) delete process.env.RULIX_APPROVED_MODEL_IDS;
    else process.env.RULIX_APPROVED_MODEL_IDS = raw;
    const admission = vi.fn(async () => ({ settle: vi.fn() }));
    setAiDispatchAdmissionHook(admission);
    const { client, create } = providerSpy();

    await expect(controlledDispatch("anthropic.claude-sonnet-4-6", client)).rejects.toMatchObject({
      code: "ai_model_policy_invalid",
      status: 503
    });
    expect(admission).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an allowlisted Bedrock ARN whose Region differs from the provider client", async () => {
    const model = "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6";
    enableControlledModelPolicy([model]);
    const admission = vi.fn(async () => ({ settle: vi.fn() }));
    setAiDispatchAdmissionHook(admission);
    const { client, create } = providerSpy();

    await expect(controlledDispatch(model, client)).rejects.toMatchObject({
      code: "ai_model_region_mismatch"
    });
    expect(admission).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("acquires admission before dispatch and settles successful usage", async () => {
    const events: string[] = [];
    setAiDispatchAuthorizationHook(async () => {
      events.push("reserve");
      return {
        replayed: false,
        markProviderStarted: async () => { events.push("mark"); },
        settle: async (result) => { events.push(`authorization:${result.status}`); }
      };
    });
    const admission = vi.fn(async (metadata) => {
      events.push(`admit:${metadata.callType}:${metadata.maxOutputTokens}`);
      return {
        settle: vi.fn(async (result) => {
          events.push(`settle:${result.status}`);
        })
      };
    });
    setAiDispatchAdmissionHook(admission);
    const { client, create } = providerSpy(() => {
      events.push("provider");
      return { content: [], usage: { input_tokens: 12, output_tokens: 4 } };
    });
    const lane = resolveBedrockLane("test-model")!;

    await dispatchAuthorizedAiRequest(
      {
        ...approvalBindings(),
        accountId: "account-1",
        dataClass: "proprietary",
        payload: { memo: "approved content" },
        purpose: "council"
      },
      lane,
      { model: lane.model, max_tokens: 321, messages: [{ role: "user", content: "hello" }] },
      undefined,
      client
    );

    expect(create).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "reserve",
      "admit:council:321",
      "mark",
      "provider",
      "settle:succeeded",
      "authorization:succeeded"
    ]);
    expect(admission).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account-1",
      provider: "amazon-bedrock",
      region: "us-east-1"
    }));
  });

  it("revalidates deployment policy after the durable provider-start claim", async () => {
    const markEntered = deferred<void>();
    const releaseMark = deferred<void>();
    const authorizationSettlement = vi.fn();
    setAiDispatchAuthorizationHook(async () => ({
      replayed: false,
      markProviderStarted: async () => {
        markEntered.resolve();
        await releaseMark.promise;
      },
      settle: authorizationSettlement
    }));
    const admissionSettlement = vi.fn();
    setAiDispatchAdmissionHook(async () => ({ settle: admissionSettlement }));
    const { client, create } = providerSpy();
    const lane = resolveBedrockLane("test-model")!;
    const pending = dispatchAuthorizedAiRequest(
      {
        ...approvalBindings(),
        accountId: "account-1",
        dataClass: "proprietary",
        payload: {},
        purpose: "council"
      },
      lane,
      { model: lane.model, max_tokens: 100, messages: [] },
      undefined,
      client
    );

    await markEntered.promise;
    process.env.RULIX_APPROVED_REGION = "us-west-2";
    releaseMark.resolve();

    await expect(pending).rejects.toMatchObject({ code: "ai_egress_lane_mismatch" });
    expect(create).not.toHaveBeenCalled();
    expect(admissionSettlement).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(authorizationSettlement).toHaveBeenCalledWith({ status: "failed" });
  });

  it("enforces one bounded provider attempt while allowing only timeout and cancellation", async () => {
    setAiDispatchAdmissionHook(async () => ({ settle: vi.fn() }));
    const { client, create } = providerSpy();
    const lane = resolveBedrockLane("test-model")!;
    const context = {
      ...approvalBindings(),
      accountId: "account-1",
      dataClass: "proprietary" as const,
      payload: {},
      purpose: "memo-chat" as const
    };
    const body = { model: lane.model, max_tokens: 100, messages: [] };

    await dispatchAuthorizedAiRequest(context, lane, body, undefined, client);
    expect(create).toHaveBeenLastCalledWith(body, {
      timeout: 60_000,
      maxRetries: 0
    });

    const signal = AbortSignal.timeout(1_000);
    await dispatchAuthorizedAiRequest(
      context,
      lane,
      body,
      { timeout: 900_000, signal },
      client
    );
    expect(create).toHaveBeenLastCalledWith(body, {
      timeout: 110_000,
      maxRetries: 0,
      signal
    });
  });

  it.each([
    ["custom headers", { headers: { authorization: "attacker-controlled" } }],
    ["a custom transport agent", { httpAgent: {} }],
    ["caller-selected retries", { maxRetries: 1 }]
  ])("rejects %s before authorization, admission, or provider construction", async (_label, options) => {
    const authorization = vi.fn(async () => ({
      replayed: false,
      markProviderStarted: vi.fn(),
      settle: vi.fn()
    }));
    const admission = vi.fn(async () => ({ settle: vi.fn() }));
    setAiDispatchAuthorizationHook(authorization);
    setAiDispatchAdmissionHook(admission);
    const { client, create } = providerSpy();
    const lane = resolveBedrockLane("test-model")!;

    await expect(dispatchAuthorizedAiRequest(
      {
        ...approvalBindings(),
        accountId: "account-1",
        dataClass: "proprietary",
        payload: {},
        purpose: "council"
      },
      lane,
      { model: lane.model, max_tokens: 100, messages: [] },
      options,
      client
    )).rejects.toMatchObject({ code: "ai_provider_options_invalid", status: 503 });
    expect(authorization).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["context accessor", () => {
      const context = {
        ...approvalBindings(),
        accountId: "account-1",
        dataClass: "proprietary" as const,
        payload: {},
        purpose: "council" as const
      };
      return {
        context: Object.defineProperty(context, "accountId", {
          enumerable: true,
          get: () => "account-1"
        }),
        lane: resolveBedrockLane("test-model")!
      };
    }],
    ["lane accessor", () => ({
      context: {
        ...approvalBindings(),
        accountId: "account-1",
        dataClass: "proprietary" as const,
        payload: {},
        purpose: "council" as const
      },
      lane: Object.defineProperty({
        provider: "amazon-bedrock" as const,
        region: "us-east-1",
        model: "test-model"
      }, "region", {
        enumerable: true,
        get: () => "us-east-1"
      })
    })],
    ["unknown outer field", () => ({
      context: {
        ...approvalBindings(),
        accountId: "account-1",
        dataClass: "proprietary" as const,
        payload: {},
        purpose: "council" as const,
        unreviewedCredentialOption: "forbidden"
      },
      lane: resolveBedrockLane("test-model")!
    })]
  ])("rejects a non-canonical %s before any hook or client boundary", async (_label, build) => {
    const authorization = vi.fn();
    const admission = vi.fn();
    setAiDispatchAuthorizationHook(authorization);
    setAiDispatchAdmissionHook(admission);
    const { client, create } = providerSpy();
    const { context, lane } = build();

    await expect(dispatchAuthorizedAiRequest(
      context,
      lane,
      { model: "test-model", max_tokens: 100, messages: [] },
      undefined,
      client
    )).rejects.toMatchObject({ code: "ai_provider_request_invalid", status: 422 });
    expect(authorization).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("snapshots every authorization and provider input before asynchronous reservations", async () => {
    const authorizationBarrier = deferred<void>();
    const admissionBarrier = deferred<void>();
    const authorizationEntered = deferred<void>();
    const admissionEntered = deferred<void>();
    const authorizationMetadata = vi.fn();
    const admissionMetadata = vi.fn();
    setAiDispatchAuthorizationHook(async (metadata) => {
      authorizationMetadata(metadata);
      authorizationEntered.resolve();
      await authorizationBarrier.promise;
      return {
        replayed: false,
        markProviderStarted: vi.fn(),
        settle: vi.fn()
      };
    });
    setAiDispatchAdmissionHook(async (metadata) => {
      admissionMetadata(metadata);
      admissionEntered.resolve();
      await admissionBarrier.promise;
      return { settle: vi.fn() };
    });
    const { client, create } = providerSpy();
    const lane = resolveBedrockLane("test-model")!;
    const context = {
      ...approvalBindings(),
      accountId: "account-1",
      dataClass: "proprietary" as const,
      payload: { memo: { text: "approved payload" } },
      purpose: "council" as const
    };
    const body = {
      model: lane.model,
      max_tokens: 100,
      messages: [{ role: "user", content: [{ type: "text", text: "approved provider body" }] }]
    };
    const expectedBody = structuredClone(body);
    const expectedPayload = structuredClone(context.payload);
    const expectedSubject = structuredClone(context.subject);

    const pending = dispatchAuthorizedAiRequest(context, lane, body, undefined, client);
    await authorizationEntered.promise;
    body.messages[0]!.content[0]!.text = "mutated during authorization";
    context.payload.memo.text = "mutated during authorization";
    context.subject.contentHash = "b".repeat(64);
    lane.model = "mutated-model";
    lane.region = "us-west-2";
    authorizationBarrier.resolve();

    await admissionEntered.promise;
    body.messages.push({ role: "user", content: [{ type: "text", text: "late injection" }] });
    context.payload.memo.text = "mutated during admission";
    lane.provider = "anthropic-direct" as typeof lane.provider;
    admissionBarrier.resolve();
    await pending;

    expect(authorizationMetadata).toHaveBeenCalledWith(expect.objectContaining({
      payloadHash: hashAiApprovalPayload(expectedPayload),
      providerRequestHash: hashAiApprovalPayload(expectedBody),
      policy: expect.objectContaining({
        provider: "amazon-bedrock",
        clientRegion: "us-east-1",
        model: "test-model"
      }),
      authorization: expect.objectContaining({ subject: expectedSubject })
    }));
    expect(admissionMetadata).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account-1",
      model: "test-model",
      provider: "amazon-bedrock",
      region: "us-east-1"
    }));
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(expectedBody, { timeout: 60_000, maxRetries: 0 });
    expect(create.mock.calls[0]![0]).not.toBe(body);
    expect(Object.isFrozen(create.mock.calls[0]![0])).toBe(true);
  });

  it.each([
    ["undefined values", { model: "test-model", messages: [{ content: undefined }] }],
    ["accessors", Object.defineProperty({ model: "test-model", messages: [] }, "system", {
      enumerable: true,
      get: () => "hidden"
    })],
    ["cycles", (() => {
      const value: Record<string, unknown> = { model: "test-model", messages: [] };
      value.self = value;
      return value;
    })()]
  ])("rejects non-canonical provider request graphs containing %s", async (_label, body) => {
    const admission = vi.fn();
    setAiDispatchAdmissionHook(admission);
    const { client, create } = providerSpy();
    const lane = resolveBedrockLane("test-model")!;
    await expect(dispatchAuthorizedAiRequest(
      {
        ...approvalBindings(),
        accountId: "account-1",
        dataClass: "proprietary",
        payload: {},
        purpose: "council"
      },
      lane,
      body,
      undefined,
      client
    )).rejects.toMatchObject({ code: "ai_provider_request_invalid", status: 422 });
    expect(admission).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects malformed provider options before constructing a provider request", async () => {
    const admission = vi.fn(async () => ({ settle: vi.fn() }));
    setAiDispatchAdmissionHook(admission);
    const { client, create } = providerSpy();
    const lane = resolveBedrockLane("test-model")!;

    await expect(dispatchAuthorizedAiRequest(
      {
        ...approvalBindings(),
        accountId: "account-1",
        dataClass: "proprietary",
        payload: {},
        purpose: "council"
      },
      lane,
      { model: lane.model, max_tokens: 100, messages: [] },
      { timeout: Number.NaN },
      client
    )).rejects.toMatchObject({ code: "ai_provider_options_invalid", status: 503 });
    expect(admission).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("fails closed before provider construction when account admission is not installed", async () => {
    const { client, create } = providerSpy();
    const lane = resolveBedrockLane("test-model")!;

    await expect(dispatchAuthorizedAiRequest(
      {
        ...approvalBindings(),
        accountId: "account-1",
        dataClass: "proprietary",
        payload: {},
        purpose: "council"
      },
      lane,
      { model: lane.model, max_tokens: 100, messages: [] },
      undefined,
      client
    )).rejects.toMatchObject({ code: "ai_admission_unconfigured", status: 503 });
    expect(create).not.toHaveBeenCalled();
  });

  it("does not construct or call a provider when account admission denies the request", async () => {
    const admissionError = new AiEgressPolicyError("account_ai_limit_exceeded", "limit", 429);
    setAiDispatchAdmissionHook(async () => {
      throw admissionError;
    });
    const { client, create } = providerSpy();
    const lane = resolveBedrockLane("test-model")!;

    await expect(dispatchAuthorizedAiRequest(
      {
        ...approvalBindings(),
        accountId: "account-1",
        dataClass: "proprietary",
        payload: {},
        purpose: "council"
      },
      lane,
      { model: lane.model, max_tokens: 100, messages: [] },
      undefined,
      client
    )).rejects.toBe(admissionError);
    expect(create).not.toHaveBeenCalled();
  });
});

function providerSpy(implementation?: () => { content: []; usage?: unknown }) {
  const create = vi.fn(async (_body: unknown, _options?: unknown) =>
    implementation?.() ?? ({ content: [], usage: undefined }));
  const client: AiProviderClient = { messages: { create } };
  return { client, create };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function approvalBindings() {
  return {
    approvalId: "approval-test",
    dispatchId: "dispatch-test",
    subject: {
      kind: "review" as const,
      id: "review-test",
      revision: 1,
      version: 1,
      contentHash: "a".repeat(64)
    }
  };
}

function enableControlledModelPolicy(models: string[]) {
  process.env.RULIX_AI_DATA_CLASS = "cui";
  process.env.RULIX_CONTROLLED_DATA_MODE = "approved";
  process.env.RULIX_APPROVED_MODEL_IDS = JSON.stringify(models);
}

function controlledDispatch(model: string, client: AiProviderClient) {
  const lane = resolveBedrockLane(model)!;
  return dispatchAuthorizedAiRequest(
    {
      ...approvalBindings(),
      accountId: "controlled-account",
      dataClass: "cui",
      payload: { memo: "controlled technical data" },
      purpose: "council"
    },
    lane,
    { model, max_tokens: 100, messages: [{ role: "user", content: "Review this item." }] },
    undefined,
    client
  );
}
