# Security remediation and deployment runbook

This document records the repository changes made from the Codex Security scan of commit
`38af71ca662c502f3ff165d1a6a10ce8ebad1084`. The remediation branch is intentionally
deployment-ready, but repository completion and production rollout are separate facts:
Terraform and Lambda changes do not protect production until an authorized production
deployment applies them.

## Security invariants

Rulix now treats the following as non-negotiable invariants:

1. A browser-provided data label can raise the effective classification but can never lower
   the server-owned deployment floor.
2. Every model request passes through one egress gateway immediately before provider use.
   The gateway verifies the exact provider, region, data class, request budget, token budget,
   spend budget, and concurrency lease.
3. Invalid policy configuration fails closed before a provider client is called.
4. Review content, analysis, decisions, and audit history can change only through narrow
   server commands. The browser cannot replace the account-state document.
5. A memo edit, analysis result, or signoff is accepted only against the exact current memo
   revision and content hash. A new analysis invalidates an older decision.
6. Authentication mutations and account-state mutations use generation checks or versioned
   compare-and-swap writes. A losing concurrent operation retries against current state or
   fails with a conflict; it cannot resurrect revoked credentials or stale content.
7. Public HTTP retrieval connects only to a vetted, pinned public address, verifies the
   connected peer, repeats validation for every redirect, and shares hard DNS, response,
   size, and redirect budgets.
8. Audit records are appended through an isolated writer. Tenant, writer identity, writer
   type, and recorded time come from trusted runtime configuration, never caller input.
9. A job that can mint an AWS OIDC token does not check out or execute repository source.
   It verifies and deploys artifacts produced by a separate uncredentialed job.
10. Non-officer AI work requires an immutable request and officer decision over the exact
    server-derived subject, classification, context, policy, and canonical provider-body hash.
    One approval authorizes one fenced dispatch; drift, expiry, revocation, or consumption fails closed.
11. User-facing collection routes return bounded keyset pages. Deliberate bulk operations enumerate
    pages only behind explicit scan and item caps; they never truncate work silently or turn a capped
    read into a misleading total.

## Finding closure

| IDs | Repository remediation |
| --- | --- |
| D01-D07 | Server-owned classification floor, strict caller-label parsing, exact provider/client-region authorization, controlled-model allowlisting, cross-Region profile rejection, one sink-adjacent egress gateway, and an officer queue that binds the exact server-derived provider body to one revocable dispatch. The generic review-provider endpoint is retired. |
| D09 | Removed terminating WAF allow behavior; oversized non-exempt bodies are blocked; route/global WAF limits and atomic per-account AI request, concurrency, token, and spend admission are enforced. |
| D12-D15 | Password reset, login, session refresh/revocation, and lockout counters use generation-aware or conditional atomic state transitions with concurrency regression tests. |
| D17 | Decision authorization is action-specific; blocker policy is re-evaluated inside the authoritative state transition; memo revision, content hash, analysis ID, and result hash are bound atomically. |
| D21-D22 | Lead search and outreach evidence use the shared connection-bound public fetcher with complete special-use address rejection, DNS/peer pinning, HTTPS downgrade rejection, abort-aware address fallback, and bounded redirects/body/time. |
| D20 | DOCX is parsed as a bounded ZIP/OPC container. Entry count, compression ratio, expanded bytes, required parts, relationships, content types, duplicate names, encryption, signed/unsigned data descriptors (including overlap ranges), and path traversal are validated before provider use. Data-URL header length and parameter count are bounded before metadata splitting. |
| D37 | The analysis-worker policy is read-only for authoritative account state (`dynamodb:GetItem` only); evidence output remains scoped to its S3 prefix. |
| D38 | Audit append moved behind a private Lambda with conditional create-only writes, trusted provenance, tenant partition binding, and DynamoDB-scoped KMS decrypt conditions. |
| D39 | GitHub OIDC trust is bound to the exact repository, production environment, and main ref. Production build and credentialed deployment are separate jobs; actions are commit-pinned. |

## AI and document controls

The deployment classification is configured by `RULIX_AI_DATA_CLASS`. Requests may include a
recognized `dataClass`; Rulix uses the more restrictive value. Controlled content also
requires all of the following at dispatch time:

- `RULIX_CONTROLLED_DATA_MODE=approved`
- an exact `RULIX_APPROVED_PROVIDER`
- an exact `RULIX_APPROVED_REGION` matching the provider client's real region
- a valid, non-empty `RULIX_APPROVED_MODEL_IDS` JSON array containing the exact model

Cross-Region inference-profile IDs such as `global.anthropic.*` and
`us.anthropic.*` are rejected for controlled content even when listed, because
the Bedrock client Region is only the request's source Region. Controlled lanes
must use an explicitly allowlisted unprefixed regional model ID or a
region-bound Bedrock model ARN whose Region exactly matches
`RULIX_APPROVED_REGION`. Inference-profile ARNs are rejected because their
opaque target may itself be cross-Region.

Admission is shared across Lambda instances through DynamoDB. The Terraform variables are:

- `ai_max_concurrent`
- `ai_requests_per_minute`
- `ai_tokens_per_day`
- `ai_spend_usd_per_day`
- `ai_max_tokens_per_call`
- `ai_max_cost_usd_per_call`
- `ai_lease_seconds`

`RULIX_BEDROCK_PRICES` is parsed once when admission is constructed. Every overridden
model family must provide all four finite rates and every rate must be greater than zero;
malformed, partial, zero, or negative pricing fails startup/admission closed so a paid call
cannot bypass spend accounting.

Raw transport bytes, decoded document bytes, ZIP expansion, and provider context are separate
budgets. A valid near-limit PDF, DOCX, or image is not rejected merely because base64 transport
encoding is larger than its decoded content, while every request still remains inside the WAF,
Express, intake, and provider limits.

## Authoritative state and conflicts

`PUT /api/account/state` is retired. The frontend uses command endpoints for review creation,
memo edits, archive state, analysis, chat, and decisions. Only bounded, non-authoritative UI
preferences—selected review and Memo Builder sessions—may be persisted through the preferences
endpoint.

Commands return the server's authoritative record. A `409` means another operation won a
revision race; the client must reload current state and let the user reapply the change. It must
not silently overwrite the newer record. Review creation uses a persisted idempotency key so a
retry after a lost response returns the same review instead of creating a duplicate.

## Public HTTP boundary

The shared public fetcher rejects credentials, unapproved schemes or ports, private and
special-use IPv4/IPv6 destinations, unsafe redirects, content-type mismatches, oversized bodies,
DNS resolution that exceeds the hop deadline, and a connected peer outside the vetted address
set. These application controls complement—not replace—the infrastructure egress variables:

- `public_http_egress_cidr_blocks`
- `public_https_egress_cidr_blocks`
- `public_http_egress_ipv6_cidr_blocks`
- `public_https_egress_ipv6_cidr_blocks`

Keep those lists restricted to approved public proxy or egress ranges where the deployment
architecture supports it. An unrestricted internet range preserves application functionality
but does not provide a second network-layer SSRF barrier.

## Audit and IAM boundary

Normalized workspace mutations commit an immutable `AU` outbox item in the same DynamoDB
transaction as the business change. The audit Lambda consumes only stream `INSERT` records,
unmarshals and validates the complete `rulix.audit-outbox/v1` image, binds its partition to the
configured tenant and workspace account/user ID, and verifies the canonical
`SHA-256({ accountId, auditEvent })` payload hash before appending. It requires a stable
server-authenticated `actorId`, an independently recorded organization ID, plus allowlisted actor
type, source, outcome, subject type, and subject ID provenance. A display name is never promoted
to an actor identity. Tenant and writer
identity are always derived from the Lambda environment, never from stream or direct-invocation
payload fields.

The audit Lambda alone receives conditional DynamoDB append permission plus exact-key `GetItem`
permission to verify idempotent retry collisions. It reports per-record DynamoDB batch failures,
so successfully appended siblings checkpoint normally and invalid poison records follow the
event source mapping's bounded retry and DLQ policy. `AuditEvent.id` is the required idempotency
key: an identical at-least-once retry returns the original immutable row, while reuse with a
different canonical payload is rejected. There is no direct-invocation append interface or
invoke policy: the handler rejects non-stream payloads and requires every record's source ARN to
equal the configured workspace table stream ARN.

The analysis worker can read the authoritative account record but cannot `PutItem` or
`UpdateItem` it. The audit runtime's KMS permission is `kms:Decrypt` on the tenant key and is
conditioned on the DynamoDB regional service, caller account, table name, and subscriber ID
encryption context.

## Production deployment boundary

The production workflow has two jobs:

1. `build` checks out source without OIDC permission, installs locked dependencies, runs tests,
   builds both Lambda bundles, validates Terraform, creates checksummed ZIP files, and uploads a
   one-day artifact tied to the commit SHA.
2. `deploy` runs only for `refs/heads/main` in the protected `production` environment. It has
   `actions:read` and `id-token:write`, but no source checkout. It downloads the named artifact,
   verifies both SHA-256 checksums before obtaining credentials, updates the exact app and audit
   Lambda functions, waits for both updates, and runs health checks.

The IAM trust policy independently checks the OIDC audience, repository, environment, and ref.
The deploy policy names only the two production Lambda ARNs.

## Required rollout

1. Review every Terraform variable for the target tenant, especially AI classification/provider,
   admission budgets, exact non-wildcard `bedrock_resource_arns`, WAF rates, public egress ranges,
   domains, and auth TTLs.
2. Run `terraform plan` from `infra/terraform` with the production backend and approved values.
   Review all IAM, KMS, WAF, Lambda, environment-variable, and table changes before applying.
3. Apply Terraform with an authorized production identity. Confirm the deployed app and audit
   Lambda configurations match the planned code hashes and environment.
4. Deploy the application through the protected main-branch workflow. Do not upload a locally
   rebuilt ZIP under an already approved artifact name.
5. Commit one mutation that emits an `AU` item and confirm its stream record produces one audit
   row. Replay the same stream image and confirm the writer returns the original immutable row
   with `duplicate: true`. Reuse the same key with a changed payload and confirm the writer
   rejects it as an idempotency conflict. Inject a staging poison image with missing actor
   provenance and confirm partial-batch retries and eventual DLQ delivery without replaying a
   completed sibling. The writer role requires only exact-table `PutItem` plus `GetItem`; it has
   no update or delete permission. Verify cross-tenant, forged writer, and caller-supplied
   authoritative provenance are rejected.
6. Exercise allowed and denied public URLs, a redirect, an oversized response, controlled-data
   denial, per-account AI throttling, edit/analyze concurrency, and decision blocker handling in
   staging before production traffic.
7. Confirm CloudWatch alarms, WAF sampled requests, Lambda errors/throttles, DynamoDB conditional
   failures, and AI usage counters are visible to the operating team.
8. Exercise outreach pagination with more than one page of leads, drafts, workflows, runs, and jobs.
   Confirm cursors cannot be reused across accounts, collections, or page sizes, and confirm oversized
   bulk work is rejected with an explicit cap message instead of being partially queued.

## Verification commands

Run from the repository root:

```powershell
npm ci
npm run typecheck
npm test -- --run
npm run build
npm run build:lambda
npm audit --audit-level=moderate
git diff --check
```

Run the infrastructure checks with the pinned Terraform version used by CI:

```powershell
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform init -backend=false -input=false
terraform -chdir=infra/terraform validate
```

Also confirm all provider constructors and `messages.create` calls remain confined to
`server/aiEgressGateway.ts`, all workflow actions use 40-character commit SHAs, and the Lambda
archives contain the expected app/audit handlers without source maps, local state, or secrets.

The browser verification pass should cover the first-run workflow, persistent Help guide, exact
officer/reviewer approval copy, guide focus trap and Escape behavior, desktop and 390-pixel mobile
layouts, guide-to-Memo-Builder and guide-to-New-Review actions, horizontal overflow, and console
warnings/errors. Browser QA uses a throwaway local account and local store; it does not call a paid
provider.

## Validation boundary

Repository tests, builds, static sink checks, Terraform validation, and live GitHub repository
controls can be verified without an AWS production identity. A real encrypted-table audit append,
deployed WAF behavior, Lambda environment, IAM attachment, and live provider billing behavior
require authorized AWS/staging access. Do not describe those runtime controls as live until that
deployment verification is complete.
