# Regulatory analysis architecture

Rulix performs export-classification review through a durable, server-owned multi-agent workflow. Each analytical role is a separate model invocation with its own bounded context, schema, tools, status, usage, and audit record. The browser cannot choose prompts, tools, models, or ordering. The result remains an AI recommendation until an authorized human records a decision.

## Workflow

1. **Intake and evidence.** Reads the exact bound memo revision and attachment excerpts, treats document instructions as untrusted text, and produces a cited evidence ledger without selecting an ECCN.
2. **Jurisdiction.** Uses the evidence ledger and exact regulatory sources to assess EAR, ITAR/USML, other-agency, or insufficient-information paths.
3. **Candidate research.** Searches the corpus broadly and returns plausible candidates plus the factual questions needed to resolve them. EAR99 is never a retrieval fallback.
4. **Candidate analysis.** Runs one independent, bounded-concurrency invocation per candidate. Each agent receives only the evidence ledger, its candidate sources, and relevant order-of-review material.
5. **Adversarial challenge.** Attempts to disprove the leading analysis and find missed entries or controlling notes. A newly discovered candidate gets its own candidate-analysis invocation before another bounded challenge round.
6. **Citation verification.** Audits every proposed factual and regulatory claim against exact evidence and source records. Mechanical code verifies only stable IDs, hashes, locators, and exact bytes.
7. **Synthesis.** Runs only after every required predecessor succeeds and receives agent artifacts rather than a local baseline. It produces the recommendation or unresolved outcome, alternatives, disagreements, missing-information requests, confidence explanation, and AI-generated format checks.
8. **Report writing.** Reorganizes the completed structured result for export without adding new facts, candidates, legal reasoning, quotations, or citations.

The implemented call graph is:

```text
intake -> jurisdiction -> candidate research
       -> N candidate analyses (bounded concurrency)
       -> challenge -> [new candidate analyses -> challenge] (bounded loop)
       -> citation verification -> synthesis -> report writing -> publish
```

No completed analysis is published without successful challenge, citation-verification, synthesis, and report-writing invocations.

## Deterministic boundary

Deterministic code is limited to non-semantic infrastructure: authentication, authorization, provider and region policy, data-class enforcement, immutable approval bindings, hashing, idempotency, input/file validation, JSON-schema validation, source-ID and exact-excerpt checks, storage, audit logging, budgets, concurrency, timeouts, job transitions, rendering, and serialization.

Structural validation may reject an invalid agent output and request one AI repair attempt. It never rewrites, merges, caps, downgrades, upgrades, supplements, or replaces a substantive AI conclusion. Provider unavailability, a failed required role, failed repair, revoked approval, stale corpus, or exhausted challenge bound fails or blocks the workflow; none creates a local classification.

## Approval and egress

An officer approval binds the exact memo and document hashes, data class, corpus checksum, workflow version, provider and region, allowed models, call/token limits, expiry, and read-only tool set. The server converts that approval into a non-serializable trusted workflow grant. Every model call still passes through the AI egress gateway, which rechecks the immutable grant, current approval, lane, and remaining budgets before dispatch.

Uploaded content is always untrusted evidence. Agents have only tenant- and case-scoped read-only tools for corpus search/read, regulatory cross-references, case excerpts, evidence records, and prior workflow artifacts. Tools return stable IDs, exact text, locators, dates, and hashes; they do not decide legal relevance.

## Durability and audit

`AgentWorkflowRun` persists the bound memo revision/hash, corpus/checksum, data class, workflow/provider/model policy, status/stage, budgets, invocation records, artifact hashes, failure information, and final analysis ID. Each invocation records its role, prompt version, input/output artifact hashes, attempt, timestamps, latency, token usage, and error code.

Production execution uses an SQS worker with a dead-letter queue. Checkpoints are written after each artifact, retries resume from durable completed work, and a partial run is never stored as a completed classification. The reviewer UI polls the run and displays actual stages and invocation records.

## Corpus governance

`npm run download:corpus` retrieves primary eCFR, BIS, and DDTC material into immutable hash-named raw snapshots. `npm run build:corpus-index` builds the exact-text research index with source URLs, locators, snapshot/effective dates, hashes, approval status, and supersession metadata. Corpus records contain authoritative text and metadata, not hardcoded legal interpretations.

Automated refreshes may open a review change only. A qualified reviewer must approve a snapshot before promotion. Runtime analysis fails closed when the corpus is unavailable, hash-invalid, stale, pending review, point-in-time incompatible, or superseded.

## Known limitations

- The checked-in 2026-07-30 corpus snapshot is pending qualified regulatory review and is stale under the current seven-day runtime policy, so production analysis remains blocked until a reviewed current snapshot is promoted.
- No held-out adjudicated gold set is checked in, so no accuracy, calibration, or legal-reliability claim is made.
- OCR, complex tables, multilingual documents, and historical point-in-time coverage require further case-specific validation.
- Rulix does not provide legal advice, a BIS classification, CCATS, DDTC commodity-jurisdiction determination, license, or transaction authorization.
