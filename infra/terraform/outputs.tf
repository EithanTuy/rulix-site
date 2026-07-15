output "partition" {
  value = data.aws_partition.current.partition
}

output "tenant_kms_key_arn" {
  value = aws_kms_key.tenant.arn
}

output "uploads_bucket" {
  value = aws_s3_bucket.uploads.bucket
}

output "corpus_bucket" {
  value = aws_s3_bucket.corpus.bucket
}

output "evidence_bucket" {
  value = aws_s3_bucket.evidence.bucket
}

output "audit_table" {
  value = aws_dynamodb_table.audit_events.name
}

output "auth_table" {
  value = aws_dynamodb_table.auth.name
}

output "account_state_table" {
  value = aws_dynamodb_table.account_state.name
}

output "analysis_worker_policy_arn" {
  description = "Least-privilege analysis capability with read-only account state and no auth or audit-table access."
  value       = aws_iam_policy.analysis_worker.arn
}

output "workspace_table" {
  value = aws_dynamodb_table.workspace.name
}

output "workspace_content_bucket" {
  value = aws_s3_bucket.workspace_content.bucket
}

output "workspace_kms_key_arn" {
  description = "KMS key used by the normalized workspace table and immutable content objects."
  value       = aws_kms_key.workspace.arn
}

output "workspace_migration_role_arn" {
  value = aws_iam_role.workspace_migration.arn
}

output "workspace_content_gc_role_arn" {
  description = "Isolated role for reference-aware, exact-VersionId orphan garbage collection."
  value       = aws_iam_role.workspace_content_gc.arn
}

output "workspace_migration_receipt_secret_arn" {
  value = aws_secretsmanager_secret.migration_receipt_hmac.arn
}

output "app_function_url" {
  description = "Lambda Function URL. AWS_IAM rejects direct anonymous requests unless the explicit temporary no-domain bootstrap override is enabled."
  value       = aws_lambda_function_url.app.function_url
}

output "app_cert_validation_records" {
  description = "ACM DNS validation CNAME(s) to add at GoDaddy before the cert/CloudFront becomes active."
  value = var.custom_domain == "" ? [] : [
    for o in aws_acm_certificate.app[0].domain_validation_options : {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  ]
}

output "app_custom_domain_cname_target" {
  description = "CloudFront domain to point app.rulix.cloud and dashboard.rulix.cloud at via CNAME records."
  value       = var.custom_domain == "" ? "" : aws_cloudfront_distribution.app[0].domain_name
}

output "github_actions_deploy_role_arn" {
  description = "OIDC role used by the production GitHub Actions deployment workflow."
  value       = aws_iam_role.github_actions_deploy.arn
}

