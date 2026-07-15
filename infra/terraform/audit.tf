# The audit writer consumes only immutable AU inserts from the normalized
# workspace stream. The application has no invoke or audit-table capability.
data "archive_file" "audit_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../../audit-lambda-build"
  output_path = "${path.module}/audit-function.zip"
}

resource "aws_cloudwatch_log_group" "audit_lambda" {
  name              = local.audit_lambda_log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.tenant.arn
  tags              = local.common_tags
}

resource "aws_iam_role" "audit_lambda" {
  name               = "${local.audit_lambda_name}-exec"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "audit_lambda" {
  statement {
    sid       = "AppendAuditEvents"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [aws_dynamodb_table.audit_events.arn]
  }

  statement {
    sid = "ConsumeWorkspaceAuditOutbox"
    actions = [
      "dynamodb:DescribeStream",
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
      "dynamodb:ListStreams"
    ]
    resources = [aws_dynamodb_table.workspace.stream_arn]
  }

  statement {
    sid       = "SendFailedStreamBatches"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.audit_stream_dlq.arn]
  }

  # DynamoDB decrypts the table key on behalf of each active caller. This
  # permits only that forward-access-session operation for this table/account;
  # the Lambda role cannot call KMS directly or use the key for another table.
  statement {
    sid       = "DecryptAuditTableKeyViaDynamoDB"
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
      values   = [aws_dynamodb_table.audit_events.name]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:dynamodb:subscriberId"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid       = "DecryptWorkspaceStreamKeyViaDynamoDB"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.workspace.arn]
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
  }

  statement {
    sid = "WriteAuditFunctionLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = ["${aws_cloudwatch_log_group.audit_lambda.arn}:*"]
  }
}

resource "aws_iam_role_policy" "audit_lambda" {
  name   = "${local.audit_lambda_name}-runtime"
  role   = aws_iam_role.audit_lambda.id
  policy = data.aws_iam_policy_document.audit_lambda.json
}

resource "aws_lambda_function" "audit_writer" {
  function_name                  = local.audit_lambda_name
  role                           = aws_iam_role.audit_lambda.arn
  runtime                        = "nodejs24.x"
  handler                        = "handler.handler"
  filename                       = data.archive_file.audit_lambda.output_path
  source_code_hash               = data.archive_file.audit_lambda.output_base64sha256
  memory_size                    = 256
  timeout                        = 10
  reserved_concurrent_executions = 5

  environment {
    variables = {
      RULIX_AUDIT_TABLE          = aws_dynamodb_table.audit_events.name
      RULIX_AUDIT_TENANT_ID      = var.tenant_slug
      RULIX_AUDIT_WRITER_ID      = local.audit_lambda_name
      RULIX_WORKSPACE_STREAM_ARN = aws_dynamodb_table.workspace.stream_arn
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.audit_lambda,
    aws_iam_role_policy.audit_lambda
  ]

  tags = local.common_tags
}
