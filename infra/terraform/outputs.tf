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

output "worker_policy_arn" {
  value = aws_iam_policy.worker.arn
}

output "app_service_url" {
  description = "Default App Runner HTTPS URL for the deployed app."
  value       = "https://${aws_apprunner_service.app.service_url}"
}

output "app_custom_domain_dns_targets" {
  description = "DNS records to add at GoDaddy to validate + activate the custom domain. Add every record shown here."
  value = var.custom_domain == "" ? [] : [
    for r in aws_apprunner_custom_domain_association.app[0].certificate_validation_records : {
      name  = r.name
      type  = r.type
      value = r.value
    }
  ]
}

output "app_custom_domain_cname_target" {
  description = "CNAME target for the app domain itself (point app.rulix.cloud here at GoDaddy)."
  value       = var.custom_domain == "" ? "" : aws_apprunner_custom_domain_association.app[0].dns_target
}

