import { writeFileSync } from "node:fs";
import { reviewFixtures } from "../src/test/reviewFixtures";
import { verifyCitations } from "../src/lib/eccnReview";
import { createAiDispatchAdmissionHook } from "./aiAdmission";
import {
  currentAiApprovalPolicy,
  deploymentDataClass,
  resolveBedrockLane,
  setAiDispatchAdmissionHook,
  setAiDispatchAuthorizationHook
} from "./aiEgressGateway";
import {
  buildCouncilProviderRequest,
  councilApprovalPayload,
  councilModelForDepth,
  getBedrockRuntime,
  runCouncilAnalysis
} from "./bedrockCouncil";
import { createStoreAiDispatchAuthorizationHook } from "./aiAuthorization";
import { hashAiApprovalPayload } from "./domain/aiApproval";
import { hashMemoContent } from "./domain/hashes";
import { LocalAccountStore } from "./store";

if (process.env.BEDROCK_ENABLED?.trim().toLowerCase() !== "true") {
  throw new Error("BEDROCK_ENABLED=true, AWS credentials, and AWS_REGION are required for the live Bedrock smoke test.");
}

const liveAccountId = process.env.RULIX_LIVE_TEST_ACCOUNT_ID?.trim() || "rulix-live-ai-smoke-test";
const liveStore = new LocalAccountStore({ persist: false });
setAiDispatchAdmissionHook(createAiDispatchAdmissionHook({
  store: liveStore
}));
setAiDispatchAuthorizationHook(createStoreAiDispatchAuthorizationHook({ store: liveStore }));

const memo = reviewFixtures[0];
await liveStore.upsertReview(liveAccountId, memo);
const dataClass = deploymentDataClass();
const runtime = getBedrockRuntime();
const model = councilModelForDepth("standard", runtime);
const lane = resolveBedrockLane(model);
if (!lane) throw new Error("The approved Bedrock lane is unavailable.");
const storedMemo = await liveStore.findReview(liveAccountId, memo.id);
if (!storedMemo) throw new Error("Live smoke memo could not be stored.");
const subject = {
  kind: "review" as const,
  id: storedMemo.id,
  revision: storedMemo.revision ?? 1,
  version: storedMemo.version ?? storedMemo.revision ?? 1,
  contentHash: storedMemo.contentHash ?? hashMemoContent(storedMemo)
};
const dispatchId = `live-${Date.now()}`;
const approval = await liveStore.createAiApproval(liveAccountId, {
  requestId: dispatchId,
  purpose: "council",
  subject,
  payloadHash: hashAiApprovalPayload(councilApprovalPayload(storedMemo, "standard")),
  providerRequestHashes: [hashAiApprovalPayload(buildCouncilProviderRequest(storedMemo, "standard", model, 1800).body)],
  dataClass,
  policy: currentAiApprovalPolicy(lane, dataClass),
  approvedBy: { id: "live-smoke-officer", role: "export-control-officer" },
  dispatchLimit: 1
});

const result = await runCouncilAnalysis(storedMemo, {
  depth: "standard",
  maxTokens: 1800,
  egress: {
    accountId: liveAccountId,
    dataClass,
    approvalId: approval.id,
    dispatchId,
    subject
  }
});

if (!result.provider.live || result.provider.source !== "bedrock") {
  throw new Error(`Expected a live Bedrock result, got ${result.provider.source}.`);
}

const invalidCitations = verifyCitations(result);
if (invalidCitations.length > 0) {
  throw new Error(`Live result returned invalid source chunk IDs: ${invalidCitations.join(", ")}`);
}

const expectedRoles = [
  "memo-parser",
  "jurisdiction-gate",
  "eccn-candidate",
  "evidence-mapper",
  "citation-verifier",
  "risk-reviewer",
  "report-writer"
];
const returnedRoles = result.agents.map((agent) => agent.role).sort();
if (JSON.stringify(returnedRoles) !== JSON.stringify([...expectedRoles].sort())) {
  throw new Error(`Live result did not return the full AI council: ${returnedRoles.join(", ")}`);
}

if (process.env.RULIX_LIVE_SUCCESS_MARKER) {
  writeFileSync(process.env.RULIX_LIVE_SUCCESS_MARKER, "ok");
}

console.log(
  `Live AI council OK: ${result.provider.model} returned ${result.recommended.eccn} with ${result.findings.length} findings and ${result.agents.length} agents in ${result.provider.latencyMs ?? 0} ms.`
);

await new Promise((resolve) => setTimeout(resolve, 500));
