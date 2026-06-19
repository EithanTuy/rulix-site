# Rulix ECCN — Architecture & Operations

This document explains the whole system end to end: what the application is, how
it is built, and how it is hosted and operated across **AWS**, **GoDaddy**, and
**GitHub**. For the click-by-click deploy steps see `docs/aws-deploy.md`; for the
current deployment status and issue log see `docs/deployment-notes.md`.

---

## 1. What Rulix is

Rulix ECCN is a review aid for **export-control classification memos** (ECCN /
EAR99 determinations) at research facilities. A reviewer brings a memo; Rulix
analyzes it against a versioned official-source corpus, highlights strong/weak/
missing/conflicting evidence, maps findings to citations, and **requires a human
export-control signoff** before any result is final. It is explicitly *not* legal
advice and does not replace counsel (see `README.md`).

---

## 2. Application architecture

One TypeScript codebase, two runtime halves served from a single origin:

```
┌──────────────────────────── Browser (SPA) ────────────────────────────┐
│  React 18 + Vite                                                        │
│  App.tsx ─ ReviewList · MemoWorkspace · AnalysisPanel · MemoChatPanel   │
│  AdminConsole · auth screens                                            │
│  talks to the backend over relative /api/* (cookie session + CSRF)      │
└───────────────────────────────┬────────────────────────────────────────┘
                                 │  same origin, no CORS in prod
┌───────────────────────────────▼────────────────────────────────────────┐
│  Express 5 (server/app.ts)                                              │
│   • Auth:    invites · login · me · logout · password reset             │
│   • Account: /api/account/state  (per-account workspace store)          │
│   • Reviews: /api/reviews [CRUD] · /:id/analyze · /:id/decision         │
│   • AI:      /api/ai/review · /api/reviews/:id/chat                      │
│   • Meta:    /api/health · /api/corpus                                  │
│   • Static:  serves the built Vite client (dist/) + SPA fallback        │
└───────────────┬─────────────────────────────────┬──────────────────────┘
                │                                   │
   ┌────────────▼───────────┐         ┌─────────────▼──────────────┐
   │ Deterministic engine    │        │ Bedrock council (live AI)   │
   │ src/lib/eccnReview.ts    │        │ server/bedrockCouncil.ts    │
   │ rules + missing-checks   │        │ 7 bounded subagents, tool   │
   │ classify / jurisdiction  │        │ schema, citation + range    │
   │ ALWAYS runs (baseline)   │        │ validation against corpus   │
   └──────────────────────────┘        └─────────────────────────────┘
```

Key design points:

- **AI with a deterministic floor.** Every analysis first computes a local
  rules result. If `BEDROCK_ENABLED=true`, the Claude council runs through
  Amazon Bedrock and its output is merged, but citation IDs are validated
  against the real corpus and evidence excerpts are re-located in the actual
  memo text, so the model cannot fabricate sources or highlights. With Bedrock
  disabled, the deterministic result is shown and labeled as such. Default
  standard model is the **Haiku council** through the global Bedrock inference
  profile (`global.anthropic.claude-haiku-4-5-20251001-v1:0`). Deep council
  reviews use Claude Sonnet 4.6.
- **Human signoff is a hard gate** — status is derived from findings + reviewer
  decision; only an explicit accept stamps signoff.
- **Single origin.** In production Express serves both the built client and the
  API, so the SPA uses relative `/api/*` paths (no CORS, no second host).

### Auth & data
- Invite-only onboarding: admins create invites, users set their first password
  through one-time links, and public self-registration is disabled.
- Cookie-based sessions with a **CSRF** check on mutating routes
  (`requireAuth` + `requireCsrf`).
- Password reset links are one-time tokens; completing a reset revokes old
  sessions and starts a fresh session.
- **Per-account workspaces**: each account has its own review/decision/audit
  state behind auth (`/api/account/state`).
- Production Lambda uses DynamoDB for users, invites, sessions, reset tokens,
  lockouts, and per-user review state when `RULIX_AUTH_TABLE` and
  `RULIX_ACCOUNT_TABLE` are configured. The local JSON store remains a
  development/test fallback.
- The seed corpus (`src/data/corpus.ts`) and sample memos ship in the bundle.

---

## 3. How it's hosted on AWS

Hosting is **serverless, single-service, behind a CDN**. (App Runner was the
original plan but is closed to new AWS accounts as of 2026-04-30 — see
`deployment-notes.md` — so we pivoted to Lambda + CloudFront.)

```
   Internet
      │
      ▼
  app.rulix.cloud ──(CNAME, GoDaddy)──► CloudFront distribution
      │                                   • ACM TLS cert (us-east-1)
      │                                   • adds secret origin header
      ▼                                     x-rulix-edge-secret
  Lambda Function URL  ◄── rejects requests missing the secret header (403)
      │
      ▼
  Lambda  rulix-prod-app  (Node 20)
      • handler.cjs = esbuild bundle of the Express app (serverless-http)
      • serves UI + /api from RULIX_DIST_DIR=dist
      • env: BEDROCK_ENABLED, BEDROCK_MODEL, DynamoDB auth/account tables,
             SES sender/base URL/token TTLs, edge secret
```

### Resources (Terraform, `infra/terraform/`)
Hosting (`hosting.tf`):
- `aws_lambda_function.app` — Node 20, 1024 MB, 60 s, runs the bundled Express app.
- `aws_lambda_function_url.app` — public Function URL origin (auth `NONE`, but
  gated by the edge secret when a custom domain is set).
- `aws_acm_certificate.app` — DNS-validated TLS cert for `app.rulix.cloud`.
- `aws_cloudfront_distribution.app` — edge/TLS, injects the `x-rulix-edge-secret`
  origin header from `random_password.edge_shared_secret`.
- `aws_iam_role.lambda_exec` (+ basic-execution logs policy).

Data layer (`main.tf`):
- `aws_kms_key.tenant` (+ alias, key policy granting CloudWatch Logs usage).
- `aws_s3_bucket` ×3 — uploads / corpus / evidence (versioned, KMS-encrypted,
  public access blocked).
- `aws_dynamodb_table.audit_events` — audit trail (PITR, KMS).
- `aws_dynamodb_table.auth` — users, invites, sessions, reset tokens, failed
  login counters, and lockouts (PITR, KMS, TTL).
- `aws_dynamodb_table.account_state` — per-tenant/user review state (PITR, KMS).
- `aws_cloudwatch_log_group.application`.
- `aws_iam_policy.worker` — scoped S3 / KMS / DynamoDB / Bedrock access.

Partition-aware and single-tenant by design so it can move to **AWS GovCloud**.

### Why this shape
- **Scales to zero** — Lambda + CloudFront cost ~$0 idle, a few $/month light use.
- **No containers / no always-on servers.**
- **Edge secret** stops the raw `*.lambda-url.aws` URL from bypassing CloudFront.

---

## 4. GoDaddy (DNS for rulix.cloud)

The domain is registered at GoDaddy; DNS is managed there. Records added for the
app (existing `www → rulix.netlify.app` marketing site and parking records were
left untouched):

| Type | Name | Value | Purpose |
|---|---|---|---|
| CNAME | `_<token>.app` | `…acm-validations.aws` | ACM cert DNS validation |
| CNAME | `app` | `dwvgir86b7phl.cloudfront.net` | points app.rulix.cloud at CloudFront |

ACM watches the validation record to issue/renew the cert; the `app` CNAME routes
user traffic to CloudFront. TLS terminates at CloudFront with the ACM cert.

---

## 5. GitHub

- **Repo:** https://github.com/Daculguy/Rulix (branch `main`).
- **What lives there:** the full app (`src/`, `server/`), the deterministic
  engine + tests, the seed corpus, Terraform (`infra/terraform/`), the Lambda
  bundler (`scripts/build-lambda.mjs`), and docs (`docs/`).
- **What does NOT:** secrets, `lambda-build/`, `function.zip`, Terraform state,
  and `corpus/raw/` — all git-ignored.
- **Workflow:** changes are committed and pushed to `main`; deploys are run
  manually (there is no CI/CD pipeline yet — deploy = `npm run build:lambda` then
  `terraform apply`). Auto-deploy on push could be added later via GitHub Actions
  (OIDC → AWS, no long-lived keys).

Commit history of this work (most recent first): Haiku council + QA hardening,
secure account workspaces + memo chat, deployment docs, the App Runner→Lambda
hosting switch, the App Runner attempt, and the UI revamp.

---

## 6. End-to-end request flow

1. User opens `https://app.rulix.cloud` → GoDaddy CNAME → CloudFront.
2. CloudFront terminates TLS (ACM cert), forwards to the Lambda Function URL,
   adding the secret origin header.
3. Express (in Lambda) checks the edge secret, serves the SPA or handles `/api`.
4. Authed reviewer submits a memo → deterministic engine runs; if Bedrock is
   enabled, the Claude **Haiku council** also runs and is merged with
   citation/range validation.
5. Findings + recommendation render; reviewer records a decision; signoff gates
   the final status.

---

## 7. Build & deploy pipeline

```
npm run build:lambda          # vite build + esbuild → lambda-build/ (handler.cjs + dist/)
cd infra/terraform
terraform apply ...           # zips lambda-build/, updates Lambda, CloudFront, etc.
```
DNS-validated TLS makes this a brief multi-phase apply the first time (cert →
GoDaddy validation record → CloudFront). Subsequent deploys are a single apply.

---

## 8. Security & compliance posture

- **Secrets** (AWS access keys and deployment credentials) are never committed
  and never deployed by the assistant. Live AI uses the AWS credential chain or
  Lambda execution role plus explicit `BEDROCK_ENABLED=true`; without that flag
  the app runs in deterministic local-rules mode.
- **Edge secret** prevents direct Function URL access in custom-domain deploys.
- **Auth + CSRF** protect account data and mutating routes.
- **Compliance:** this public commercial deployment is a sample/redacted-data
  pilot. Real controlled technical data belongs in AWS GovCloud (README + notes).

---

## 9. Operational quick reference

| Thing | Where |
|---|---|
| Live app | https://app.rulix.cloud |
| Direct fallback | Lambda Function URL (`*.lambda-url.us-east-1.on.aws`, edge-secret gated) |
| AWS account / region | 431445330783 / us-east-1 |
| Deploy runbook | `docs/aws-deploy.md` |
| Status & issues | `docs/deployment-notes.md` |
| Reviewer guide | `docs/reviewer-guide.md` |
| GovCloud target arch | `docs/aws-govcloud-architecture.md` |
