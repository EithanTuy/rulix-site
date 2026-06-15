# Deploying Rulix ECCN to AWS (app.rulix.cloud)

This stands the app up on **AWS App Runner** as a single Node service (Express
serves the built Vite client + the `/api` routes). App Runner builds straight
from the GitHub repo and provides managed HTTPS and a custom domain. No Docker,
S3, or CloudFront.

> Compliance note: per the project README this public commercial deployment is a
> sample/redacted-data pilot. Do not process real controlled technical data here
> — that path is AWS GovCloud.

Terraform lives in `infra/terraform/`. The hosting resources are in `hosting.tf`.

## One-time prerequisites (these are your actions — they're security-gated)

### 1. Deploy credentials (do NOT have the assistant create these)
Create an IAM **user** (not root) with programmatic access scoped to App Runner,
IAM (for the service roles), and Secrets Manager, then configure it locally so
Terraform can read it **without the secret ever going through chat**:

```powershell
# In YOUR terminal, after creating the access key in the console:
aws configure --profile rulix-deploy   # paste key id + secret when prompted
$env:AWS_PROFILE = "rulix-deploy"
```
(Terraform reads `~/.aws/credentials` automatically.)

### 2. App Runner ↔ GitHub connection
Console → App Runner → **GitHub connections** → create + authorize for
`Daculguy/Rulix`. Copy the connection ARN.

### 3. Anthropic API key secret (optional — omit to run in local-rules mode)
```powershell
aws secretsmanager create-secret --name rulix/anthropic-api-key --secret-string "sk-ant-..."
```
Copy the returned ARN.

## Apply

```powershell
cd infra/terraform
terraform init
terraform apply `
  -var tenant_slug=prod `
  -var aws_region=us-east-1 `
  -var apprunner_connection_arn="arn:aws:apprunner:...:connection/..." `
  -var anthropic_secret_arn="arn:aws:secretsmanager:...:secret:rulix/anthropic-api-key-XXXX"
```

App Runner builds from `main` and goes live at the `app_service_url` output.

## DNS for app.rulix.cloud (GoDaddy)

After apply, Terraform prints two outputs:

- `app_custom_domain_dns_targets` — certificate **validation** CNAME records.
- `app_custom_domain_cname_target` — the target the app domain points to.

In GoDaddy → `rulix.cloud` → DNS, add:

1. Each validation record from `app_custom_domain_dns_targets` (Type CNAME,
   Name/Value as shown).
2. A CNAME: **Name** `app` → **Value** = `app_custom_domain_cname_target`.

Validation usually completes within minutes to an hour; re-running
`terraform apply` (or checking the App Runner console) shows the domain as
`active` once the managed certificate is issued. The app is then live at
https://app.rulix.cloud.

## Tear down

```powershell
terraform destroy -var tenant_slug=prod -var aws_region=us-east-1 ...
```
