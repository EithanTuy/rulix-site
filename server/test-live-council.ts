import { writeFileSync } from "node:fs";
import { reviewFixtures } from "../src/test/reviewFixtures";
import { verifyCitations } from "../src/lib/eccnReview";
import type { AgentRole, MemoRecord, ReviewResult } from "../src/types";
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

const EXPECTED_ROLES: AgentRole[] = [
  "memo-parser",
  "jurisdiction-gate",
  "eccn-candidate",
  "evidence-mapper",
  "citation-verifier",
  "risk-reviewer",
  "report-writer"
];

const EXPECTATIONS: Record<string, {
  eccnPattern: RegExp;
  shouldHaveBlocker: boolean;
  maxBlockers?: number;
  rationale: string;
}> = {
  "fixture-cryo-2026-0417": {
    eccnPattern: /3A001|cryogenic/i,
    shouldHaveBlocker: true,
    rationale: "cryostat memo should stay in Category 3 review and flag research/end-use reasoning gaps"
  },
  "fixture-camera-2026-0412": {
    eccnPattern: /6A003|camera|imaging/i,
    shouldHaveBlocker: true,
    rationale: "camera memo should remain blocked on omitted sensor parameters"
  },
  "fixture-quantum-2026-0409": {
    eccnPattern: /3A001|3D001|electronics|software|technology/i,
    shouldHaveBlocker: true,
    rationale: "quantum-control memo should not accept EAR99 without electronics/software facts"
  },
  "fixture-laser-2026-0406": {
    eccnPattern: /6A005|laser/i,
    shouldHaveBlocker: true,
    rationale: "laser memo should stay blocked on missing pulse and end-use facts"
  },
  "fixture-vac-2026-0401": {
    eccnPattern: /EAR99|no specific CCL|classification path/i,
    shouldHaveBlocker: false,
    maxBlockers: 0,
    rationale: "vacuum-pump memo should not be overblocked without a concrete CCL gap"
  }
};

if (process.env.BEDROCK_ENABLED?.trim().toLowerCase() !== "true") {
  throw new Error("BEDROCK_ENABLED=true, AWS credentials, and AWS_REGION are required for the deep live Bedrock council test.");
}

const liveAccountId = process.env.RULIX_LIVE_TEST_ACCOUNT_ID?.trim() || "rulix-live-council-test";
const liveStore = new LocalAccountStore({ persist: false });
setAiDispatchAdmissionHook(createAiDispatchAdmissionHook({
  store: liveStore
}));
setAiDispatchAuthorizationHook(createStoreAiDispatchAuthorizationHook({ store: liveStore }));

const summaries: string[] = [];

for (const memo of reviewFixtures) {
  const result = await runLiveCouncilWithRetry(memo);
  assertQuality(memo, result);
  const blockers = result.findings.filter((finding) =>
    finding.status === "missing" || finding.status === "conflict"
  );
  summaries.push(
    `${memo.id}: ${result.provider.model} -> ${result.recommended.eccn}; ` +
      `${result.findings.length} findings, ${blockers.length} blockers, ` +
      `${result.infoRequests.length} requests, ${result.provider.latencyMs ?? 0} ms`
  );
}

if (process.env.RULIX_LIVE_SUCCESS_MARKER) {
  writeFileSync(process.env.RULIX_LIVE_SUCCESS_MARKER, "ok");
}

console.log(["Deep live AI council OK:", ...summaries.map((summary) => `- ${summary}`)].join("\n"));

await new Promise((resolve) => setTimeout(resolve, 500));

async function runLiveCouncilWithRetry(memo: MemoRecord) {
  let result = await runCouncilAnalysis(memo, {
    depth: "deep",
    maxTokens: 3600,
    egress: await liveEgressContext(memo)
  });
  if (result.provider.source !== "bedrock") {
    result = await runCouncilAnalysis(memo, {
      depth: "deep",
      maxTokens: 3600,
      egress: await liveEgressContext(memo)
    });
  }
  return result;
}

async function liveEgressContext(memo: MemoRecord) {
  await liveStore.upsertReview(liveAccountId, memo);
  const storedMemo = await liveStore.findReview(liveAccountId, memo.id);
  if (!storedMemo) throw new Error("Live council memo could not be stored.");
  const dataClass = deploymentDataClass();
  const model = councilModelForDepth("deep", getBedrockRuntime());
  const lane = resolveBedrockLane(model);
  if (!lane) throw new Error("The approved Bedrock lane is unavailable.");
  const subject = {
    kind: "review" as const,
    id: storedMemo.id,
    revision: storedMemo.revision ?? 1,
    version: storedMemo.version ?? storedMemo.revision ?? 1,
    contentHash: storedMemo.contentHash ?? hashMemoContent(storedMemo)
  };
  const dispatchId = `live-${memo.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const approval = await liveStore.createAiApproval(liveAccountId, {
    requestId: dispatchId,
    purpose: "council",
    subject,
    payloadHash: hashAiApprovalPayload(councilApprovalPayload(storedMemo, "deep")),
    providerRequestHashes: [
      hashAiApprovalPayload(buildCouncilProviderRequest(storedMemo, "deep", model, 3600).body)
    ],
    dataClass,
    policy: currentAiApprovalPolicy(lane, dataClass),
    approvedBy: { id: "live-council-officer", role: "export-control-officer" },
    dispatchLimit: 1
  });
  return {
    accountId: liveAccountId,
    dataClass,
    approvalId: approval.id,
    dispatchId,
    subject
  };
}

function assertQuality(memo: MemoRecord, result: ReviewResult) {
  const expectation = EXPECTATIONS[memo.id];
  if (!expectation) {
    throw new Error(`No deep-test expectation is registered for ${memo.id}.`);
  }

  if (!result.provider.live || result.provider.source !== "bedrock") {
    throw new Error(`${memo.id}: expected a live Bedrock result, got ${result.provider.source}.`);
  }

  if (!/sonnet/i.test(result.provider.model)) {
    throw new Error(`${memo.id}: deep review should use a Sonnet model, got ${result.provider.model}.`);
  }

  if (result.provider.depth !== "deep") {
    throw new Error(`${memo.id}: provider did not record deep analysis depth.`);
  }

  const invalidCitations = verifyCitations(result);
  if (invalidCitations.length > 0) {
    throw new Error(`${memo.id}: invalid source chunk IDs: ${invalidCitations.join(", ")}`);
  }

  const returnedRoles = [...new Set(result.agents.map((agent) => agent.role))].sort();
  if (JSON.stringify(returnedRoles) !== JSON.stringify([...EXPECTED_ROLES].sort())) {
    throw new Error(`${memo.id}: missing full council roles: ${returnedRoles.join(", ")}`);
  }

  if (!expectation.eccnPattern.test(result.recommended.eccn + " " + result.recommended.label)) {
    throw new Error(
      `${memo.id}: recommendation ${result.recommended.eccn} did not match expected family; ${expectation.rationale}.`
    );
  }

  const blockers = result.findings.filter((finding) =>
    finding.status === "missing" || finding.status === "conflict"
  );
  if (expectation.shouldHaveBlocker && blockers.length === 0) {
    throw new Error(`${memo.id}: expected at least one blocker; ${expectation.rationale}.`);
  }
  if (expectation.maxBlockers !== undefined && blockers.length > expectation.maxBlockers) {
    throw new Error(
      `${memo.id}: expected at most ${expectation.maxBlockers} blockers, got ${blockers.length}; ${expectation.rationale}.`
    );
  }

  const unsafeText = [
    result.recommended.summary,
    result.jurisdiction.rationale,
    ...result.findings.map((finding) => `${finding.claim} ${finding.rationale}`)
  ].join("\n");
  if (/\b(final legal determination|license not required|approved for export)\b/i.test(unsafeText)) {
    throw new Error(`${memo.id}: result used overconfident legal/export language.`);
  }
}
