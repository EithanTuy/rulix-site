# Deployment Notes & Known Issues

Status of the first AWS production deployment of Rulix ECCN, and every issue
hit along the way. See `docs/aws-deploy.md` for the step-by-step runbook.

## Live Deployment (Current)

| Item | Value |
|---|---|
| Public URL | https://app.rulix.cloud |
| Fallback URL | Lambda Function URL, protected by CloudFront origin secret when `custom_domain` is set |
| AWS account | 431445330783, region `us-east-1` |
| Compute | Lambda `rulix-prod-app` (Node 20, Express UI + `/api`) |
| Edge / TLS | CloudFront `dwvgir86b7phl.cloudfront.net`, ACM cert for `app.rulix.cloud` |
| DNS | GoDaddy `rulix.cloud`: ACM validation CNAME + `app` to CloudFront |
| AI mode | **local-rules** (deterministic) - no Anthropic key deployed |

Verified end-to-end: UI loads, `/api/health` 200, `/api/ai/review` returns
grounded findings when called from an authenticated session.

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

### 2. Deployed in Local-Rules Mode, Not Live Claude (BY DESIGN)

No `ANTHROPIC_API_KEY` is deployed, so the app uses the deterministic council.
This is intentional: secrets are not handled by the deploy assistant.

To enable live AI, redeploy with the key kept on the operator side:

```bash
terraform apply -var tenant_slug=prod -var aws_region=us-east-1 -var anthropic_api_key="sk-ant-..."
```

The key is injected as a Lambda env var. For production, move it to Secrets
Manager and reference it instead of passing it inline.

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

---

## Local Artifacts (Git-Ignored, Not Deployed)

- `data/` - local single-node account store.
- `lambda-build/` - esbuild output zipped by Terraform.
- `infra/terraform/function.zip`, `.terraform/`, `*.tfstate*` - build/state.
