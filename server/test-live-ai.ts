import { sampleMemos } from "../src/data/sampleMemos";
import { verifyCitations } from "../src/lib/eccnReview";
import { runCouncilAnalysis } from "./anthropicCouncil";

if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  throw new Error("ANTHROPIC_API_KEY is required for the live AI smoke test.");
}

const result = await runCouncilAnalysis(sampleMemos[0], {
  maxTokens: 1800
});

if (!result.provider.live || result.provider.source !== "anthropic") {
  throw new Error(`Expected a live Anthropic result, got ${result.provider.source}.`);
}

const invalidCitations = verifyCitations(result);
if (invalidCitations.length > 0) {
  throw new Error(`Live result returned invalid source chunk IDs: ${invalidCitations.join(", ")}`);
}

console.log(
  `Live AI council OK: ${result.provider.model} returned ${result.recommended.eccn} with ${result.findings.length} findings in ${result.provider.latencyMs ?? 0} ms.`
);
