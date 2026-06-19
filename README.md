# Rulix ECCN

Rulix ECCN is a Phase 2 MVP for reviewing ECCN classification memos against a versioned official-source corpus. It ingests memo text, runs a backend AI council through Amazon Bedrock when `BEDROCK_ENABLED=true`, falls back to deterministic local rules when the provider is unavailable, highlights memo evidence, maps findings to citations, and requires human export-control signoff before any result is treated as final.

## Run

```bash
npm install
npm run dev:server
npm run dev
```

The Vite app runs on `http://127.0.0.1:5173` by default and proxies `/api` to the backend at `http://127.0.0.1:8787`.

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

Useful checks:

```bash
npm test
npm run build
npm run test:ai
npm run download:corpus
```

Reviewer workflow guide: `docs/reviewer-guide.md`.
Security and storage guide: `docs/security-auth-storage.md`.

`npm run test:ai` requires `BEDROCK_ENABLED=true`, AWS credentials, Bedrock model access, and `AWS_REGION`. It verifies that the backend returns a live Bedrock result. Do not commit `.env` files or AWS access keys.

`npm run download:corpus` downloads official source pages into `corpus/raw/` and writes `corpus/manifest.generated.json`. Those generated files are ignored by Git so a tenant can refresh snapshots without polluting source control.

## What Is Implemented

- React/Vite dashboard based on the generated concept in `design/eccn-dashboard-concept.png`.
- Express backend with `/api/health`, `/api/corpus`, `/api/reviews`, `/api/reviews/:id/analyze`, `/api/ai/review`, and reviewer decision endpoints.
- Invite-only authenticated account workspace with DynamoDB-ready storage for users, invites, sessions, reset tokens, memos, decisions, analysis results, memo chat history, and audit events.
- Review queue, upload/paste intake, highlighted memo viewer, editable memo text, memo chat-assisted edits, AI council panel, source citations, decision notes, and report export.
- Backend Bedrock Claude Haiku council adapter with deterministic citation/range validation and safe local fallback.
- Local review engine that recommends candidate ECCNs/EAR99 review paths, labels evidence as strong/weak/missing/conflict, verifies citations against the official corpus, and preserves human signoff as a hard gate.
- Seed official corpus metadata for EAR/ITAR/BIS/ITA sources, with a downloader for full raw snapshots.
- AWS/GovCloud architecture notes in `docs/aws-govcloud-architecture.md`.
- API contract in `api/openapi.yaml`.
- Terraform starter in `infra/terraform/` for single-tenant AWS or GovCloud-ready storage, auth/account tables, audit, KMS, SES-capable Lambda permissions, and worker permissions.

## Product Boundary

The app produces AI-generated classification recommendations and evidence review. It is not legal advice, does not create an attorney-client relationship, is not BIS/DDTC/CCATS/CJ, and does not replace qualified export-control personnel or counsel.

Commercial AWS pilots should use public, sample, or authorized/redacted material unless counsel/customer compliance approves processing real controlled technical data outside GovCloud. The architecture is intentionally single-tenant and partition-aware so it can move to AWS GovCloud.
