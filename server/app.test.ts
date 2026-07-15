// @vitest-environment node

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewFixtures } from "../src/test/reviewFixtures";
import type { UserProfile } from "../src/types";
import { analyzeMemo } from "../src/lib/eccnReview";
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
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(response.headers.pragma).toBe("no-cache");
  });

  it("returns a terminal JSON 500 envelope with a correlation ID and no rejection details", async () => {
    const { agent, store } = await signedInAgent("terminal-error@example.com");
    vi.spyOn(store, "listReviews").mockRejectedValue(
      new Error("injected-sensitive-provider-detail")
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await agent.get("/api/reviews").expect(500);

      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.body).toMatchObject({
        code: "internal_error",
        error: expect.any(String),
        correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/i)
      });
      expect(response.headers["x-rulix-correlation-id"]).toBe(response.body.correlationId);
      expect(JSON.stringify(response.body)).not.toContain("injected-sensitive-provider-detail");
      expect(errorLog).toHaveBeenCalledOnce();
      expect(String(errorLog.mock.calls[0]?.[0])).not.toContain("injected-sensitive-provider-detail");
    } finally {
      errorLog.mockRestore();
    }
  });

  it("treats malformed cookie encoding as anonymous instead of failing the request", async () => {
    const response = await request(testApp())
      .get("/api/auth/me")
      .set("Cookie", "unrelated=%E0%A4%A; rulix_session=%")
      .expect(200);

    expect(response.body).toEqual({ user: null, csrfToken: null });
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

  it("creates a secure account with an empty paged review store and retires bulk state reads", async () => {
    const { agent, csrfToken } = await signedInAgent("empty-state@example.com");
    const response = await agent.get("/api/reviews?limit=50&state=active").expect(200);

    expect(csrfToken).toEqual(expect.any(String));
    expect(response.body.items).toEqual([]);
    expect(response.body.nextCursor).toBeUndefined();
    await agent.get("/api/account/state").expect(410);
  });

  it("accepts an invite and then signs in with the invited account", async () => {
    const { app, store } = testHarness();
    const invite = await store.createInvite({
      name: "Invited Reviewer",
      email: "invited@example.com",
      role: "reviewer"
    });

    const publicInfo = await request(app)
      .post("/api/auth/invite/inspect")
      .send({ token: invite.rawToken })
      .expect(200);
    expect(publicInfo.body.invite.email).toBe("invited@example.com");
    expect(publicInfo.headers["cache-control"]).toContain("no-store");

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

  it("preserves leading and trailing password bytes through invite, login, and reset routes", async () => {
    const { app, store } = testHarness();
    const email = "opaque-password@example.com";
    const originalPassword = " Correct-Horse-2026 ";
    const replacementPassword = " Reset-Horse-2026 ";
    const invite = await store.createInvite({ email, name: "Opaque Password" });

    await request(app)
      .post("/api/auth/invite/accept")
      .send({ token: invite.rawToken, password: originalPassword })
      .expect(201);
    await request(app)
      .post("/api/auth/login")
      .send({ email, password: originalPassword })
      .expect(200);
    await request(app)
      .post("/api/auth/login")
      .send({ email, password: originalPassword.trim() })
      .expect(401);

    const reset = await store.requestPasswordReset(email);
    await request(app)
      .post("/api/auth/password-reset/complete")
      .send({ token: reset.rawToken, password: replacementPassword })
      .expect(200);
    await request(app)
      .post("/api/auth/login")
      .send({ email, password: replacementPassword })
      .expect(200);
    await request(app)
      .post("/api/auth/login")
      .send({ email, password: replacementPassword.trim() })
      .expect(401);
  });

  it("rejects oversized default-route JSON before auth work while preserving explicit large lanes", async () => {
    const app = testApp();
    const oversized = await request(app)
      .post("/api/auth/login")
      .send({
        email: "bounded@example.com",
        password: "Correct-Horse-2026",
        padding: "x".repeat(40 * 1024)
      })
      .expect(413);
    expect(oversized.body.code).toBe("request_body_too_large");

    const retiredOversized = await request(app)
      .post("/api/ai/review")
      .send({ memo: { memoText: "x".repeat(40 * 1024) } })
      .expect(413);
    expect(retiredOversized.body.code).toBe("request_body_too_large");
    await request(app)
      .post("/api/documents/extract")
      .send({ dataBase64: "x".repeat(300 * 1024) })
      .expect(401);
  });

  it("uses a host-only prefixed session cookie in production", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { app, store } = testHarness();
      const invite = await store.createInvite({ email: "cookie-prefix@example.com" });
      const response = await request(app)
        .post("/api/auth/invite/accept")
        .send({ token: invite.rawToken, password: "Correct-Horse-2026" })
        .expect(201);

      const cookie = response.headers["set-cookie"]?.[0] ?? "";
      expect(cookie).toContain("__Host-rulix_session=");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).not.toMatch(/Domain=/i);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("rejects unsafe API requests from untrusted browser origins before authentication", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const app = testApp();
      const hostile = await request(app)
        .post("/api/auth/login")
        .set("Origin", "https://evil.example")
        .send({ email: "victim@example.com", password: "attacker-selected" })
        .expect(403);
      expect(hostile.body.code).toBe("untrusted_origin");

      const crossSiteForm = await request(app)
        .post("/api/auth/password-reset/request")
        .set("Sec-Fetch-Site", "cross-site")
        .send({ email: "victim@example.com" })
        .expect(403);
      expect(crossSiteForm.body.code).toBe("untrusted_origin");

      await request(app)
        .post("/api/auth/login")
        .set("Origin", "https://app.rulix.cloud")
        .send({ email: "missing@example.com", password: "not-a-real-password" })
        .expect(401);
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("fails expired, used, invalid, and wrong-purpose tokens", async () => {
    const { app, store } = testHarness();
    const expired = await store.createInvite({
      email: "expired-invite@example.com",
      expiresAt: new Date(Date.now() - 1000).toISOString()
    });
    await request(app).post("/api/auth/invite/inspect").send({ token: expired.rawToken }).expect(410);
    await request(app)
      .post("/api/auth/invite/accept")
      .send({ token: expired.rawToken, password: "Correct-Horse-2026" })
      .expect(410);

    const used = await store.createInvite({ email: "used-invite@example.com" });
    await request(app)
      .post("/api/auth/invite/accept")
      .send({ token: used.rawToken, password: "Correct-Horse-2026" })
      .expect(201);
    await request(app).post("/api/auth/invite/inspect").send({ token: used.rawToken }).expect(410);
    await request(app).post("/api/auth/invite/inspect").send({ token: "not-a-token" }).expect(400);
    await request(app).get("/api/auth/invites/retired-token-path").expect(404);

    const reset = await store.requestPasswordReset("used-invite@example.com");
    expect(reset.rawToken).toEqual(expect.any(String));
    await request(app).post("/api/auth/invite/inspect").send({ token: reset.rawToken }).expect(404);
    await request(app).post("/api/auth/password-reset/inspect").send({ token: used.rawToken }).expect(404);
    await request(app).get("/api/auth/password-reset/retired-token-path").expect(404);
  });

  it("bounds public auth credentials before password hashing and keeps login failures generic", async () => {
    const { app, store } = testHarness();
    const oversizedPassword = `Aa1!${"x".repeat(2_048)}`;
    const invite = await store.createInvite({ email: "bounded-invite@example.com" });

    const inviteResponse = await request(app)
      .post("/api/auth/invite/accept")
      .send({ token: invite.rawToken, password: oversizedPassword })
      .expect(400);
    expect(inviteResponse.body.error).toContain("1,024 UTF-8 bytes");

    await request(app)
      .post("/api/auth/invite/accept")
      .send({ token: invite.rawToken, password: "Correct-Horse-2026" })
      .expect(201);

    const loginResponse = await request(app)
      .post("/api/auth/login")
      .send({ email: "bounded-invite@example.com", password: oversizedPassword })
      .expect(401);
    expect(loginResponse.body).toEqual({ error: "Invalid email or password." });

    const reset = await store.requestPasswordReset("bounded-invite@example.com");
    const resetResponse = await request(app)
      .post("/api/auth/password-reset/complete")
      .send({ token: reset.rawToken, password: oversizedPassword })
      .expect(400);
    expect(resetResponse.body.error).toContain("1,024 UTF-8 bytes");
  });

  it("rejects overlong invite email and name fields at the authenticated route", async () => {
    const admin = await signedInAgent("bounded-admin@example.com", "export-control-officer");
    await admin.agent
      .post("/api/auth/invites")
      .set("x-rulix-csrf", admin.csrfToken)
      .send({ email: `${"a".repeat(245)}@example.com`, name: "Bounded", role: "reviewer" })
      .expect(400);
    await admin.agent
      .post("/api/auth/invites")
      .set("x-rulix-csrf", admin.csrfToken)
      .send({ email: "bounded-name@example.com", name: "n".repeat(121), role: "reviewer" })
      .expect(400);
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

  it("invalidates every older password-reset link when a new one is issued", async () => {
    const { app, store } = await signedInAgent("reset-single-use@example.com");
    const first = await store.requestPasswordReset("reset-single-use@example.com");
    const second = await store.requestPasswordReset("reset-single-use@example.com");

    await request(app)
      .post("/api/auth/password-reset/complete")
      .send({ token: first.rawToken, password: "Rejected-Horse-2026" })
      .expect(410);

    await request(app)
      .post("/api/auth/password-reset/complete")
      .send({ token: second.rawToken, password: "Accepted-Horse-2026" })
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

  it("does not accept client-authored reviews, decisions, analysis, or audit history", async () => {
    const { agent, csrfToken } = await signedInAgent("authoritative-state@example.com");
    const forged = {
      ...emptyAccountState(),
      memos: [reviewFixtures[0]],
      decisions: {
        [reviewFixtures[0].id]: {
          action: "accept",
          notes: "Forged in the browser",
          signedBy: "Mallory",
          signedAt: new Date().toISOString()
        }
      },
      auditEvents: [{
        id: "forged-event",
        memoId: reviewFixtures[0].id,
        at: new Date().toISOString(),
        actor: "Mallory",
        action: "Forged approval",
        detail: "Client-authored",
        severity: "info"
      }]
    };

    const response = await agent
      .put("/api/account/state")
      .set("x-rulix-csrf", csrfToken)
      .send({ state: forged })
      .expect(410);

    expect(response.body.error).toContain("server-owned");
  });

  it("blocks submitters from running council analysis or recording decisions", async () => {
    const submitter = await signedInAgent("submitter-boundary@example.com", "submitter");
    const created = await submitter.agent
      .post("/api/reviews")
      .set("x-rulix-csrf", submitter.csrfToken)
      .send(validReviewInput())
      .expect(201);

    await submitter.agent
      .post(`/api/reviews/${created.body.review.id}/analyze`)
      .set("x-rulix-csrf", submitter.csrfToken)
      .send({ depth: "standard" })
      .expect(403);

    await submitter.agent
      .post(`/api/reviews/${created.body.review.id}/decision`)
      .set("x-rulix-csrf", submitter.csrfToken)
      .send({ action: "request-info", notes: "Attempted submitter decision" })
      .expect(403);
  });

  it("rejects controlled-data cases until an approved data lane is configured", async () => {
    const reviewer = await signedInAgent("controlled-boundary@example.com", "reviewer");
    const response = await reviewer.agent
      .post("/api/reviews")
      .set("x-rulix-csrf", reviewer.csrfToken)
      .send({ ...validReviewInput(), dataClass: "cui" })
      .expect(422);

    expect(response.body.code).toBe("data_class_not_allowed");
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
        dataBase64: Buffer.from(text, "utf8").toString("base64"),
        dataClass: "proprietary",
        requestId: "159df70e-3cc8-4cda-b1a7-cba3a7f26acc"
      })
      .expect(200);

    expect(response.body.extraction).toMatchObject({
      fileName: "controller-notes.txt",
      mediaType: "text/plain",
      method: "text",
      text
    });
  });

  it("retires ad hoc analysis in favor of bound stored-review approval", async () => {
    const { agent, csrfToken } = await signedInAgent("analysis@example.com");
    const response = await agent
      .post("/api/ai/review")
      .set("x-rulix-csrf", csrfToken)
      .send({ memo: reviewFixtures[0] })
      .expect(410);

    expect(response.body).toMatchObject({
      code: "client_upgrade_required"
    });
    expect(response.body.error).toContain("Ad-hoc AI review is retired");
  });

  it("does not accept client-supplied model requests on the retired ad hoc route", async () => {
    const { agent, csrfToken } = await signedInAgent("depth@example.com");
    const response = await agent
      .post("/api/ai/review")
      .set("x-rulix-csrf", csrfToken)
      .send({
        memo: reviewFixtures[0],
        depth: "deep",
        model: "claude-opus-4-8"
      })
      .expect(410);

    expect(response.body.code).toBe("client_upgrade_required");
    expect(response.body.error).not.toContain("claude-opus-4-8");
  });

  it("preserves server-side audit events after a revision is created", async () => {
    const { agent, csrfToken } = await signedInAgent("audit-merge@example.com");
    const created = await agent
      .post("/api/reviews")
      .set("x-rulix-csrf", csrfToken)
      .send(validReviewInput())
      .expect(201);
    const memoId = created.body.review.id;

    const editedMemoText = `${reviewFixtures[0].memoText}\n\nReviewer note: confirm model number before signoff.`;
    const editResponse = await agent
      .patch(`/api/reviews/${memoId}`)
      .set("x-rulix-csrf", csrfToken)
      .send({
        memoText: editedMemoText,
        ...reviewBindings(created.body.review)
      })
      .expect(200);

    expect(editResponse.body.review.memoText).toBe(editedMemoText);

    const stateResponse = await agent.get(`/api/reviews/${memoId}/audit?limit=50`).expect(200);
    expect(
      stateResponse.body.items.some((event: { action: string }) => event.action === "Memo edited")
    ).toBe(true);
  });

  it("records a reviewer decision under the signed-in account", async () => {
    const reviewer = await signedInAgent("decision@example.com");
    const created = await reviewer.agent
      .post("/api/reviews")
      .set("x-rulix-csrf", reviewer.csrfToken)
      .send(validReviewInput())
      .expect(201);
    const memo = created.body.review;
    const baseline = analyzeMemo(memo);
    await reviewer.store.setAnalysisResult(workspaceId(reviewer.user), memo, {
      ...baseline,
      provider: {
        ...baseline.provider,
        source: "bedrock" as const,
        label: "Amazon Bedrock",
        model: "test-live-model",
        live: true,
        message: "Live result for request-information coverage."
      }
    });

    const response = await reviewer.agent
      .post(`/api/reviews/${created.body.review.id}/decision`)
      .set("x-rulix-csrf", reviewer.csrfToken)
      .send({
        action: "request-info",
        notes: "Need vendor parameter mapping.",
        ...await decisionBindings(reviewer.store, reviewer.user, memo.id)
      })
      .expect(200);

    expect(response.body.review.status).toBe("needs-info");
    expect(response.body.decision.notes).toContain("vendor parameter");
    expect(response.body.decision.id).toMatch(
      /^decision-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(response.body.auditEvents).toHaveLength(1);
    expect(response.body.auditEvents[0]).toMatchObject({
      action: "Reviewer decision: request-info",
      memoId: memo.id,
      metadata: { decisionId: response.body.decision.id }
    });
  });

  it("derives signer identity on the server and invalidates approval after a memo edit", async () => {
    const reviewer = await signedInAgent("server-signer@example.com", "reviewer");
    const created = await reviewer.agent
      .post("/api/reviews")
      .set("x-rulix-csrf", reviewer.csrfToken)
      .send(validReviewInput())
      .expect(201);
    const memo = created.body.review;
    const accountId = workspaceId(reviewer.user);
    const baseline = analyzeMemo(memo);
    const result = {
      ...baseline,
      provider: {
        ...baseline.provider,
        source: "bedrock" as const,
        label: "Amazon Bedrock",
        model: "test-live-model",
        live: true,
        message: "Live provider result for signer-integrity coverage."
      },
      findings: baseline.findings.map((finding) => ({
        ...finding,
        status: "strong" as const,
        severity: "info" as const
      }))
    };
    await reviewer.store.setAnalysisResult(accountId, { ...memo, status: "ready" }, result);

    const accepted = await reviewer.agent
      .post(`/api/reviews/${memo.id}/decision`)
      .set("x-rulix-csrf", reviewer.csrfToken)
      .send({
        action: "accept",
        notes: "Evidence reviewed.",
        signedBy: "Mallory",
        signedAt: "1999-01-01T00:00:00.000Z",
        ...await decisionBindings(reviewer.store, reviewer.user, memo.id)
      })
      .expect(200);

    expect(accepted.body.decision.signedBy).toBe(reviewer.user.name);
    expect(accepted.body.decision.signerId).toBe(reviewer.user.id);
    expect(accepted.body.decision.signedAt).not.toBe("1999-01-01T00:00:00.000Z");
    expect(accepted.body.decision.memoHash).toEqual(expect.any(String));
    expect(accepted.body.decision.analysisHash).toEqual(expect.any(String));

    await reviewer.agent
      .patch(`/api/reviews/${memo.id}`)
      .set("x-rulix-csrf", reviewer.csrfToken)
      .send({
        memoText: `${memo.memoText}\n\nMaterial change after approval.`,
        ...reviewBindings(accepted.body.review)
      })
      .expect(200);

    const refreshed = await reviewer.agent.get(`/api/reviews/${memo.id}`).expect(200);
    expect(refreshed.body.decision).toBeUndefined();
    expect(refreshed.body.result).toBeUndefined();
    expect(refreshed.body.review.revision).toBe(2);
  });

  it("round-trips versioned Memo Builder sessions through the scoped store", async () => {
    const user = await signedInAgent("builder-persistence@example.com");
    const accountId = workspaceId(user.user);
    await user.store.upsertMemoBuilderSession(accountId, "builder-session-1", {
      expectedVersion: 0,
      session: {
        id: "builder-session-1",
        title: "Cryogenic controller memo",
        dataClass: "proprietary",
        updatedAt: "2026-07-13T12:00:00.000Z",
        pendingInput: "Preserve this draft",
        messages: [{ role: "user", content: "Help me build this memo" }]
      }
    });

    const restored = await user.store.listMemoBuilderSessions(accountId, { limit: 25 });
    expect(restored.items[0]?.session.id).toBe("builder-session-1");
    expect(restored.items[0]?.session.pendingInput).toBe("Preserve this draft");
  });

  it("isolates memo records between accounts", async () => {
    const userA = await signedInAgent("user-a@example.com");
    const userB = await signedInAgent("user-b@example.com");
    const created = await userA.agent
      .post("/api/reviews")
      .set("x-rulix-csrf", userA.csrfToken)
      .send(validReviewInput())
      .expect(201);

    await userA.agent.get(`/api/reviews/${created.body.review.id}`).expect(200);
    await userB.agent.get(`/api/reviews/${created.body.review.id}`).expect(404);
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

  it("routes metrics through the bounded store snapshot and rejects unsupported ranges", async () => {
    const admin = await signedInAgent("ops-bounded@example.com", "export-control-officer");
    const snapshot = await admin.store.getAdminMetrics(7);
    const bounded = vi.spyOn(admin.store, "getAdminMetrics").mockResolvedValue(snapshot);
    const legacyUsage = vi.spyOn(admin.store, "getUsage");
    const legacyUsers = vi.spyOn(admin.store, "listUsers");
    const legacySessions = vi.spyOn(admin.store, "listActiveSessions");

    const response = await admin.agent.get("/api/admin/metrics?rangeDays=7").expect(200);
    expect(response.body.metrics).toMatchObject({
      rangeDays: 7,
      availability: { status: "complete" }
    });
    expect(bounded).toHaveBeenCalledWith(7);
    expect(legacyUsage).not.toHaveBeenCalled();
    expect(legacyUsers).not.toHaveBeenCalled();
    expect(legacySessions).not.toHaveBeenCalled();

    await admin.agent.get("/api/admin/metrics?rangeDays=365").expect(400, {
      code: "invalid_metrics_range",
      error: "rangeDays must be one of 7, 30, or 90."
    });
    await admin.agent.get("/api/admin/metrics?rangeDays=7days").expect(400);
  });

  it("serves the imported lead sheet and records disabled lead searches", async () => {
    const admin = await signedInAgent("lead-admin@example.com", "export-control-officer");

    const workspace = (await admin.agent.get("/api/admin/outreach").expect(200)).body;
    expect(workspace.leads).toHaveLength(25);
    expect(workspace.pagination.leads).toMatchObject({ loadedCount: 25, hasMore: true });
    expect(workspace.leads[0]).toMatchObject({
      leadId: "RULIX-00001",
      email: "exportcontrol@brown.edu",
      priority: "A"
    });
    expect(workspace.bedrock.leadSearchModel).toContain("sonnet-4-6");
    expect(workspace.bedrock.personalizationModel).toContain("sonnet-4-6");
    await admin.agent
      .get(`/api/admin/outreach/pages/drafts?limit=25&cursor=${encodeURIComponent(workspace.pagination.leads.nextCursor)}`)
      .expect(400);
    await admin.agent
      .get(`/api/admin/outreach/pages/leads?limit=10&cursor=${encodeURIComponent(workspace.pagination.leads.nextCursor)}`)
      .expect(400);

    const allLeads = [...workspace.leads];
    let cursor = workspace.pagination.leads.nextCursor as string | undefined;
    while (cursor) {
      const page = (await admin.agent
        .get(`/api/admin/outreach/pages/leads?limit=25&cursor=${encodeURIComponent(cursor)}`)
        .expect(200)).body;
      allLeads.push(...page.items);
      cursor = page.nextCursor;
    }
    expect(allLeads).toHaveLength(154);
    expect(new Set(allLeads.map((lead: { leadId: string }) => lead.leadId))).toHaveLength(154);

    const search = await admin.agent
      .post("/api/admin/leads/search")
      .set("x-rulix-csrf", admin.csrfToken)
      .send({
        requestId: "2645bbc1-5f1e-4e5b-972b-749c31d4f63e",
        durationSeconds: 15
      })
      .expect(502);
    expect(search.body.run.status).toBe("failed");

    const refreshed = (await admin.agent.get("/api/admin/outreach").expect(200)).body;
    expect(refreshed.leadSearchRuns[0].status).toBe("failed");
  });

  it("requires a saved draft and an approved AI provider lane before personalization", async () => {
    const admin = await signedInAgent("personalize-admin@example.com", "export-control-officer");

    await admin.agent
      .post("/api/admin/outreach/drafts/RULIX-00001/personalize")
      .set("x-rulix-csrf", admin.csrfToken)
      .send({ requestId: "6f43a8d8-ef53-49d7-b36b-ec0b74a92e52" })
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
      .send({ requestId: "1580899d-e72b-416d-8f76-e5ee663c2d13" })
      .expect(502);
    expect(response.body.error).toContain("No approved AI provider lane is configured");

    await admin.agent
      .put("/api/admin/outreach/drafts/RULIX-00001")
      .set("x-rulix-csrf", admin.csrfToken)
      .send({ subject: "Valid", body: "x".repeat(48_001) })
      .expect(400);
    await admin.agent
      .put("/api/admin/outreach/drafts/RULIX-00001")
      .set("x-rulix-csrf", admin.csrfToken)
      .send({ subject: "Valid", body: "Valid", unexpected: true })
      .expect(400);
  });

  it("creates controllable background jobs and persists lead workflow decisions", async () => {
    const admin = await signedInAgent("workflow-admin@example.com", "export-control-officer");

    const leadPages = vi.spyOn(admin.store, "listOutreachLeadsPage");
    const draftPages = vi.spyOn(admin.store, "listOutreachDraftsPage");
    const boundedBatch = await admin.agent
      .post("/api/admin/outreach/jobs")
      .set("x-rulix-csrf", admin.csrfToken)
      .send({ type: "draft-missing", maxCostUsd: 10, maxRetries: 2 })
      .expect(202);
    expect(boundedBatch.body.job.itemIds).toHaveLength(154);
    expect(leadPages.mock.calls.length).toBeGreaterThan(3);
    expect(draftPages).toHaveBeenCalledTimes(1);

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

function validReviewInput() {
  return {
    requestId: randomUUID(),
    title: "RLX-200 controller review",
    itemFamily: "Cryogenic controller",
    manufacturer: "Rulix Test Instruments",
    intendedUse: "University research laboratory",
    dataClass: "proprietary",
    sourcePath: "self-classification",
    memoText: reviewFixtures[0].memoText,
    attachments: []
  };
}

function reviewBindings(memo: { version: number; revision: number; contentHash: string }) {
  return {
    expectedVersion: memo.version,
    expectedRevision: memo.revision,
    expectedHash: memo.contentHash
  };
}

function workspaceId(user: UserProfile) {
  return (user as UserProfile & { organizationId?: string }).organizationId ?? user.id;
}

async function decisionBindings(store: AccountStore, user: UserProfile, memoId: string) {
  const detail = await store.getReviewDetail(workspaceId(user), memoId);
  const memo = detail?.review;
  const analysis = detail?.result;
  if (!memo) {
    throw new Error(`Review ${memoId} was not found.`);
  }
  return {
    expectedVersion: memo.version,
    expectedRevision: memo.revision,
    expectedHash: memo.contentHash,
    expectedAnalysisId: analysis?.id,
    expectedAnalysisHash: analysis?.resultHash
  };
}
