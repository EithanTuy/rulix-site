resource "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"

  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = local.common_tags
}

data "aws_iam_policy_document" "github_actions_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:EithanTuy/rulix-site:environment:production"]
    }

    # Environment-based OIDC subjects do not include the originating ref. Bind
    # the separate ref claim so a manually-dispatched workflow on another branch
    # cannot assume the production deployment role.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:ref"
      values   = ["refs/heads/main"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:environment"
      values   = ["production"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository"
      values   = ["EithanTuy/rulix-site"]
    }
  }
}

resource "aws_iam_role" "github_actions_deploy" {
  name               = "rulix-github-actions-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_actions_assume.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "github_actions_deploy" {
  statement {
    sid = "DeployRulixLambda"
    actions = [
      "lambda:GetFunction",
      "lambda:GetFunctionConfiguration",
      "lambda:UpdateFunctionCode"
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${local.fn_name}",
      "arn:${data.aws_partition.current.partition}:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${local.audit_lambda_name}"
    ]
  }
}

resource "aws_iam_role_policy" "github_actions_deploy" {
  name   = "rulix-production-lambda-deploy"
  role   = aws_iam_role.github_actions_deploy.id
  policy = data.aws_iam_policy_document.github_actions_deploy.json
}
