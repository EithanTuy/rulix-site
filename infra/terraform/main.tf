terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.80.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

locals {
  name_prefix                 = "rulix-${var.tenant_slug}"
  log_group_name              = "/aws/rulix/${var.tenant_slug}/application"
  lambda_log_group_name       = "/aws/lambda/${local.name_prefix}-app"
  audit_lambda_name           = "${local.name_prefix}-audit-writer"
  audit_lambda_log_group_name = "/aws/lambda/${local.audit_lambda_name}"
  log_group_arn               = "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:${local.log_group_name}"
  lambda_log_group_arn        = "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:${local.lambda_log_group_name}"
  audit_lambda_log_group_arn  = "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:${local.audit_lambda_log_group_name}"
  approved_ai_region          = coalesce(var.approved_region, var.aws_region)
  common_tags = {
    Application = "Rulix ECCN"
    Tenant      = var.tenant_slug
    DataScope   = "export-classification-review"
  }
}

data "aws_iam_policy_document" "tenant_kms" {
  statement {
    sid = "EnableTenantAccountAdministration"
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid = "AllowCloudWatchLogsEncryption"
    principals {
      type        = "Service"
      identifiers = ["logs.${var.aws_region}.amazonaws.com"]
    }
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo"
    ]
    resources = ["*"]
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values = [
        local.log_group_arn,
        "${local.log_group_arn}:*",
        local.lambda_log_group_arn,
        "${local.lambda_log_group_arn}:*",
        local.audit_lambda_log_group_arn,
        "${local.audit_lambda_log_group_arn}:*"
      ]
    }
  }
}

resource "aws_kms_key" "tenant" {
  description             = "Rulix ECCN tenant data key for ${var.tenant_slug}"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.tenant_kms.json
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

resource "aws_s3_bucket_ownership_controls" "all" {
  for_each = {
    uploads  = aws_s3_bucket.uploads.id
    corpus   = aws_s3_bucket.corpus.id
    evidence = aws_s3_bucket.evidence.id
  }

  bucket = each.value
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "all" {
  for_each = {
    uploads  = aws_s3_bucket.uploads.id
    corpus   = aws_s3_bucket.corpus.id
    evidence = aws_s3_bucket.evidence.id
  }

  bucket = each.value
  rule {
    id     = "retained-version-hygiene"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
    noncurrent_version_expiration {
      noncurrent_days = 2555
    }
  }
}

data "aws_iam_policy_document" "tenant_bucket_tls" {
  for_each = {
    uploads  = aws_s3_bucket.uploads.arn
    corpus   = aws_s3_bucket.corpus.arn
    evidence = aws_s3_bucket.evidence.arn
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      each.value,
      "${each.value}/*"
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenyWrongEncryption"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${each.value}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  statement {
    sid       = "DenyWrongKmsKey"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${each.value}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_key.tenant.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "tenant_bucket_tls" {
  for_each = {
    uploads  = aws_s3_bucket.uploads.id
    corpus   = aws_s3_bucket.corpus.id
    evidence = aws_s3_bucket.evidence.id
  }

  bucket = each.value
  policy = data.aws_iam_policy_document.tenant_bucket_tls[each.key].json
}

resource "aws_dynamodb_table" "audit_events" {
  name                        = "${local.name_prefix}-audit-events"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "tenantReviewId"
  range_key                   = "eventTime"
  deletion_protection_enabled = var.data_deletion_protection_enabled

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

resource "aws_dynamodb_table" "auth" {
  name                        = "${local.name_prefix}-auth"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = var.data_deletion_protection_enabled

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAtEpoch"
    enabled        = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.tenant.arn
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = merge(local.common_tags, {
    DataClass = "auth"
  })
}

resource "aws_dynamodb_table" "account_state" {
  name                        = "${local.name_prefix}-account-state"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  deletion_protection_enabled = var.data_deletion_protection_enabled

  attribute {
    name = "pk"
    type = "S"
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.tenant.arn
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = merge(local.common_tags, {
    DataClass = "account-review-state"
  })
}

resource "aws_cloudwatch_log_group" "application" {
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.tenant.arn
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = local.lambda_log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.tenant.arn
  tags              = local.common_tags
}

data "aws_iam_policy_document" "analysis_worker" {
  statement {
    sid = "ReadAnalysisInputs"
    actions = [
      "s3:GetObject",
      "s3:ListBucket"
    ]
    resources = [
      aws_s3_bucket.uploads.arn,
      "${aws_s3_bucket.uploads.arn}/*",
      aws_s3_bucket.corpus.arn,
      "${aws_s3_bucket.corpus.arn}/*"
    ]
  }

  statement {
    sid = "WriteAnalysisEvidence"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:ListBucket"
    ]
    resources = [
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

  dynamic "statement" {
    for_each = var.workspace_mode == "normalized" ? [] : [1]
    content {
      sid       = "ReadLegacyAccountState"
      actions   = ["dynamodb:GetItem"]
      resources = [aws_dynamodb_table.account_state.arn]
    }
  }

  statement {
    sid     = "ReadNormalizedWorkspace"
    actions = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = [
      aws_dynamodb_table.workspace.arn,
      "${aws_dynamodb_table.workspace.arn}/index/*"
    ]
  }

  statement {
    sid       = "ReadWorkspaceContent"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.workspace_content.arn}/tenant/${var.tenant_slug}/*"]
  }

  statement {
    sid       = "DecryptWorkspaceViaServices"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [aws_kms_key.workspace.arn]
    condition {
      test     = "StringLike"
      variable = "kms:ViaService"
      values = [
        "dynamodb.${var.aws_region}.amazonaws.com",
        "s3.${var.aws_region}.amazonaws.com"
      ]
    }
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

resource "aws_iam_policy" "analysis_worker" {
  name        = "${local.name_prefix}-analysis-worker"
  description = "Read normalized analysis inputs, write S3 evidence, and invoke approved Bedrock models without workspace mutation."
  policy      = data.aws_iam_policy_document.analysis_worker.json
  tags        = local.common_tags
}
