# Public app hosting for Rulix ECCN on AWS App Runner.
#
# This deploys the single Node service (Express serving the built Vite client
# plus the /api routes) straight from the GitHub repo — no Docker, no S3, no
# CloudFront. App Runner provides managed HTTPS and a custom domain for
# app.rulix.cloud. See docs/aws-deploy.md for the apply runbook.
#
# Prerequisites that must exist BEFORE `terraform apply` (see runbook):
#   1. An App Runner <-> GitHub connection authorized in the console; pass its
#      ARN via var.apprunner_connection_arn.
#   2. The Anthropic API key stored in Secrets Manager; pass its ARN via
#      var.anthropic_secret_arn (or leave empty to run in local-rules mode).

locals {
  service_name = "rulix-${var.tenant_slug}-app"
}

# IAM role App Runner assumes to pull the source connection / read secrets.
data "aws_iam_policy_document" "apprunner_build_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["build.apprunner.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "apprunner_build" {
  name               = "${local.service_name}-build"
  assume_role_policy = data.aws_iam_policy_document.apprunner_build_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "apprunner_build" {
  role       = aws_iam_role.apprunner_build.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

# IAM role the running instance uses (read the API key secret + optional Bedrock).
data "aws_iam_policy_document" "apprunner_instance_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["tasks.apprunner.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "apprunner_instance" {
  name               = "${local.service_name}-instance"
  assume_role_policy = data.aws_iam_policy_document.apprunner_instance_assume.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "apprunner_instance" {
  count = var.anthropic_secret_arn == "" ? 0 : 1

  statement {
    sid       = "ReadAnthropicKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.anthropic_secret_arn]
  }
}

resource "aws_iam_role_policy" "apprunner_instance" {
  count  = var.anthropic_secret_arn == "" ? 0 : 1
  name   = "${local.service_name}-secrets"
  role   = aws_iam_role.apprunner_instance.id
  policy = data.aws_iam_policy_document.apprunner_instance[0].json
}

resource "aws_apprunner_service" "app" {
  service_name = local.service_name

  source_configuration {
    authentication_configuration {
      connection_arn = var.apprunner_connection_arn
    }
    auto_deployments_enabled = true

    code_repository {
      repository_url = var.repository_url
      source_code_version {
        type  = "BRANCH"
        value = var.repository_branch
      }
      code_configuration {
        configuration_source = "API"
        code_configuration_values {
          runtime       = "NODEJS_18"
          build_command = "npm install && npm run build"
          start_command = "npm run start"
          port          = "8080"
          runtime_environment_variables = {
            NODE_ENV = "production"
            PORT     = "8080"
            HOST     = "0.0.0.0"
          }
          runtime_environment_secrets = var.anthropic_secret_arn == "" ? {} : {
            ANTHROPIC_API_KEY = var.anthropic_secret_arn
          }
        }
      }
    }
  }

  instance_configuration {
    cpu               = "1024"
    memory            = "2048"
    instance_role_arn = aws_iam_role.apprunner_instance.arn
  }

  health_check_configuration {
    protocol = "HTTP"
    path     = "/api/health"
    interval = 10
    timeout  = 5
  }

  tags = local.common_tags
}

# Custom domain: app.rulix.cloud. After apply, App Runner emits DNS validation
# records (in the outputs) that must be added at GoDaddy before the domain
# becomes active and the managed TLS cert is issued.
resource "aws_apprunner_custom_domain_association" "app" {
  count       = var.custom_domain == "" ? 0 : 1
  domain_name = var.custom_domain
  service_arn = aws_apprunner_service.app.arn

  enable_www_subdomain = false
}
