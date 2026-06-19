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

## Prerequisites (Your Actions - Security-Gated)

### 1. Deploy Credentials

Create an IAM **user** (not root) with deploy permissions, then configure it
locally so Terraform reads it without the secret going through any chat:

```powershell
& "C:\Program Files\Amazon\AWSCLIV2\aws.exe" configure --profile rulix-deploy
$env:AWS_PROFILE = "rulix-deploy"
```

### 2. Optional Bedrock Live AI

Without `BEDROCK_ENABLED=true` the app runs in deterministic local-rules mode.
To enable live analysis, grant the Lambda execution role Bedrock model access
and set the deployment flag:

```powershell
terraform apply -var bedrock_enabled=true
```

The Lambda uses its execution role, not an Anthropic API key. The role policy in
`hosting.tf` allows `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`
against `var.bedrock_resource_arns`; scope those ARNs explicitly for production.
The default model is `global.anthropic.claude-haiku-4-5-20251001-v1:0`.

### 3. Auth Email and First Admin

Production auth uses DynamoDB tables created by Terraform and sends invite/reset
links with SESv2. Verify a sender address in SES, then deploy with:

```powershell
terraform apply `
  -var tenant_slug=prod `
  -var aws_region=us-east-1 `
  -var auth_email_from=security@rulix.cloud `
  -var auth_bootstrap_secret="<one-time-random-secret>"
```

`auth_email_from` may be left empty during dry runs; invites will be created but
email delivery will report that `AUTH_EMAIL_FROM` is not configured. Use
`POST /api/auth/bootstrap-invite` with header `x-rulix-bootstrap-secret` only to
create the first export-control-officer invite, then remove or rotate the
bootstrap secret after an admin can create invites from the Users console.

## Build the Lambda Bundle

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
5. Sign out and confirm the prior session cookie is rejected.

## DNS at GoDaddy (`rulix.cloud` -> DNS)

1. **Cert validation** (phase 2a): add each record from
   `app_cert_validation_records` as a **CNAME**. Use the Name without the
   `.rulix.cloud` suffix.
2. **App domains** (after phase 2b): add **CNAME** records with Names `app` and
   `dashboard`, both pointing to `app_custom_domain_cname_target`, the
   CloudFront `*.cloudfront.net` domain.

CloudFront takes roughly 5-15 minutes to deploy.

## Tear Down

```powershell
terraform destroy -var tenant_slug=prod -var aws_region=us-east-1
```
