# Public app hosting for Rulix ECCN on AWS Lambda + Function URL, fronted by
# CloudFront for the custom domain app.rulix.cloud.
#
# The single Node service (Express serving the built Vite client + /api) is
# bundled by `npm run build:lambda` into ../../lambda-build, zipped here, and
# run on the Node 24 Lambda runtime. CloudFront terminates TLS for the custom
# domain and forwards everything to the Function URL. See docs/aws-deploy.md.

locals {
  fn_name = "rulix-${var.tenant_slug}-app"
  configured_bedrock_models = toset([
    var.bedrock_model,
    var.bedrock_deep_model,
    var.bedrock_outreach_model,
    var.bedrock_personalization_model,
    var.bedrock_lead_search_model
  ])
}

# Exact memo-chat content is retained only long enough for an officer to
# inspect a pending request. Generate a dedicated AES-256 key and keep prior
# keys only during the documented, bounded rotation overlap.
resource "random_id" "ai_approval_preview" {
  byte_length = 32
  keepers = {
    key_id = var.ai_approval_preview_key_id
  }
}

locals {
  ai_approval_preview_previous_keys = try(jsondecode(var.ai_approval_preview_previous_keys_json), {})
  ai_approval_preview_keys = merge(local.ai_approval_preview_previous_keys, {
    (var.ai_approval_preview_key_id) = random_id.ai_approval_preview.b64_url
  })
  ai_approval_preview_keys_json = sensitive(jsonencode(local.ai_approval_preview_keys))
}

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambda-build"
  output_path = "${path.module}/function.zip"
}

# ---- Lambda execution role ----
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda_exec" {
  name               = "${local.fn_name}-exec"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "lambda_bedrock" {
  statement {
    sid = "BedrockModelInvocation"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream"
    ]
    resources = var.bedrock_resource_arns
  }
}

resource "aws_iam_role_policy" "lambda_bedrock" {
  name   = "${local.fn_name}-bedrock"
  role   = aws_iam_role.lambda_exec.id
  policy = data.aws_iam_policy_document.lambda_bedrock.json
}

data "aws_iam_policy_document" "lambda_auth" {
  statement {
    sid = "AuthTableCommands"
    actions = [
      "dynamodb:ConditionCheckItem",
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:TransactWriteItems",
      "dynamodb:UpdateItem"
    ]
    resources = [aws_dynamodb_table.auth.arn]
  }

  dynamic "statement" {
    for_each = var.workspace_mode == "normalized" ? [] : [1]
    content {
      sid = "LegacyAccountState"
      actions = var.workspace_mode == "legacy" ? [
        "dynamodb:GetItem",
        "dynamodb:PutItem"
      ] : ["dynamodb:GetItem"]
      resources = [aws_dynamodb_table.account_state.arn]
    }
  }

  statement {
    sid = "NormalizedWorkspaceCommands"
    actions = [
      "dynamodb:BatchGetItem",
      "dynamodb:ConditionCheckItem",
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
    sid       = "ImmutableWorkspaceContent"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.workspace_content.arn}/tenant/${var.tenant_slug}/*"]
  }

  statement {
    sid = "AuthEmailDelivery"
    actions = [
      "ses:SendEmail"
    ]
    resources = ["*"]
  }

  statement {
    sid = "TenantKmsForAuthTables"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey"
    ]
    resources = [aws_kms_key.tenant.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["dynamodb.${var.aws_region}.amazonaws.com"]
    }
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
      test     = "StringLike"
      variable = "kms:ViaService"
      values = [
        "dynamodb.${var.aws_region}.amazonaws.com",
        "s3.${var.aws_region}.amazonaws.com"
      ]
    }
  }
}

resource "aws_iam_role_policy" "lambda_auth" {
  name   = "${local.fn_name}-auth"
  role   = aws_iam_role.lambda_exec.id
  policy = data.aws_iam_policy_document.lambda_auth.json
}

# ---- The function ----
resource "aws_lambda_function" "app" {
  function_name                  = local.fn_name
  role                           = aws_iam_role.lambda_exec.arn
  runtime                        = "nodejs24.x"
  handler                        = "handler.handler"
  filename                       = data.archive_file.lambda.output_path
  source_code_hash               = data.archive_file.lambda.output_base64sha256
  kms_key_arn                    = aws_kms_key.tenant.arn
  memory_size                    = 1024
  timeout                        = 120
  reserved_concurrent_executions = var.app_reserved_concurrency

  environment {
    variables = merge(
      {
        NODE_ENV                                = "production"
        RULIX_DIST_DIR                          = "dist"
        BEDROCK_ENABLED                         = tostring(var.bedrock_enabled)
        BEDROCK_MODEL                           = var.bedrock_model
        BEDROCK_DEEP_MODEL                      = var.bedrock_deep_model
        BEDROCK_OUTREACH_MODEL                  = var.bedrock_outreach_model
        BEDROCK_PERSONALIZATION_MODEL           = var.bedrock_personalization_model
        BEDROCK_LEAD_SEARCH_MODEL               = var.bedrock_lead_search_model
        RULIX_APPROVED_MODEL_IDS                = jsonencode(var.approved_model_ids)
        RULIX_AI_DATA_CLASS                     = var.ai_data_class
        RULIX_APPROVED_PROVIDER                 = var.approved_provider
        RULIX_APPROVED_REGION                   = local.approved_ai_region
        RULIX_CONTROLLED_DATA_MODE              = var.controlled_data_mode
        RULIX_AI_MAX_CONCURRENT                 = tostring(var.ai_max_concurrent)
        RULIX_AI_REQUESTS_PER_MINUTE            = tostring(var.ai_requests_per_minute)
        RULIX_AI_TOKENS_PER_DAY                 = tostring(var.ai_tokens_per_day)
        RULIX_AI_SPEND_USD_PER_DAY              = tostring(var.ai_spend_usd_per_day)
        RULIX_AI_MAX_TOKENS_PER_CALL            = tostring(var.ai_max_tokens_per_call)
        RULIX_AI_MAX_COST_USD_PER_CALL          = tostring(var.ai_max_cost_usd_per_call)
        RULIX_AI_LEASE_SECONDS                  = tostring(var.ai_lease_seconds)
        RULIX_AI_APPROVAL_PREVIEW_ACTIVE_KEY_ID = var.ai_approval_preview_key_id
        RULIX_AI_APPROVAL_PREVIEW_KEYS_JSON     = local.ai_approval_preview_keys_json
        RULIX_AUTH_TABLE                        = aws_dynamodb_table.auth.name
        RULIX_ACCOUNT_TABLE                     = aws_dynamodb_table.account_state.name
        RULIX_WORKSPACE_TABLE                   = aws_dynamodb_table.workspace.name
        RULIX_WORKSPACE_CONTENT_BUCKET          = aws_s3_bucket.workspace_content.bucket
        RULIX_WORKSPACE_KMS_KEY_ARN             = aws_kms_key.workspace.arn
        RULIX_WORKSPACE_MODE                    = var.workspace_mode
        RULIX_WORKSPACE_CURSOR_ACTIVE_KID       = var.workspace_cursor_key_id
        RULIX_WORKSPACE_CURSOR_KEYS_JSON        = jsonencode(local.workspace_cursor_keys)
        RULIX_TENANT_ID                         = var.tenant_slug
        RULIX_ALLOWED_ORIGINS = join(",", distinct(compact(concat(
          [var.app_base_url, var.dashboard_domain == "" ? "" : "https://${var.dashboard_domain}"],
          var.marketing_origins
        ))))
        APP_BASE_URL           = var.app_base_url
        AUTH_INVITE_TTL_HOURS  = tostring(var.auth_invite_ttl_hours)
        AUTH_RESET_TTL_MINUTES = tostring(var.auth_reset_ttl_minutes)
        AUTH_SESSION_TTL_HOURS = tostring(var.auth_session_ttl_hours)
      },
      var.bedrock_prices_json == "" ? {} : { RULIX_BEDROCK_PRICES = var.bedrock_prices_json },
      var.auth_email_from == "" ? {} : { AUTH_EMAIL_FROM = var.auth_email_from },
      var.auth_bootstrap_secret == "" ? {} : { AUTH_BOOTSTRAP_SECRET = var.auth_bootstrap_secret }
    )
  }

  lifecycle {
    precondition {
      condition = (
        (var.approved_provider == "amazon-bedrock" && local.approved_ai_region == var.aws_region) ||
        (var.approved_provider == "anthropic-direct" && local.approved_ai_region == "global")
      )
      error_message = "amazon-bedrock must use aws_region as approved_region; anthropic-direct must use global."
    }

    precondition {
      condition     = var.controlled_data_mode != "approved" || var.approved_provider == "amazon-bedrock"
      error_message = "controlled_data_mode may be approved only for amazon-bedrock."
    }

    precondition {
      condition = var.controlled_data_mode != "approved" || (
        length(var.approved_model_ids) > 0 &&
        alltrue([for model in local.configured_bedrock_models : contains(var.approved_model_ids, model)])
      )
      error_message = "controlled_data_mode=approved requires every configured Bedrock workflow model in approved_model_ids."
    }

    precondition {
      condition = var.controlled_data_mode != "approved" || alltrue([
        for model in local.configured_bedrock_models :
        !can(regex("^(global|us|eu|apac|jp|au)\\.", model)) &&
        (!startswith(model, "arn:") || can(regex(
          "^arn:(aws|aws-us-gov|aws-cn):bedrock:${local.approved_ai_region}:",
          model
        )))
      ])
      error_message = "Controlled-data workflows forbid cross-region profiles and require Bedrock ARNs to match approved_region."
    }

    precondition {
      condition = alltrue([
        for model in var.approved_model_ids :
        startswith(model, "arn:")
        ? contains(var.bedrock_resource_arns, model)
        : anytrue([for arn in var.bedrock_resource_arns : endswith(arn, "/${model}")])
      ])
      error_message = "Every approved_model_ids entry must be covered by an exact bedrock_resource_arns entry."
    }
  }

  tags = local.common_tags
}

# Function URL origin. Production custom-domain deployments require SigV4 and
# grant only their CloudFront distribution permission to invoke the function.
# The public NONE mode remains available solely for the documented, temporary
# no-domain bootstrap/smoke-test configuration.
resource "aws_lambda_function_url" "app" {
  function_name      = aws_lambda_function.app.function_name
  authorization_type = var.custom_domain == "" && var.allow_public_function_url_bootstrap ? "NONE" : "AWS_IAM"
}

resource "aws_cloudfront_origin_access_control" "app" {
  count = var.custom_domain == "" ? 0 : 1

  name                              = "${local.fn_name}-lambda-url"
  description                       = "SigV4 access from the Rulix CloudFront distribution to its Lambda URL"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ---- Edge security policy ----
resource "aws_cloudfront_response_headers_policy" "app_security" {
  count   = var.custom_domain == "" ? 0 : 1
  name    = "${local.fn_name}-security-headers"
  comment = "Security and noindex headers for Rulix app/dashboard"

  security_headers_config {
    content_security_policy {
      content_security_policy = "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: https:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; upgrade-insecure-requests"
      override                = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }

    xss_protection {
      mode_block = true
      protection = true
      override   = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=(), payment=()"
      override = true
    }

    items {
      header   = "X-Robots-Tag"
      value    = "noindex, nofollow"
      override = false
    }
  }
}

resource "aws_wafv2_regex_pattern_set" "ai_routes" {
  count = var.custom_domain == "" || !var.enable_waf ? 0 : 1
  name  = "${local.fn_name}-ai-routes"
  scope = "CLOUDFRONT"

  regular_expression { regex_string = "^/api/ai/memo-builder-chat$" }
  regular_expression { regex_string = "^/api/ai-approval-requests$" }
  regular_expression { regex_string = "^/api/reviews/[^/]+/(analyze|chat)$" }
  regular_expression { regex_string = "^/api/documents/extract$" }
  regular_expression { regex_string = "^/api/admin/outreach/(generate|drafts/[^/]+/personalize)$" }
  regular_expression { regex_string = "^/api/admin/leads/search$" }

  tags = local.common_tags
}

resource "aws_wafv2_regex_pattern_set" "large_post_body_routes" {
  count = var.custom_domain == "" || !var.enable_waf ? 0 : 1
  name  = "${local.fn_name}-large-post-body-routes"
  scope = "CLOUDFRONT"

  regular_expression { regex_string = "^/api/documents/extract$" }
  regular_expression { regex_string = "^/api/ai/memo-builder-chat$" }
  regular_expression { regex_string = "^/api/ai-approval-requests$" }
  regular_expression { regex_string = "^/api/reviews$" }
  regular_expression { regex_string = "^/api/reviews/[A-Za-z0-9_-]+/chat$" }

  tags = local.common_tags
}

resource "aws_wafv2_regex_pattern_set" "large_patch_body_routes" {
  count = var.custom_domain == "" || !var.enable_waf ? 0 : 1
  name  = "${local.fn_name}-large-patch-body-routes"
  scope = "CLOUDFRONT"

  regular_expression { regex_string = "^/api/reviews/[A-Za-z0-9_-]+$" }

  tags = local.common_tags
}

resource "aws_wafv2_regex_pattern_set" "large_put_body_routes" {
  count = var.custom_domain == "" || !var.enable_waf ? 0 : 1
  name  = "${local.fn_name}-large-put-body-routes"
  scope = "CLOUDFRONT"

  regular_expression { regex_string = "^/api/account/memo-builder/sessions/[A-Za-z0-9_-]+$" }

  tags = local.common_tags
}

resource "aws_wafv2_web_acl" "app" {
  count = var.custom_domain == "" || !var.enable_waf ? 0 : 1
  name  = "${local.fn_name}-edge"
  scope = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # Preserve the managed rule's 8 KB body-size boundary everywhere except the
  # exact method/path pairs that legitimately accept larger JSON. Every
  # exception has an application-layer raw-byte ceiling in server/app.ts;
  # CloudFront WAF cannot distinguish payload sizes beyond its inspection
  # window, so the origin is the authoritative cap for those named routes.
  # The managed group counts only SizeRestrictions_BODY, leaving every other
  # managed and rate rule active for these requests.
  # First block oversized bodies for every unsupported HTTP method. The next
  # three rules then allow only the exact route set assigned to POST, PATCH, or
  # PUT. This avoids a path-only exception accidentally admitting a large body
  # on another verb while staying within WAF's logical-statement nesting rules.
  rule {
    name     = "BlockOversizeBodiesForUnsupportedMethods"
    priority = 0

    action {
      block {}
    }

    statement {
      and_statement {
        statement {
          size_constraint_statement {
            comparison_operator = "GT"
            size                = 8192

            field_to_match {
              body {
                oversize_handling = "MATCH"
              }
            }

            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }

        statement {
          not_statement {
            statement {
              or_statement {
                statement {
                  byte_match_statement {
                    positional_constraint = "EXACTLY"
                    search_string         = "POST"

                    field_to_match {
                      method {}
                    }
                    text_transformation {
                      priority = 0
                      type     = "NONE"
                    }
                  }
                }

                statement {
                  byte_match_statement {
                    positional_constraint = "EXACTLY"
                    search_string         = "PATCH"

                    field_to_match {
                      method {}
                    }
                    text_transformation {
                      priority = 0
                      type     = "NONE"
                    }
                  }
                }

                statement {
                  byte_match_statement {
                    positional_constraint = "EXACTLY"
                    search_string         = "PUT"

                    field_to_match {
                      method {}
                    }
                    text_transformation {
                      priority = 0
                      type     = "NONE"
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.fn_name}-oversize-unsupported-method"
      sampled_requests_enabled   = true
    }
  }

  dynamic "rule" {
    for_each = {
      POST = {
        priority = 1
        arn      = aws_wafv2_regex_pattern_set.large_post_body_routes[0].arn
        metric   = "oversize-post-body"
      }
      PATCH = {
        priority = 2
        arn      = aws_wafv2_regex_pattern_set.large_patch_body_routes[0].arn
        metric   = "oversize-patch-body"
      }
      PUT = {
        priority = 3
        arn      = aws_wafv2_regex_pattern_set.large_put_body_routes[0].arn
        metric   = "oversize-put-body"
      }
    }
    content {
      name     = "BlockOversize${title(lower(rule.key))}BodiesOutsideLargeRoutes"
      priority = rule.value.priority

      action {
        block {}
      }

      statement {
        and_statement {
          statement {
            size_constraint_statement {
              comparison_operator = "GT"
              size                = 8192

              field_to_match {
                body {
                  oversize_handling = "MATCH"
                }
              }

              text_transformation {
                priority = 0
                type     = "NONE"
              }
            }
          }

          statement {
            byte_match_statement {
              positional_constraint = "EXACTLY"
              search_string         = rule.key

              field_to_match {
                method {}
              }
              text_transformation {
                priority = 0
                type     = "NONE"
              }
            }
          }

          statement {
            not_statement {
              statement {
                regex_pattern_set_reference_statement {
                  arn = rule.value.arn

                  field_to_match {
                    uri_path {}
                  }

                  text_transformation {
                    priority = 0
                    type     = "NONE"
                  }
                }
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${local.fn_name}-${rule.value.metric}"
        sampled_requests_enabled   = true
      }
    }
  }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 4

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"

        rule_action_override {
          name = "SizeRestrictions_BODY"

          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.fn_name}-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 5

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.fn_name}-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimitAuthRoutes"
    priority = 10

    action {
      block {}
    }

    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = var.waf_auth_rate_limit

        scope_down_statement {
          byte_match_statement {
            positional_constraint = "STARTS_WITH"
            search_string         = "/api/auth/"

            field_to_match {
              uri_path {}
            }

            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.fn_name}-auth-rate"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimitAdminRoutes"
    priority = 11

    action {
      block {}
    }

    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = var.waf_admin_rate_limit

        scope_down_statement {
          byte_match_statement {
            positional_constraint = "STARTS_WITH"
            search_string         = "/api/admin/"

            field_to_match {
              uri_path {}
            }

            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.fn_name}-admin-rate"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimitAiRoutes"
    priority = 12

    action {
      block {}
    }

    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = var.waf_ai_rate_limit

        scope_down_statement {
          and_statement {
            statement {
              byte_match_statement {
                positional_constraint = "EXACTLY"
                search_string         = "POST"

                field_to_match {
                  method {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }

            statement {
              regex_pattern_set_reference_statement {
                arn = aws_wafv2_regex_pattern_set.ai_routes[0].arn

                field_to_match {
                  uri_path {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.fn_name}-ai-rate"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimitAccessRequests"
    priority = 13

    action {
      block {}
    }

    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = var.waf_auth_rate_limit

        scope_down_statement {
          and_statement {
            statement {
              byte_match_statement {
                positional_constraint = "EXACTLY"
                search_string         = "POST"

                field_to_match {
                  method {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }

            statement {
              byte_match_statement {
                positional_constraint = "EXACTLY"
                search_string         = "/api/access-requests"

                field_to_match {
                  uri_path {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.fn_name}-access-rate"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimitAllRoutes"
    priority = 20

    action {
      block {}
    }

    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = var.waf_global_rate_limit
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.fn_name}-global-rate"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.fn_name}-edge"
    sampled_requests_enabled   = true
  }

  tags = local.common_tags
}

# ---- Custom domain: CloudFront + ACM (us-east-1, required for CloudFront) ----
resource "aws_acm_certificate" "app" {
  count                     = var.custom_domain == "" ? 0 : 1
  domain_name               = var.custom_domain
  subject_alternative_names = var.dashboard_domain == "" ? [] : [var.dashboard_domain]
  validation_method         = "DNS"
  tags                      = local.common_tags

  lifecycle {
    create_before_destroy = true
  }
}

locals {
  fn_url_host = replace(replace(aws_lambda_function_url.app.function_url, "https://", ""), "/", "")
}

resource "aws_cloudfront_distribution" "app" {
  count           = var.custom_domain == "" ? 0 : 1
  enabled         = true
  is_ipv6_enabled = true
  comment         = "Rulix ECCN ${var.tenant_slug}"
  aliases         = compact([var.custom_domain, var.dashboard_domain])
  web_acl_id      = var.enable_waf ? aws_wafv2_web_acl.app[0].arn : null

  origin {
    domain_name              = local.fn_url_host
    origin_id                = "lambda-fn-url"
    origin_access_control_id = aws_cloudfront_origin_access_control.app[0].id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 120
    }
  }

  default_cache_behavior {
    target_origin_id       = "lambda-fn-url"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]

    # AWS managed policies: CachingDisabled + AllViewerExceptHostHeader.
    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id   = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.app_security[0].id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.app[0].arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = local.common_tags
}

# AWS requires both permissions for new IAM-authenticated Function URLs. Each
# statement is scoped to this one distribution, and ordinary principals receive
# no direct URL or non-URL Lambda invocation capability.
resource "aws_lambda_permission" "cloudfront_function_url" {
  count = var.custom_domain == "" ? 0 : 1

  statement_id           = "AllowCloudFrontFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.app.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.app[0].arn
  function_url_auth_type = "AWS_IAM"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lambda_permission" "cloudfront_invoke_function" {
  count = var.custom_domain == "" ? 0 : 1

  statement_id             = "AllowCloudFrontInvokeViaFunctionUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.app.function_name
  principal                = "cloudfront.amazonaws.com"
  source_arn               = aws_cloudfront_distribution.app[0].arn
  invoked_via_function_url = true

  lifecycle {
    create_before_destroy = true
  }
}
