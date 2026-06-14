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

