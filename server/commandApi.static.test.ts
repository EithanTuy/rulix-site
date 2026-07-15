// @vitest-environment node

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const app = source("server/app.ts");
const outreachJobs = source("server/outreachJobs.ts");
const apiClient = source("src/lib/apiClient.ts");
const frontend = source("src/App.tsx");
const openapi = source("api/openapi.yaml");

describe("command API static boundaries", () => {
  it("keeps browser code off the retired bulk account-state transport", () => {
    for (const browserSource of [apiClient, frontend]) {
      expect(browserSource).not.toContain("/api/account/state");
      expect(browserSource).not.toMatch(/\b(?:load|save)AccountState\b/);
      expect(browserSource).not.toMatch(/\b(?:get|replace)AccountState\b/);
    }
    expect(app).toContain('app.get("/api/account/state"');
    expect(app).toContain('app.put("/api/account/state"');
    expect(app.match(/client_upgrade_required/g)).toHaveLength(3);
  });

  it("keeps one-time auth secrets out of request URLs", () => {
    expect(apiClient).toContain('"/api/auth/invite/inspect"');
    expect(apiClient).toContain('"/api/auth/password-reset/inspect"');
    expect(apiClient).not.toMatch(/`\/api\/auth\/(?:invites|password-reset)\/\$\{/);
    expect(app).not.toContain('app.get("/api/auth/invites/:token"');
    expect(app).not.toContain('app.get("/api/auth/password-reset/:token"');
    expect(openapi).not.toContain("/auth/invites/{token}:");
    expect(openapi).not.toContain("/auth/password-reset/{token}:");
  });

  it("forbids legacy whole-state and unbound review mutations in production routes and jobs", () => {
    const forbidden = [
      /\.getAccountState\s*\(/,
      /\.replaceAccountState\s*\(/,
      /\.upsertReview\s*\(/,
      /\.updateReview\s*\(/,
      /\.appendAuditEvent\s*\(/,
      /\.appendChatMessages\s*\(/
    ];
    for (const productionSource of [app, outreachJobs]) {
      for (const pattern of forbidden) expect(productionSource).not.toMatch(pattern);
    }
    expect(outreachJobs).toContain("store.listOutreachLeadsPage(");
    expect(outreachJobs).toContain("store.getOutreachLead(");
    expect(outreachJobs).not.toContain("store.listOutreachLeads(");
    expect(outreachJobs).not.toContain("store.listLeadWorkflows(");
    expect(outreachJobs).toContain("store.getOutreachDraft(");
    expect(outreachJobs).toContain("store.upsertOutreachJob(");
  });

  it("documents only scoped pages, details, and commands", () => {
    expect(openapi).not.toContain("/account/state:");
    expect(openapi).not.toContain("AccountReviewState:");
    expect(openapi).not.toContain("getAccountState");
    expect(openapi).not.toContain("saveAccountState");
    expect(openapi).toContain("/reviews/{reviewId}/audit:");
    expect(openapi).toContain("/reviews/{reviewId}/chat/{messageId}/apply:");
    expect(openapi).toContain("requestId:");
    expect(openapi).toContain("ExpectedReviewBindings:");
  });

  it("parses the OpenAPI contract and preserves security-critical schema boundaries", () => {
    const document = parse(openapi) as {
      components?: { schemas?: Record<string, {
        additionalProperties?: boolean;
        required?: string[];
        properties?: Record<string, unknown>;
      }> };
    };
    const schemas = document.components?.schemas;
    const decision = schemas?.ReviewerDecision;
    const requiredDecisionProperties = [
      "id",
      "action",
      "notes",
      "signerId",
      "signedBy",
      "signedAt",
      "createdAt",
      "memoRevision",
      "memoHash",
      "analysisId",
      "analysisHash"
    ];

    expect(decision?.required).toEqual(requiredDecisionProperties);
    expect(Object.keys(decision?.properties ?? {}).sort())
      .toEqual([...requiredDecisionProperties].sort());

    const providerConfig = schemas?.OutreachProviderConfig;
    expect(providerConfig?.additionalProperties).toBe(false);
    expect(providerConfig?.required).toEqual([
      "provider",
      "deploymentProvider",
      "credentialConfigured",
      "ready"
    ]);
    expect(Object.keys(providerConfig?.properties ?? {}).sort()).toEqual([
      "credentialConfigured",
      "deploymentProvider",
      "provider",
      "ready"
    ]);
  });

  it("does not build production identifiers from Math.random", () => {
    const suspicious: string[] = [];
    for (const file of productionTypeScriptFiles()) {
      const contents = readFileSync(file, "utf8");
      if (/(?:\bid\b|\b[A-Za-z]+Id\b)[^\n]{0,160}Math\.random|Math\.random[^\n]{0,160}(?:\bid\b|\b[A-Za-z]+Id\b)/i.test(contents)) {
        suspicious.push(path.relative(root, file));
      }
      expect(contents).not.toContain("Math.random().toString");
    }
    expect(suspicious).toEqual([]);
  });
});

function source(relativePath: string) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function productionTypeScriptFiles() {
  return ["server", "src"].flatMap((directory) => walk(path.join(root, directory)))
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .filter((file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))
    .filter((file) => !/[\\/]test-live-[^\\/]+\.ts$/.test(file));
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const file = path.join(directory, entry);
    return statSync(file).isDirectory() ? walk(file) : [file];
  });
}
