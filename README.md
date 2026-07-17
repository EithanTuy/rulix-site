# Rulix ECCN

Rulix ECCN is a Phase 2 MVP for reviewing ECCN classification memos against a versioned official-source corpus. It ingests memo text, runs a backend AI council through Amazon Bedrock when `BEDROCK_ENABLED=true`, fails closed without recording a result when live AI is unavailable, highlights memo evidence, maps findings to citations, and requires human export-control signoff before any result is treated as final. Deterministic rules remain an internal validation baseline for live results, not a reviewer-visible substitute for the provider.

## Run

```bash
npm install
npm run dev
```

`npm run dev` starts both required processes: the Vite app at
`http://127.0.0.1:5173` and the API at `http://127.0.0.1:8787`. Vite proxies
`/api` to the backend. Use `npm run dev:client` or `npm run dev:server` only
when you intentionally want to run one side by itself.

For a production-style local run, `npm start` builds the client and serves the
complete app from `http://127.0.0.1:8787`.

GitHub Actions runs tests and the production build for pull requests and main.
Pushes to `main` deploy through the repository-scoped AWS OIDC role provisioned
in `infra/terraform/github_actions.tf`; no long-lived AWS secret is stored in GitHub.

Auth is invite-only. In local development the server falls back to a git-ignored JSON store unless `RULIX_AUTH_TABLE` and `RULIX_ACCOUNT_TABLE` point at DynamoDB tables. A first operator can create an invite through the bootstrap endpoint when `AUTH_BOOTSTRAP_SECRET` is set, or through the Users console after signing in as an export-control officer.

Enable live Bedrock calls only from your local shell or deployment environment. The Bedrock SDK uses the AWS default credential chain, so keep credentials in an AWS profile, IAM role, or temporary environment variables:

```bash
BEDROCK_ENABLED=true AWS_PROFILE=rulix-bedrock AWS_REGION=us-east-1 npm run dev:server
```

Optional model override:

```bash
BEDROCK_MODEL=global.anthropic.claude-haiku-4-5-20251001-v1:0
```

Deep council reviews use Claude Sonnet 4.6 by default. Override that server-side
with `BEDROCK_DEEP_MODEL`; standard reviews, memo chat, and drafting remain on
`BEDROCK_MODEL`.

AI egress is bound to a deployment-owned classification, provider, and region;
request bodies cannot lower that policy. The default lane is Amazon Bedrock in
`AWS_REGION`/`AWS_DEFAULT_REGION`, and the default sensitivity floor is
`proprietary`:

```bash
RULIX_AI_DATA_CLASS=proprietary
RULIX_APPROVED_PROVIDER=amazon-bedrock
RULIX_APPROVED_REGION=us-east-1
# Required only when controlled-data mode is enabled:
RULIX_APPROVED_MODEL_IDS='["anthropic.claude-sonnet-4-6"]'
```

`RULIX_AI_DATA_CLASS` accepts `public`, `proprietary`, `export-controlled`,
`itar-risk`, or `cui`. `RULIX_APPROVED_PROVIDER` accepts `amazon-bedrock` or
`anthropic-direct`; direct Anthropic uses region identity `global` and still
requires an explicitly approved lane. Controlled classes are disabled unless
all approval values are explicit, the provider is regional Bedrock, the exact
model ID or ARN appears in `RULIX_APPROVED_MODEL_IDS`, and
`RULIX_CONTROLLED_DATA_MODE=approved`. Cross-Region inference-profile IDs such
as `global.anthropic.*` and `us.anthropic.*` are never controlled-data lanes;
use an explicitly allowlisted unprefixed regional model ID or a region-bound
Bedrock model ARN in the approved client Region. Inference-profile ARNs are not
accepted because an opaque application profile can still wrap cross-Region
routing. Invalid classification, missing region/model
identity, lane drift, missing admission, or malformed admission limits stop the
request before provider-client construction.

Every AI provider call passes through exact lane authorization and per-account
workload admission before a provider client is created. Defaults allow 4
concurrent leases, 60 requests per minute, 5,000,000 tokens per UTC day, and $50
per UTC day, with per-call caps of 200,000 tokens and $5. Leases expire after
240 seconds so an interrupted worker cannot consume concurrency forever.
Override these server-side when a tenant's approved budget differs:

```bash
RULIX_AI_MAX_CONCURRENT=4
RULIX_AI_REQUESTS_PER_MINUTE=60
RULIX_AI_TOKENS_PER_DAY=5000000
RULIX_AI_SPEND_USD_PER_DAY=50
RULIX_AI_MAX_TOKENS_PER_CALL=200000
RULIX_AI_MAX_COST_USD_PER_CALL=5
RULIX_AI_LEASE_SECONDS=240
```

Missing values use the defaults above. An explicitly malformed or out-of-range
value disables AI admission with a `503` rather than silently falling back to a
more permissive limit. See `docs/security-auth-storage.md` for the reservation
and settlement semantics.

Useful checks:

```bash
npm run typecheck
npm test -- --run
npm run build
npm run build:lambda
npm run test:bundle
npm run test:e2e
npm audit --audit-level=moderate
npm run test:ai
npm run download:corpus
```

Reviewer workflow guide: `docs/reviewer-guide.md`.
Operator dashboard runbook: `docs/dashboard-operator-runbook.md`.
Frontend release and rollback: `docs/frontend-release-runbook.md`.
Design system and accessibility: `docs/frontend-design-system.md` and `docs/accessibility-checklist.md`.
AI approval and human signoff: `docs/ai-approval-and-human-signoff.md`.
Security and storage guide: `docs/security-auth-storage.md`.
Bounded admin metrics runbook: `docs/admin-metrics-operations.md`.
Bounded outreach operations: `docs/outreach-operations.md`.

`npm run test:ai` requires `BEDROCK_ENABLED=true`, AWS credentials, Bedrock model access, and `AWS_REGION`. It verifies that the backend returns a live Bedrock result. Do not commit `.env` files or AWS access keys.

`npm run download:corpus` downloads official source pages into `corpus/raw/` and writes `corpus/manifest.generated.json`. Those generated files are ignored by Git so a tenant can refresh snapshots without polluting source control.

## What Is Implemented

- React/Vite dashboard based on the generated concept in `design/eccn-dashboard-concept.png`.
- Express backend with `/api/health`, `/api/corpus`, review commands, exact AI approval-request queues, council analysis, memo chat, Memo Builder, document extraction, and reviewer decision endpoints. The former `/api/ai/review` surface is retired with `410`; local public templates never call a provider.
- Invite-only authenticated account workspace with credential-generation-bound sessions, conditional DynamoDB auth transitions, and storage for users, invites, reset tokens, memos, decisions, analysis results, memo chat history, encrypted pending AI-approval previews, and audit events.
- Atomic per-account AI admission with expiring concurrency leases, rolling request limits, daily token/spend budgets, and actual-usage settlement before provider dispatch.
- Exact 7/30/90-day admin usage metrics from bounded daily DynamoDB aggregates, with an atomic account counter and explicit availability instead of partial totals.
- Reviewer/counsel AI work queues one immutable, exact-content request for officer inspection. Approval binds the current content/classification, server-loaded context, policy, and canonical provider-body hash to one dispatch; stale or revoked approvals fail before provider use.
- A first-run workflow, persistent in-app Help guide, exact role-specific AI guidance, keyboard focus management, and responsive desktop/mobile navigation keep the security model understandable at the point of use.
- Review queue, upload/paste intake, highlighted memo viewer, editable memo text, memo chat-assisted edits, AI council panel, source citations, decision notes, and report export.
- Outreach administration uses account-bound keyset cursors, bounded first pages, deliberate capped server-side bulk enumeration, stable load-more controls, and capped job logs instead of whole-tenant reads.
- Backend Bedrock Claude Haiku council adapter with deterministic citation/range validation and fail-closed provider handling.
- Local review engine that recommends candidate ECCNs/EAR99 review paths, labels evidence as strong/weak/missing/conflict, verifies citations against the official corpus, and preserves human signoff as a hard gate.
- Seed official corpus metadata for EAR/ITAR/BIS/ITA sources, with a downloader for full raw snapshots.
- AWS/GovCloud architecture notes in `docs/aws-govcloud-architecture.md`.
- API contract in `api/openapi.yaml`.
- Terraform starter in `infra/terraform/` for single-tenant AWS or GovCloud-ready storage, auth/account tables, audit, KMS, SES-capable Lambda permissions, and worker permissions.

## Product Boundary

The app produces AI-generated classification recommendations and evidence review. It is not legal advice, does not create an attorney-client relationship, is not BIS/DDTC/CCATS/CJ, and does not replace qualified export-control personnel or counsel.

Commercial AWS pilots should use public, sample, or authorized/redacted material unless counsel/customer compliance approves processing real controlled technical data outside GovCloud. The architecture is intentionally single-tenant and partition-aware so it can move to AWS GovCloud.
