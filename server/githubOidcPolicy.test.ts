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

describe("production deployment identity", () => {
  it("requires the production environment token to originate from main", () => {
    expect(terraform).toMatch(iamStringEquals("sub", "repo:EithanTuy/rulix-site:environment:production"));
    expect(terraform).not.toContain('"repo:EithanTuy/rulix-site:ref:refs/heads/main"');
    expect(terraform).toMatch(iamStringEquals("ref", "refs/heads/main"));
    expect(terraform).toMatch(iamStringEquals("environment", "production"));
    expect(terraform).toMatch(iamStringEquals("repository", "EithanTuy/rulix-site"));
  });

  it("isolates OIDC to a minimal, main-only deployment job", () => {
    const jobsIndex = workflow.indexOf("jobs:");
    const deployIndex = workflow.indexOf("\n  deploy:");
    const buildJob = workflow.slice(jobsIndex, deployIndex);
    const deployJob = workflow.slice(deployIndex);

    expect(workflow.slice(0, jobsIndex)).not.toContain("id-token: write");
    expect(buildJob).not.toContain("id-token: write");
    expect(buildJob).not.toContain("configure-aws-credentials");
    expect(buildJob).toContain("npm test -- --run");
    expect(buildJob).toContain("npm run build:lambda");
    expect(buildJob).toContain("terraform validate");
    expect(buildJob).toContain("rulix-production-${{ github.sha }}");

    expect(deployJob).toContain("needs: build");
    expect(deployJob).toContain("if: github.ref == 'refs/heads/main'");
    expect(deployJob).toContain("environment: production");
    expect(deployJob).toContain("id-token: write");
    expect(deployJob).not.toContain("contents: read");
    expect(deployJob).toContain("actions/download-artifact@");
    expect(deployJob).toContain("sha256sum -c rulix-production.sha256");
    expect(deployJob).toContain("aws-actions/configure-aws-credentials@");
    expect(deployJob).not.toContain("actions/checkout@");
    expect(deployJob).not.toContain("actions/setup-node@");
    expect(deployJob).not.toMatch(/\bnpm\b/);
    expect(deployJob).not.toMatch(/\bterraform\b/);
    expect(deployJob.indexOf("sha256sum -c")).toBeLessThan(
      deployJob.indexOf("configure-aws-credentials@")
    );
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
