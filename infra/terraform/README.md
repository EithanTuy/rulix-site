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
controlled_data_mode = "disabled"
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

Keep `controlled_data_mode = "disabled"` unless the selected Amazon Bedrock provider and region have been explicitly approved for controlled data. Direct Anthropic deployments must set `approved_provider = "anthropic-direct"` and `approved_region = "global"`; application credentials remain outside Terraform state.

For GovCloud, configure the AWS provider with a GovCloud account and region such as `us-gov-west-1`.
