// @vitest-environment node

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewFixtures } from "../src/test/reviewFixtures";
import type { DataClass, MemoRecord, UserProfile } from "../src/types";
import { createApp } from "./app";
import { setAiDispatchAdmissionHook, type AiProviderClient } from "./aiEgressGateway";
import { createAccountStore, type AccountStore } from "./store";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.BEDROCK_ENABLED = "true";
  process.env.AWS_REGION = "us-east-1";
  process.env.RULIX_APPROVED_PROVIDER = "amazon-bedrock";
  process.env.RULIX_APPROVED_REGION = "us-east-1";
  process.env.RULIX_AI_DATA_CLASS = "proprietary";
  delete process.env.RULIX_CONTROLLED_DATA_MODE;
  delete process.env.RULIX_AI_REQUESTS_PER_MINUTE;
});

afterEach(() => {
  setAiDispatchAdmissionHook(undefined);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("AI route security boundary", () => {
  it("keeps the retired ad-hoc review endpoint closed without touching a provider", async () => {
    const provider = providerSpy();
    const session = await signedIn(provider.client);
    const response = await session.agent
      .post("/api/ai/review")
      .set("x-rulix-csrf", session.csrfToken)
      .send({ memo: { memoText: reviewFixtures[0].memoText, dataClass: "public" } })
      .expect(410);

    expect(response.body.code).toBe("client_upgrade_required");
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("keeps public-source drafting local and rejects any classification or provider-control fields", async () => {
    const provider = providerSpy();
    const session = await signedIn(provider.client);
    const local = await session.agent
      .post("/api/public-memo-draft")
      .set("x-rulix-csrf", session.csrfToken)
      .send({ item: "RLX-200 controller" })
      .expect(200);
    expect(local.body.memoText).toEqual(expect.any(String));
    expect(provider.create).not.toHaveBeenCalled();

    const rejected = await session.agent
      .post("/api/public-memo-draft")
      .set("x-rulix-csrf", session.csrfToken)
      .send({ item: "RLX-200 controller", dataClass: "public" })
      .expect(400);
    expect(rejected.body.code).toBe("invalid_public_draft_request");
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("blocks document AI at the server-owned controlled-data floor before provider use", async () => {
    process.env.RULIX_AI_DATA_CLASS = "cui";
    const provider = providerSpy();
    const session = await signedIn(provider.client);

    const response = await session.agent
      .post("/api/documents/extract")
      .set("x-rulix-csrf", session.csrfToken)
      .send(documentRequest("public"))
      .expect(422);

    expect(response.body.code).toBe("data_class_not_allowed");
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("blocks a stored Memo Builder session at the server-owned controlled-data floor", async () => {
    process.env.RULIX_AI_DATA_CLASS = "cui";
    const provider = providerSpy();
    const session = await signedIn(provider.client);
    const builder = await saveBuilderSession(session, "public");

    const response = await session.agent
      .post("/api/ai/memo-builder-chat")
      .set("x-rulix-csrf", session.csrfToken)
      .send({ sessionId: builder.id, pendingMessage: builder.pendingInput, requestId: randomUUID() })
      .expect(422);

    expect(response.body.code).toBe("data_class_not_allowed");
    expect(provider.create).not.toHaveBeenCalled();
  });

  it.each(["export-controlled", "itar-risk", "cui"])(
    "honors a caller's higher %s document classification before provider use",
    async (dataClass) => {
      const provider = providerSpy();
      const session = await signedIn(provider.client);
      const response = await session.agent
        .post("/api/documents/extract")
        .set("x-rulix-csrf", session.csrfToken)
        .send(documentRequest(dataClass))
        .expect(422);

      expect(response.body.code).toBe("data_class_not_allowed");
      expect(provider.create).not.toHaveBeenCalled();
    }
  );

  it("honors a higher stored Memo Builder classification before provider use", async () => {
    const provider = providerSpy();
    const session = await signedIn(provider.client);
    const builder = await saveBuilderSession(session, "cui");

    const response = await session.agent
      .post("/api/ai/memo-builder-chat")
      .set("x-rulix-csrf", session.csrfToken)
      .send({ sessionId: builder.id, pendingMessage: builder.pendingInput, requestId: randomUUID() })
      .expect(422);

    expect(response.body.code).toBe("data_class_not_allowed");
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("rejects an unrecognized caller classification before provider use", async () => {
    const provider = providerSpy();
    const session = await signedIn(provider.client);
    const response = await session.agent
      .post("/api/documents/extract")
      .set("x-rulix-csrf", session.csrfToken)
      .send(documentRequest("secret-ish"))
      .expect(422);

    expect(response.body.code).toBe("data_class_required");
    expect(provider.create).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { sessionId: "not-a-builder", pendingMessage: "valid", requestId: randomUUID() },
    { sessionId: `builder-${randomUUID()}`, pendingMessage: "   ", requestId: randomUUID() },
    { sessionId: `builder-${randomUUID()}`, pendingMessage: "x".repeat(8_001), requestId: randomUUID() },
    { sessionId: `builder-${randomUUID()}`, pendingMessage: "valid", requestId: "not-a-uuid" },
    { sessionId: `builder-${randomUUID()}`, pendingMessage: "valid", requestId: randomUUID(), extra: true }
  ])("rejects malformed exact Memo Builder bindings without truncating or filtering %#", async (body) => {
    const provider = providerSpy();
    const session = await signedIn(provider.client);

    await session.agent
      .post("/api/ai/memo-builder-chat")
      .set("x-rulix-csrf", session.csrfToken)
      .send(body)
      .expect(400);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("rejects memo-builder JSON above the transport budget", async () => {
    const provider = providerSpy();
    const session = await signedIn(provider.client);

    await session.agent
      .post("/api/ai/memo-builder-chat")
      .set("x-rulix-csrf", session.csrfToken)
      .send({
        sessionId: `builder-${randomUUID()}`,
        pendingMessage: "valid",
        requestId: randomUUID(),
        ignoredPadding: "x".repeat(260 * 1024)
      })
      .expect(413);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("rejects an invalid deployment classification before provider use", async () => {
    process.env.RULIX_AI_DATA_CLASS = "unknown";
    const provider = providerSpy();
    const session = await signedIn(provider.client);

    const response = await session.agent
      .post("/api/documents/extract")
      .set("x-rulix-csrf", session.csrfToken)
      .send(documentRequest("proprietary"))
      .expect(503);

    expect(response.body.code).toBe("ai_data_class_invalid");
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("requires the actual provider region to match current approval", async () => {
    process.env.RULIX_APPROVED_REGION = "us-west-2";
    const provider = providerSpy();
    const session = await signedIn(provider.client, "export-control-officer");

    const response = await session.agent
      .post("/api/documents/extract")
      .set("x-rulix-csrf", session.csrfToken)
      .send(documentRequest("proprietary"))
      .expect(422);

    expect(response.body.code).toBe("ai_egress_lane_mismatch");
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("enforces a per-account request budget before a second provider dispatch", async () => {
    process.env.RULIX_AI_REQUESTS_PER_MINUTE = "1";
    const provider = providerSpy();
    const session = await signedIn(provider.client, "export-control-officer");

    const first = await session.agent
      .post("/api/documents/extract")
      .set("x-rulix-csrf", session.csrfToken)
      .send(documentRequest("proprietary"))
      .expect(200);
    expect(first.body.extraction.method).toBe("bedrock-image");

    const second = await session.agent
      .post("/api/documents/extract")
      .set("x-rulix-csrf", session.csrfToken)
      .send(documentRequest("proprietary"))
      .expect(429);

    expect(second.body.code).toBe("ai_workload_limit_exceeded");
    expect(provider.create).toHaveBeenCalledOnce();
  });

  it("rechecks controlled-data approval before stored memo chat", async () => {
    process.env.RULIX_AI_DATA_CLASS = "cui";
    process.env.RULIX_CONTROLLED_DATA_MODE = "approved";
    const provider = providerSpy();
    const session = await signedIn(provider.client);
    const created = await session.agent
      .post("/api/reviews")
      .set("x-rulix-csrf", session.csrfToken)
      .send(reviewInput("public"))
      .expect(201);
    expect(created.body.review.dataClass).toBe("cui");

    delete process.env.RULIX_CONTROLLED_DATA_MODE;
    const response = await session.agent
      .post(`/api/reviews/${created.body.review.id}/chat`)
      .set("x-rulix-csrf", session.csrfToken)
      .send({ requestId: randomUUID(), message: "Explain the evidence.", ...reviewBindings(created.body.review) })
      .expect(422);

    expect(response.body.code).toBe("data_class_not_allowed");
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("fails closed on an unrecognized persisted classification", async () => {
    const provider = providerSpy();
    const session = await signedIn(provider.client);
    const created = await session.agent
      .post("/api/reviews")
      .set("x-rulix-csrf", session.csrfToken)
      .send(reviewInput("proprietary"))
      .expect(201);
    await session.store.upsertReview(
      workspaceId(session.user),
      { ...created.body.review, dataClass: "unknown-persisted-value" } as MemoRecord
    );
    const persisted = await session.store.getReviewDetail(
      workspaceId(session.user),
      created.body.review.id
    );
    expect(persisted).toBeDefined();

    const response = await session.agent
      .post(`/api/reviews/${created.body.review.id}/chat`)
      .set("x-rulix-csrf", session.csrfToken)
      .send({ requestId: randomUUID(), message: "Explain the evidence.", ...reviewBindings(persisted!.review) })
      .expect(422);

    expect(response.body.code).toBe("data_class_required");
    expect(provider.create).not.toHaveBeenCalled();
  });
});

async function signedIn(
  providerClient: AiProviderClient,
  role: UserProfile["role"] = "reviewer"
) {
  const store = createAccountStore({ persist: false });
  const agent = request.agent(createApp({ store, aiProviderClient: providerClient }));
  const invite = await store.createInvite({
    name: "Security Reviewer",
    email: `ai-security-${Math.random().toString(36).slice(2)}@example.com`,
    role
  });
  const response = await agent
    .post("/api/auth/invite/accept")
    .send({ token: invite.rawToken, password: "Correct-Horse-2026" })
    .expect(201);
  return {
    store: store as AccountStore,
    agent,
    csrfToken: response.body.csrfToken as string,
    user: response.body.user as UserProfile
  };
}

function providerSpy() {
  const create = vi.fn(async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        title: "RLX-200 draft",
        memoText: "# Draft\n\nThis is an AI-generated draft that requires independent verification.",
        sources: []
      })
    }],
    usage: { input_tokens: 100, output_tokens: 40 }
  }));
  return {
    client: { messages: { create } } satisfies AiProviderClient,
    create
  };
}

function reviewInput(dataClass: string) {
  return {
    requestId: randomUUID(),
    title: "RLX-200 controller review",
    itemFamily: "Cryogenic controller",
    dataClass,
    sourcePath: "self-classification",
    memoText: reviewFixtures[0].memoText,
    attachments: []
  };
}

function documentRequest(dataClass: string) {
  return {
    fileName: "evidence.png",
    mediaType: "image/png",
    dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"),
    dataClass,
    requestId: randomUUID()
  };
}

async function saveBuilderSession(
  session: Awaited<ReturnType<typeof signedIn>>,
  dataClass: string
) {
  const id = `builder-${randomUUID()}`;
  const pendingInput = "Draft a classification memo from the saved evidence.";
  await session.store.upsertMemoBuilderSession(workspaceId(session.user), id, {
    expectedVersion: 0,
    session: {
      id,
      title: "Bounded security test",
      dataClass: dataClass as DataClass,
      updatedAt: new Date().toISOString(),
      messages: [],
      pendingInput
    }
  });
  return { id, pendingInput };
}

function reviewBindings(review: MemoRecord) {
  return {
    expectedVersion: review.version,
    expectedRevision: review.revision,
    expectedHash: review.contentHash
  };
}

function workspaceId(user: UserProfile) {
  return (user as UserProfile & { organizationId?: string }).organizationId ?? user.id;
}
