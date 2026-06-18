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

# ---- The function ----
resource "aws_lambda_function" "app" {
  function_name    = local.fn_name
  role             = aws_iam_role.lambda_exec.arn
  runtime          = "nodejs20.x"
  handler          = "handler.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 1024
  timeout          = 60

  environment {
    variables = merge(
      {
        NODE_ENV        = "production"
        RULIX_DIST_DIR  = "dist"
        BEDROCK_ENABLED = tostring(var.bedrock_enabled)
        BEDROCK_MODEL   = var.bedrock_model
      },
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

# ---- Custom domain: CloudFront + ACM (us-east-1, required for CloudFront) ----
resource "aws_acm_certificate" "app" {
  count             = var.custom_domain == "" ? 0 : 1
  domain_name       = var.custom_domain
  validation_method = "DNS"
  tags              = local.common_tags

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
  aliases         = [var.custom_domain]

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
    }
  }

  default_cache_behavior {
    target_origin_id       = "lambda-fn-url"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]

    # AWS managed policies: CachingDisabled + AllViewerExceptHostHeader.
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
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
