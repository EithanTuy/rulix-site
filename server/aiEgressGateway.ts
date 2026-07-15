import Anthropic from "@anthropic-ai/sdk";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import type {
  AiApprovalPolicyBinding,
  AiApprovalPurpose,
  AiApprovalSubjectBinding,
  DataClass
} from "../src/types";
import { hashAiApprovalPayload, sameAiApprovalPolicy } from "./domain/aiApproval";

export type AiEgressPurpose = AiApprovalPurpose;

export type AiProviderLane =
  | {
      provider: "amazon-bedrock";
      region: string;
      model: string;
    }
  | {
      provider: "anthropic-direct";
      region: "global";
      model: string;
    };

export interface AiProviderResponseBlock {
  type: string;
  name?: string;
  input?: unknown;
  text?: string;
}

export interface AiProviderResponse {
  content: AiProviderResponseBlock[];
  usage?: unknown;
}

export interface AiProviderClient {
  messages: {
    create: (body: unknown, options?: unknown) => Promise<AiProviderResponse>;
  };
}

export interface AiEgressContext {
  accountId: string;
  dataClass: DataClass;
  payload: unknown;
  purpose: AiEgressPurpose;
  /** Server-issued approval ID for user-initiated provider work. */
  approvalId?: string;
  /** Caller-generated idempotency ID for one logical provider attempt. */
  dispatchId: string;
  /** Exact server-owned subject snapshot approved for this call. */
  subject?: AiApprovalSubjectBinding;
  /** Opaque capability for the narrowly enumerated background workflows. */
  trustedWorkflowGrant?: AiTrustedWorkflowGrant;
}

export type AiTrustedWorkflow = "lead-search" | "outreach-personalization" | "outreach-writer";

declare const AI_TRUSTED_WORKFLOW_GRANT: unique symbol;
export interface AiTrustedWorkflowGrant {
  readonly [AI_TRUSTED_WORKFLOW_GRANT]: true;
}

export type AiDispatchAuthorizationIdentity =
  | {
      kind: "approval";
      approvalId: string;
      subject: AiApprovalSubjectBinding;
    }
  | {
      kind: "trusted-workflow";
      workflow: AiTrustedWorkflow;
      subjectId: string;
    };

export interface AiDispatchAuthorizationMetadata {
  accountId: string;
  authorization: AiDispatchAuthorizationIdentity;
  dataClass: DataClass;
  dispatchId: string;
  payloadHash: string;
  providerRequestHash: string;
  purpose: AiEgressPurpose;
  policy: AiApprovalPolicyBinding;
}

export interface AiDispatchAuthorizationSettlement {
  status: "failed" | "released" | "succeeded";
}

export interface AiDispatchAuthorizationLease {
  /** A durable identical dispatch receipt already exists; never call provider. */
  replayed: boolean;
  /** Atomically seals the receipt before provider construction or invocation. */
  markProviderStarted: () => Promise<void> | void;
  settle: (result: AiDispatchAuthorizationSettlement) => Promise<void> | void;
}

export type AiDispatchAuthorizationHook = (
  metadata: AiDispatchAuthorizationMetadata
) => Promise<AiDispatchAuthorizationLease> | AiDispatchAuthorizationLease;

export interface AiDispatchMetadata {
  accountId: string;
  callType: AiEgressPurpose;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  model: string;
  payloadBytes: number;
  provider: AiProviderLane["provider"];
  region: string;
}

export interface AiDispatchSettlement {
  error?: unknown;
  status: "failed" | "succeeded";
  usage?: unknown;
}

export interface AiDispatchLease {
  settle: (result: AiDispatchSettlement) => Promise<void> | void;
}

export type AiDispatchAdmissionHook = (
  metadata: AiDispatchMetadata
) => Promise<AiDispatchLease | void> | AiDispatchLease | void;

let defaultAdmissionHook: AiDispatchAdmissionHook | undefined;
let defaultAuthorizationHook: AiDispatchAuthorizationHook | undefined;
const trustedWorkflowGrants = new WeakMap<object, { workflow: AiTrustedWorkflow; subjectId: string }>();
const DEFAULT_PROVIDER_CONTEXT_TOKENS = 200_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;
const MAX_PROVIDER_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDER_REQUEST_DEPTH = 128;
const MAX_PROVIDER_REQUEST_NODES = 250_000;
const CONTROLLED_MODEL_ALLOWLIST_ENV = "RULIX_APPROVED_MODEL_IDS";
// CloudFront and the synchronous app Lambda are capped at 120 seconds. Keep a
// ten-second envelope for cold start, parsing, persistence, and response flush.
const MAX_PROVIDER_TIMEOUT_MS = 110_000;

export class AiEgressPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "AiEgressPolicyError";
  }
}

export function setAiDispatchAdmissionHook(hook: AiDispatchAdmissionHook | undefined) {
  const previous = defaultAdmissionHook;
  defaultAdmissionHook = hook;
  return () => {
    defaultAdmissionHook = previous;
  };
}

export function setAiDispatchAuthorizationHook(hook: AiDispatchAuthorizationHook | undefined) {
  const previous = defaultAuthorizationHook;
  defaultAuthorizationHook = hook;
  return () => {
    defaultAuthorizationHook = previous;
  };
}

/**
 * Issues a process-local, non-serializable capability for a background workflow.
 * A request body cannot manufacture a member of the WeakMap, and the gateway
 * additionally requires the grant workflow to equal its hard-coded purpose.
 */
export function issueTrustedAiWorkflowGrant(
  workflow: AiTrustedWorkflow,
  subjectId: string
): AiTrustedWorkflowGrant {
  if (!isTrustedWorkflow(workflow) || !validContextIdentifier(subjectId, 512)) {
    throw new AiEgressPolicyError(
      "ai_trusted_workflow_invalid",
      "The trusted AI workflow grant request is invalid.",
      500
    );
  }
  const grant = Object.freeze({}) as AiTrustedWorkflowGrant;
  trustedWorkflowGrants.set(grant, { workflow, subjectId });
  return grant;
}

export function parseDataClass(value: unknown): DataClass | undefined {
  return value === "public" ||
    value === "proprietary" ||
    value === "export-controlled" ||
    value === "itar-risk" ||
    value === "cui"
    ? value
    : undefined;
}

export function deploymentDataClass(): DataClass {
  const configured = process.env.RULIX_AI_DATA_CLASS?.trim().toLowerCase();
  if (!configured) return "proprietary";
  const parsed = parseDataClass(configured);
  if (!parsed) {
    throw new AiEgressPolicyError(
      "ai_data_class_invalid",
      "AI egress is disabled because RULIX_AI_DATA_CLASS is not a recognized classification.",
      503
    );
  }
  return parsed;
}

export function maxDataClass(left: DataClass, right: DataClass): DataClass {
  const order: DataClass[] = ["public", "proprietary", "export-controlled", "itar-risk", "cui"];
  return order[Math.max(order.indexOf(left), order.indexOf(right))];
}

export function isControlledDataClass(value: DataClass) {
  return value === "export-controlled" || value === "itar-risk" || value === "cui";
}

export function resolveBedrockLane(model: string): AiProviderLane | undefined {
  if (process.env.BEDROCK_ENABLED?.trim().toLowerCase() !== "true") return undefined;
  const region = configuredAwsRegion();
  if (!region) return undefined;
  return { provider: "amazon-bedrock", region, model };
}

/** Selects the approved lane first so an unrelated direct key cannot shadow Bedrock. */
export function resolveMemoBuilderLane(options: {
  anthropicModel: string;
  bedrockModel: string;
}): AiProviderLane | undefined {
  const approvedProvider = configuredApprovedProvider();
  if (approvedProvider === "amazon-bedrock") return resolveBedrockLane(options.bedrockModel);
  if (approvedProvider === "anthropic-direct" && process.env.ANTHROPIC_API_KEY?.trim()) {
    return {
      provider: "anthropic-direct",
      region: "global",
      model: options.anthropicModel
    };
  }
  return undefined;
}

export function resolveConfiguredAiLane(
  config: { provider: "bedrock" | "anthropic" },
  options: { anthropicModel: string; bedrockModel: string }
): AiProviderLane | undefined {
  const approvedProvider = configuredApprovedProvider();
  if (approvedProvider === "amazon-bedrock" && config.provider === "bedrock") {
    return resolveBedrockLane(options.bedrockModel);
  }
  if (
    approvedProvider === "anthropic-direct" &&
    config.provider === "anthropic" &&
    process.env.ANTHROPIC_API_KEY?.trim()
  ) {
    return {
      provider: "anthropic-direct",
      region: "global",
      model: options.anthropicModel
    };
  }
  return undefined;
}

/**
 * The only credential-bearing AI dispatch boundary in the application.
 * Policy and account admission complete before provider-client construction.
 */
export async function dispatchAuthorizedAiRequest(
  context: AiEgressContext,
  lane: AiProviderLane,
  body: unknown,
  requestOptions?: unknown,
  injectedClient?: AiProviderClient,
  admissionHook = defaultAdmissionHook,
  authorizationHook = defaultAuthorizationHook
): Promise<AiProviderResponse> {
  // Everything that contributes to authorization, admission, provider-client
  // selection, or the provider request is copied before the first await. This
  // prevents a caller from authorizing one object graph and mutating the same
  // references while a durable reservation is in flight.
  const contextSnapshot = snapshotAiEgressContext(context);
  const laneSnapshot = snapshotAiProviderLane(lane);
  const bodySnapshot = snapshotJsonValue(body, "AI provider request body");
  if (!bodySnapshot || typeof bodySnapshot !== "object" || Array.isArray(bodySnapshot) ||
      typeof (bodySnapshot as Record<string, unknown>).model !== "string" ||
      (bodySnapshot as Record<string, unknown>).model !== laneSnapshot.model) {
    throw new AiEgressPolicyError(
      "ai_provider_model_mismatch",
      "The exact provider request model must match the authorized provider lane.",
      403
    );
  }
  authorizeAiEgress(contextSnapshot, laneSnapshot);
  const providerOptions = hardenedProviderRequestOptions(requestOptions);
  if (!authorizationHook) {
    throw new AiEgressPolicyError(
      "ai_authorization_unconfigured",
      "AI provider dispatch is disabled until approval authorization is installed.",
      503
    );
  }
  const authorizationMetadata = freezeAuthorizationMetadata(
    aiAuthorizationMetadata(contextSnapshot, laneSnapshot, bodySnapshot)
  );
  const authorization = await authorizationHook(authorizationMetadata);
  if (authorization.replayed) {
    throw new AiEgressPolicyError(
      "ai_dispatch_replayed",
      "This exact AI dispatch was already reserved or attempted; it will not be billed twice.",
      409
    );
  }
  if (!admissionHook) {
    try {
      await authorization.settle({ status: "released" });
    } catch {
      // The short reservation lease is reclaimable only before provider start.
    }
    throw new AiEgressPolicyError(
      "ai_admission_unconfigured",
      "AI provider dispatch is disabled until account admission control is installed.",
      503
    );
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify(bodySnapshot), "utf8");
  const maxOutputTokens = readMaxOutputTokens(bodySnapshot);
  let lease: AiDispatchLease | void;
  try {
    lease = await admissionHook({
      accountId: contextSnapshot.accountId,
      callType: contextSnapshot.purpose,
      estimatedInputTokens: estimateProviderInputTokens(bodySnapshot, maxOutputTokens),
      maxOutputTokens,
      model: laneSnapshot.model,
      payloadBytes,
      provider: laneSnapshot.provider,
      region: laneSnapshot.region
    });
  } catch (error) {
    try {
      await authorization.settle({ status: "released" });
    } catch {
      // Preserve the admission failure; the reserved dispatch lease expires.
    }
    throw error;
  }
  let result: AiProviderResponse | undefined;
  let caught: unknown;
  let providerStarted = false;
  try {
    // Reject stable credential misconfiguration while the short dispatch
    // reservation can still be released without consuming the approval.
    if (!injectedClient) assertProviderClientConfigured(laneSnapshot);
    await authorization.markProviderStarted();
    providerStarted = true;
    // The durable start claim is the final asynchronous boundary. Re-read the
    // deployment-owned lane, model, classification, and policy configuration
    // after it so a long-lived process cannot dispatch under stale policy.
    authorizeAiEgress(contextSnapshot, laneSnapshot);
    const currentPolicy = currentAiApprovalPolicy(laneSnapshot, contextSnapshot.dataClass);
    if (!sameAiApprovalPolicy(currentPolicy, authorizationMetadata.policy)) {
      throw new AiEgressPolicyError(
        "ai_egress_policy_changed",
        "AI provider policy changed before dispatch; request approval under the current policy.",
        409
      );
    }
    if (!injectedClient) assertProviderClientConfigured(laneSnapshot);
    const client = injectedClient ?? createProviderClient(laneSnapshot);
    result = await client.messages.create(bodySnapshot, providerOptions);
    return result;
  } catch (error) {
    caught = error;
    throw error;
  } finally {
    let bookkeepingError: unknown;
    try {
      await lease?.settle({
        error: providerStarted
          ? caught
          : new AiEgressPolicyError("ai_provider_not_started", "Provider dispatch did not start.", 503),
        status: caught === undefined ? "succeeded" : "failed",
        usage: result?.usage
      });
    } catch (error) {
      bookkeepingError = error;
    } finally {
      try {
        await authorization.settle({
          status: !providerStarted ? "released" : caught === undefined ? "succeeded" : "failed"
        });
      } catch (error) {
        bookkeepingError ??= error;
      }
    }
    if (caught === undefined && bookkeepingError !== undefined) {
      throw new AiEgressPolicyError(
        "ai_dispatch_settlement_failed",
        "The provider completed, but durable AI dispatch bookkeeping did not finish. The response is withheld and this dispatch cannot be replayed.",
        503
      );
    }
  }
}

export function currentAiApprovalPolicy(
  lane: AiProviderLane,
  dataClass: DataClass
): AiApprovalPolicyBinding {
  const version = process.env.RULIX_AI_POLICY_VERSION?.trim() || "rulix-ai-egress/v1";
  if (!validContextIdentifier(version, 128)) {
    throw new AiEgressPolicyError(
      "ai_approval_policy_invalid",
      "AI approval policy version is invalid.",
      503
    );
  }
  const configuredMode = process.env.RULIX_CONTROLLED_DATA_MODE?.trim().toLowerCase() || "blocked";
  if (configuredMode !== "approved" && configuredMode !== "blocked") {
    throw new AiEgressPolicyError(
      "ai_approval_policy_invalid",
      "AI approval policy mode must be explicitly configured as approved or blocked.",
      503
    );
  }
  return {
    version,
    mode: isControlledDataClass(dataClass) ? configuredMode : "approved",
    provider: lane.provider,
    clientRegion: lane.region,
    model: lane.model
  };
}

function aiAuthorizationMetadata(
  context: AiEgressContext,
  lane: AiProviderLane,
  body: unknown
): AiDispatchAuthorizationMetadata {
  if (!validContextIdentifier(context.accountId, 512) || !validContextIdentifier(context.dispatchId, 160)) {
    throw new AiEgressPolicyError(
      "ai_approval_binding_invalid",
      "AI dispatch account and idempotency bindings are required."
    );
  }
  let authorization: AiDispatchAuthorizationIdentity;
  if (context.trustedWorkflowGrant !== undefined) {
    if (context.approvalId !== undefined || context.subject !== undefined) {
      throw new AiEgressPolicyError(
        "ai_approval_binding_invalid",
        "AI dispatch cannot combine approval and trusted-workflow authorization."
      );
    }
    const grant = trustedWorkflowGrants.get(context.trustedWorkflowGrant);
    if (!grant || grant.workflow !== context.purpose || !isTrustedWorkflow(context.purpose)) {
      throw new AiEgressPolicyError(
        "ai_trusted_workflow_invalid",
        "AI dispatch does not have a valid trusted-workflow capability."
      );
    }
    authorization = { kind: "trusted-workflow", ...grant };
  } else {
    if (!validContextIdentifier(context.approvalId, 160) || !context.subject) {
      throw new AiEgressPolicyError(
        "ai_approval_required",
        "An exact, server-owned AI approval is required for this provider dispatch.",
        403
      );
    }
    authorization = {
      kind: "approval",
      approvalId: context.approvalId,
      subject: context.subject
    };
  }
  return {
    accountId: context.accountId,
    authorization,
    dataClass: context.dataClass,
    dispatchId: context.dispatchId,
    payloadHash: hashAiApprovalPayload(context.payload),
    providerRequestHash: hashAiApprovalPayload(body),
    purpose: context.purpose,
    policy: currentAiApprovalPolicy(lane, context.dataClass)
  };
}

function snapshotAiEgressContext(context: AiEgressContext): AiEgressContext {
  const fields = snapshotOuterDataRecord(context, "AI egress context", new Set([
    "accountId",
    "approvalId",
    "dataClass",
    "dispatchId",
    "payload",
    "purpose",
    "subject",
    "trustedWorkflowGrant"
  ]));
  const payload = snapshotJsonValue(fields.payload, "AI authorization payload");
  const subject = fields.subject === undefined
    ? undefined
    : snapshotJsonValue(fields.subject, "AI approval subject") as AiApprovalSubjectBinding;
  return Object.freeze({
    accountId: fields.accountId as string,
    dataClass: fields.dataClass as DataClass,
    payload,
    purpose: fields.purpose as AiEgressPurpose,
    ...(fields.approvalId === undefined ? {} : { approvalId: fields.approvalId as string }),
    dispatchId: fields.dispatchId as string,
    ...(subject === undefined ? {} : { subject }),
    ...(fields.trustedWorkflowGrant === undefined
      ? {}
      : { trustedWorkflowGrant: fields.trustedWorkflowGrant as AiTrustedWorkflowGrant })
  });
}

function snapshotAiProviderLane(lane: AiProviderLane): AiProviderLane {
  const fields = snapshotOuterDataRecord(
    lane,
    "AI provider lane",
    new Set(["model", "provider", "region"])
  );
  if (fields.provider === "amazon-bedrock") {
    return Object.freeze({
      provider: fields.provider,
      region: fields.region as string,
      model: fields.model as string
    });
  }
  return Object.freeze({
    provider: fields.provider as "anthropic-direct",
    region: fields.region as "global",
    model: fields.model as string
  });
}

function freezeAuthorizationMetadata(
  metadata: AiDispatchAuthorizationMetadata
): AiDispatchAuthorizationMetadata {
  Object.freeze(metadata.policy);
  Object.freeze(metadata.authorization);
  return Object.freeze(metadata);
}

function snapshotJsonValue(value: unknown, label: string): unknown {
  const state = {
    ancestors: new WeakSet<object>(),
    bytes: 0,
    nodes: 0
  };
  const snapshot = cloneJsonValue(value, label, state, 0);
  const serialized = JSON.stringify(snapshot);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_PROVIDER_REQUEST_BYTES) {
    throw invalidSnapshot(label, `must be at most ${MAX_PROVIDER_REQUEST_BYTES} UTF-8 bytes`);
  }
  return snapshot;
}

function cloneJsonValue(
  value: unknown,
  label: string,
  state: { ancestors: WeakSet<object>; bytes: number; nodes: number },
  depth: number
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_PROVIDER_REQUEST_NODES) {
    throw invalidSnapshot(label, `contains more than ${MAX_PROVIDER_REQUEST_NODES} values`);
  }
  if (depth > MAX_PROVIDER_REQUEST_DEPTH) {
    throw invalidSnapshot(label, `is nested more than ${MAX_PROVIDER_REQUEST_DEPTH} levels`);
  }
  if (value === null) return null;

  switch (typeof value) {
    case "string":
      addSnapshotBytes(state, value, label);
      return value;
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw invalidSnapshot(label, "contains a non-finite number");
      return Object.is(value, -0) ? 0 : value;
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw invalidSnapshot(label, `contains a non-JSON ${typeof value} value`);
    case "object":
      break;
    default:
      throw invalidSnapshot(label, `contains an unsupported ${typeof value} value`);
  }

  const source = value as object;
  if (state.ancestors.has(source)) throw invalidSnapshot(label, "contains a cyclic reference");
  state.ancestors.add(source);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_PROVIDER_REQUEST_NODES) {
        throw invalidSnapshot(label, `contains an array longer than ${MAX_PROVIDER_REQUEST_NODES} items`);
      }
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !isCanonicalArrayIndex(key, value.length)) {
          throw invalidSnapshot(label, "contains a symbol, sparse slot, or non-index array property");
        }
      }
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw invalidSnapshot(label, "contains a sparse slot or accessor array property");
        }
        output.push(cloneJsonValue(descriptor.value, label, state, depth + 1));
      }
      return Object.freeze(output);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidSnapshot(label, "contains a non-plain object");
    }
    const output: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw invalidSnapshot(label, "contains a symbol-keyed property");
      addSnapshotBytes(state, key, label);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw invalidSnapshot(label, "contains an accessor or non-enumerable property");
      }
      Object.defineProperty(output, key, {
        configurable: false,
        enumerable: true,
        value: cloneJsonValue(descriptor.value, label, state, depth + 1),
        writable: false
      });
    }
    return Object.freeze(output);
  } finally {
    state.ancestors.delete(source);
  }
}

function isCanonicalArrayIndex(key: string, length: number) {
  if (!/^(0|[1-9]\d*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function addSnapshotBytes(
  state: { bytes: number },
  value: string,
  label: string
) {
  state.bytes += Buffer.byteLength(value, "utf8");
  if (state.bytes > MAX_PROVIDER_REQUEST_BYTES) {
    throw invalidSnapshot(label, `must be at most ${MAX_PROVIDER_REQUEST_BYTES} UTF-8 bytes`);
  }
}

function assertPlainDataRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidSnapshot(label, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidSnapshot(label, "must be a plain object");
  }
}

function snapshotOuterDataRecord(
  value: unknown,
  label: string,
  allowedKeys: ReadonlySet<string>
): Readonly<Record<string, unknown>> {
  assertPlainDataRecord(value, label);
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw invalidSnapshot(label, "contains an unknown or symbol-keyed property");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw invalidSnapshot(label, "contains an accessor or non-enumerable property");
    }
    Object.defineProperty(output, key, {
      configurable: false,
      enumerable: true,
      value: descriptor.value,
      writable: false
    });
  }
  return Object.freeze(output);
}

function invalidSnapshot(label: string, detail: string) {
  return new AiEgressPolicyError(
    "ai_provider_request_invalid",
    `${label} ${detail}.`,
    422
  );
}

/**
 * Provider SDK retries can create multiple billable requests behind one
 * admission lease. Enforce one bounded attempt at the credential-bearing
 * boundary, even if a caller omits options or accidentally asks for retries.
 */
function hardenedProviderRequestOptions(value: unknown) {
  if (value !== undefined && (
    !value || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )) {
    throw new AiEgressPolicyError(
      "ai_provider_options_invalid",
      "AI provider dispatch options must be a plain object.",
      503
    );
  }
  const options = value === undefined ? {} : value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || (key !== "signal" && key !== "timeout")) {
      throw new AiEgressPolicyError(
        "ai_provider_options_invalid",
        "AI provider dispatch options may only include signal and timeout.",
        503
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new AiEgressPolicyError(
        "ai_provider_options_invalid",
        "AI provider dispatch options must be enumerable data properties.",
        503
      );
    }
  }
  const requestedTimeout = options.timeout;
  const requestedSignal = options.signal;
  if (requestedSignal !== undefined && !(requestedSignal instanceof AbortSignal)) {
    throw new AiEgressPolicyError(
      "ai_provider_options_invalid",
      "AI provider signal must be an AbortSignal.",
      503
    );
  }
  if (
    requestedTimeout !== undefined &&
    (typeof requestedTimeout !== "number" || !Number.isFinite(requestedTimeout) || requestedTimeout < 1)
  ) {
    throw new AiEgressPolicyError(
      "ai_provider_options_invalid",
      "AI provider timeout must be a positive finite number.",
      503
    );
  }
  return {
    timeout: Math.min(
      requestedTimeout === undefined ? DEFAULT_PROVIDER_TIMEOUT_MS : Math.floor(requestedTimeout),
      MAX_PROVIDER_TIMEOUT_MS
    ),
    maxRetries: 0,
    ...(requestedSignal === undefined ? {} : { signal: requestedSignal })
  };
}

/**
 * Binary document/image inputs are billed from the provider's interpreted
 * content, not from their base64 transport expansion. Reserve the full
 * configured policy context for those calls; ordinary text remains a
 * conservative one-token-per-UTF-8-byte estimate. Raw request bytes remain a
 * separate edge/parser limit and are still reported in dispatch metadata.
 */
export function estimateProviderInputTokens(body: unknown, maxOutputTokens: number) {
  if (containsBase64Media(body)) {
    return Math.max(0, DEFAULT_PROVIDER_CONTEXT_TOKENS - Math.max(0, maxOutputTokens));
  }
  return Buffer.byteLength(JSON.stringify(body), "utf8");
}

export function authorizeAiEgress(context: AiEgressContext, lane: AiProviderLane) {
  const floor = deploymentDataClass();
  if (maxDataClass(context.dataClass, floor) !== context.dataClass) {
    throw new AiEgressPolicyError(
      "ai_data_class_below_floor",
      "The content classification is below this deployment's AI sensitivity floor."
    );
  }
  assertLaneApproved(context.dataClass, lane);
}

function createProviderClient(lane: AiProviderLane): AiProviderClient {
  if (lane.provider === "anthropic-direct") {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      throw new AiEgressPolicyError(
        "ai_provider_unavailable",
        "The approved direct Anthropic provider is not configured.",
        503
      );
    }
    return new Anthropic({
      apiKey,
      // Never allow ANTHROPIC_BASE_URL to redirect approved egress.
      baseURL: "https://api.anthropic.com"
    }) as unknown as AiProviderClient;
  }
  assertAwsRegionIdentity(lane.region);
  return new AnthropicBedrock({
    awsRegion: lane.region,
    // Never allow ANTHROPIC_BEDROCK_BASE_URL to bypass the approved Region.
    baseURL: `https://bedrock-runtime.${lane.region}.amazonaws.com`
  }) as unknown as AiProviderClient;
}

function assertProviderClientConfigured(lane: AiProviderLane) {
  if (lane.provider === "anthropic-direct" && !process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new AiEgressPolicyError(
      "ai_provider_unavailable",
      "The approved direct Anthropic provider is not configured.",
      503
    );
  }
}

function assertLaneApproved(dataClass: DataClass, lane: AiProviderLane) {
  const configuredProvider = process.env.RULIX_APPROVED_PROVIDER?.trim().toLowerCase();
  const approvedProvider = configuredApprovedProvider();
  const configuredRegion = configuredApprovedRegion(approvedProvider);
  const approvedRegion = configuredRegion || (approvedProvider === "amazon-bedrock" ? configuredAwsRegion() : undefined);
  if (!approvedRegion) {
    throw new AiEgressPolicyError(
      "ai_egress_policy_unconfigured",
      "AI egress is disabled until the approved provider has an explicit region identity.",
      503
    );
  }
  if (approvedProvider !== lane.provider || approvedRegion !== lane.region) {
    throw new AiEgressPolicyError(
      "ai_egress_lane_mismatch",
      "The selected AI provider and region do not match the current approved lane."
    );
  }
  if (isControlledDataClass(dataClass)) {
    if (
      process.env.RULIX_CONTROLLED_DATA_MODE?.trim().toLowerCase() !== "approved" ||
      !configuredProvider ||
      !configuredRegion
    ) {
      throw new AiEgressPolicyError(
        "data_class_not_allowed",
        "Controlled data requires an explicitly approved provider and region."
      );
    }
    if (lane.provider !== "amazon-bedrock") {
      throw new AiEgressPolicyError(
        "ai_egress_lane_mismatch",
        "Controlled data requires an approved provider with an explicit regional identity."
      );
    }
    assertControlledBedrockModelApproved(lane);
  }
}

/**
 * A Bedrock client's endpoint Region is only the request's source Region. A
 * cross-Region inference-profile ID can execute elsewhere, so controlled data
 * must bind to both the client Region and one exact, deployment-owned model
 * identity at the credential-bearing dispatch boundary.
 */
function assertControlledBedrockModelApproved(
  lane: Extract<AiProviderLane, { provider: "amazon-bedrock" }>
) {
  if (isCrossRegionInferenceProfile(lane.model)) {
    throw new AiEgressPolicyError(
      "ai_model_cross_region_not_allowed",
      "Controlled data cannot use a cross-Region Bedrock inference profile."
    );
  }

  const modelArnRegion = bedrockArnRegion(lane.model);
  if (modelArnRegion !== undefined && modelArnRegion !== lane.region) {
    throw new AiEgressPolicyError(
      "ai_model_region_mismatch",
      "The approved Bedrock model ARN is not in the provider client's approved Region."
    );
  }

  const approvedModels = controlledModelAllowlist(lane.region);
  if (!approvedModels.has(lane.model)) {
    throw new AiEgressPolicyError(
      "ai_model_not_approved",
      "The selected Bedrock model is not explicitly approved for controlled data."
    );
  }
}

function controlledModelAllowlist(approvedRegion: string) {
  const raw = process.env[CONTROLLED_MODEL_ALLOWLIST_ENV]?.trim();
  if (!raw) {
    throw controlledModelPolicyError(
      `${CONTROLLED_MODEL_ALLOWLIST_ENV} must be a non-empty JSON array for controlled-data dispatch.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw controlledModelPolicyError(`${CONTROLLED_MODEL_ALLOWLIST_ENV} must be valid JSON.`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 100) {
    throw controlledModelPolicyError(
      `${CONTROLLED_MODEL_ALLOWLIST_ENV} must contain between 1 and 100 exact model IDs or ARNs.`
    );
  }

  const approved = new Set<string>();
  for (const value of parsed) {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 2_048 ||
      value !== value.trim() ||
      !/^[A-Za-z0-9._:/-]+$/.test(value)
    ) {
      throw controlledModelPolicyError(
        `${CONTROLLED_MODEL_ALLOWLIST_ENV} contains an invalid model identity.`
      );
    }
    if (approved.has(value)) {
      throw controlledModelPolicyError(
        `${CONTROLLED_MODEL_ALLOWLIST_ENV} contains a duplicate model identity.`
      );
    }
    if (isCrossRegionInferenceProfile(value)) {
      throw controlledModelPolicyError(
        `${CONTROLLED_MODEL_ALLOWLIST_ENV} cannot contain cross-Region inference profiles.`
      );
    }
    const arnRegion = bedrockArnRegion(value);
    if (arnRegion !== undefined && arnRegion !== approvedRegion) {
      throw controlledModelPolicyError(
        `${CONTROLLED_MODEL_ALLOWLIST_ENV} contains a Bedrock ARN outside the approved Region.`
      );
    }
    if (arnRegion === undefined && !value.startsWith("anthropic.")) {
      throw controlledModelPolicyError(
        `${CONTROLLED_MODEL_ALLOWLIST_ENV} contains a model ID without an explicit regional Bedrock identity.`
      );
    }
    approved.add(value);
  }
  return approved;
}

function isCrossRegionInferenceProfile(model: string) {
  // System-defined geographic/global profile IDs are prefixed before the
  // provider name, both as bare IDs and inside inference-profile ARNs. An
  // application-profile ARN can hide whether its source is regional or
  // cross-Region, so it is not a provable in-Region identity either.
  return /(?:^|\/)[a-z0-9-]+\.anthropic\./i.test(model) ||
    /^arn:[^:]+:bedrock:[^:]+:[^:]*:(?:application-)?inference-profile\//i.test(model);
}

function bedrockArnRegion(model: string) {
  if (!model.startsWith("arn:")) return undefined;
  const segments = model.split(":", 6);
  if (
    segments.length !== 6 ||
    segments[2] !== "bedrock" ||
    !segments[3] ||
    !segments[5]
  ) {
    throw controlledModelPolicyError(
      `${CONTROLLED_MODEL_ALLOWLIST_ENV} contains a malformed or non-Bedrock ARN.`
    );
  }
  return segments[3].toLowerCase();
}

function controlledModelPolicyError(message: string) {
  return new AiEgressPolicyError("ai_model_policy_invalid", message, 503);
}

function configuredApprovedProvider(): AiProviderLane["provider"] {
  const configured = process.env.RULIX_APPROVED_PROVIDER?.trim().toLowerCase();
  if (!configured) return "amazon-bedrock";
  if (configured === "amazon-bedrock" || configured === "anthropic-direct") return configured;
  throw new AiEgressPolicyError(
    "ai_egress_policy_invalid",
    "AI egress is disabled because RULIX_APPROVED_PROVIDER is not recognized.",
    503
  );
}

function configuredAwsRegion() {
  const raw = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (!raw) return undefined;
  return assertAwsRegionIdentity(raw);
}

function configuredApprovedRegion(provider: AiProviderLane["provider"]) {
  const raw = process.env.RULIX_APPROVED_REGION;
  if (!raw) return undefined;
  if (provider === "amazon-bedrock") return assertAwsRegionIdentity(raw);
  if (raw !== "global") {
    throw new AiEgressPolicyError(
      "ai_egress_policy_invalid",
      "The approved direct-provider region identity must be exactly global.",
      503
    );
  }
  return raw;
}

function assertAwsRegionIdentity(value: string) {
  if (value !== value.trim() || value !== value.toLowerCase() ||
      !/^[a-z]{2}(?:-[a-z0-9]+)+-[1-9][0-9]*$/u.test(value)) {
    throw new AiEgressPolicyError(
      "ai_egress_policy_invalid",
      "AI egress is disabled because the AWS Region identity is invalid.",
      503
    );
  }
  return value;
}

function readMaxOutputTokens(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return 0;
  const value = (body as { max_tokens?: unknown }).max_tokens;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function containsBase64Media(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.type === "base64" && typeof record.data === "string") return true;
  }
  return Object.values(value).some((item) => containsBase64Media(item, seen));
}

function isTrustedWorkflow(value: unknown): value is AiTrustedWorkflow {
  return value === "lead-search" ||
    value === "outreach-personalization" ||
    value === "outreach-writer";
}

function validContextIdentifier(value: unknown, maximum: number): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    value === value.trim() &&
    /^[A-Za-z0-9._:@/-]+$/u.test(value);
}
