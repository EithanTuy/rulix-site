# Rulix ECCN Terraform Starter

This starter provisions the single-tenant AWS foundation for the app:

- KMS key for tenant data
- S3 buckets for uploads, official corpus snapshots, and immutable evidence bundles
- DynamoDB audit, auth, and account-state tables
- CloudWatch log groups for worker/API and private audit-writer logs
- Lambda hosting with DynamoDB auth/account access and SES send permissions
- a private conditional audit-append Lambda; Terraform supplies its authoritative tenant/writer identity, callers can submit only asserted provenance, and its runtime can append with `dynamodb:PutItem` plus table/account-bound KMS decrypt through DynamoDB
- separate least-privilege analysis-worker and audit-invoker policies; analysis workers have read-only account-state access, write evidence only to S3, and cannot access authentication or audit tables

It is partition-aware through `data.aws_partition.current`, so the same module shape can run in commercial AWS or AWS GovCloud after provider credentials and region are configured.

Normalized workspace migration, fenced reference-aware content cleanup, abort,
and recovery procedures are documented in
[`../../docs/workspace-v2-operations.md`](../../docs/workspace-v2-operations.md).

This starter intentionally does not create Bedrock model access, VPC endpoints, RDS/OpenSearch, or customer SSO yet. Those should be added after the first pilot customer chooses the target AWS partition, region, and compliance baseline.

## Production state backend

Production state is stored in the versioned, public-blocked, KMS-encrypted S3
bucket `rulix-terraform-state-431445330783-us-east-1` under
`rulix/prod/terraform.tfstate`. The backend uses Terraform's native S3 lockfile;
there is no separate DynamoDB lock table. Initialize from the repository root:

```powershell
terraform -chdir=infra/terraform init -reconfigure `
  -backend-config="bucket=rulix-terraform-state-431445330783-us-east-1" `
  -backend-config="key=rulix/prod/terraform.tfstate" `
  -backend-config="region=us-east-1" `
  -backend-config="profile=rulix-codex" `
  -backend-config="encrypt=true" `
  -backend-config="kms_key_id=arn:aws:kms:us-east-1:431445330783:key/ae363238-24d8-4a69-8a53-117a7e539dfd" `
  -backend-config="use_lockfile=true"
```

The `profile` argument is for local operators only. GitHub OIDC jobs omit it and
use their assumed role. Never run `apply` from an empty or newly selected state;
`terraform state list` must show the imported `rulix-prod-*` resources first.

The one-time recovery/import command is deliberately separate from normal
deployment:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/import-production-state.ps1
```

It validates the AWS account, imports only the known pre-existing production
resources, skips addresses already present, and stops at the first failed
import. New audit, normalized-workspace, alarm, OAC, and WAF support resources
are not imported because Terraform must create them from the reviewed plan.

### First private-origin cutover

The one-time migration from a public Lambda Function URL plus shared header to
CloudFront OAC must be staged. This keeps the current origin available until
CloudFront has fully deployed signed requests. Run each apply with the reviewed
production variables, and require `https://app.rulix.cloud/api/health` to return
HTTP 200 after every numbered step:

1. Apply `aws_cloudfront_origin_access_control.app[0]` only.
2. Apply `aws_cloudfront_distribution.app[0]` only, then wait until the
   distribution reports `Deployed`.
3. Apply both `aws_lambda_permission.cloudfront_function_url[0]` and
   `aws_lambda_permission.cloudfront_invoke_function[0]`. Their lifecycle
   creates the scoped CloudFront statements before removing the public ones.
4. Apply `aws_lambda_function_url.app` to switch it to `AWS_IAM`.
5. Generate and review a fresh full plan, then apply all remaining resources.

Do not combine steps 2 and 4 during the first cutover. Normal later applies are
not subject to this bootstrap ordering because OAC and IAM auth are then already
active.

## Example

```bash
npm run build:lambda
cd infra/terraform
terraform init
terraform plan -var-file=production.tfvars
```

The AI egress and admission controls have secure, code-matched defaults. A fully explicit `terraform.tfvars` example is:

```hcl
tenant_slug          = "research-pilot"
aws_region           = "us-east-1"
ai_data_class        = "proprietary"
approved_provider    = "amazon-bedrock"
approved_region      = "us-east-1" # omit to inherit aws_region
controlled_data_mode = "blocked"
bedrock_resource_arns = [
  # Replace with every exact model/inference-profile ARN approved for this tenant.
  "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0"
]

ai_max_concurrent        = 4
ai_requests_per_minute   = 60
ai_tokens_per_day        = 5000000
ai_spend_usd_per_day     = 50
ai_max_tokens_per_call   = 200000
ai_max_cost_usd_per_call = 5
ai_lease_seconds         = 240
```

`bedrock_resource_arns` has no wildcard/default escape hatch. Terraform rejects
an empty list, `"*"`, and malformed ARNs. Cross-region inference may require the
approved inference-profile ARN plus each documented foundation-model ARN in its
destination regions; use the exact set shown by AWS for the selected profile.

Keep `controlled_data_mode = "blocked"` unless the selected Amazon Bedrock provider and region have been explicitly approved for controlled data. Direct Anthropic deployments must set `approved_provider = "anthropic-direct"` and `approved_region = "global"`; application credentials remain outside Terraform state.

For GovCloud, configure the AWS provider with a GovCloud account and region such as `us-gov-west-1`.
