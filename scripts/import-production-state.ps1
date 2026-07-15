[CmdletBinding()]
param(
  [string]$Profile = "rulix-codex",
  [string]$Region = "us-east-1",
  [string]$AccountId = "431445330783",
  [string]$Tenant = "prod"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$terraformDir = Join-Path $repoRoot "infra\terraform"
$identity = aws sts get-caller-identity --profile $Profile --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $identity.Account -ne $AccountId) {
  throw "AWS profile $Profile does not resolve to expected account $AccountId."
}

$env:AWS_PROFILE = $Profile
$env:AWS_REGION = $Region
$env:AWS_DEFAULT_REGION = $Region

Push-Location $terraformDir
try {
  function Import-IfMissing {
    param([Parameter(Mandatory)][string]$Address, [Parameter(Mandatory)][string]$Id)
    # Windows PowerShell removes embedded quotes when constructing a native
    # command line. Prefix them so Terraform receives literal for_each keys.
    $nativeAddress = $Address.Replace('"', '\"')
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    terraform state show $nativeAddress 2>$null | Out-Null
    $stateShowExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorAction
    if ($stateShowExitCode -eq 0) {
      Write-Host "Present  $Address"
      return
    }
    Write-Host "Import   $Address"
    terraform import -input=false -lock-timeout=5m $nativeAddress $Id
    if ($LASTEXITCODE -ne 0) {
      throw "Terraform import failed for $Address."
    }
  }

  $prefix = "rulix-$Tenant"
  $buckets = @{
    uploads  = "$prefix-uploads-$AccountId"
    corpus   = "$prefix-corpus-$AccountId"
    evidence = "$prefix-evidence-$AccountId"
  }

  Import-IfMissing "aws_kms_key.tenant" "ae363238-24d8-4a69-8a53-117a7e539dfd"
  Import-IfMissing "aws_kms_alias.tenant" "alias/$prefix-tenant"
  foreach ($entry in $buckets.GetEnumerator()) {
    $key = $entry.Key
    $bucket = $entry.Value
    Import-IfMissing "aws_s3_bucket.$key" $bucket
    Import-IfMissing "aws_s3_bucket_versioning.all[`"$key`"]" $bucket
    Import-IfMissing "aws_s3_bucket_server_side_encryption_configuration.all[`"$key`"]" $bucket
    Import-IfMissing "aws_s3_bucket_public_access_block.all[`"$key`"]" $bucket
    Import-IfMissing "aws_s3_bucket_ownership_controls.all[`"$key`"]" $bucket
  }

  Import-IfMissing "aws_dynamodb_table.audit_events" "$prefix-audit-events"
  Import-IfMissing "aws_dynamodb_table.auth" "$prefix-auth"
  Import-IfMissing "aws_dynamodb_table.account_state" "$prefix-account-state"
  Import-IfMissing "aws_cloudwatch_log_group.application" "/aws/rulix/$Tenant/application"
  Import-IfMissing "aws_cloudwatch_log_group.lambda" "/aws/lambda/$prefix-app"
  Import-IfMissing "aws_iam_policy.analysis_worker" "arn:aws:iam::$AccountId`:policy/$prefix-worker"

  Import-IfMissing "aws_iam_role.lambda_exec" "$prefix-app-exec"
  Import-IfMissing "aws_iam_role_policy_attachment.lambda_logs" "$prefix-app-exec/arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
  Import-IfMissing "aws_iam_role_policy.lambda_bedrock" "$prefix-app-exec`:$prefix-app-bedrock"
  Import-IfMissing "aws_iam_role_policy.lambda_auth" "$prefix-app-exec`:$prefix-app-auth"
  Import-IfMissing "aws_lambda_function.app" "$prefix-app"
  Import-IfMissing "aws_lambda_function_url.app" "$prefix-app"

  Import-IfMissing "aws_cloudfront_response_headers_policy.app_security[0]" "f48ba369-5668-4e4d-bcf0-5972a6cec68b"
  Import-IfMissing "aws_wafv2_web_acl.app[0]" "8d5c2e4d-4497-4d40-8da2-9e508413bf53/$prefix-app-edge/CLOUDFRONT"
  Import-IfMissing "aws_acm_certificate.app[0]" "arn:aws:acm:us-east-1:$AccountId`:certificate/b6ff14da-52e2-4a60-aa81-02b260b14fca"
  Import-IfMissing "aws_cloudfront_distribution.app[0]" "ESASQFO7MC8HB"
  Import-IfMissing "aws_lambda_permission.cloudfront_function_url[0]" "$prefix-app/FunctionURLAllowPublicAccess"
  Import-IfMissing "aws_lambda_permission.cloudfront_invoke_function[0]" "$prefix-app/FunctionURLAllowInvokeAction"

  Import-IfMissing "aws_iam_openid_connect_provider.github" "arn:aws:iam::$AccountId`:oidc-provider/token.actions.githubusercontent.com"
  Import-IfMissing "aws_iam_role.github_actions_deploy" "rulix-github-actions-deploy"
  Import-IfMissing "aws_iam_role_policy.github_actions_deploy" "rulix-github-actions-deploy:rulix-production-lambda-deploy"

  terraform state list
  if ($LASTEXITCODE -ne 0) { throw "Terraform state listing failed after imports." }
}
finally {
  Pop-Location
}
