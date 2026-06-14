# Rulix ECCN Terraform Starter

This starter provisions the single-tenant AWS foundation for the app:

- KMS key for tenant data
- S3 buckets for uploads, official corpus snapshots, and immutable evidence bundles
- DynamoDB audit event table
- CloudWatch log group for worker/API logs
- IAM policy document for application workers

It is partition-aware through `data.aws_partition.current`, so the same module shape can run in commercial AWS or AWS GovCloud after provider credentials and region are configured.

This starter intentionally does not create Bedrock model access, VPC endpoints, RDS/OpenSearch, or customer SSO yet. Those should be added after the first pilot customer chooses the target AWS partition, region, and compliance baseline.

## Example

```bash
terraform init
terraform plan -var tenant_slug=research-pilot -var aws_region=us-east-1
```

For GovCloud, configure the AWS provider with a GovCloud account and region such as `us-gov-west-1`.
