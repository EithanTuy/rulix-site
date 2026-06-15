# Deploying Rulix ECCN to AWS (app.rulix.cloud)

This runs the app on **AWS Lambda** as a single Node service (Express serving
the built Vite client + the `/api` routes), exposed via a **Lambda Function URL**
and fronted by **CloudFront** for the custom domain `app.rulix.cloud` with a
managed ACM certificate. No App Runner (closed to new accounts), no containers,
no S3 static origin.

> Compliance note: per the project README this public commercial deployment is a
> sample/redacted-data pilot. Do not process real controlled technical data here
> — that path is AWS GovCloud.

Terraform lives in `infra/terraform/`; the hosting resources are in `hosting.tf`.

## Prerequisites (your actions — these are security-gated)

### 1. Deploy credentials (do NOT have the assistant create these)
Create an IAM **user** (not root) with deploy permissions, then configure it
locally so Terraform reads it without the secret going through any chat:

```powershell
& "C:\Program Files\Amazon\AWSCLIV2\aws.exe" configure --profile rulix-deploy
$env:AWS_PROFILE = "rulix-deploy"
```

### 2. (Optional) Anthropic API key for live AI
Without a key the app runs in deterministic local-rules mode. To enable the live
Claude council, pass the key at apply time (stored only as a Lambda env var):
`-var anthropic_api_key="sk-ant-..."` — or wire it through Secrets Manager.

## Build the Lambda bundle

```powershell
npm install
npm run build:lambda   # vite build + esbuild bundle -> lambda-build/
```
This produces `lambda-build/handler.cjs` (bundled Express app) and
`lambda-build/dist/` (built client). Terraform zips this directory.

## Apply (two phases because of DNS-validated TLS)

```powershell
cd infra/terraform
terraform init

# Phase 1 — app live at the Function URL immediately:
terraform apply -target=aws_lambda_function_url.app `
  -var tenant_slug=prod -var aws_region=us-east-1

# Phase 2a — create the ACM cert, then add the printed validation CNAME at GoDaddy:
terraform apply -target=aws_acm_certificate.app `
  -var tenant_slug=prod -var aws_region=us-east-1
#   -> add `app_cert_validation_records` to GoDaddy DNS, wait for ISSUED:
#   aws acm wait certificate-validated --certificate-arn <arn> --region us-east-1

# Phase 2b — full apply creates CloudFront (needs the issued cert):
terraform apply -var tenant_slug=prod -var aws_region=us-east-1
```

## DNS at GoDaddy (rulix.cloud → DNS)

1. **Cert validation** (phase 2a): add each record from
   `app_cert_validation_records` as a **CNAME** (Name without the `.rulix.cloud`
   suffix).
2. **App domain** (after phase 2b): add a **CNAME** — Name `app`, Value =
   `app_custom_domain_cname_target` (the CloudFront `*.cloudfront.net` domain).

CloudFront takes ~5–15 min to deploy. The app is then live at
https://app.rulix.cloud. The raw `app_function_url` works immediately regardless.

## Tear down

```powershell
terraform destroy -var tenant_slug=prod -var aws_region=us-east-1
```
