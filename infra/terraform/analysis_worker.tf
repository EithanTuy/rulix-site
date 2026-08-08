data "archive_file" "analysis_worker_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../../analysis-worker-lambda-build"
  output_path = "${path.module}/analysis-worker-function.zip"
}

resource "aws_sqs_queue" "analysis_dlq" {
  name                      = "${local.name_prefix}-analysis-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

resource "aws_sqs_queue" "analysis" {
  name                       = "${local.name_prefix}-analysis"
  visibility_timeout_seconds = 5400
  message_retention_seconds  = 1209600
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.analysis_dlq.arn
    maxReceiveCount     = 3
  })
  tags = local.common_tags
}

resource "aws_iam_role" "analysis_worker" {
  name               = "${local.name_prefix}-analysis-worker-exec"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "analysis_worker_logs" {
  role       = aws_iam_role.analysis_worker.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "analysis_worker_access" {
  role       = aws_iam_role.analysis_worker.name
  policy_arn = aws_iam_policy.analysis_worker.arn
}

resource "aws_cloudwatch_log_group" "analysis_worker" {
  name              = local.analysis_worker_log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.tenant.arn
  tags              = local.common_tags
}

resource "aws_lambda_function" "analysis_worker" {
  function_name                  = local.analysis_worker_name
  role                           = aws_iam_role.analysis_worker.arn
  runtime                        = "nodejs24.x"
  handler                        = "handler.handler"
  filename                       = data.archive_file.analysis_worker_lambda.output_path
  source_code_hash               = data.archive_file.analysis_worker_lambda.output_base64sha256
  kms_key_arn                    = aws_kms_key.tenant.arn
  memory_size                    = 2048
  timeout                        = 900
  reserved_concurrent_executions = var.analysis_worker_reserved_concurrency

  environment {
    variables = merge({
      NODE_ENV                          = "production"
      BEDROCK_ENABLED                   = tostring(var.bedrock_enabled)
      BEDROCK_MODEL                     = var.bedrock_deep_model
      BEDROCK_DEEP_MODEL                = var.bedrock_deep_model
      RULIX_APPROVED_MODEL_IDS          = jsonencode(var.approved_model_ids)
      RULIX_AI_DATA_CLASS               = var.ai_data_class
      RULIX_APPROVED_PROVIDER           = var.approved_provider
      RULIX_APPROVED_REGION             = local.approved_ai_region
      RULIX_CONTROLLED_DATA_MODE        = var.controlled_data_mode
      RULIX_AI_MAX_CONCURRENT           = tostring(var.ai_max_concurrent)
      RULIX_AI_REQUESTS_PER_MINUTE      = tostring(var.ai_requests_per_minute)
      RULIX_AI_TOKENS_PER_DAY           = tostring(var.ai_tokens_per_day)
      RULIX_AI_SPEND_USD_PER_DAY        = tostring(var.ai_spend_usd_per_day)
      RULIX_AI_MAX_TOKENS_PER_CALL      = tostring(var.ai_max_tokens_per_call)
      RULIX_AI_MAX_COST_USD_PER_CALL    = tostring(var.ai_max_cost_usd_per_call)
      RULIX_AI_LEASE_SECONDS            = tostring(var.ai_lease_seconds)
      RULIX_AUTH_TABLE                  = aws_dynamodb_table.auth.name
      RULIX_ACCOUNT_TABLE               = aws_dynamodb_table.account_state.name
      RULIX_WORKSPACE_TABLE             = aws_dynamodb_table.workspace.name
      RULIX_WORKSPACE_CONTENT_BUCKET    = aws_s3_bucket.workspace_content.bucket
      RULIX_WORKSPACE_KMS_KEY_ARN       = aws_kms_key.workspace.arn
      RULIX_WORKSPACE_MODE              = var.workspace_mode
      RULIX_WORKSPACE_CURSOR_ACTIVE_KID = var.workspace_cursor_key_id
      RULIX_WORKSPACE_CURSOR_KEYS_JSON  = jsonencode(local.workspace_cursor_keys)
      RULIX_TENANT_ID                   = var.tenant_slug
      RULIX_EVIDENCE_BUCKET             = aws_s3_bucket.evidence.bucket
      RULIX_EVIDENCE_KMS_KEY_ID         = aws_kms_key.tenant.arn
    }, var.bedrock_prices_json == "" ? {} : { RULIX_BEDROCK_PRICES = var.bedrock_prices_json })
  }

  depends_on = [
    aws_cloudwatch_log_group.analysis_worker,
    aws_iam_role_policy_attachment.analysis_worker_access,
    aws_iam_role_policy_attachment.analysis_worker_logs
  ]
  tags = local.common_tags
}

resource "aws_lambda_event_source_mapping" "analysis_worker" {
  event_source_arn                   = aws_sqs_queue.analysis.arn
  function_name                      = aws_lambda_function.analysis_worker.arn
  batch_size                         = 1
  maximum_batching_window_in_seconds = 0
  function_response_types            = ["ReportBatchItemFailures"]
  enabled                            = true
}

data "aws_iam_policy_document" "app_analysis_enqueue" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.analysis.arn]
  }
}

resource "aws_iam_role_policy" "app_analysis_enqueue" {
  name   = "${local.fn_name}-analysis-enqueue"
  role   = aws_iam_role.lambda_exec.id
  policy = data.aws_iam_policy_document.app_analysis_enqueue.json
}

resource "aws_cloudwatch_metric_alarm" "analysis_dlq_visible" {
  alarm_name          = "${local.name_prefix}-analysis-dlq-visible"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "Analysis jobs exhausted bounded retries and entered the DLQ."
  dimensions          = { QueueName = aws_sqs_queue.analysis_dlq.name }
  tags                = local.common_tags
}
