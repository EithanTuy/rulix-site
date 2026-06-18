import { writeFileSync } from "node:fs";
import { reviewFixtures } from "../src/test/reviewFixtures";
import { verifyCitations } from "../src/lib/eccnReview";
import { runCouncilAnalysis } from "./bedrockCouncil";

if (process.env.BEDROCK_ENABLED?.trim().toLowerCase() !== "true") {
  throw new Error("BEDROCK_ENABLED=true, AWS credentials, and AWS_REGION are required for the live Bedrock smoke test.");
}

const result = await runCouncilAnalysis(reviewFixtures[0], {
  depth: "standard",
  maxTokens: 1800
});

if (!result.provider.live || result.provider.source !== "bedrock") {
  throw new Error(`Expected a live Bedrock result, got ${result.provider.source}.`);
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
