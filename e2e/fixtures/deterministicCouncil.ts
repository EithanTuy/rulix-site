import type { AiProviderClient } from "../../server/aiEgressGateway";

const deterministicCouncilResult = {
  recommended: {
    eccn: "3A001.a.5",
    label: "Cryogenic equipment candidate",
    confidence: 0.91,
    risk: "medium",
    summary: "The synthetic memo contains relevant cryogenic performance evidence, but the reviewer should verify the cited technical threshold before relying on the recommendation.",
    sourceChunkIds: ["chunk-3a001-cryogenic"]
  },
  findings: [
    {
      id: "demo-cryogenic-threshold",
      status: "weak",
      title: "Verify the controlled cryogenic threshold",
      claim: "The synthetic controller is described as supporting a 1.2 K laboratory system.",
      rationale: "The final classification depends on matching the approved technical evidence to the cited Category 3 threshold.",
      excerpt: "Synthetic sample: base temperature 1.2 K; cooling capacity 20 mW.",
      sourceChunkIds: ["chunk-3a001-cryogenic"],
      agent: "evidence-mapper",
      severity: "review"
    }
  ],
  infoRequests: [
    "Confirm the final base temperature and cooling-capacity specifications against the approved manufacturer source."
  ]
};

export const deterministicCouncilClient: AiProviderClient = {
  messages: {
    create: async () => ({
      content: [{
        type: "tool_use",
        name: "record_eccn_review",
        input: deterministicCouncilResult
      }],
      usage: {
        input_tokens: 120,
        output_tokens: 64,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      }
    })
  }
};
