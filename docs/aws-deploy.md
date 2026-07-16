# Deploying Rulix ECCN to AWS (app.rulix.cloud + dashboard.rulix.cloud)

This runs the app on **AWS Lambda** as a single Node service (Express serving
the built Vite client + the `/api` routes), exposed to CloudFront through a
Lambda Function URL origin and fronted by **CloudFront** for the custom domain
`app.rulix.cloud` and the officer-only operations surface at
`dashboard.rulix.cloud` with a managed ACM certificate. No App Runner (closed to new
accounts), no containers, no S3 static origin.

> Compliance note: per the project README this public commercial deployment is a
> sample/redacted-data pilot. Do not process real controlled technical data here;
> that path is AWS GovCloud unless counsel and customer compliance approve
> another boundary.

Terraform lives in `infra/terraform/`; the hosting resources are in `hosting.tf`.
After provisioning normalized workspace resources, use
[`workspace-v2-operations.md`](workspace-v2-operations.md) for the required
migration, verification, fenced content-GC, abort, and recovery sequence.

## Prerequisites (Your Actions - Security-Gated)

### 1. Deploy Credentials

Create an IAM **user** (not root) with deploy permissions, then configure it
locally so Terraform reads it without the secret going through any chat:

```powershell
& "C:\Program Files\Amazon\AWSCLIV2\aws.exe" configure --profile rulix-deploy
$env:AWS_PROFILE = "rulix-deploy"
```

### 2. Optional Bedrock Live AI

Without `BEDROCK_ENABLED=true`, reviewer-facing analysis is unavailable. To
enable live analysis, grant the Lambda execution role Bedrock model access and
set the deployment flag:

```powershell
terraform apply -var-file=production.tfvars -var bedrock_enabled=true
```

The Lambda uses its execution role, not an Anthropic API key. The role policy in
`hosting.tf` allows `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`
against `var.bedrock_resource_arns`; scope those ARNs explicitly for production.
The variable is required and rejects `*`; include only the exact model and
inference-profile ARNs approved for the tenant and region.
The default model is `global.anthropic.claude-haiku-4-5-20251001-v1:0`.

#### AI egress policy

Every provider attempt is authorized against the deployment's current
classification, provider, and region before the SDK client is constructed, and
then admitted against the account workload budget. Caller-supplied API fields
cannot select or weaken this lane.

Configure these as tracked Lambda environment variables:

| Variable | Default | Allowed values / requirement |
|---|---|---|
| `RULIX_AI_DATA_CLASS` | `proprietary` | `public`, `proprietary`, `export-controlled`, `itar-risk`, or `cui`; this is the deployment sensitivity floor |
| `RULIX_APPROVED_PROVIDER` | `amazon-bedrock` | `amazon-bedrock` or `anthropic-direct` |
| `RULIX_APPROVED_REGION` | Bedrock: `AWS_REGION`/`AWS_DEFAULT_REGION`; direct: none | Exact approved Bedrock region, or `global` for direct Anthropic |
| `RULIX_APPROVED_MODEL_IDS` | unset | JSON array of exact regional Bedrock model IDs/ARNs; required and non-empty for controlled data |
| `RULIX_CONTROLLED_DATA_MODE` | unset (controlled dispatch disabled) | Exact value `approved` |

For `export-controlled`, `itar-risk`, or `cui`, all approval values must be set
explicitly, `RULIX_CONTROLLED_DATA_MODE` must equal `approved`, and the selected
provider must be regional Amazon Bedrock. The exact model identity must appear
in `RULIX_APPROVED_MODEL_IDS`. Bare IDs must be unprefixed regional Bedrock IDs;
Region-bound Bedrock model ARNs must name the same Region as
`RULIX_APPROVED_REGION`. Inference-profile ARNs are rejected because an opaque
application profile can wrap cross-Region routing. Global and
geographic cross-Region inference-profile IDs (`global.`, `us.`, `eu.`,
`apac.`, and similar provider prefixes) are rejected even if listed, because
the provider client's source Region does not bind their execution Region.
Direct Anthropic is never a valid controlled-data lane. An invalid class,
unrecognized provider, absent region/model allowlist, lane drift, or missing
admission hook fails closed before provider construction (`422` or `503`,
depending on whether policy or configuration is invalid).

The public commercial tenant remains a sample/redacted-data pilot regardless of
these switches. Do not enable a controlled classification until the approved
hosting and compliance boundary is in place.

#### Per-account AI workload limits

After lane authorization, AI dispatch is admitted before the provider client is
constructed. The built-in production defaults are 4 concurrent leases, 60
requests/minute, 5,000,000 tokens/UTC day, $50/UTC day, 200,000 tokens/call,
$5/call, and a 240-second lease. No additional Lambda variables are required to
use those defaults.

If an approved tenant budget requires different values, manage these as Lambda
environment variables through the deployment configuration rather than making
an untracked console-only edit:

- `RULIX_AI_MAX_CONCURRENT`
- `RULIX_AI_REQUESTS_PER_MINUTE`
- `RULIX_AI_TOKENS_PER_DAY`
- `RULIX_AI_SPEND_USD_PER_DAY`
- `RULIX_AI_MAX_TOKENS_PER_CALL`
- `RULIX_AI_MAX_COST_USD_PER_CALL`
- `RULIX_AI_LEASE_SECONDS`

Use the defaults and accepted ranges in `docs/security-auth-storage.md`. An
explicit invalid value disables AI dispatch with `503`; it never silently
falls back. Update `RULIX_BEDROCK_PRICES` when an approved model's effective
price differs from the bundled pricing table, because admission uses that table
for worst-case cost reservations. Each overridden family must provide all four
strictly positive finite rates (`inputPer1M`, `outputPer1M`, `cacheReadPer1M`,
and `cacheWritePer1M`); malformed, partial, zero, or negative pricing prevents
AI admission from starting.

#### Human approval preview encryption and rotation

Reviewer and counsel requests for controlled AI work are queued for an
export-control officer. The queue retains immutable hashes and decision
metadata for audit, but an exact pending memo-chat message is retained only
until the request is decided or expires (24 hours by default, 72 hours
maximum). That short-lived plaintext is encrypted with AES-256-GCM and bound to
the request ID and command hash. List endpoints never decrypt it; only the
officer detail endpoint does, and approval rechecks the ciphertext binding,
expiry, current workspace version, exact provider-request hash, and policy in
the same decision transaction.

Terraform generates a dedicated 32-byte key and injects the keyring as
`RULIX_AI_APPROVAL_PREVIEW_ACTIVE_KEY_ID` and
`RULIX_AI_APPROVAL_PREVIEW_KEYS_JSON`. The app Lambda uses the tenant customer
managed KMS key for server-side environment encryption. Do not replace these
with console-only values, expose them as Terraform outputs, or copy them into
application logs. Protect the Terraform state as secret material with an
encrypted, access-controlled backend and state locking.

Rotate without invalidating pending requests:

1. Securely capture the current key ID/value from the protected Terraform
   state and add it to `ai_approval_preview_previous_keys_json`.
2. Change `ai_approval_preview_key_id` to a new safe identifier and apply. The
   generated new key becomes active while the old key remains decrypt-only.
3. Wait at least 72 hours, or verify that no request encrypted under the old
   key remains pending.
4. Remove the old entry from `ai_approval_preview_previous_keys_json` and apply
   again. Never reuse a retired key ID.

An absent, malformed, unknown, or prematurely retired key fails closed with
`503`; it cannot fall back to plaintext or approve content the officer could
not inspect.

### 3. Auth Email and First Admin

Production auth uses DynamoDB tables created by Terraform and sends invite/reset
links with SESv2. Terraform manages the `rulix.cloud` domain identity, the
`mail.rulix.cloud` custom MAIL FROM domain, and the default
`security@rulix.cloud` sender. Publish the DKIM, MAIL FROM MX, and SPF records
reported by SES at GoDaddy before enabling real invitations or password resets.
Deploy with:

```powershell
terraform apply `
  -var tenant_slug=prod `
  -var aws_region=us-east-1 `
  -var auth_bootstrap_secret="<one-time-random-secret>"
```

Override `auth_email_from` only when a different address under the verified
domain is required. It may be set to an empty string during dry runs; invites
will be created but email delivery will report that `AUTH_EMAIL_FROM` is not
configured. Use
`POST /api/auth/bootstrap-invite` with header `x-rulix-bootstrap-secret` only to
create the first export-control-officer invite, then remove or rotate the
bootstrap secret after an admin can create invites from the Users console.

## Build the Lambda Bundle

Before directing operators to the new admin dashboard, run the idempotent
aggregate migration described in `docs/admin-metrics-operations.md`. Until its
current-schema marker is complete, `/api/admin/metrics` intentionally returns
`503` rather than scanning raw production tables or showing partial totals.

```powershell
npm install
npm run build:lambda
```

This produces `lambda-build/handler.cjs` (bundled Express app) and
`lambda-build/dist/` (built client). Terraform zips this directory.

## Apply

```powershell
cd infra/terraform
terraform init

# Phase 1: create the Lambda Function URL origin for AWS smoke tests.
terraform apply -target=aws_lambda_function_url.app `
  -var tenant_slug=prod -var aws_region=us-east-1

# Phase 2a: create the ACM cert, then add the printed validation CNAME at GoDaddy.
terraform apply -target=aws_acm_certificate.app `
  -var tenant_slug=prod -var aws_region=us-east-1

# Add every app_cert_validation_records entry to GoDaddy DNS, including the
# dashboard.rulix.cloud SAN validation record, then wait for ISSUED:
# aws acm wait certificate-validated --certificate-arn <arn> --region us-east-1

# Phase 2b: full apply creates CloudFront and the origin secret.
terraform apply -var tenant_slug=prod -var aws_region=us-east-1
```

When `custom_domain` is set, Terraform generates a shared origin secret and
wires it into both CloudFront and Lambda. Direct requests to `app_function_url`
without the `x-rulix-edge-secret` header return 403. The user-facing URLs are
https://app.rulix.cloud and https://dashboard.rulix.cloud. The client selects
the operations dashboard by hostname while both surfaces share the same API.

If `custom_domain = ""`, no edge secret is injected and the Function URL remains
usable for AWS smoke tests.

## Auth Smoke Test

After deploy, verify the durable login path:

1. Create the first admin invite through `POST /api/auth/bootstrap-invite` or
   create an invite from the Users console while signed in as an admin.
2. Open the invite link, set a password, and confirm sign-in succeeds.
3. Call `/api/account/state` from the signed-in browser session.
4. Request a password reset, complete it, and confirm the old session no longer
   reaches `/api/account/state`.
5. Confirm the former password is rejected and the new password creates a
   working session. This checks the credential-generation transition, not only
   the best-effort session cleanup query.
6. Sign out and confirm the prior session cookie is rejected and remains
   rejected after another `/api/auth/me` request attempts activity refresh.

## AI Admission Smoke Test

Run this only in a staging tenant with an injected/fake provider or an approved
low-cost model:

1. Confirm a normal admitted request reaches the provider and its lease settles.
2. Temporarily deploy a reviewed low per-call or request-minute limit, exceed it
   with one controlled request, and confirm the API returns `429` while provider
   invocation metrics do not increase for the denied call.
3. Restore the approved limits through deployment configuration.
4. Confirm malformed admission configuration produces `503` before provider
   invocation, then restore valid configuration.
5. Change the selected test lane's region to a non-approved value and confirm
   provider invocation metrics remain unchanged; restore the approved region.

Do not validate budgets by generating uncontrolled production traffic. Monitor
admission denials alongside Bedrock invocation, token, and cost metrics.

## DNS at GoDaddy (`rulix.cloud` -> DNS)

1. **Cert validation** (phase 2a): add each record from
   `app_cert_validation_records` as a **CNAME**. Use the Name without the
   `.rulix.cloud` suffix.
2. **App domains** (after phase 2b): add **CNAME** records with Names `app` and
   `dashboard`, both pointing to `app_custom_domain_cname_target`, the
   CloudFront `*.cloudfront.net` domain.

CloudFront takes roughly 5-15 minutes to deploy.

The CloudFront Lambda origin read timeout is 60 seconds. Live Bedrock council
calls use a shorter backend deadline so Rulix can fail closed with a clear
live-AI-unavailable response before the edge connection closes.

## Tear Down

```powershell
terraform destroy -var tenant_slug=prod -var aws_region=us-east-1
```
