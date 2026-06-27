// @vitest-environment node

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewFixtures } from "../src/test/reviewFixtures";
import type { AccountReviewState, UserProfile } from "../src/types";
import { createApp } from "./app";
import { createAccountStore, emptyAccountState, type AccountStore } from "./store";

const originalBedrockEnabled = process.env.BEDROCK_ENABLED;
const originalAuthTable = process.env.RULIX_AUTH_TABLE;
const originalAccountTable = process.env.RULIX_ACCOUNT_TABLE;

describe("Rulix ECCN API", () => {
  beforeEach(() => {
    delete process.env.BEDROCK_ENABLED;
    delete process.env.RULIX_AUTH_TABLE;
    delete process.env.RULIX_ACCOUNT_TABLE;
  });

  afterEach(() => {
    if (originalBedrockEnabled) {
      process.env.BEDROCK_ENABLED = originalBedrockEnabled;
    } else {
      delete process.env.BEDROCK_ENABLED;
    }
    if (originalAuthTable) {
      process.env.RULIX_AUTH_TABLE = originalAuthTable;
    } else {
      delete process.env.RULIX_AUTH_TABLE;
    }
    if (originalAccountTable) {
      process.env.RULIX_ACCOUNT_TABLE = originalAccountTable;
    } else {
      delete process.env.RULIX_ACCOUNT_TABLE;
    }
  });

  it("reports minimal public health without exposing model identifiers", async () => {
    const response = await request(testApp()).get("/api/health").expect(200);

    expect(response.body.ok).toBe(true);
    expect(response.body.service).toBe("rulix-eccn-api");
    expect(response.body.provider.configured).toBe(false);
    expect(response.body.provider.model).toBeUndefined();
    expect(response.body.provider.deepModel).toBeUndefined();
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("limits production CORS to trusted app origins", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const allowed = await request(testApp())
        .get("/api/health")
        .set("Origin", "https://app.rulix.cloud")
        .expect(200);
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.rulix.cloud");

      const rejected = await request(testApp())
        .get("/api/health")
        .set("Origin", "https://evil.example")
        .expect(200);
      expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it("keeps app and dashboard hosts out of public indexes", async () => {
    const robots = await request(testApp())
      .get("/robots.txt")
      .set("Host", "dashboard.rulix.cloud")
      .expect(200);
    expect(robots.text).toContain("Disallow: /");
    expect(robots.headers["x-robots-tag"]).toContain("noindex");

    const sitemap = await request(testApp())
      .get("/sitemap.xml")
      .set("Host", "app.rulix.cloud")
      .expect(404);
    expect(sitemap.headers["x-robots-tag"]).toContain("noindex");

    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const productionRobots = await request(testApp()).get("/robots.txt").expect(200);
      expect(productionRobots.text).toContain("Disallow: /");
      expect(productionRobots.headers["x-robots-tag"]).toContain("noindex");
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it("serves crawl assets for the public marketing host", async () => {
    const robots = await request(testApp())
      .get("/robots.txt")
      .set("Host", "rulix.cloud")
      .expect(200);
    expect(robots.text).toContain("Allow: /");
    expect(robots.text).toContain("https://rulix.cloud/sitemap.xml");
    expect(robots.headers["x-robots-tag"]).toBeUndefined();

    const sitemap = await request(testApp())
      .get("/sitemap.xml")
      .set("Host", "www.rulix.cloud")
      .expect(200);
    expect(sitemap.text).toContain("https://rulix.cloud/export-control-memo-review");
    expect(sitemap.text).toContain("https://rulix.cloud/manufacturer-eccn-review");
    expect(sitemap.headers["content-type"]).toContain("application/xml");
  });

  it("serves the official corpus snapshot", async () => {
    const response = await request(testApp()).get("/api/corpus").expect(200);

    expect(response.body.id).toBe("official-corpus-2026-06-seed");
    expect(response.body.chunks.length).toBeGreaterThan(3);
  });

  it("requires sign in for account review state", async () => {
    await request(testApp()).get("/api/reviews").expect(401);
  });

  it("rejects public self-registration", async () => {
    await request(testApp())
      .post("/api/auth/register")
      .send({
        name: "Public User",
        email: "public-register@example.com",
        password: "Correct-Horse-2026"
      })
      .expect(410);
  });

  it("creates a secure account with an empty memo store", async () => {
    const { agent, csrfToken } = await signedInAgent("empty-state@example.com");
    const response = await agent.get("/api/account/state").expect(200);

    expect(csrfToken).toEqual(expect.any(String));
    expect(response.body.state.memos).toEqual([]);
  });

  it("accepts an invite and then signs in with the invited account", async () => {
    const { app, store } = testHarness();
    const invite = await store.createInvite({
      name: "Invited Reviewer",
      email: "invited@example.com",
      role: "reviewer"
    });

    const publicInfo = await request(app)
      .get(`/api/auth/invites/${encodeURIComponent(invite.rawToken)}`)
      .expect(200);
    expect(publicInfo.body.invite.email).toBe("invited@example.com");

    await request(app)
      .post("/api/auth/invite/accept")
      .send({ token: invite.rawToken, password: "Correct-Horse-2026" })
      .expect(201);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "invited@example.com", password: "Correct-Horse-2026" })
      .expect(200);
    expect(login.body.user.email).toBe("invited@example.com");
  });

  it("fails expired, used, invalid, and wrong-purpose tokens", async () => {
    const { app, store } = testHarness();
    const expired = await store.createInvite({
      email: "expired-invite@example.com",
      expiresAt: new Date(Date.now() - 1000).toISOString()
    });
    await request(app).get(`/api/auth/invites/${encodeURIComponent(expired.rawToken)}`).expect(410);
    await request(app)
      .post("/api/auth/invite/accept")
      .send({ token: expired.rawToken, password: "Correct-Horse-2026" })
      .expect(410);

    const used = await store.createInvite({ email: "used-invite@example.com" });
    await request(app)
      .post("/api/auth/invite/accept")
      .send({ token: used.rawToken, password: "Correct-Horse-2026" })
      .expect(201);
    await request(app).get(`/api/auth/invites/${encodeURIComponent(used.rawToken)}`).expect(410);
    await request(app).get("/api/auth/invites/not-a-token").expect(404);

    const reset = await store.requestPasswordReset("used-invite@example.com");
    expect(reset.rawToken).toEqual(expect.any(String));
    await request(app).get(`/api/auth/invites/${encodeURIComponent(reset.rawToken ?? "")}`).expect(404);
    await request(app).get(`/api/auth/password-reset/${encodeURIComponent(used.rawToken)}`).expect(404);
  });

  it("handles duplicate invite and existing account email conflicts deterministically", async () => {
    const admin = await signedInAgent("admin-invites@example.com", "export-control-officer");
    await admin.agent
      .post("/api/auth/invites")
      .set("x-rulix-csrf", admin.csrfToken)
      .send({ email: "duplicate@example.com", name: "Duplicate Reviewer", role: "reviewer" })
      .expect(201);
    const duplicateInvite = await admin.agent
      .post("/api/auth/invites")
      .set("x-rulix-csrf", admin.csrfToken)
      .send({ email: "duplicate@example.com", name: "Duplicate Reviewer", role: "reviewer" })
      .expect(409);
    expect(duplicateInvite.body.error).toContain("pending invite");

    const existing = await admin.store.createInvite({ email: "existing-account@example.com" });
    await request(admin.app)
      .post("/api/auth/invite/accept")
      .send({ token: existing.rawToken, password: "Correct-Horse-2026" })
      .expect(201);
    const existingAccountInvite = await admin.agent
      .post("/api/auth/invites")
      .set("x-rulix-csrf", admin.csrfToken)
      .send({ email: "existing-account@example.com", name: "Existing", role: "reviewer" })
      .expect(409);
    expect(existingAccountInvite.body.error).toContain("already exists");
  });

  it("revokes old sessions after password reset", async () => {
    const { app, store, agent } = await signedInAgent("reset-revoke@example.com");
    const reset = await store.requestPasswordReset("reset-revoke@example.com");

    await request(app)
      .post("/api/auth/password-reset/complete")
      .send({ token: reset.rawToken, password: "Reset-Horse-2026" })
      .expect(200);

    await agent.get("/api/account/state").expect(401);
    await request(app)
      .post("/api/auth/login")
      .send({ email: "reset-revoke@example.com", password: "Reset-Horse-2026" })
      .expect(200);
  });

  it("locks out repeated failed logins and clears the lockout after reset", async () => {
    const { app, store } = await signedInAgent("lockout@example.com");
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await request(app)
        .post("/api/auth/login")
        .send({ email: "lockout@example.com", password: "Wrong-Horse-2026" })
        .expect(401);
    }
    await request(app)
      .post("/api/auth/login")
      .send({ email: "lockout@example.com", password: "Correct-Horse-2026" })
      .expect(429);

    const reset = await store.requestPasswordReset("lockout@example.com");
    await request(app)
      .post("/api/auth/password-reset/complete")
      .send({ token: reset.rawToken, password: "Reset-Horse-2026" })
      .expect(200);
    await request(app)
      .post("/api/auth/login")
      .send({ email: "lockout@example.com", password: "Reset-Horse-2026" })
      .expect(200);
  });

  it("still blocks mutating routes without a CSRF token", async () => {
    const { agent } = await signedInAgent("csrf@example.com");
    await agent
      .post("/api/ai/review")
      .send({ memo: reviewFixtures[0] })
      .expect(403);
  });

  it("extracts uploaded text documents through the authenticated document endpoint", async () => {
    const { agent, csrfToken } = await signedInAgent("documents@example.com");
    const text = "1.0 Item\nCryogenic controller model RLX-200 with RF timing specs and manufacturer notes.";
    const response = await agent
      .post("/api/documents/extract")
      .set("x-rulix-csrf", csrfToken)
      .send({
        fileName: "controller-notes.txt",
        mediaType: "text/plain",
        dataBase64: Buffer.from(text, "utf8").toString("base64")
      })
      .expect(200);

    expect(response.body.extraction).toMatchObject({
      fileName: "controller-notes.txt",
      mediaType: "text/plain",
      method: "text",
      text
    });
  });

  it("rejects ad hoc analysis when live AI is unavailable", async () => {
    const { agent, csrfToken } = await signedInAgent("analysis@example.com");
    const response = await agent
      .post("/api/ai/review")
      .set("x-rulix-csrf", csrfToken)
      .send({ memo: reviewFixtures[0] })
      .expect(503);

    expect(response.body).toMatchObject({
      code: "live_council_unavailable",
      error: "Live AI analysis is not configured. No deterministic analysis was recorded."
    });
  });

  it("does not expose deterministic analysis for client-supplied model requests", async () => {
    const { agent, csrfToken } = await signedInAgent("depth@example.com");
    const response = await agent
      .post("/api/ai/review")
      .set("x-rulix-csrf", csrfToken)
      .send({
        memo: reviewFixtures[0],
        depth: "deep",
        model: "claude-opus-4-8"
      })
      .expect(503);

    expect(response.body.code).toBe("live_council_unavailable");
    expect(response.body.error).toContain("No deterministic analysis was recorded");
  });

  it("preserves server-side audit events across later client state saves", async () => {
    const { agent, csrfToken } = await signedInAgent("audit-merge@example.com");
    await saveState(agent, csrfToken, {
      ...emptyAccountState(),
      memos: [reviewFixtures[0]],
      selectedMemoId: reviewFixtures[0].id
    });

    const editedMemoText = `${reviewFixtures[0].memoText}\n\nReviewer note: confirm model number before signoff.`;
    const editResponse = await agent
      .patch(`/api/reviews/${reviewFixtures[0].id}`)
      .set("x-rulix-csrf", csrfToken)
      .send({ memoText: editedMemoText })
      .expect(200);

    expect(editResponse.body.review.memoText).toBe(editedMemoText);

    await saveState(agent, csrfToken, {
      ...emptyAccountState(),
      memos: [reviewFixtures[0]],
      selectedMemoId: reviewFixtures[0].id
    });

    const stateResponse = await agent.get("/api/account/state").expect(200);
    expect(
      stateResponse.body.state.auditEvents.some((event: { action: string }) => event.action === "Memo edited")
    ).toBe(true);
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

  it("blocks non-admins from the admin dashboard endpoints", async () => {
    const reviewer = await signedInAgent("reviewer-metrics@example.com", "reviewer");
    await reviewer.agent.get("/api/admin/metrics").expect(403);
    await reviewer.agent.get("/api/admin/users").expect(403);
  });

  it("reports admin metrics including recorded Bedrock usage and online users", async () => {
    const admin = await signedInAgent("ops@example.com", "export-control-officer");
    await admin.store.recordUsage({
      id: "usage-test-1",
      userId: admin.user.id,
      userEmail: admin.user.email,
      at: new Date().toISOString(),
      model: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
      callType: "council",
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      latencyMs: 1200
    });

    const metrics = (await admin.agent.get("/api/admin/metrics").expect(200)).body.metrics;
    expect(metrics.totals.calls).toBe(1);
    expect(metrics.totals.inputTokens).toBe(1_000_000);
    // Haiku default pricing: 1M input @ $1 + 0.2M output @ $5 = $2.00
    expect(metrics.totals.costUsd).toBeCloseTo(2, 2);
    expect(metrics.users.total).toBeGreaterThanOrEqual(1);
    expect(metrics.users.online).toBeGreaterThanOrEqual(1);
    expect(metrics.byModel[0].label).toContain("Haiku");

    const users = (await admin.agent.get("/api/admin/users").expect(200)).body.users;
    const me = users.find((entry: { email: string }) => entry.email === "ops@example.com");
    expect(me.usage.calls).toBe(1);
    expect(me.online).toBe(true);
  });

  it("serves the imported lead sheet and records disabled lead searches", async () => {
    const admin = await signedInAgent("lead-admin@example.com", "export-control-officer");

    const workspace = (await admin.agent.get("/api/admin/outreach").expect(200)).body;
    expect(workspace.leads).toHaveLength(154);
    expect(workspace.leads[0]).toMatchObject({
      leadId: "RULIX-00001",
      email: "exportcontrol@brown.edu",
      priority: "A"
    });
    expect(workspace.bedrock.leadSearchModel).toContain("sonnet-4-6");
    expect(workspace.bedrock.personalizationModel).toContain("sonnet-4-6");

    const search = await admin.agent
      .post("/api/admin/leads/search")
      .set("x-rulix-csrf", admin.csrfToken)
      .send({ durationSeconds: 15 })
      .expect(502);
    expect(search.body.run.status).toBe("failed");

    const refreshed = (await admin.agent.get("/api/admin/outreach").expect(200)).body;
    expect(refreshed.leadSearchRuns[0].status).toBe("failed");
  });

  it("requires a saved draft and enabled Bedrock before personalization", async () => {
    const admin = await signedInAgent("personalize-admin@example.com", "export-control-officer");

    await admin.agent
      .post("/api/admin/outreach/drafts/RULIX-00001/personalize")
      .set("x-rulix-csrf", admin.csrfToken)
      .expect(404);

    await admin.agent
      .put("/api/admin/outreach/drafts/RULIX-00001")
      .set("x-rulix-csrf", admin.csrfToken)
      .send({
        subject: "A small Rulix pilot",
        body: "I am exploring a small Rulix pilot with export-control teams. If this is not relevant, I will not follow up."
      })
      .expect(200);

    const response = await admin.agent
      .post("/api/admin/outreach/drafts/RULIX-00001/personalize")
      .set("x-rulix-csrf", admin.csrfToken)
      .expect(502);
    expect(response.body.error).toContain("Bedrock is not enabled");
  });

  it("creates controllable background jobs and persists lead workflow decisions", async () => {
    const admin = await signedInAgent("workflow-admin@example.com", "export-control-officer");

    const created = await admin.agent
      .post("/api/admin/outreach/jobs")
      .set("x-rulix-csrf", admin.csrfToken)
      .send({ type: "lead-search", maxCostUsd: 1, maxRetries: 2, searchDurationSeconds: 15 })
      .expect(202);
    expect(created.body.job).toMatchObject({
      type: "lead-search",
      status: "queued",
      maxCostUsd: 1
    });

    const paused = await admin.agent
      .post(`/api/admin/outreach/jobs/${created.body.job.id}/pause`)
      .set("x-rulix-csrf", admin.csrfToken)
      .expect(200);
    expect(paused.body.job.status).toBe("paused");

    const resumed = await admin.agent
      .post(`/api/admin/outreach/jobs/${created.body.job.id}/resume`)
      .set("x-rulix-csrf", admin.csrfToken)
      .expect(200);
    expect(resumed.body.job.status).toBe("queued");

    const terminated = await admin.agent
      .post(`/api/admin/outreach/jobs/${created.body.job.id}/terminate`)
      .set("x-rulix-csrf", admin.csrfToken)
      .expect(200);
    expect(terminated.body.job.status).toBe("terminated");
    expect(terminated.body.job.completedAt).toBeTruthy();
    expect(terminated.body.job.logs[0].message).toContain("Terminated by operator");

    await admin.agent
      .post(`/api/admin/outreach/jobs/${created.body.job.id}/resume`)
      .set("x-rulix-csrf", admin.csrfToken)
      .expect(409);

    const workflow = await admin.agent
      .put("/api/admin/leads/RULIX-00001/workflow")
      .set("x-rulix-csrf", admin.csrfToken)
      .send({
        reviewStatus: "approved",
        lifecycleStatus: "approved",
        assignedOwner: "Eithan",
        followUpAt: "2026-07-01T14:00:00.000Z",
        replyStatus: "Awaiting outreach"
      })
      .expect(200);
    expect(workflow.body.workflow).toMatchObject({
      leadId: "RULIX-00001",
      reviewStatus: "approved",
      assignedOwner: "Eithan"
    });

    const workspace = (await admin.agent.get("/api/admin/outreach").expect(200)).body;
    expect(workspace.outreachJobs[0].id).toBe(created.body.job.id);
    expect(workspace.leadWorkflows["RULIX-00001"].reviewStatus).toBe("approved");
  });
});

function testApp() {
  return testHarness().app;
}

function testHarness() {
  const store = createAccountStore({ persist: false });
  return { app: createApp({ store }), store };
}

async function signedInAgent(email: string, role: UserProfile["role"] = "reviewer") {
  const { app, store } = testHarness();
  const agent = request.agent(app);
  const invite = await store.createInvite({
    name: "Garry Reviewer",
    email,
    role
  });
  const response = await agent
    .post("/api/auth/invite/accept")
    .send({
      token: invite.rawToken,
      password: "Correct-Horse-2026"
    })
    .expect(201);

  return {
    app,
    store: store as AccountStore,
    agent,
    csrfToken: response.body.csrfToken as string,
    user: response.body.user as UserProfile
  };
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
