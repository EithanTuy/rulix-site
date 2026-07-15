# Normalized workspace storage. Application commands mutate only entity-scoped
# items in this table; the legacy whole-account table is a migration source.

resource "aws_kms_key" "workspace" {
  description             = "Rulix normalized workspace and immutable content key for ${var.tenant_slug}"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  tags                    = merge(local.common_tags, { DataClass = "workspace-v2" })
}

resource "aws_kms_alias" "workspace" {
  name          = "alias/${local.name_prefix}-workspace"
  target_key_id = aws_kms_key.workspace.key_id
}

resource "aws_dynamodb_table" "workspace" {
  name                        = "${local.name_prefix}-workspace-v2"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = var.data_deletion_protection_enabled
  stream_enabled              = true
  stream_view_type            = "NEW_IMAGE"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  attribute {
    name = "gsi2pk"
    type = "S"
  }

  attribute {
    name = "gsi2sk"
    type = "S"
  }

  global_secondary_index {
    name = "gsi1"

    key_schema {
      attribute_name = "gsi1pk"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "gsi1sk"
      key_type       = "RANGE"
    }

    projection_type = "ALL"
  }

  global_secondary_index {
    name = "gsi2"

    key_schema {
      attribute_name = "gsi2pk"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "gsi2sk"
      key_type       = "RANGE"
    }

    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.workspace.arn
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = merge(local.common_tags, { DataClass = "normalized-workspace" })
}

resource "aws_s3_bucket" "workspace_content" {
  bucket = "${local.name_prefix}-workspace-${data.aws_caller_identity.current.account_id}"
  tags   = merge(local.common_tags, { DataClass = "workspace-content" })
}

resource "aws_s3_bucket_ownership_controls" "workspace_content" {
  bucket = aws_s3_bucket.workspace_content.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_public_access_block" "workspace_content" {
  bucket                  = aws_s3_bucket.workspace_content.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "workspace_content" {
  bucket = aws_s3_bucket.workspace_content.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "workspace_content" {
  bucket = aws_s3_bucket.workspace_content.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.workspace.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "workspace_content" {
  bucket = aws_s3_bucket.workspace_content.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }

  # Committed pointers pin VersionId, so blanket noncurrent-version expiry is
  # unsafe: a later version must never expire the pinned version. Runtime
  # tenant/* orphans are handled only by the fenced, reference-aware GC role;
  # lifecycle expiry is limited to explicit operator-owned scratch namespaces.
  rule {
    id     = "expire-uncommitted-content"
    status = "Enabled"
    filter { prefix = "orphan/" }
    expiration { days = 7 }
    noncurrent_version_expiration { noncurrent_days = 7 }
  }

  rule {
    id     = "expire-temporary-content"
    status = "Enabled"
    filter { prefix = "tmp/" }
    expiration { days = 7 }
    noncurrent_version_expiration { noncurrent_days = 7 }
  }
}

data "aws_iam_policy_document" "workspace_content_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.workspace_content.arn,
      "${aws_s3_bucket.workspace_content.arn}/*"
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
    resources = ["${aws_s3_bucket.workspace_content.arn}/*"]
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
    resources = ["${aws_s3_bucket.workspace_content.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_key.workspace.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "workspace_content" {
  bucket = aws_s3_bucket.workspace_content.id
  policy = data.aws_iam_policy_document.workspace_content_bucket.json
}

resource "random_password" "workspace_cursor_hmac" {
  length  = 64
  special = false
  keepers = { key_id = var.workspace_cursor_key_id }
}

locals {
  workspace_cursor_previous_keys = try(jsondecode(var.workspace_cursor_previous_keys_json), {})
  workspace_cursor_keys = merge(local.workspace_cursor_previous_keys, {
    (var.workspace_cursor_key_id) = random_password.workspace_cursor_hmac.result
  })
}

resource "random_password" "migration_receipt_hmac" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "migration_receipt_hmac" {
  name                    = "${local.name_prefix}/workspace-migration-receipt-hmac"
  kms_key_id              = aws_kms_key.workspace.arn
  recovery_window_in_days = 30
  tags                    = local.common_tags
}

resource "aws_secretsmanager_secret_version" "migration_receipt_hmac" {
  secret_id     = aws_secretsmanager_secret.migration_receipt_hmac.id
  secret_string = random_password.migration_receipt_hmac.result
}

data "aws_iam_policy_document" "workspace_migration_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = var.workspace_migration_principal_arns
    }
  }
}

resource "aws_iam_role" "workspace_migration" {
  name                 = "${local.name_prefix}-workspace-migration"
  assume_role_policy   = data.aws_iam_policy_document.workspace_migration_assume.json
  max_session_duration = 3600
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "workspace_migration" {
  statement {
    sid       = "ReadLegacyAccounts"
    actions   = ["dynamodb:GetItem", "dynamodb:Scan"]
    resources = [aws_dynamodb_table.account_state.arn]
  }

  # DynamoDB decrypts the legacy table key on behalf of the migration role.
  # Bind that forward-access-session permission to this account, service, and
  # exact source table so the role cannot use the tenant key directly.
  statement {
    sid       = "DecryptLegacyAccountStateViaDynamoDB"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.tenant.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["dynamodb.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:dynamodb:tableName"
      values   = [aws_dynamodb_table.account_state.name]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:dynamodb:subscriberId"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid = "MigrateNormalizedWorkspace"
    actions = [
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:TransactWriteItems",
      "dynamodb:UpdateItem"
    ]
    resources = [
      aws_dynamodb_table.workspace.arn,
      "${aws_dynamodb_table.workspace.arn}/index/*"
    ]
  }

  statement {
    sid       = "MigrateImmutableContent"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.workspace_content.arn}/tenant/${var.tenant_slug}/*"]
  }

  statement {
    sid       = "ReadMigrationReceiptSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.migration_receipt_hmac.arn]
  }

  statement {
    sid = "WorkspaceKmsViaServices"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey"
    ]
    resources = [aws_kms_key.workspace.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "StringLike"
      variable = "kms:ViaService"
      values = [
        "dynamodb.${var.aws_region}.amazonaws.com",
        "s3.${var.aws_region}.amazonaws.com",
        "secretsmanager.${var.aws_region}.amazonaws.com"
      ]
    }
  }
}

resource "aws_iam_role_policy" "workspace_migration" {
  name   = "${local.name_prefix}-workspace-migration"
  role   = aws_iam_role.workspace_migration.id
  policy = data.aws_iam_policy_document.workspace_migration.json
}

# Offline, reference-aware garbage collection is deliberately separated from
# the app role. The app can never delete content versions during an ambiguous
# DynamoDB outcome; this role scans committed pointers first and deletes only
# exact, aged, unreferenced S3 VersionIds.
resource "aws_iam_role" "workspace_content_gc" {
  name                 = "${local.name_prefix}-workspace-content-gc"
  assume_role_policy   = data.aws_iam_policy_document.workspace_migration_assume.json
  max_session_duration = 3600
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "workspace_content_gc" {
  statement {
    sid       = "ScanCommittedWorkspacePointers"
    actions   = ["dynamodb:Scan"]
    resources = [aws_dynamodb_table.workspace.arn]
  }

  statement {
    sid       = "CoordinateTenantGcLease"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.workspace.arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["TENANT#${var.tenant_slug}#SYSTEM"]
    }
  }

  statement {
    sid       = "ListTenantContentVersions"
    actions   = ["s3:ListBucketVersions"]
    resources = [aws_s3_bucket.workspace_content.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["tenant/${var.tenant_slug}/*"]
    }
  }

  statement {
    sid       = "DeleteExactOrphanVersions"
    actions   = ["s3:DeleteObjectVersion"]
    resources = ["${aws_s3_bucket.workspace_content.arn}/tenant/${var.tenant_slug}/*"]
  }

  statement {
    sid = "WorkspaceKmsViaServices"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey"
    ]
    resources = [aws_kms_key.workspace.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "StringLike"
      variable = "kms:ViaService"
      values = [
        "dynamodb.${var.aws_region}.amazonaws.com",
        "s3.${var.aws_region}.amazonaws.com"
      ]
    }
  }
}

resource "aws_iam_role_policy" "workspace_content_gc" {
  name   = "${local.name_prefix}-workspace-content-gc"
  role   = aws_iam_role.workspace_content_gc.id
  policy = data.aws_iam_policy_document.workspace_content_gc.json
}

resource "aws_sqs_queue" "audit_stream_dlq" {
  name                      = "${local.name_prefix}-audit-stream-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

resource "aws_lambda_event_source_mapping" "workspace_audit" {
  event_source_arn                   = aws_dynamodb_table.workspace.stream_arn
  function_name                      = aws_lambda_function.audit_writer.arn
  starting_position                  = "LATEST"
  batch_size                         = 10
  maximum_batching_window_in_seconds = 1
  bisect_batch_on_function_error     = true
  maximum_retry_attempts             = 10
  maximum_record_age_in_seconds      = 3600
  function_response_types            = ["ReportBatchItemFailures"]

  destination_config {
    on_failure { destination_arn = aws_sqs_queue.audit_stream_dlq.arn }
  }

  depends_on = [aws_iam_role_policy.audit_lambda]
}

resource "aws_cloudwatch_metric_alarm" "audit_iterator_age" {
  alarm_name          = "${local.name_prefix}-audit-iterator-age"
  namespace           = "AWS/Lambda"
  metric_name         = "IteratorAge"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 300000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = aws_lambda_function.audit_writer.function_name }
}

resource "aws_cloudwatch_metric_alarm" "audit_errors" {
  alarm_name          = "${local.name_prefix}-audit-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = aws_lambda_function.audit_writer.function_name }
}

resource "aws_cloudwatch_metric_alarm" "audit_throttles" {
  alarm_name          = "${local.name_prefix}-audit-throttles"
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = aws_lambda_function.audit_writer.function_name }
}

resource "aws_cloudwatch_metric_alarm" "audit_dlq" {
  alarm_name          = "${local.name_prefix}-audit-dlq-visible"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = aws_sqs_queue.audit_stream_dlq.name }
}

resource "aws_cloudwatch_metric_alarm" "workspace_throttles" {
  alarm_name          = "${local.name_prefix}-workspace-throttles"
  namespace           = "AWS/DynamoDB"
  metric_name         = "ThrottledRequests"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { TableName = aws_dynamodb_table.workspace.name }
}

resource "aws_cloudwatch_log_metric_filter" "app_kms_access_denied" {
  name           = "${local.name_prefix}-app-kms-access-denied"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "\"AccessDenied\" \"kms\""

  metric_transformation {
    name      = "WorkspaceKmsAccessDenied"
    namespace = "Rulix/Security"
    value     = "1"
  }
}

resource "aws_cloudwatch_log_metric_filter" "audit_kms_access_denied" {
  name           = "${local.name_prefix}-audit-kms-access-denied"
  log_group_name = aws_cloudwatch_log_group.audit_lambda.name
  pattern        = "\"AccessDenied\" \"kms\""

  metric_transformation {
    name      = "WorkspaceKmsAccessDenied"
    namespace = "Rulix/Security"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "workspace_kms_access_denied" {
  alarm_name          = "${local.name_prefix}-workspace-kms-access-denied"
  namespace           = "Rulix/Security"
  metric_name         = "WorkspaceKmsAccessDenied"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}
