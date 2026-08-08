# Rulix ECCN - Architecture and operations

Rulix reviews export-classification memos against a versioned exact-text regulatory corpus. It produces an AI recommendation and evidence record; an authorized human remains the decision maker. The product is not legal advice and does not replace BIS, DDTC, counsel, or qualified export-control personnel.

## Application shape

The React/Vite single-page app and Express API are served from one origin. The browser handles intake, progress display, review, collaboration, and signoff controls. Server routes own authentication, CSRF, account isolation, approval requests, workflow creation, polling/cancellation, decisions, reports, and administrative operations.

The browser never chooses regulatory prompts, models, tools, budgets, or agent order. Starting analysis returns a durable run ID. The UI polls the bound run and renders the current stage, real invocation statuses, evidence, candidates, challenges, citation audit, missing information, and final recommendation.

## Regulatory analysis

Regulatory analysis is a fail-closed, server-owned multi-agent workflow:

```text
intake -> jurisdiction -> candidate research
       -> N candidate analyses (bounded concurrency)
       -> challenge -> [new candidate analyses -> challenge] (bounded loop)
       -> citation verification -> synthesis -> report writing -> publish
```

Each role is a separate Bedrock model invocation with a role-specific prompt, bounded input artifacts, output schema, read-only tool allowlist, status, usage, and audit record. Candidate analyses are isolated from one another. Challenger-discovered candidates receive their own analysis before synthesis. Synthesis receives completed agent artifacts and never a local semantic baseline.

Runtime code does not use regexes, keyword mappings, confidence caps, local classifications, or semantic merge logic to affect jurisdiction, candidate selection, EAR99, evidence interpretation, missing facts, risk, confidence, format checks, alternatives, or recommendation language. Deterministic code is limited to security and non-semantic infrastructure such as hashes, immutable bindings, schema validation, exact source/excerpt checks, budgets, storage, and state transitions. Invalid output receives one bounded AI repair call; failed repair or any failed required role prevents publication.

See `docs/regulatory-analysis-architecture.md` for the role contracts, corpus boundary, and failure model.

## Approval, egress, and human authority

An officer approval binds the exact memo/document hashes, data class, corpus checksum, workflow version, provider/region/model lane, tool set, budgets, and expiry. A server-issued non-serializable workflow grant authorizes only the approved internal calls. Every call passes through the AI egress gateway immediately before provider dispatch; stale, revoked, expired, consumed, or drifted approval blocks remaining work.

The final analysis remains a recommendation. Acceptance or override requires an authorized human action bound to the exact analysis revision. Reanalysis invalidates the prior decision. Audit history preserves approvals, agent artifacts and usage, analysis revisions, and human decisions.

## Data and isolation

Invite-only sessions use secure cookies and CSRF protection. Production stores auth, account state, workflow records, and artifacts in scoped DynamoDB/S3 resources with KMS encryption. Tools can read only the active tenant, case, approved corpus snapshot, and prior artifacts from the same workflow. Uploaded text is untrusted evidence and cannot grant instructions or access secrets, unrelated tenant data, internal prompts, or write-capable tools.

The corpus stores exact authoritative text and metadata: entry paragraphs, notes, definitions, order-of-review material, ITAR/USML text, source URL, locator, dates, hash, approval status, and supersession. Automated refreshes do not auto-approve or activate legal sources.

## AWS deployment

Production uses CloudFront in front of the application Lambda and one SQS-backed analysis-worker Lambda:

```text
browser -> CloudFront -> application Lambda -> SQS analysis queue
                                             -> analysis-worker Lambda
                                                -> Bedrock + scoped stores
browser <- poll run state <- application Lambda <- DynamoDB/S3 checkpoints
```

The queue processes one durable run per message, has bounded retries, and redrives exhausted jobs to a DLQ with a CloudWatch alarm. The worker checkpoints every completed artifact. Safe retries resume from valid checkpoints; partial work is never stored as a completed classification. Local development can execute the same orchestrator in process while preserving the same state contract.

The application and worker use deployment-owned Bedrock/data-class policy and scoped IAM. CloudFront supplies the origin secret for the public app Lambda URL. Terraform under `infra/terraform/` provisions hosting, queue/DLQ, worker, alarms, KMS, DynamoDB, S3, logs, and least-privilege policies.

## Build and verification

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run build:lambda
npm run test:bundle
npm run test:regulatory
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform validate
```

`npm run build:lambda` produces the application and analysis-worker bundles. Deployment is repository-scoped through GitHub OIDC; credentials and Terraform state are not committed.

## Operational limitations

Analysis is unavailable when the provider lane is disabled, approval is not current, or the corpus is unavailable, unapproved, hash-invalid, stale, or superseded. The checked-in 2026-07-30 snapshot is pending qualified review and stale under the configured seven-day policy, so it must not be promoted or used consequentially until a qualified reviewer approves a current snapshot.
