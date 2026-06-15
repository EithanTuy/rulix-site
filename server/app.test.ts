// @vitest-environment node

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewFixtures } from "../src/test/reviewFixtures";
import type { AccountReviewState } from "../src/types";
import { createApp } from "./app";
import { createAccountStore, emptyAccountState } from "./store";

const originalKey = process.env.ANTHROPIC_API_KEY;

describe("Rulix ECCN API", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalKey) {
      process.env.ANTHROPIC_API_KEY = originalKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("reports health and whether the Anthropic backend is configured", async () => {
    const response = await request(testApp()).get("/api/health").expect(200);

    expect(response.body.ok).toBe(true);
    expect(response.body.service).toBe("rulix-eccn-api");
    expect(response.body.provider.configured).toBe(false);
  });

  it("serves the official corpus snapshot", async () => {
    const response = await request(testApp()).get("/api/corpus").expect(200);

    expect(response.body.id).toBe("official-corpus-2026-06-seed");
    expect(response.body.chunks.length).toBeGreaterThan(3);
  });

  it("requires sign in for account review state", async () => {
    await request(testApp()).get("/api/reviews").expect(401);
  });

  it("creates a secure account with an empty memo store", async () => {
    const { agent, csrfToken } = await signedInAgent("empty-state@example.com");
    const response = await agent.get("/api/account/state").expect(200);

    expect(csrfToken).toEqual(expect.any(String));
    expect(response.body.state.memos).toEqual([]);
  });

  it("analyzes an ad hoc memo through the authenticated fallback backend path", async () => {
    const { agent, csrfToken } = await signedInAgent("analysis@example.com");
    const response = await agent
      .post("/api/ai/review")
      .set("x-rulix-csrf", csrfToken)
      .send({ memo: reviewFixtures[0] })
      .expect(200);

    expect(response.body.result.memoId).toBe(reviewFixtures[0].id);
    expect(response.body.result.recommended.eccn).toBe("3A001.a.5");
    expect(response.body.result.provider.source).toBe("local-rules");
  });

  it("records a reviewer decision under the signed-in account", async () => {
    const { agent, csrfToken } = await signedInAgent("decision@example.com");
    await saveState(agent, csrfToken, {
      ...emptyAccountState(),
      memos: [reviewFixtures[0]],
      selectedMemoId: reviewFixtures[0].id
    });

    const response = await agent
      .post(`/api/reviews/${reviewFixtures[0].id}/decision`)
      .set("x-rulix-csrf", csrfToken)
      .send({ action: "request-info", notes: "Need vendor parameter mapping." })
      .expect(200);

    expect(response.body.review.status).toBe("needs-info");
    expect(response.body.decision.notes).toContain("vendor parameter");
  });

  it("isolates memo records between accounts", async () => {
    const userA = await signedInAgent("user-a@example.com");
    const userB = await signedInAgent("user-b@example.com");
    await saveState(userA.agent, userA.csrfToken, {
      ...emptyAccountState(),
      memos: [reviewFixtures[0]],
      selectedMemoId: reviewFixtures[0].id
    });

    await userA.agent.get(`/api/reviews/${reviewFixtures[0].id}`).expect(200);
    await userB.agent.get(`/api/reviews/${reviewFixtures[0].id}`).expect(404);
  });
});

function testApp() {
  return createApp({ store: createAccountStore({ persist: false }) });
}

async function signedInAgent(email: string) {
  const agent = request.agent(testApp());
  const response = await agent
    .post("/api/auth/register")
    .send({
      name: "Garry Reviewer",
      email,
      password: "Correct-Horse-2026"
    })
    .expect(201);

  return { agent, csrfToken: response.body.csrfToken as string };
}

async function saveState(
  agent: ReturnType<typeof request.agent>,
  csrfToken: string,
  state: AccountReviewState
) {
  await agent
    .put("/api/account/state")
    .set("x-rulix-csrf", csrfToken)
    .send({ state })
    .expect(200);
}
