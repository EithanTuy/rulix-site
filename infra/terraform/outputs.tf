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

output "worker_policy_arn" {
  value = aws_iam_policy.worker.arn
}

output "app_function_url" {
  description = "Lambda Function URL. With custom_domain set, direct browser access is rejected unless the CloudFront origin secret header is present."
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

