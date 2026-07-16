# Deployment Notes & Known Issues

Status of the first AWS production deployment of Rulix ECCN, and every issue
hit along the way. See `docs/aws-deploy.md` for the step-by-step runbook.

## Live Deployment (Current)

| Item | Value |
|---|---|
| Public URL | https://app.rulix.cloud |
| Operations URL | https://dashboard.rulix.cloud |
| Fallback URL | Lambda Function URL, protected by CloudFront origin secret when `custom_domain` is set |
| AWS account | 431445330783, region `us-east-1` |
| Compute | Lambda `rulix-prod-app` (Node 24, Express UI + `/api`) |
| Edge / TLS | CloudFront `dwvgir86b7phl.cloudfront.net`, ACM cert for `app.rulix.cloud` and `dashboard.rulix.cloud` |
| DNS | GoDaddy `rulix.cloud`: ACM validation CNAMEs + `app` and `dashboard` to CloudFront |
| AI mode | Bedrock-enabled in production; reviewer-facing analysis fails closed when live AI is unavailable |
| Auth mode | Invite-only custom auth with DynamoDB tables and SESv2 email when `AUTH_EMAIL_FROM` is configured |

Previously verified live: UI loads and `/api/health` returns 200. The current
repository retires `/api/ai/review`; after deploying this remediation, verify
the reviewer request -> officer inspection/approval -> one exact council
dispatch flow instead of probing the retired endpoint.

Deep Sonnet reviews are bounded to 50 seconds and CloudFront waits up to 60
seconds for the Lambda origin. If Sonnet exceeds the deadline, the backend
returns a live-AI-unavailable error instead of recording a deterministic
review result or exposing a CloudFront 504 page.

---

## Known Issues

### 1. CloudWatch Log Group Encryption (RESOLVED)

Earlier `terraform apply` runs errored on `aws_cloudwatch_log_group.application`:

```text
AccessDeniedException: The specified KMS key does not exist or is not allowed
to be used with Arn 'arn:aws:logs:us-east-1:...:log-group:/aws/rulix/prod/application'
```

**Root cause:** earlier versions of `aws_kms_key.tenant` had no key policy.
CloudWatch Logs cannot use a CMK for log-group encryption unless the key policy
grants the regional CloudWatch Logs service principal the required encrypt,
decrypt, re-encrypt, data-key, and describe permissions for the log-group ARN.

**Fix shipped:** `infra/terraform/main.tf` now attaches a tenant KMS key policy
with account-root administration and scoped CloudWatch Logs usage for the
application log group ARN.

### 2. Initial Local-Rules Mode, Then Bedrock Enabled (RESOLVED)

The first deployment used the deterministic council only. Production has since
been redeployed with Bedrock enabled. Reviewer-facing analysis now requires
live AI; deterministic local rules remain an internal baseline only.

To explicitly redeploy with Bedrock enabled:

```bash
terraform apply -var tenant_slug=prod -var aws_region=us-east-1 -var bedrock_enabled=true
```

The Lambda uses its execution role for AWS credentials. Ensure the account keeps
Bedrock model access for the configured Anthropic model/profile in `us-east-1`.

### 3. AWS App Runner Was Unavailable (RESOLVED)

The original plan used App Runner, but as of 2026-04-30 App Runner stopped
accepting new customers, and this account had none. The architecture pivoted to
Lambda + Function URL + CloudFront, which is also cheaper and scales to zero.

### 4. Lambda Bundling Gotchas (RESOLVED)

- The project is `"type": "module"`, so the esbuild CJS bundle must be emitted
  as **`handler.cjs`** (not `.js`) or Node loads it as ESM and the export breaks.
- `server/app.ts` uses `import.meta.url` to locate `dist/`, which is invalid in a
  CJS bundle. In Lambda the dist path comes from the `RULIX_DIST_DIR` env var,
  and esbuild defines `import.meta.url` to a placeholder. See
  `scripts/build-lambda.mjs`.

### 5. Public Function URL Bypass (RESOLVED FOR CUSTOM-DOMAIN DEPLOYS)

The Lambda Function URL still uses `authorization_type = "NONE"` because
CloudFront forwards to it as a custom origin. For custom-domain deploys,
Terraform now generates `random_password.edge_shared_secret`, injects it into
Lambda as `RULIX_EDGE_SHARED_SECRET`, and configures CloudFront to send the
matching `x-rulix-edge-secret` origin header. Direct Function URL requests
without that header return 403.

If `custom_domain = ""`, the app intentionally remains reachable through the
Function URL for AWS smoke tests.

### 6. Compliance Scope (NOTE)

This is a public commercial AWS deployment. Per the README it must serve only
public, sample, or authorized/redacted material. Real controlled technical data
belongs in AWS GovCloud unless counsel and customer compliance approve another
boundary.

### 7. SES Sender and First Admin Bootstrap

The app no longer supports public account creation. Terraform manages the
`rulix.cloud` SES identity, the `mail.rulix.cloud` custom MAIL FROM domain, and
the default `security@rulix.cloud` sender. Publish the SES-provided DKIM, MX,
and SPF records in GoDaddy and wait for both identity and MAIL FROM verification
before inviting production users. Configure a temporary
`AUTH_BOOTSTRAP_SECRET` to create the first `export-control-officer` invite.
After the first admin signs in, future invites should be created from the Users
console and the bootstrap secret should be removed or rotated.

### 8. June 2026 Edge and App Hardening

The app/dashboard production edge should be deployed with the hardened
configuration from this repo:

- CloudFront security response headers and HSTS.
- AWS WAF managed rule groups plus rate limits for auth, admin, and global
  traffic.
- `X-Robots-Tag: noindex, nofollow` and app/dashboard `robots.txt` handling.
- `/api/health` exposing provider configured status without model IDs.
- Production CORS restricted to `app.rulix.cloud` and `dashboard.rulix.cloud`
  by default.
- Real Lambda log group `/aws/lambda/rulix-prod-app` imported into Terraform,
  encrypted with the tenant KMS key, and retained for `log_retention_days`.

The public marketing site at `rulix.cloud` remains a separate Netlify surface.
See `docs/website-leads-and-hardening.md` for lead-generation and SEO changes
that need to be deployed from that site project.

---

## Local Artifacts (Git-Ignored, Not Deployed)

- `data/` - local development/test account store fallback.
- `lambda-build/` - esbuild output zipped by Terraform.
- `infra/terraform/function.zip`, `.terraform/`, `*.tfstate*` - build/state.
