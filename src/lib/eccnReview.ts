import { officialCorpus } from "../data/corpus";
import type {
  AgentRole,
  ClassificationCandidate,
  CouncilAgentRun,
  EvidenceFinding,
  FormatCheck,
  JurisdictionFinding,
  MemoRecord,
  ReviewResult
} from "../types";

export function detectFormatChecks(memoText: string): FormatCheck[] {
  const t = memoText;

  // At least one ECCN, EAR99, or ITAR/USML entry is explicitly named
  const hasEccns = /\bear99\b|eccn\s*[\dA-Z]|usml\s+category|itar\s+categor|\b\d[A-Z]\d{3}/i.test(t);

  // There is actual reasoning text — not just a conclusion sentence
  const hasAnalysis =
    t.trim().length > 150 &&
    /because|therefore|since|does not meet|is not subject|subject to|falls under|controlled under|not controlled|the item|this item/i.test(t);

  // Each ECCN/ITAR mentioned has some explanation attached to it
  const hasExplanationPerEntry =
    /not subject|subject to|does not meet|meets the criteria|falls (under|within)|controlled (under|by)|EAR99 because|because .{10,}/i.test(t);

  return [
    {
      key: "has-eccns-identified",
      label: "ECCNs/ITAR explicitly identified",
      pass: hasEccns,
      note: hasEccns ? undefined : "Name every ECCN and ITAR category considered."
    },
    {
      key: "has-analysis",
      label: "Analysis present (not just a conclusion)",
      pass: hasAnalysis,
      note: hasAnalysis ? undefined : "Include reasoning, not only a final determination."
    },
    {
      key: "has-explanation-per-entry",
      label: "Explanation given for each entry",
      pass: hasExplanationPerEntry,
      note: hasExplanationPerEntry ? undefined : "For each ECCN/ITAR considered, explain why the item is or is not subject."
    }
  ];
}

type RuleMatch = {
  pattern: RegExp;
  status: EvidenceFinding["status"];
  title: string;
  rationale: string;
  sourceChunkIds: string[];
  agent: AgentRole;
  severity: EvidenceFinding["severity"];
};

const rules: RuleMatch[] = [
  {
    pattern: /closed-cycle pulse tube refrigerator[\s\S]{0,180}?1\.2 K at the sample space/i,
    status: "strong",
    title: "Pulse tube + JT cooling to 1.2 K",
    rationale:
      "The memo ties the item to cryogenic equipment and provides a low-temperature performance claim that should be mapped to Category 3 review.",
    sourceChunkIds: ["chunk-3a001-cryogenic", "chunk-eccn-method"],
    agent: "evidence-mapper",
    severity: "info"
  },
  {
    pattern: /Cooling Capacity:\s*20 mW at 1\.2 K/i,
    status: "strong",
    title: "Cooling capacity stated at controlled temperature",
    rationale:
      "A concrete cooling-capacity value gives the reviewer a useful performance anchor instead of a bare item description.",
    sourceChunkIds: ["chunk-3a001-cryogenic"],
    agent: "evidence-mapper",
    severity: "info"
  },
  {
    pattern: /Operating Pressure:[^\n]+/i,
    status: "weak",
    title: "Pressure listed without enough control relevance",
    rationale:
      "The memo lists pressure values, but does not explain why pressure is or is not a controlled parameter for the proposed ECCN.",
    sourceChunkIds: ["chunk-eccn-method"],
    agent: "risk-reviewer",
    severity: "review"
  },
  {
    pattern: /not specifically designed[\s\S]{0,140}?fundamental research/i,
    status: "conflict",
    title: "Research use does not settle jurisdiction or classification",
    rationale:
      "A research-use statement can matter, but it does not by itself disprove USML/CCL applicability or replace technical parameter mapping.",
    sourceChunkIds: ["chunk-order-of-review", "chunk-usml-check", "chunk-source-classification"],
    agent: "jurisdiction-gate",
    severity: "escalate"
  },
  {
    pattern: /Hold Time:\s*>48 hours[^\n]*/i,
    status: "weak",
    title: "Hold time needs mapping to a control parameter",
    rationale:
      "The performance value may be relevant, but the memo should tie it to the proposed ECCN paragraph or explain why it is background only.",
    sourceChunkIds: ["chunk-3a001-cryogenic"],
    agent: "evidence-mapper",
    severity: "review"
  },
  {
    pattern: /Not for use in weapons, missile, or nuclear applications/i,
    status: "conflict",
    title: "End-use statement is not classification analysis",
    rationale:
      "End-use restrictions and transaction licensing are separate from ECCN classification. This sentence should not carry the ECCN conclusion.",
    sourceChunkIds: ["chunk-ear-subject", "chunk-source-classification"],
    agent: "risk-reviewer",
    severity: "escalate"
  },
  {
    pattern: /high-speed camera[\s\S]{0,180}?frames per second/i,
    status: "strong",
    title: "Camera frame-rate evidence",
    rationale:
      "The memo identifies imaging equipment and provides a frame-rate claim that belongs in Category 6 review.",
    sourceChunkIds: ["chunk-6a003-camera", "chunk-eccn-method"],
    agent: "evidence-mapper",
    severity: "info"
  },
  {
    pattern: /does not include spectral sensitivity[\s\S]{0,160}?operating temperature range/i,
    status: "missing",
    title: "Camera sensor parameters are explicitly missing",
    rationale:
      "The memo itself identifies omitted sensor parameters that are needed for Category 6 review.",
    sourceChunkIds: ["chunk-6a003-camera"],
    agent: "risk-reviewer",
    severity: "review"
  },
  {
    pattern: /ultrafast tunable laser[\s\S]{0,120}?femtosecond pulse duration/i,
    status: "strong",
    title: "Laser pulse-duration evidence",
    rationale:
      "The item description points to Category 6 laser review and includes a pulse-duration characteristic.",
    sourceChunkIds: ["chunk-6a005-laser", "chunk-eccn-method"],
    agent: "evidence-mapper",
    severity: "info"
  },
  {
    pattern: /omits pulse energy[\s\S]{0,180}?military end-use restrictions apply/i,
    status: "missing",
    title: "Laser performance parameters are explicitly missing",
    rationale:
      "The memo lists the exact laser-control parameters it lacks, so the EAR99 conclusion should stay blocked.",
    sourceChunkIds: ["chunk-6a005-laser", "chunk-eccn-method"],
    agent: "risk-reviewer",
    severity: "review"
  },
  {
    pattern: /EAR99 because it will be used in a university/i,
    status: "conflict",
    title: "EAR99 conclusion relies on use context",
    rationale:
      "Academic or university use does not replace CCL parameter review and does not by itself establish EAR99.",
    sourceChunkIds: ["chunk-ear-subject", "chunk-eccn-method"],
    agent: "risk-reviewer",
    severity: "escalate"
  },
  {
    pattern: /does not provide timing resolution[\s\S]{0,180}?separately provided/i,
    status: "missing",
    title: "Control electronics parameters are explicitly missing",
    rationale:
      "The memo identifies omitted electronics, software, and firmware evidence needed before an EAR99 conclusion can be trusted.",
    sourceChunkIds: ["chunk-eccn-method", "chunk-ear-subject", "chunk-itar-release"],
    agent: "risk-reviewer",
    severity: "review"
  },
  {
    pattern: /manufacturer classification review and internal CCL screening/i,
    status: "strong",
    title: "Source classification path documented",
    rationale:
      "The memo describes a valid classification path and records that CCL screening was performed.",
    sourceChunkIds: ["chunk-source-classification", "chunk-eccn-method"],
    agent: "citation-verifier",
    severity: "info"
  }
];

const missingChecks: Array<{
  id: string;
  title: string;
  claim: string;
  requiredWhen: RegExp;
  absent: RegExp;
  sourceChunkIds: string[];
}> = [
  {
    id: "dimensions-mass",
    title: "Missing technical parameter",
    claim: "Provide dimensions and mass for the item and major components.",
    requiredWhen: /cryogenic|cryostat|dewar|pulse tube|Joule-Thomson/i,
    absent: /dimension|mass|weight/i,
    sourceChunkIds: ["chunk-eccn-method", "chunk-3a001-cryogenic"]
  },
  {
    id: "special-design",
    title: "Missing specially-designed reasoning",
    claim:
      "Explain whether specially-designed analysis is needed and document why it applies or does not apply.",
    requiredWhen: /weapon|missile|defense|USML|specially designed/i,
    absent: /specially designed analysis|specially-designed analysis|catch and release/i,
    sourceChunkIds: ["chunk-order-of-review", "chunk-usml-check"]
  },
  {
    id: "camera-sensitivity",
    title: "Missing camera sensor parameters",
    claim:
      "Provide spectral sensitivity, ruggedization, radiation hardening, and full operating temperature range.",
    requiredWhen: /camera|imaging|CMOS|frames per second|fps/i,
    absent: /spectral sensitivity|radiation hardening|ruggedization/i,
    sourceChunkIds: ["chunk-6a003-camera"]
  },
  {
    id: "laser-pulse-energy",
    title: "Missing laser performance parameters",
    claim:
      "Provide pulse energy, repetition rate, wavelength/tuning range, beam quality, and average/peak power.",
    requiredWhen: /laser|femtosecond|wavelength|pulse duration|pulse energy/i,
    absent: /pulse energy|repetition rate|beam quality/i,
    sourceChunkIds: ["chunk-6a005-laser"]
  },
  {
    id: "firmware-software",
    title: "Missing software and technology split",
    claim:
      "State whether firmware, source code, software updates, or technical data are separately provided.",
    requiredWhen: /firmware|software|electronics|quantum control|control electronics|source code/i,
    absent: /technical data|source code|software updates|separately provided/i,
    sourceChunkIds: ["chunk-ear-subject", "chunk-itar-release"]
  }
];

export function analyzeMemo(memo: MemoRecord): ReviewResult {
  const text = memo.memoText;
  const findings: EvidenceFinding[] = [];
  const generatedAt = new Date().toISOString();

  rules.forEach((rule, index) => {
    const match = text.match(rule.pattern);
    if (!match || match.index === undefined) return;
    findings.push({
      id: `rule-${index}-${match.index}`,
      status: rule.status,
      title: rule.title,
      claim: match[0].replace(/\s+/g, " ").trim(),
      rationale: rule.rationale,
      excerpt: match[0],
      start: match.index,
      end: match.index + match[0].length,
      sourceChunkIds: rule.sourceChunkIds,
      agent: rule.agent,
      severity: rule.severity
    });
  });

  missingChecks.forEach((check) => {
    if (check.requiredWhen.test(text) && !check.absent.test(text)) {
      findings.push({
        id: `missing-${check.id}`,
        status: "missing",
        title: check.title,
        claim: check.claim,
        rationale:
          "The memo has enough context to trigger this check, but the required evidence was not found in the text.",
        sourceChunkIds: check.sourceChunkIds,
        agent: "risk-reviewer",
        severity: "review"
      });
    }
  });

  const recommended = classify(text);
  const jurisdiction = assessJurisdiction(text);
  const alternatives = buildAlternatives(text, recommended);
  const infoRequests = findings
    .filter((finding) => finding.status === "missing" || finding.status === "weak")
    .map((finding) => finding.claim);

  return {
    memoId: memo.id,
    generatedAt,
    corpusId: officialCorpus.id,
    modelPolicy:
      "Local deterministic council: classifier recommendation requires human export-control signoff.",
    provider: {
      source: "local-rules",
      label: "Local rules council",
      model: "local-rule-engine-v1",
      live: false,
      message: "Deterministic local analysis is being shown because live AI was not used for this result.",
      checkedAt: generatedAt
    },
    jurisdiction,
    recommended,
    alternatives,
    findings: findings.sort(sortFindings),
    infoRequests,
    agents: buildAgentRuns(findings, recommended),
    formatChecks: detectFormatChecks(text)
  };
}

function classify(text: string): ClassificationCandidate {
  if (/cryogenic|cryostat|pulse tube|Joule-Thomson|1\.2 K/i.test(text)) {
    return {
      eccn: "3A001.a.5",
      label: "Cryogenic or low-temperature electronics equipment candidate",
      confidence: 0.78,
      risk: hasEscalationTerms(text) ? "medium" : "low",
      summary:
        "The strongest evidence supports Category 3 review because the item is cryogenic equipment with stated low-temperature performance. More technical mapping is needed before signoff.",
      sourceChunkIds: ["chunk-3a001-cryogenic", "chunk-eccn-method"]
    };
  }

  if (/camera|imaging|frames per second|CMOS/i.test(text)) {
    return {
      eccn: "6A003 review",
      label: "High-speed camera or imaging equipment candidate",
      confidence: 0.66,
      risk: "medium",
      summary:
        "The item looks like Category 6 imaging equipment, but sensor and ruggedization details are incomplete.",
      sourceChunkIds: ["chunk-6a003-camera", "chunk-eccn-method"]
    };
  }

  if (/laser|femtosecond|wavelength|pulse energy|pulse duration|beam quality|repetition rate|ultrafast/i.test(text)) {
    return {
      eccn: "6A005 review",
      label: "Laser system candidate",
      confidence: 0.61,
      risk: "high",
      summary:
        "Laser controls may depend on omitted performance values; the EAR99 conclusion should not be accepted without parameter mapping.",
      sourceChunkIds: ["chunk-6a005-laser", "chunk-eccn-method"]
    };
  }

  if (/quantum|microwave|\bRF\b|waveform|qubit|firmware/i.test(text)) {
    return {
      eccn: "3A001/3D001 review",
      label: "Advanced electronics plus software/technology review",
      confidence: 0.54,
      risk: "medium",
      summary:
        "Control electronics may require Category 3 and software/technology review; the EAR99 conclusion is under-supported.",
      sourceChunkIds: ["chunk-eccn-method", "chunk-ear-subject"]
    };
  }

  return {
    eccn: "EAR99 candidate",
    label: "No specific CCL match found in seed corpus",
    confidence: /manufacturer classification|CCL screening/i.test(text) ? 0.74 : 0.45,
    risk: /manufacturer classification|CCL screening/i.test(text) ? "low" : "medium",
    summary:
      "The memo does not match the seed CCL category heuristics. A reviewer should confirm the full CCL screen before signoff.",
    sourceChunkIds: ["chunk-source-classification", "chunk-eccn-method", "chunk-ear-subject"]
  };
}

function assessJurisdiction(text: string): JurisdictionFinding {
  if (/weapon|missile|defense|military|USML|munitions|nuclear/i.test(text)) {
    return {
      outcome: "itar-risk",
      summary: "ITAR/USML risk needs reviewer attention",
      rationale:
        "The memo contains defense or restricted end-use language. Order-of-review requires resolving USML risk before relying on an EAR classification.",
      sourceChunkIds: ["chunk-order-of-review", "chunk-usml-check", "chunk-itar-release"]
    };
  }

  if (/laboratory|research|commercial|manufacturer|CCL|ECCN|EAR/i.test(text)) {
    return {
      outcome: "ear-likely",
      summary: "Appears to be within EAR review path",
      rationale:
        "The memo describes a civil/research item and includes EAR/ECCN classification language, while still requiring USML screening evidence.",
      sourceChunkIds: ["chunk-ear-subject", "chunk-order-of-review"]
    };
  }

  return {
    outcome: "insufficient-info",
    summary: "Jurisdiction cannot be established from this memo",
    rationale:
      "The memo lacks enough item origin, technical-data, and defense-article context to pick an EAR or ITAR path.",
    sourceChunkIds: ["chunk-ear-subject", "chunk-order-of-review", "chunk-usml-check"]
  };
}

function buildAlternatives(
  text: string,
  recommended: ClassificationCandidate
): ClassificationCandidate[] {
  const alternatives: ClassificationCandidate[] = [];

  if (recommended.eccn !== "EAR99 candidate") {
    alternatives.push({
      eccn: "EAR99 fallback",
      label: "Only if full CCL parameter review finds no controlling entry",
      confidence: 0.33,
      risk: "medium",
      summary:
        "EAR99 should remain a fallback rather than a conclusion until the reviewer documents the CCL screen.",
      sourceChunkIds: ["chunk-eccn-method", "chunk-source-classification"]
    });
  }

  if (/weapon|missile|military|defense|USML/i.test(text)) {
    alternatives.push({
      eccn: "Commodity Jurisdiction escalation",
      label: "Potential DDTC CJ or counsel review",
      confidence: 0.52,
      risk: "high",
      summary:
        "Defense-related wording means jurisdiction should be resolved before an EAR ECCN is relied on.",
      sourceChunkIds: ["chunk-order-of-review", "chunk-usml-check"]
    });
  }

  return alternatives;
}

function buildAgentRuns(
  findings: EvidenceFinding[],
  recommended: ClassificationCandidate
): CouncilAgentRun[] {
  const roles: Array<[AgentRole, string]> = [
    ["memo-parser", "Memo Parser"],
    ["jurisdiction-gate", "Jurisdiction Gate"],
    ["eccn-candidate", "ECCN Candidate"],
    ["evidence-mapper", "Evidence Mapper"],
    ["citation-verifier", "Citation Verifier"],
    ["risk-reviewer", "Risk Reviewer"],
    ["report-writer", "Report Writer"]
  ];

  return roles.map(([role, label]) => {
    const roleFindings = findings.filter((finding) => finding.agent === role);
    const blockers = roleFindings.filter(
      (finding) => finding.status === "missing" || finding.status === "conflict"
    );

    return {
      role,
      label,
      status: blockers.length > 0 ? "blocked" : "complete",
      summary:
        role === "eccn-candidate"
          ? `Selected ${recommended.eccn} with ${Math.round(
              recommended.confidence * 100
            )}% review confidence.`
          : blockers.length > 0
            ? `${blockers.length} issue${blockers.length === 1 ? "" : "s"} require reviewer attention.`
            : roleFindings.length > 0
              ? `${roleFindings.length} finding${roleFindings.length === 1 ? "" : "s"} mapped.`
              : "No blocking issue found."
    };
  });
}

function sortFindings(a: EvidenceFinding, b: EvidenceFinding) {
  const weight = { conflict: 0, missing: 1, weak: 2, strong: 3 };
  if (weight[a.status] !== weight[b.status]) return weight[a.status] - weight[b.status];
  return (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER);
}

function hasEscalationTerms(text: string) {
  return /weapon|missile|military|nuclear|specially designed|foreign national|classified/i.test(
    text
  );
}

export function verifyCitations(result: ReviewResult): string[] {
  const knownChunkIds = new Set(officialCorpus.chunks.map((chunk) => chunk.id));
  const citedIds = [
    ...result.jurisdiction.sourceChunkIds,
    ...result.recommended.sourceChunkIds,
    ...result.alternatives.flatMap((candidate) => candidate.sourceChunkIds),
    ...result.findings.flatMap((finding) => finding.sourceChunkIds)
  ];

  return citedIds.filter((id) => !knownChunkIds.has(id));
}
