# ECCN Review Report

Document: CX-1200 Cryostat Classification Memo
Code: PASTE-20260627
Corpus: Official Corpus v2026.06 (official-corpus-2026-06-seed)
Generated: 2026-06-27T21:21:34.352Z
Provider: Claude Haiku council via Bedrock (global.anthropic.claude-haiku-4-5-20251001-v1:0)
Depth: standard

## AI Classification Recommendation
3A001.a.5 - Cryogenic or low-temperature electronics equipment candidate
Confidence: 78%
Risk: medium

The memo provides strong technical evidence that the item is cryogenic equipment: a closed-cycle pulse tube refrigerator with integrated Joule-Thomson stage reaching 1.2 K, with stated cooling capacity (20 mW at 1.2 K) and long hold times (>48 hours). These facts directly trigger Category 3 (Electronics) and specifically paragraph 3A001.a.5 for cryogenic or superconductive equipment review. However, confidence is lowered from baseline to 78% because: (1) the memo lacks dimensions, mass, and component details needed for full parameter mapping; (2) the memo does not explain pressure thresholds or their relevance to control; (3) software/firmware disclosures are absent; (4) 'specially designed' analysis is not documented; and (5) the EAR99 proposal rests on use context ('university research lab') rather than CCL parameter screening. The recommendation assumes USML non-applicability is resol

## Jurisdiction Gate
ITAR/USML risk requires resolver before classification reliance. Memo does not explicitly address USML or order-of-review compliance.
The deterministic baseline and corpus guidance (chunk-order-of-review, chunk-usml-check) establish that order-of-review requires resolving USML applicability before relying on an EAR classification. The memo contains no explicit USML waiver, exclusion statement, or DDTC commodity jurisdiction confirmation. The phrase 'not for use in weapons, missile, or nuclear applications' is a disclaimer rather than a jurisdictional analysis. The item is cryogenic equipment capable of low-temperature research, and cryogenic systems are often dual-use. A qualified reviewer must confirm USML non-applicability or route to DDTC counsel before this classification can proceed.

## Evidence Findings
- [CONFLICT] Research use does not settle jurisdiction or classification: A research-use statement can matter, but it does not by itself disprove USML/CCL applicability or replace technical parameter mapping.
- [CONFLICT] EAR99 conclusion relies on use context: Academic or university use does not replace CCL parameter review and does not by itself establish EAR99.
- [MISSING] Missing technical parameter: The memo has enough context to trigger this check, but the required evidence was not found in the text.
- [MISSING] Missing specially-designed reasoning: The memo has enough context to trigger this check, but the required evidence was not found in the text.
- [MISSING] Missing software and technology split: The memo has enough context to trigger this check, but the required evidence was not found in the text.
- [WEAK] Hold time needs mapping to a control parameter: The performance value may be relevant, but the memo should tie it to the proposed ECCN paragraph or explain why it is background only.
- [WEAK] Pressure listed without enough control relevance: The memo lists pressure values, but does not explain why pressure is or is not a controlled parameter for the proposed ECCN.
- [STRONG] Pulse tube + JT cooling to 1.2 K: The memo ties the item to cryogenic equipment and provides a low-temperature performance claim that should be mapped to Category 3 review.
- [STRONG] Cooling capacity stated at controlled temperature: A concrete cooling-capacity value gives the reviewer a useful performance anchor instead of a bare item description.

## Requested Information
- Provide dimensions and mass for the item and major components.
- Explain whether specially-designed analysis is needed and document why it applies or does not apply.
- State whether firmware, source code, software updates, or technical data are separately provided.
- Hold Time: >48 hours between maintenance cycles
- Operating Pressure: 16 bar helium charge, 2.5 bar low side

## AI Council
- Memo Parser: complete - No blocking issue found.
- Jurisdiction Gate: blocked - 1 issue require reviewer attention.
- ECCN Candidate: complete - Selected 3A001.a.5 with 78% review confidence.
- Evidence Mapper: complete - 3 findings mapped.
- Citation Verifier: complete - No blocking issue found.
- Risk Reviewer: blocked - 4 issues require reviewer attention.
- Report Writer: complete - No blocking issue found.

## Human Review
Action: request-info
Notes: Request threshold mapping, end-use support, and manufacturer classification evidence before final signoff.
Signed By: pending
Signed At: pending

## Audit Trail
- 2026-06-27T21:21:41.841Z | Codex | Reviewer decision: request-info: Request threshold mapping, end-use support, and manufacturer classification evidence before final signoff.
- 2026-06-27T21:21:34.470Z | Codex | Analysis completed: Live Claude Haiku council via Bedrock analysis completed as a standard full-council pass; citation IDs and memo highlights were validated by the backend.
- 2026-06-27T21:20:51.457Z | Codex | Memo pasted: Pasted memo text. Analysis has not been run yet.

## Citations
- 15 CFR Part 774 Supp. No. 4: Order of Review (https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-774/appendix-Supplement%20No.%204%20to%20Part%20774)
- 22 CFR Part 121: USML review (https://www.ecfr.gov/current/title-22/chapter-I/subchapter-M/part-121)
- 22 CFR Part 120: ITAR definitions and release risk (https://www.ecfr.gov/current/title-22/chapter-I/subchapter-M/part-120)
- ECCN 3A001.a.5 seed chunk: Category 3 - Electronics candidate control (https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-774/appendix-Supplement%20No.%204%20to%20Part%20774)
- ITA ECCN guidance: ECCN determination guidance (https://www.trade.gov/how-do-i-determine-my-export-control-classification-number-eccn)
- BIS Classify Your Item: Classification paths (https://www.bis.gov/licensing/classify-your-item)
- 15 CFR 734.3: Items subject to the EAR (https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-734/section-734.3)

This output is an AI-generated classification recommendation package. It is not legal advice, is not a BIS/DDTC/CCATS/CJ determination, and requires qualified human export-control signoff before reliance.