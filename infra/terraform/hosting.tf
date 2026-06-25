# Public app hosting for Rulix ECCN on AWS Lambda + Function URL, fronted by
# CloudFront for the custom domain app.rulix.cloud.
#
# The single Node service (Express serving the built Vite client + /api) is
# bundled by `npm run build:lambda` into ../../lambda-build, zipped here, and
# run on the Node 20 Lambda runtime. CloudFront terminates TLS for the custom
# domain and forwards everything to the Function URL. See docs/aws-deploy.md.

locals {
  fn_name = "rulix-${var.tenant_slug}-app"
}

resource "random_password" "edge_shared_secret" {
  length  = 32
  special = false
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
    sid = "AuthAndAccountTables"
    actions = [
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem"
    ]
    resources = [
      aws_dynamodb_table.auth.arn,
      aws_dynamodb_table.account_state.arn
    ]
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
  }
}

resource "aws_iam_role_policy" "lambda_auth" {
  name   = "${local.fn_name}-auth"
  role   = aws_iam_role.lambda_exec.id
  policy = data.aws_iam_policy_document.lambda_auth.json
}

# ---- The function ----
resource "aws_lambda_function" "app" {
  function_name    = local.fn_name
  role             = aws_iam_role.lambda_exec.arn
  runtime          = "nodejs20.x"
  handler          = "handler.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 1024
  timeout          = 180

  environment {
    variables = merge(
      {
        NODE_ENV                      = "production"
        RULIX_DIST_DIR                = "dist"
        BEDROCK_ENABLED               = tostring(var.bedrock_enabled)
        BEDROCK_MODEL                 = var.bedrock_model
        BEDROCK_DEEP_MODEL            = var.bedrock_deep_model
        BEDROCK_OUTREACH_MODEL        = var.bedrock_outreach_model
        BEDROCK_PERSONALIZATION_MODEL = var.bedrock_personalization_model
        BEDROCK_LEAD_SEARCH_MODEL     = var.bedrock_lead_search_model
        RULIX_AUTH_TABLE              = aws_dynamodb_table.auth.name
        RULIX_ACCOUNT_TABLE           = aws_dynamodb_table.account_state.name
        RULIX_TENANT_ID               = var.tenant_slug
        RULIX_ALLOWED_ORIGINS         = join(",", compact([var.app_base_url, var.dashboard_domain == "" ? "" : "https://${var.dashboard_domain}"]))
        APP_BASE_URL                  = var.app_base_url
        AUTH_INVITE_TTL_HOURS         = tostring(var.auth_invite_ttl_hours)
        AUTH_RESET_TTL_MINUTES        = tostring(var.auth_reset_ttl_minutes)
        AUTH_SESSION_TTL_HOURS        = tostring(var.auth_session_ttl_hours)
      },
      var.auth_email_from == "" ? {} : { AUTH_EMAIL_FROM = var.auth_email_from },
      var.auth_bootstrap_secret == "" ? {} : { AUTH_BOOTSTRAP_SECRET = var.auth_bootstrap_secret },
      var.custom_domain == "" ? {} : { RULIX_EDGE_SHARED_SECRET = random_password.edge_shared_secret.result }
    )
  }

  tags = local.common_tags
}

# Function URL origin. With a custom domain, the app rejects direct requests
# unless CloudFront supplies the generated origin secret header.
resource "aws_lambda_function_url" "app" {
  function_name      = aws_lambda_function.app.function_name
  authorization_type = "NONE"
}

# ---- Edge security policy ----
resource "aws_cloudfront_response_headers_policy" "app_security" {
  count = var.custom_domain == "" ? 0 : 1
  name  = "${local.fn_name}-security-headers"

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

resource "aws_wafv2_web_acl" "app" {
  count = var.custom_domain == "" || !var.enable_waf ? 0 : 1
  name  = "${local.fn_name}-edge"
  scope = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # Allow large POST bodies on authenticated API paths that routinely exceed
  # WAF's 8 KB body-inspection limit: document extraction, the AI endpoints
  # (memo-builder-chat, ai/review), and account-state saves (all memos).
  # These paths all require session auth, so bypassing body-size inspection
  # here is safe — the managed rules still apply to every other path.
  rule {
    name     = "AllowLargeApiRequests"
    priority = 0

    action {
      allow {}
    }

    statement {
      or_statement {
        statement {
          byte_match_statement {
            positional_constraint = "EXACTLY"
            search_string         = "/api/documents/extract"
            field_to_match { uri_path {} }
            text_transformation { priority = 0; type = "NONE" }
          }
        }
        statement {
          byte_match_statement {
            positional_constraint = "STARTS_WITH"
            search_string         = "/api/ai/"
            field_to_match { uri_path {} }
            text_transformation { priority = 0; type = "NONE" }
          }
        }
        statement {
          byte_match_statement {
            positional_constraint = "STARTS_WITH"
            search_string         = "/api/account/"
            field_to_match { uri_path {} }
            text_transformation { priority = 0; type = "NONE" }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.fn_name}-large-api-allow"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
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
    priority = 2

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
    domain_name = local.fn_url_host
    origin_id   = "lambda-fn-url"

    custom_header {
      name  = "x-rulix-edge-secret"
      value = random_password.edge_shared_secret.result
    }

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
