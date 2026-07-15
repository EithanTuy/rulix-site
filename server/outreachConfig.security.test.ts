// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { resolveModel } from "./aiClient";
import { resolveConfiguredAiLane } from "./aiEgressGateway";
import { LocalAccountStore } from "./store";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.RULIX_APPROVED_PROVIDER = "anthropic-direct";
  process.env.RULIX_APPROVED_REGION = "global";
  process.env.ANTHROPIC_API_KEY = "deployment-only-secret";
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("deployment-managed outreach credentials", () => {
  it("never accepts or returns credential material through the admin API", async () => {
    const store = new LocalAccountStore({ persist: false });
    const agent = request.agent(createApp({ store }));
    const invite = await store.createInvite({
      email: "provider-admin@example.com",
      role: "export-control-officer"
    });
    const accepted = await agent
      .post("/api/auth/invite/accept")
      .send({ token: invite.rawToken, password: "Correct-Horse-2026" })
      .expect(201);

    const get = await agent.get("/api/admin/outreach-config").expect(200);
    expect(get.body).toEqual({
      provider: "anthropic",
      deploymentProvider: "anthropic",
      credentialConfigured: true,
      ready: true
    });
    expect(JSON.stringify(get.body)).not.toMatch(/secret|keymasked|apikey/i);

    await agent
      .put("/api/admin/outreach-config")
      .set("x-rulix-csrf", accepted.body.csrfToken)
      .send({ provider: "anthropic", anthropicApiKey: "must-not-enter-the-app" })
      .expect(400);
    await agent
      .put("/api/admin/outreach-config")
      .set("x-rulix-csrf", accepted.body.csrfToken)
      .send({ provider: "bedrock" })
      .expect(409);

    delete process.env.ANTHROPIC_API_KEY;
    await agent
      .put("/api/admin/outreach-config")
      .set("x-rulix-csrf", accepted.body.csrfToken)
      .send({ provider: "anthropic" })
      .expect(503);
  });

  it("scrubs legacy plaintext keys from local persistence on read and write", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "rulix-config-scrub-"));
    const filePath = path.join(directory, "store.json");
    try {
      writeFileSync(filePath, JSON.stringify({
        users: [],
        sessions: [],
        invites: [],
        resets: [],
        accounts: {},
        usage: [],
        outreachConfig: { provider: "anthropic", anthropicApiKey: "legacy-plaintext" }
      }));
      const store = new LocalAccountStore({ filePath, persist: true });
      expect(await store.getOutreachConfig()).toEqual({ provider: "anthropic" });
      expect(readFileSync(filePath, "utf8")).not.toContain("legacy-plaintext");

      await store.setOutreachConfig({
        provider: "bedrock",
        anthropicApiKey: "runtime-extra"
      } as never);
      expect(await store.getOutreachConfig()).toEqual({ provider: "bedrock" });
      expect(readFileSync(filePath, "utf8")).not.toContain("runtime-extra");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses only the deployment environment and normalizes every supported Bedrock prefix", () => {
    expect(resolveConfiguredAiLane(
      { provider: "anthropic" },
      { anthropicModel: "claude-sonnet-4-6", bedrockModel: "ignored" }
    )).toMatchObject({ provider: "anthropic-direct", region: "global" });
    delete process.env.ANTHROPIC_API_KEY;
    expect(resolveConfiguredAiLane(
      { provider: "anthropic" },
      { anthropicModel: "claude-sonnet-4-6", bedrockModel: "ignored" }
    )).toBeUndefined();

    for (const prefix of ["global", "us", "eu", "apac", "jp"]) {
      expect(resolveModel(`${prefix}.anthropic.claude-sonnet-4-6-v1:0`, { provider: "anthropic" }))
        .toBe("claude-sonnet-4-6");
    }
  });
});
