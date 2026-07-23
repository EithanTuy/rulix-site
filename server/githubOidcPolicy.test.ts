// @vitest-environment node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const terraform = readFileSync(
  fileURLToPath(new URL("../infra/terraform/github_actions.tf", import.meta.url)),
  "utf8"
);
const workflow = readFileSync(
  fileURLToPath(new URL("../.github/workflows/deploy.yml", import.meta.url)),
  "utf8"
);
const ciWorkflow = readFileSync(
  fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)),
  "utf8"
);

describe("repository deployment boundary", () => {
  it("assigns app and dashboard deployment identity to Daculguy/Rulix", () => {
    expect(terraform).toMatch(iamStringEquals("sub", "repo:Daculguy/Rulix:environment:production"));
    expect(terraform).not.toContain('"repo:Daculguy/Rulix:ref:refs/heads/main"');
    expect(terraform).toMatch(iamStringEquals("ref", "refs/heads/main"));
    expect(terraform).toMatch(iamStringEquals("environment", "production"));
    expect(terraform).toMatch(iamStringEquals("repository", "Daculguy/Rulix"));
    expect(terraform).not.toContain("EithanTuy/rulix-site");
  });

  it("keeps the marketing workflow unable to deploy app or dashboard infrastructure", () => {
    expect(workflow).toContain("Verify marketing production");
    expect(workflow).toContain("npm test -- --run");
    expect(workflow).toContain("npm run build");
    expect(workflow).not.toContain("id-token: write");
    expect(workflow).not.toContain("configure-aws-credentials");
    expect(workflow).not.toContain("npm run build:lambda");
    expect(workflow).not.toContain("terraform validate");
    expect(workflow).not.toContain("rulix-prod-app");
    expect(workflow).not.toContain("dashboard.rulix.cloud");
  });

  it("pins every third-party workflow action to an immutable commit", () => {
    for (const source of [workflow, ciWorkflow]) {
      const actions = [...source.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(action).toMatch(/^[^@\s]+@[a-f0-9]{40}$/);
      }
    }
  });
});

function iamStringEquals(claim: string, value: string) {
  return new RegExp(
    `condition\\s*{\\s*test\\s*=\\s*"StringEquals"\\s*variable\\s*=\\s*"token\\.actions\\.githubusercontent\\.com:${claim}"\\s*values\\s*=\\s*\\["${value.replace("/", "\\/")}\"\\]\\s*}`,
    "m"
  );
}
