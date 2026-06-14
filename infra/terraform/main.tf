terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.80.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

locals {
  name_prefix = "rulix-${var.tenant_slug}"
  common_tags = {
    Application = "Rulix ECCN"
    Tenant      = var.tenant_slug
    DataScope   = "export-classification-review"
  }
}

resource "aws_kms_key" "tenant" {
  description             = "Rulix ECCN tenant data key for ${var.tenant_slug}"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  tags                    = local.common_tags
}

resource "aws_kms_alias" "tenant" {
  name          = "alias/${local.name_prefix}-tenant"
  target_key_id = aws_kms_key.tenant.key_id
}

resource "aws_s3_bucket" "uploads" {
  bucket = "${local.name_prefix}-uploads-${data.aws_caller_identity.current.account_id}"
  tags   = local.common_tags
}

resource "aws_s3_bucket" "corpus" {
  bucket = "${local.name_prefix}-corpus-${data.aws_caller_identity.current.account_id}"
  tags   = local.common_tags
}

resource "aws_s3_bucket" "evidence" {
  bucket = "${local.name_prefix}-evidence-${data.aws_caller_identity.current.account_id}"
  tags   = local.common_tags
}

resource "aws_s3_bucket_versioning" "all" {
  for_each = {
    uploads  = aws_s3_bucket.uploads.id
    corpus   = aws_s3_bucket.corpus.id
    evidence = aws_s3_bucket.evidence.id
  }

  bucket = each.value
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "all" {
  for_each = {
    uploads  = aws_s3_bucket.uploads.id
    corpus   = aws_s3_bucket.corpus.id
    evidence = aws_s3_bucket.evidence.id
  }

  bucket = each.value

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.tenant.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "all" {
  for_each = {
    uploads  = aws_s3_bucket.uploads.id
    corpus   = aws_s3_bucket.corpus.id
    evidence = aws_s3_bucket.evidence.id
  }

  bucket                  = each.value
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "audit_events" {
  name         = "${local.name_prefix}-audit-events"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "tenantReviewId"
  range_key    = "eventTime"

  attribute {
    name = "tenantReviewId"
    type = "S"
  }

  attribute {
    name = "eventTime"
    type = "S"
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.tenant.arn
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_log_group" "application" {
  name              = "/aws/rulix/${var.tenant_slug}/application"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.tenant.arn
  tags              = local.common_tags
}

data "aws_iam_policy_document" "worker" {
  statement {
    sid = "TenantBucketAccess"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:ListBucket"
    ]
    resources = [
      aws_s3_bucket.uploads.arn,
      "${aws_s3_bucket.uploads.arn}/*",
      aws_s3_bucket.corpus.arn,
      "${aws_s3_bucket.corpus.arn}/*",
      aws_s3_bucket.evidence.arn,
      "${aws_s3_bucket.evidence.arn}/*"
    ]
  }

  statement {
    sid = "TenantKmsAccess"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey"
    ]
    resources = [aws_kms_key.tenant.arn]
  }

  statement {
    sid = "AuditTableAccess"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem"
    ]
    resources = [aws_dynamodb_table.audit_events.arn]
  }

  statement {
    sid = "BedrockInference"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:Retrieve",
      "bedrock:RetrieveAndGenerate"
    ]
    resources = var.bedrock_resource_arns
  }
}

resource "aws_iam_policy" "worker" {
  name   = "${local.name_prefix}-worker"
  policy = data.aws_iam_policy_document.worker.json
  tags   = local.common_tags
}
