# Deployment Notes & Known Issues

Status of the first AWS production deployment of Rulix ECCN, and every issue
hit along the way. See `docs/aws-deploy.md` for the step-by-step runbook.

## Live deployment (current)

| Item | Value |
|---|---|
| Public URL | https://app.rulix.cloud |
| Fallback URL | the Lambda Function URL (`*.lambda-url.us-east-1.on.aws`) |
| AWS account | 431445330783, region `us-east-1` |
| Compute | Lambda `rulix-prod-app` (Node 20, Express UI + `/api`) |
| Edge / TLS | CloudFront `dwvgir86b7phl.cloudfront.net`, ACM cert for `app.rulix.cloud` |
| DNS | GoDaddy `rulix.cloud`: ACM validation CNAME + `app` → CloudFront |
| AI mode | **local-rules** (deterministic) — no Anthropic key deployed |

Verified end-to-end: UI loads, `/api/health` 200, `/api/ai/review` returns
grounded findings.

---

## Known issues

### 1. CloudWatch log group fails to create (OPEN — non-blocking)
`terraform apply` errors on `aws_cloudwatch_log_group.application`:

```
AccessDeniedException: The specified KMS key does not exist or is not allowed
to be used with Arn 'arn:aws:logs:us-east-1:...:log-group:/aws/rulix/prod/application'
```

**Root cause:** `aws_kms_key.tenant` (in `infra/terraform/main.tf`) has no key
policy. CloudWatch Logs cannot use a CMK for log-group encryption unless the key
policy grants `logs.<region>.amazonaws.com` the `kms:Encrypt*/Decrypt*/
ReEncrypt*/GenerateDataKey*/Describe*` actions for that log-group ARN.

**Impact:** none on the running app — the app runs on Lambda and is unaffected.
Only this one data-layer resource is missing; all other data-layer resources
(KMS key, 3 S3 buckets, DynamoDB audit table, worker IAM policy) were created.

**Fix:** add a `policy` to `aws_kms_key.tenant` granting the CloudWatch Logs
service principal usage scoped to the log-group ARN, then re-apply. (Tracked as a
follow-up; the app does not depend on it.)

### 2. Deployed in local-rules mode, not live Claude (BY DESIGN)
No `ANTHROPIC_API_KEY` is deployed, so the app uses the deterministic council.
This is intentional — secrets are not handled by the deploy assistant.

**To enable live AI:** redeploy with the key (kept on your side):
```
terraform apply -var tenant_slug=prod -var aws_region=us-east-1 -var anthropic_api_key="sk-ant-..."
```
The key is injected as a Lambda env var. For production, move it to Secrets
Manager and reference it instead of passing it inline.

### 3. AWS App Runner was unavailable (RESOLVED — architecture changed)
The original plan used App Runner, but as of 2026-04-30 App Runner stopped
accepting new customers, and this account had none. Pivoted to **Lambda +
Function URL + CloudFront**, which is also cheaper (scales to zero). The App
Runner Terraform was replaced in commit history by the Lambda config.

### 4. Lambda bundling gotchas (RESOLVED — documented for maintainers)
- The project is `"type": "module"`, so the esbuild CJS bundle must be emitted
  as **`handler.cjs`** (not `.js`) or Node loads it as ESM and the export breaks.
- `server/app.ts` uses `import.meta.url` to locate `dist/`, which is invalid in a
  CJS bundle. In Lambda the dist path comes from the `RULIX_DIST_DIR` env var
  instead, and esbuild `define`s `import.meta.url` to a placeholder so the bundle
  is clean. See `scripts/build-lambda.mjs`.

### 5. Public Function URL (NOTE — acceptable for this pilot)
The Lambda Function URL uses `authorization_type = "NONE"`, so the raw
`*.lambda-url...` URL is publicly reachable and bypasses CloudFront. Fine for a
sample-data pilot. To lock it down later, switch the Function URL to `AWS_IAM`
and put CloudFront Origin Access in front, or add a shared-secret header check.

### 6. Compliance scope (NOTE)
This is a public **commercial** AWS deployment. Per the README it must serve only
public / sample / redacted material. Real controlled technical data belongs in
AWS GovCloud, not here.

---

## Local artifacts (git-ignored, not deployed)
- `lambda-build/` — esbuild output zipped by Terraform.
- `infra/terraform/function.zip`, `.terraform/`, `*.tfstate*` — build/state.
