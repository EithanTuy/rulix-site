# Deploying Rulix ECCN to AWS (app.rulix.cloud)

This runs the app on **AWS Lambda** as a single Node service (Express serving
the built Vite client + the `/api` routes), exposed to CloudFront through a
Lambda Function URL origin and fronted by **CloudFront** for the custom domain
`app.rulix.cloud` with a managed ACM certificate. No App Runner (closed to new
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

### 2. Optional Anthropic API Key for Live AI

Without a key the app runs in deterministic local-rules mode. To enable live
analysis, pass the key at apply time (stored only as a Lambda env var):

```powershell
terraform apply -var anthropic_api_key="sk-ant-..."
```

For production, wire the secret through Secrets Manager instead of passing it
inline.

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

# Add app_cert_validation_records to GoDaddy DNS, wait for ISSUED:
# aws acm wait certificate-validated --certificate-arn <arn> --region us-east-1

# Phase 2b: full apply creates CloudFront and the origin secret.
terraform apply -var tenant_slug=prod -var aws_region=us-east-1
```

When `custom_domain` is set, Terraform generates a shared origin secret and
wires it into both CloudFront and Lambda. Direct requests to `app_function_url`
without the `x-rulix-edge-secret` header return 403. The user-facing URL is
https://app.rulix.cloud.

If `custom_domain = ""`, no edge secret is injected and the Function URL remains
usable for AWS smoke tests.

## DNS at GoDaddy (`rulix.cloud` -> DNS)

1. **Cert validation** (phase 2a): add each record from
   `app_cert_validation_records` as a **CNAME**. Use the Name without the
   `.rulix.cloud` suffix.
2. **App domain** (after phase 2b): add a **CNAME** with Name `app` and Value
   `app_custom_domain_cname_target`, the CloudFront `*.cloudfront.net` domain.

CloudFront takes roughly 5-15 minutes to deploy.

## Tear Down

```powershell
terraform destroy -var tenant_slug=prod -var aws_region=us-east-1
```
