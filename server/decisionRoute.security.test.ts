// @vitest-environment node

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeMemo } from "../src/lib/eccnReview";
import { reviewFixtures } from "../src/test/reviewFixtures";
import type {
  AuditEvent,
  EvidenceFinding,
  MemoRecord,
  ReviewResult,
  ReviewerDecision,
  UserProfile
} from "../src/types";
import { createApp } from "./app";
import { setAiDispatchAdmissionHook, type AiProviderClient } from "./aiEgressGateway";
import {
  LocalAccountStore,
  type DecisionExpectedBindings,
  type DecisionTransitionResult
} from "./store";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.BEDROCK_ENABLED = "true";
  process.env.AWS_REGION = "us-east-1";
  process.env.RULIX_APPROVED_PROVIDER = "amazon-bedrock";
  process.env.RULIX_APPROVED_REGION = "us-east-1";
  process.env.RULIX_AI_DATA_CLASS = "proprietary";
});

afterEach(() => {
  setAiDispatchAdmissionHook(undefined);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("authoritative review decision transition", () => {
  it.each(["missing", "conflict"] as const)(
    "rejects ordinary acceptance of %s findings without persisting decision, lifecycle, or audit state",
    async (status) => {
    const harness = await signedInReviewer(`blocked-${status}-decision@example.com`);
    const memo = await createReview(harness);
    const result = liveResult(memo, [finding(status)]);
    await harness.store.setAnalysisResult(workspaceId(harness.user), { ...memo, status: "ready" }, result);
    const before = await harness.store.getAccountState(workspaceId(harness.user));

    const response = await harness.agent
      .post(`/api/reviews/${memo.id}/decision`)
      .set("x-rulix-csrf", harness.csrfToken)
      .send(await decisionBody(
        harness,
        memo.id,
        "accept",
        "Accept despite unresolved evidence."
      ));

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("decision_blocked");
    const after = await harness.store.getAccountState(workspaceId(harness.user));
    expect(after.decisions[memo.id]).toBeUndefined();
    expect(after.memos.find((item) => item.id === memo.id)?.status)
      .toBe(before.memos.find((item) => item.id === memo.id)?.status);
    expect(after.memos.find((item) => item.id === memo.id)?.lifecycleStage)
      .toBe(before.memos.find((item) => item.id === memo.id)?.lifecycleStage);
    expect(after.auditEvents).toEqual(before.auditEvents);
    }
  );

  it("requires complete client bindings and rejects a stale analysis tab with current metadata", async () => {
    const harness = await signedInReviewer("stale-decision-tab@example.com");
    const memo = await createReview(harness);
    await harness.store.setAnalysisResult(
      workspaceId(harness.user),
      memo,
      liveResult(memo, [finding("strong")])
    );

    const missing = await harness.agent
      .post(`/api/reviews/${memo.id}/decision`)
      .set("x-rulix-csrf", harness.csrfToken)
      .send({ action: "accept", notes: "Missing the authoritative bindings." })
      .expect(400);
    expect(missing.body.code).toBe("decision_binding_required");

    const stale = await decisionBody(
      harness,
      memo.id,
      "accept",
      "Decision drafted against the first analysis."
    );
    const currentMemo = (await harness.store.getAccountState(workspaceId(harness.user)))
      .memos.find((item) => item.id === memo.id)!;
    const replacement = liveResult(currentMemo, [finding("strong")]);
    replacement.id = `analysis-replacement-${memo.id}`;
    replacement.generatedAt = new Date(Date.parse(replacement.generatedAt) + 1_000).toISOString();
    await harness.store.setAnalysisResult(workspaceId(harness.user), currentMemo, replacement);

    const response = await harness.agent
      .post(`/api/reviews/${memo.id}/decision`)
      .set("x-rulix-csrf", harness.csrfToken)
      .send(stale)
      .expect(409);
    expect(response.body.code).toBe("analysis_binding_mismatch");
    expect(response.body.current).toMatchObject({
      revision: 1,
      version: 1,
      analysisId: replacement.id
    });
    expect(response.body.current.analysisHash).not.toBe(stale.expectedAnalysisHash);
    const state = await harness.store.getAccountState(workspaceId(harness.user));
    expect(state.decisions[memo.id]).toBeUndefined();
    expect(state.auditEvents.some((event) => event.action.startsWith("Reviewer decision:")))
      .toBe(false);
  });

  it("enforces action-specific capability while preserving officer override and clean reviewer acceptance", async () => {
    const reviewer = await signedInReviewer("reviewer-override-decision@example.com");
    const reviewerMemo = await createReview(reviewer);
    await reviewer.store.setAnalysisResult(
      workspaceId(reviewer.user),
      { ...reviewerMemo, status: "ready" },
      liveResult(reviewerMemo, [finding("conflict")])
    );
    const rejectedOverride = await reviewer.agent
      .post(`/api/reviews/${reviewerMemo.id}/decision`)
      .set("x-rulix-csrf", reviewer.csrfToken)
      .send({ action: "override", notes: "A reviewer must not self-grant override authority." })
      .expect(403);
    expect(rejectedOverride.body.code).toBe("organization_forbidden");
    const reviewerState = await reviewer.store.getAccountState(workspaceId(reviewer.user));
    expect(reviewerState.decisions[reviewerMemo.id]).toBeUndefined();

    const blocked = await signedInUser(
      "officer-override-decision@example.com",
      "export-control-officer"
    );
    const blockedMemo = await createReview(blocked);
    await blocked.store.setAnalysisResult(
      workspaceId(blocked.user),
      { ...blockedMemo, status: "ready" },
      liveResult(blockedMemo, [finding("conflict")])
    );

    const override = await blocked.agent
      .post(`/api/reviews/${blockedMemo.id}/decision`)
      .set("x-rulix-csrf", blocked.csrfToken)
      .send(await decisionBody(
        blocked,
        blockedMemo.id,
        "override",
        "Officer-approved exception with supporting rationale."
      ))
      .expect(200);
    expect(override.body.decision.action).toBe("override");
    const blockedState = await blocked.store.getAccountState(workspaceId(blocked.user));
    expect(blockedState.decisions[blockedMemo.id]?.action).toBe("override");
    expect(blockedState.auditEvents[0]).toMatchObject({
      memoId: blockedMemo.id,
      severity: "escalate"
    });

    const clean = await signedInReviewer("clean-decision@example.com");
    const cleanMemo = await createReview(clean);
    await clean.store.setAnalysisResult(
      workspaceId(clean.user),
      { ...cleanMemo, status: "ready" },
      liveResult(cleanMemo, [finding("strong")])
    );

    const accepted = await clean.agent
      .post(`/api/reviews/${cleanMemo.id}/decision`)
      .set("x-rulix-csrf", clean.csrfToken)
      .send(await decisionBody(
        clean,
        cleanMemo.id,
        "accept",
        "Reviewed the complete live evidence set."
      ))
      .expect(200);
    expect(accepted.body.decision.action).toBe("accept");
    expect(accepted.body.review.lifecycleStage).toBe("approved");
  });

  it("atomically rejects acceptance when a concurrent PATCH invalidates the analyzed revision", async () => {
    const store = new PausingDecisionStore({ persist: false });
    const harness = await signedInUser("decision-edit-race@example.com", "reviewer", store);
    const memo = await createReview(harness);
    await store.setAnalysisResult(
      workspaceId(harness.user),
      { ...memo, status: "ready" },
      liveResult(memo, [finding("strong")])
    );

    const gate = store.pauseNextDecision();
    const decisionRequest = await decisionBody(
      harness,
      memo.id,
      "accept",
      "Accept the clean analyzed revision."
    );
    const decisionPromise = Promise.resolve(
      harness.agent
        .post(`/api/reviews/${memo.id}/decision`)
        .set("x-rulix-csrf", harness.csrfToken)
        .send(decisionRequest)
    );
    await gate.reached;

    const editedText = `${memo.memoText}\n\nA concurrent material edit.`;
    await harness.agent
      .patch(`/api/reviews/${memo.id}`)
      .set("x-rulix-csrf", harness.csrfToken)
      .send({ memoText: editedText, ...await memoBindings(harness, memo.id) })
      .expect(200);
    gate.release();

    const decision = await decisionPromise;
    expect(decision.status).toBe(409);
    expect(decision.body.code).toBe("stale_revision");
    expect(decision.body.current).toMatchObject({ revision: 2, version: 2 });
    const finalState = await store.getAccountState(workspaceId(harness.user));
    const finalMemo = finalState.memos.find((item) => item.id === memo.id);
    expect(finalMemo).toMatchObject({
      memoText: editedText,
      revision: 2,
      lifecycleStage: "draft"
    });
    expect(finalState.decisions[memo.id]).toBeUndefined();
    expect(finalState.analysisResults[memo.id]).toBeUndefined();
    expect(finalState.auditEvents.some((event) => event.action.startsWith("Reviewer decision:")))
      .toBe(false);
    expect(finalState.auditEvents.some((event) => event.action === "Memo edited")).toBe(true);
  });

  it("discards a deferred provider result when PATCH changes the memo during analysis", async () => {
    const provider = deferredCouncilProvider();
    const harness = await signedInUser(
      "analysis-edit-race@example.com",
      "reviewer",
      new LocalAccountStore({ persist: false }),
      provider.client
    );
    const memo = await createReview(harness);
    const officer = await signedInUser(
      `analysis-edit-race-officer-${randomUUID()}@example.com`,
      "export-control-officer",
      harness.store
    );
    const analysisBody = await approveCouncilDispatch(harness, officer, memo.id);

    const analysisPromise = Promise.resolve(
      harness.agent
        .post(`/api/reviews/${memo.id}/analyze`)
        .set("x-rulix-csrf", harness.csrfToken)
        .send(analysisBody)
    );
    await expectProviderStart(provider.reached, analysisPromise);

    const editedText = `${memo.memoText}\n\nEdit committed while the provider was running.`;
    await harness.agent
      .patch(`/api/reviews/${memo.id}`)
      .set("x-rulix-csrf", harness.csrfToken)
      .send({ memoText: editedText, ...await memoBindings(harness, memo.id) })
      .expect(200);
    provider.release();

    const analysis = await analysisPromise;
    expect(analysis.status).toBe(409);
    expect(analysis.body.code).toBe("stale_revision");
    const finalState = await harness.store.getAccountState(workspaceId(harness.user));
    expect(finalState.memos.find((item) => item.id === memo.id)).toMatchObject({
      memoText: editedText,
      revision: 2,
      lifecycleStage: "draft"
    });
    expect(finalState.analysisResults[memo.id]).toBeUndefined();
    expect(finalState.decisions[memo.id]).toBeUndefined();
    expect(finalState.auditEvents.some((event) => event.action === "Analysis completed"))
      .toBe(false);
  });

  it("assigns collision-resistant UUIDs to independently persisted analysis runs", async () => {
    const provider = deferredCouncilProvider();
    const harness = await signedInUser(
      "analysis-id-entropy@example.com",
      "reviewer",
      new LocalAccountStore({ persist: false }),
      provider.client
    );
    const memo = await createReview(harness);
    const officer = await signedInUser(
      `analysis-id-entropy-officer-${randomUUID()}@example.com`,
      "export-control-officer",
      harness.store
    );
    const firstBody = await approveCouncilDispatch(harness, officer, memo.id);

    const firstPromise = Promise.resolve(
      harness.agent
        .post(`/api/reviews/${memo.id}/analyze`)
        .set("x-rulix-csrf", harness.csrfToken)
        .send(firstBody)
    );
    await expectProviderStart(provider.reached, firstPromise);
    provider.release();
    const first = await firstPromise;
    expect(first.status).toBe(200);

    const secondBody = await approveCouncilDispatch(harness, officer, memo.id);
    const second = await harness.agent
      .post(`/api/reviews/${memo.id}/analyze`)
      .set("x-rulix-csrf", harness.csrfToken)
      .send(secondBody)
      .expect(200);

    const analysisId = /^analysis-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(first.body.result.id).toMatch(analysisId);
    expect(second.body.result.id).toMatch(analysisId);
    expect(second.body.result.id).not.toBe(first.body.result.id);
  });

  it("invalidates an accepted decision when a genuinely new analysis is committed", async () => {
    const harness = await signedInReviewer("analysis-rerun-signoff@example.com");
    const memo = await createReview(harness);
    await harness.store.setAnalysisResult(
      workspaceId(harness.user),
      memo,
      liveResult(memo, [finding("strong")])
    );
    await harness.agent
      .post(`/api/reviews/${memo.id}/decision`)
      .set("x-rulix-csrf", harness.csrfToken)
      .send(await decisionBody(
        harness,
        memo.id,
        "accept",
        "Accept the first clean analysis."
      ))
      .expect(200);

    const beforeRerun = await harness.store.getAccountState(workspaceId(harness.user));
    expect(beforeRerun.decisions[memo.id]?.action).toBe("accept");
    const idempotent = await harness.store.setAnalysisResult(
      workspaceId(harness.user),
      beforeRerun.memos.find((item) => item.id === memo.id)!,
      beforeRerun.analysisResults[memo.id]
    );
    expect(idempotent.decisionInvalidated).toBe(false);
    expect((await harness.store.getAccountState(workspaceId(harness.user))).decisions[memo.id]?.action)
      .toBe("accept");
    const rerun = liveResult(memo, [finding("strong")]);
    rerun.id = `analysis-rerun-${memo.id}`;
    rerun.generatedAt = new Date(Date.parse(rerun.generatedAt) + 1_000).toISOString();
    const transition = await harness.store.setAnalysisResult(
      workspaceId(harness.user),
      idempotent.review,
      rerun
    );

    expect(transition.decisionInvalidated).toBe(true);
    expect(transition.review).toMatchObject({
      status: "ready",
      lifecycleStage: "ready-for-decision"
    });
    const afterRerun = await harness.store.getAccountState(workspaceId(harness.user));
    expect(afterRerun.decisions[memo.id]).toBeUndefined();
    expect(afterRerun.analysisResults[memo.id].id).toBe(rerun.id);
    expect(afterRerun.auditEvents.filter((event) => event.action === "Reviewer decision invalidated"))
      .toHaveLength(1);
  });
});

async function signedInReviewer(email: string) {
  return signedInUser(email, "reviewer");
}

async function signedInUser(
  email: string,
  role: UserProfile["role"],
  store: LocalAccountStore = new LocalAccountStore({ persist: false }),
  aiProviderClient?: AiProviderClient
) {
  const app = createApp({ store, aiProviderClient });
  const agent = request.agent(app);
  const invite = await store.createInvite({ email, name: "Security Reviewer", role });
  const response = await agent
    .post("/api/auth/invite/accept")
    .send({ token: invite.rawToken, password: "Correct-Horse-2026" })
    .expect(201);
  return {
    agent,
    store,
    csrfToken: response.body.csrfToken as string,
    user: response.body.user as UserProfile
  };
}

async function createReview(harness: Awaited<ReturnType<typeof signedInReviewer>>) {
  const response = await harness.agent
    .post("/api/reviews")
    .set("x-rulix-csrf", harness.csrfToken)
    .send({
      requestId: randomUUID(),
      title: "RLX-200 controller review",
      itemFamily: "Cryogenic controller",
      manufacturer: "Rulix Test Instruments",
      intendedUse: "University research laboratory",
      dataClass: "proprietary",
      sourcePath: "self-classification",
      memoText: reviewFixtures[0].memoText,
      attachments: []
    })
    .expect(201);
  return response.body.review as MemoRecord;
}

async function memoBindings(
  harness: Pick<Awaited<ReturnType<typeof signedInReviewer>>, "store" | "user">,
  memoId: string
) {
  const detail = await harness.store.getReviewDetail(workspaceId(harness.user), memoId);
  if (!detail) {
    throw new Error(`Review ${memoId} was not found.`);
  }
  return {
    expectedVersion: detail.review.version,
    expectedRevision: detail.review.revision,
    expectedHash: detail.review.contentHash
  };
}

async function approveCouncilDispatch(
  requester: Awaited<ReturnType<typeof signedInUser>>,
  officer: Awaited<ReturnType<typeof signedInUser>>,
  memoId: string
) {
  const bindings = await memoBindings(requester, memoId);
  const queued = await requester.agent
    .post("/api/ai-approval-requests")
    .set("x-rulix-csrf", requester.csrfToken)
    .send({
      requestId: randomUUID(),
      purpose: "council",
      reviewId: memoId,
      depth: "standard",
      ...bindings
    })
    .expect(201);
  const approvalRequestId = queued.body.request?.id as string | undefined;
  expect(approvalRequestId).toMatch(/^air-/);
  await officer.agent
    .post(`/api/admin/ai-approval-requests/${approvalRequestId}/approve`)
    .set("x-rulix-csrf", officer.csrfToken)
    .send({ requestId: randomUUID() })
    .expect(200);
  return {
    requestId: randomUUID(),
    depth: "standard" as const,
    ...bindings
  };
}

function liveResult(memo: Parameters<typeof analyzeMemo>[0], findings: EvidenceFinding[]): ReviewResult {
  const result = analyzeMemo(memo);
  return {
    ...result,
    id: `analysis-${memo.id}`,
    provider: {
      ...result.provider,
      source: "bedrock",
      label: "Amazon Bedrock",
      model: "test-live-model",
      live: true,
      message: "Live provider result used by the security regression."
    },
    findings
  };
}

function finding(status: EvidenceFinding["status"]): EvidenceFinding {
  return {
    id: `finding-${status}`,
    status,
    title: `${status} evidence`,
    claim: "A classification-relevant claim requires authoritative disposition.",
    rationale: "Security regression fixture.",
    sourceChunkIds: ["fixture-source"],
    agent: "evidence-mapper",
    severity: status === "strong" ? "info" : "escalate"
  };
}

function workspaceId(user: UserProfile) {
  return user.organizationId ?? user.id;
}

async function decisionBody(
  harness: Awaited<ReturnType<typeof signedInUser>>,
  memoId: string,
  action: ReviewerDecision["action"],
  notes: string
) {
  const state = await harness.store.getAccountState(workspaceId(harness.user));
  const memo = state.memos.find((item) => item.id === memoId)!;
  const analysis = state.analysisResults[memoId];
  return {
    action,
    notes,
    expectedVersion: memo.version,
    expectedRevision: memo.revision,
    expectedHash: memo.contentHash,
    expectedAnalysisId: analysis?.id,
    expectedAnalysisHash: analysis?.resultHash
  };
}

function deferredCouncilProvider() {
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const create = vi.fn(async () => {
    reached();
    await releasePromise;
    return {
      content: [{
        type: "tool_use",
        name: "record_eccn_review",
        input: {
          recommended: {
            eccn: "3A001.a.5",
            label: "Cryogenic equipment candidate",
            confidence: 0.91,
            risk: "medium",
            summary: "The memo includes cryogenic performance evidence.",
            sourceChunkIds: ["chunk-3a001-cryogenic"]
          },
          findings: [],
          infoRequests: []
        }
      }],
      usage: { input_tokens: 100, output_tokens: 40 }
    };
  });
  return {
    client: { messages: { create } } satisfies AiProviderClient,
    reached: reachedPromise,
    release
  };
}

async function expectProviderStart(
  reached: Promise<void>,
  response: PromiseLike<{ status: number; body: unknown }>
) {
  await Promise.race([
    reached,
    Promise.resolve(response).then((result) => {
      throw new Error(
        `Analysis completed before provider dispatch: ${result.status} ${JSON.stringify(result.body)}`
      );
    })
  ]);
}

class PausingDecisionStore extends LocalAccountStore {
  private decisionGate?: {
    reached: () => void;
    release: Promise<void>;
  };

  pauseNextDecision() {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    this.decisionGate = { reached, release: releasePromise };
    return { reached: reachedPromise, release };
  }

  override async setDecision(
    userId: string,
    memoId: string,
    decision: ReviewerDecision,
    auditEvent: AuditEvent,
    expected: DecisionExpectedBindings
  ): Promise<DecisionTransitionResult> {
    const gate = this.decisionGate;
    if (gate) {
      this.decisionGate = undefined;
      gate.reached();
      await gate.release;
    }
    return super.setDecision(userId, memoId, decision, auditEvent, expected);
  }
}
