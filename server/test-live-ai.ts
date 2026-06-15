import { writeFileSync } from "node:fs";
import { reviewFixtures } from "../src/test/reviewFixtures";
import { verifyCitations } from "../src/lib/eccnReview";
import { runCouncilAnalysis } from "./anthropicCouncil";

if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  throw new Error("ANTHROPIC_API_KEY is required for the live AI smoke test.");
}

const result = await runCouncilAnalysis(reviewFixtures[0], {
  depth: "standard",
  maxTokens: 1800
});

if (!result.provider.live || result.provider.source !== "anthropic") {
  throw new Error(`Expected a live Anthropic result, got ${result.provider.source}.`);
}

const invalidCitations = verifyCitations(result);
if (invalidCitations.length > 0) {
  throw new Error(`Live result returned invalid source chunk IDs: ${invalidCitations.join(", ")}`);
}

const expectedRoles = [
  "memo-parser",
  "jurisdiction-gate",
  "eccn-candidate",
  "evidence-mapper",
  "citation-verifier",
  "risk-reviewer",
  "report-writer"
];
const returnedRoles = result.agents.map((agent) => agent.role).sort();
if (JSON.stringify(returnedRoles) !== JSON.stringify([...expectedRoles].sort())) {
  throw new Error(`Live result did not return the full AI council: ${returnedRoles.join(", ")}`);
}

if (process.env.RULIX_LIVE_SUCCESS_MARKER) {
  writeFileSync(process.env.RULIX_LIVE_SUCCESS_MARKER, "ok");
}

console.log(
  `Live AI council OK: ${result.provider.model} returned ${result.recommended.eccn} with ${result.findings.length} findings and ${result.agents.length} agents in ${result.provider.latencyMs ?? 0} ms.`
);

await new Promise((resolve) => setTimeout(resolve, 500));
