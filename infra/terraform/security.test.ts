// @vitest-environment node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_AI_ADMISSION_CONFIG } from "../../server/aiAdmission";

const terraformDirectory = fileURLToPath(new URL(".", import.meta.url));
const hosting = readFileSync(`${terraformDirectory}/hosting.tf`, "utf8");
const main = readFileSync(`${terraformDirectory}/main.tf`, "utf8");
const outputs = readFileSync(`${terraformDirectory}/outputs.tf`, "utf8");
const variables = readFileSync(`${terraformDirectory}/variables.tf`, "utf8");
const audit = readFileSync(`${terraformDirectory}/audit.tf`, "utf8");
const workspace = readFileSync(`${terraformDirectory}/workspace_v2.tf`, "utf8");
const githubActions = readFileSync(`${terraformDirectory}/github_actions.tf`, "utf8");
const buildLambda = readFileSync(`${terraformDirectory}/../../scripts/build-lambda.mjs`, "utf8");
const serverApp = readFileSync(`${terraformDirectory}/../../server/app.ts`, "utf8");

function extractBlock(source: string, declaration: string, from = 0) {
  const declarationIndex = source.indexOf(declaration, from);
  if (declarationIndex < 0) throw new Error(`Missing Terraform declaration: ${declaration}`);
  const declaredBrace = declaration.lastIndexOf("{");
  const openingBrace = declaredBrace >= 0
    ? declarationIndex + declaredBrace
    : source.indexOf("{", declarationIndex + declaration.length);
  if (openingBrace < 0) throw new Error(`Missing opening brace for: ${declaration}`);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) {
      return { text: source.slice(declarationIndex, index + 1), end: index + 1 };
    }
  }
  throw new Error(`Unclosed Terraform declaration: ${declaration}`);
}

function wafRule(webAcl: string, name: string) {
  let cursor = 0;
  while (cursor < webAcl.length) {
    const next = webAcl.indexOf("rule {", cursor);
    if (next < 0) break;
    const rule = extractBlock(webAcl, "rule {", next);
    if (rule.text.includes(`name     = "${name}"`)) return rule.text;
    cursor = rule.end;
  }
  throw new Error(`Missing WAF rule: ${name}`);
}

function terraformVariable(name: string) {
  return extractBlock(variables, `variable "${name}"`).text;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("Terraform security invariants", () => {
  it("requires explicit Bedrock resources and rejects wildcard IAM scope", () => {
    const bedrockResources = terraformVariable("bedrock_resource_arns");
    expect(bedrockResources).toContain("type        = set(string)");
    expect(bedrockResources).not.toMatch(/default\s*=/);
    expect(bedrockResources).toContain('arn != "*"');
    expect(bedrockResources).toContain("length(var.bedrock_resource_arns) > 0");
    expect(bedrockResources).toContain("validation {");
    expect(hosting).toContain("resources = var.bedrock_resource_arns");
    expect(main).toContain("resources = var.bedrock_resource_arns");
  });

  it("limits large-body WAF exceptions to exact HTTP method and route pairs", () => {
    const webAcl = extractBlock(hosting, 'resource "aws_wafv2_web_acl" "app"').text;
    const unsupportedMethods = wafRule(webAcl, "BlockOversizeBodiesForUnsupportedMethods");
    const methodRules = extractBlock(webAcl, 'dynamic "rule"').text;
    const postRoutes = extractBlock(hosting, 'resource "aws_wafv2_regex_pattern_set" "large_post_body_routes"').text;
    const patchRoutes = extractBlock(hosting, 'resource "aws_wafv2_regex_pattern_set" "large_patch_body_routes"').text;
    const putRoutes = extractBlock(hosting, 'resource "aws_wafv2_regex_pattern_set" "large_put_body_routes"').text;
    const commonRules = wafRule(webAcl, "AWSManagedRulesCommonRuleSet");
    const knownBadInputs = wafRule(webAcl, "AWSManagedRulesKnownBadInputsRuleSet");
    const globalRateLimit = wafRule(webAcl, "RateLimitAllRoutes");

    expect(webAcl.match(/\ballow\s*\{\s*\}/g)).toHaveLength(1);
    expect(webAcl).not.toContain("AllowLargeApiRequests");
    expect(unsupportedMethods).toContain("priority = 0");
    expect(unsupportedMethods).toMatch(/action\s*\{\s*block\s*\{\s*\}/s);
    expect(unsupportedMethods).toMatch(/comparison_operator\s*=\s*"GT"/);
    expect(unsupportedMethods).toMatch(/size\s*=\s*8192/);
    expect(unsupportedMethods).toMatch(/body\s*\{\s*oversize_handling\s*=\s*"MATCH"/s);
    expect(unsupportedMethods).toMatch(/not_statement\s*\{\s*statement\s*\{\s*or_statement/s);
    for (const method of ["POST", "PATCH", "PUT"]) {
      expect(unsupportedMethods).toContain(`search_string         = "${method}"`);
      expect(methodRules).toContain(`${method} = {`);
    }
    expect(methodRules).toContain("aws_wafv2_regex_pattern_set.large_post_body_routes[0].arn");
    expect(methodRules).toContain("aws_wafv2_regex_pattern_set.large_patch_body_routes[0].arn");
    expect(methodRules).toContain("aws_wafv2_regex_pattern_set.large_put_body_routes[0].arn");
    expect(methodRules).toContain("search_string         = rule.key");
    expect(methodRules).toMatch(/comparison_operator\s*=\s*"GT"/);
    expect(postRoutes).toContain('regex_string = "^/api/documents/extract$"');
    expect(postRoutes).toContain('regex_string = "^/api/ai/memo-builder-chat$"');
    expect(postRoutes).toContain('regex_string = "^/api/reviews/[A-Za-z0-9_-]+/chat$"');
    expect(postRoutes).not.toContain('regex_string = "^/api/reviews/[A-Za-z0-9_-]+$"');
    expect(postRoutes).not.toContain("public-memo-draft");
    expect(postRoutes).not.toContain("ai/(review|");
    expect(patchRoutes).toContain('regex_string = "^/api/reviews/[A-Za-z0-9_-]+$"');
    expect(putRoutes).toContain('regex_string = "^/api/account/memo-builder/sessions/[A-Za-z0-9_-]+$"');

    expect(commonRules).toContain("priority = 4");
    expect(commonRules).toContain('name = "SizeRestrictions_BODY"');
    expect(commonRules).toMatch(/action_to_use\s*\{\s*count\s*\{\s*\}/s);
    expect(commonRules).toMatch(/override_action\s*\{\s*none\s*\{\s*\}/s);
    expect(commonRules).not.toContain("scope_down_statement");
    expect(knownBadInputs).toContain("priority = 5");
    expect(globalRateLimit).toContain("priority = 20");
  });

  it("bounds app concurrency, aligns the origin deadline, and enforces raw-byte command caps", () => {
    const appLambda = extractBlock(hosting, 'resource "aws_lambda_function" "app"').text;
    const distribution = extractBlock(hosting, 'resource "aws_cloudfront_distribution" "app"').text;
    const concurrency = terraformVariable("app_reserved_concurrency");

    expect(appLambda).toMatch(/timeout\s*=\s*120/);
    expect(appLambda).toMatch(/runtime\s*=\s*"nodejs24\.x"/);
    expect(appLambda).toContain("reserved_concurrent_executions = var.app_reserved_concurrency");
    expect(distribution).toMatch(/origin_read_timeout\s*=\s*120/);
    expect(concurrency).toMatch(/default\s*=\s*40/);
    expect(concurrency).toContain("var.app_reserved_concurrency == -1");
    expect(concurrency).toContain("var.app_reserved_concurrency >= 2");
    expect(concurrency).toContain("var.app_reserved_concurrency <= 1000");

    for (const parserCap of [
      "const parseReviewCreateJson = jsonParserWithLimit(256 * 1024)",
      "const parseReviewUpdateJson = jsonParserWithLimit(224 * 1024)",
      "const parseReviewChatJson = jsonParserWithLimit(MEMO_CHAT_REQUEST_MAX_BYTES)",
      "const parseAiApprovalRequestJson = jsonParserWithLimit(MEMO_CHAT_REQUEST_MAX_BYTES)",
      "const parseMemoBuilderChatJson = jsonParserWithLimit(256 * 1024)",
      "const parseBuilderSessionJson = jsonParserWithLimit(320 * 1024)",
      "const parseDocumentJson = jsonParserWithLimit(12 * 1024 * 1024)"
    ]) expect(serverApp).toContain(parserCap);
    expect(serverApp).toContain('req.method === "POST" && req.path === "/api/reviews"');
    expect(serverApp).toContain('req.method === "PATCH" && /^\\/api\\/reviews\\/[^/]+$/.test(req.path)');
    expect(serverApp).toContain('req.method === "POST" && /^\\/api\\/reviews\\/[^/]+\\/chat$/.test(req.path)');
    expect(serverApp).toContain('req.method === "POST" && req.path === "/api/ai-approval-requests"');
    expect(serverApp).toContain('req.method === "POST" && req.path === "/api/ai/memo-builder-chat"');
    expect(serverApp).toContain('req.method === "PUT" && req.path.startsWith("/api/account/memo-builder/sessions/")');
    expect(serverApp).toContain('req.method === "POST" && req.path === "/api/documents/extract"');
    expect(serverApp).toContain("rawJsonBytes = buffer.byteLength");
    expect(serverApp).toContain('code: "request_body_too_large"');
  });

  it("exports an analysis policy with read-only account state and no auth or audit capability", () => {
    const policy = extractBlock(
      main,
      'data "aws_iam_policy_document" "analysis_worker"'
    ).text;
    const dynamodbActions = [...policy.matchAll(/"(dynamodb:[^"]+)"/g)]
      .map((match) => match[1]);

    expect(policy).toContain("aws_dynamodb_table.account_state.arn");
    expect(policy).toContain('sid = "WriteAnalysisEvidence"');
    expect(policy).toContain('"s3:PutObject"');
    expect(policy).toContain("aws_s3_bucket.evidence.arn");
    expect(policy).not.toContain("aws_dynamodb_table.auth.arn");
    expect(policy).not.toContain("aws_dynamodb_table.audit_events.arn");
    expect(dynamodbActions).toEqual([
      "dynamodb:GetItem",
      "dynamodb:GetItem",
      "dynamodb:Query"
    ]);
    expect(policy).not.toContain('"dynamodb:PutItem"');
    expect(policy).not.toContain('"dynamodb:UpdateItem"');
    expect(policy).not.toContain('"dynamodb:DeleteItem"');
    expect(outputs).toContain('output "analysis_worker_policy_arn"');
    expect(outputs).not.toContain('output "worker_policy_arn"');
  });

  it("puts raw audit-table access behind a stream-only audit consumer", () => {
    const auditLambda = extractBlock(
      audit,
      'resource "aws_lambda_function" "audit_writer"'
    ).text;
    const auditConcurrency = terraformVariable("audit_reserved_concurrency");
    const runtimePolicy = extractBlock(
      audit,
      'data "aws_iam_policy_document" "audit_lambda"'
    ).text;
    const dynamodbActions = [...runtimePolicy.matchAll(/"(dynamodb:[^"]+)"/g)]
      .map((match) => match[1]);
    const kmsActions = [...runtimePolicy.matchAll(/"(kms:[^"]+)"/g)]
      .map((match) => match[1])
      .filter((value) => !value.startsWith("kms:Via") &&
        !value.startsWith("kms:Caller") &&
        !value.startsWith("kms:EncryptionContext"));

    expect(dynamodbActions).toEqual([
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DescribeStream",
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
      "dynamodb:ListStreams"
    ]);
    expect(kmsActions).toEqual(["kms:Decrypt", "kms:Decrypt"]);
    expect(runtimePolicy).toContain("aws_dynamodb_table.audit_events.arn");
    expect(runtimePolicy).toContain("aws_kms_key.tenant.arn");
    expect(runtimePolicy).toContain('variable = "kms:ViaService"');
    expect(runtimePolicy).toContain('values   = ["dynamodb.${var.aws_region}.amazonaws.com"]');
    expect(runtimePolicy).toContain('variable = "kms:CallerAccount"');
    expect(runtimePolicy).toContain(
      'variable = "kms:EncryptionContext:aws:dynamodb:tableName"'
    );
    expect(runtimePolicy).toContain("values   = [aws_dynamodb_table.audit_events.name]");
    expect(runtimePolicy).toContain(
      'variable = "kms:EncryptionContext:aws:dynamodb:subscriberId"'
    );
    expect(runtimePolicy).toContain("values   = [data.aws_caller_identity.current.account_id]");
    expect(runtimePolicy).not.toContain('"kms:*"');
    expect(runtimePolicy).not.toContain("aws_dynamodb_table.auth.arn");
    expect(runtimePolicy).not.toContain("aws_dynamodb_table.account_state.arn");
    expect(audit).not.toContain("audit_append_invoker");
    expect(audit).not.toContain("lambda:InvokeFunction");
    expect(workspace).toContain('resource "aws_lambda_event_source_mapping" "workspace_audit"');
    expect(workspace).toContain("function_name                      = aws_lambda_function.audit_writer.arn");
    expect(workspace).toContain('function_response_types            = ["ReportBatchItemFailures"]');
    expect(workspace).toContain("filter_criteria {");
    expect(workspace).toContain('eventName = ["INSERT"]');
    expect(workspace).toContain('entityType = { S = ["AU"] }');
    expect(audit).not.toContain('resource "aws_lambda_function_url"');
    expect(auditLambda).toMatch(/runtime\s*=\s*"nodejs24\.x"/);
    expect(auditLambda).toContain("reserved_concurrent_executions = var.audit_reserved_concurrency");
    expect(auditConcurrency).toMatch(/default\s*=\s*5/);
    expect(auditConcurrency).toContain("var.audit_reserved_concurrency == -1");
    expect(audit).toContain('source_dir  = "${path.module}/../../audit-lambda-build"');
    expect(audit).toMatch(/RULIX_AUDIT_TABLE\s*=\s*aws_dynamodb_table\.audit_events\.name/);
    expect(audit).toMatch(/RULIX_AUDIT_TENANT_ID\s*=\s*var\.tenant_slug/);
    expect(audit).toMatch(/RULIX_AUDIT_WRITER_ID\s*=\s*local\.audit_lambda_name/);
    expect(buildLambda).toContain('"server", "auditLambda.ts"');
    expect(outputs).not.toContain('output "audit_append_invoker_policy_arn"');
    expect(outputs).not.toContain('output "audit_writer_policy_arn"');
  });

  it("wires validated AI egress and admission policy defaults into the app Lambda", () => {
    const appLambda = extractBlock(hosting, 'resource "aws_lambda_function" "app"').text;
    const secureStringDefaults = {
      ai_data_class: 'default     = "proprietary"',
      approved_provider: 'default     = "amazon-bedrock"',
      controlled_data_mode: 'default     = "disabled"'
    };
    const admissionDefaults = {
      ai_max_concurrent: DEFAULT_AI_ADMISSION_CONFIG.maxConcurrentLeases,
      ai_requests_per_minute: DEFAULT_AI_ADMISSION_CONFIG.requestsPerMinute,
      ai_tokens_per_day: DEFAULT_AI_ADMISSION_CONFIG.tokensPerDay,
      ai_spend_usd_per_day: DEFAULT_AI_ADMISSION_CONFIG.spendUsdPerDay,
      ai_max_tokens_per_call: DEFAULT_AI_ADMISSION_CONFIG.maxTokensPerCall,
      ai_max_cost_usd_per_call: DEFAULT_AI_ADMISSION_CONFIG.maxCostUsdPerCall,
      ai_lease_seconds: DEFAULT_AI_ADMISSION_CONFIG.leaseDurationMs / 1_000
    };

    for (const [name, expectedDefault] of Object.entries(secureStringDefaults)) {
      const block = terraformVariable(name);
      expect(block).toContain("type        = string");
      expect(block).toContain(expectedDefault);
      expect(block).toContain("validation {");
    }
    const approvedRegion = terraformVariable("approved_region");
    expect(approvedRegion).toContain("type        = string");
    expect(approvedRegion).toContain("default     = null");
    expect(approvedRegion).toContain("validation {");
    expect(main).toContain("approved_ai_region");
    expect(main).toContain("coalesce(var.approved_region, var.aws_region)");

    for (const [name, expectedDefault] of Object.entries(admissionDefaults)) {
      const block = terraformVariable(name);
      expect(block).toContain("type        = number");
      expect(block).toMatch(new RegExp(`default\\s+=\\s+${expectedDefault}`));
      expect(block).toContain("validation {");
    }

    const environmentBindings = {
      RULIX_AI_DATA_CLASS: "var.ai_data_class",
      RULIX_APPROVED_PROVIDER: "var.approved_provider",
      RULIX_APPROVED_REGION: "local.approved_ai_region",
      RULIX_CONTROLLED_DATA_MODE: "var.controlled_data_mode",
      RULIX_APPROVED_MODEL_IDS: "jsonencode(var.approved_model_ids)",
      RULIX_BEDROCK_PRICES: "var.bedrock_prices_json",
      RULIX_AI_MAX_CONCURRENT: "tostring(var.ai_max_concurrent)",
      RULIX_AI_REQUESTS_PER_MINUTE: "tostring(var.ai_requests_per_minute)",
      RULIX_AI_TOKENS_PER_DAY: "tostring(var.ai_tokens_per_day)",
      RULIX_AI_SPEND_USD_PER_DAY: "tostring(var.ai_spend_usd_per_day)",
      RULIX_AI_MAX_TOKENS_PER_CALL: "tostring(var.ai_max_tokens_per_call)",
      RULIX_AI_MAX_COST_USD_PER_CALL: "tostring(var.ai_max_cost_usd_per_call)",
      RULIX_AI_LEASE_SECONDS: "tostring(var.ai_lease_seconds)"
    };
    for (const [name, expression] of Object.entries(environmentBindings)) {
      expect(appLambda).toMatch(
        new RegExp(`${name}\\s*=\\s*${escapeRegExp(expression)}`)
      );
    }
    const pricing = terraformVariable("bedrock_prices_json");
    expect(pricing).toMatch(/default\s*=\s*""/);
    expect(pricing).toContain('var.bedrock_prices_json == ""');
    expect(pricing).toContain("length(keys(jsondecode(var.bedrock_prices_json))) > 0");
    expect(appLambda).toContain(
      'var.bedrock_prices_json == "" ? {} : { RULIX_BEDROCK_PRICES = var.bedrock_prices_json }'
    );
    expect(appLambda.match(/precondition\s*\{/g)).toHaveLength(5);
    expect(appLambda).toContain(
      'var.approved_provider == "amazon-bedrock" && local.approved_ai_region == var.aws_region'
    );
    expect(appLambda).toContain(
      'var.approved_provider == "anthropic-direct" && local.approved_ai_region == "global"'
    );
    expect(appLambda).toContain(
      'var.controlled_data_mode != "approved" || var.approved_provider == "amazon-bedrock"'
    );
    expect(appLambda).toContain("length(var.approved_model_ids) > 0");
    expect(appLambda).toContain("contains(var.approved_model_ids, model)");
    expect(appLambda).toContain('!can(regex("^(global|us|eu|apac|jp|au)\\\\.", model))');
    expect(appLambda).toContain("contains(var.bedrock_resource_arns, model)");
  });

  it("isolates normalized workspace storage, migration, GC, and audit permissions", () => {
    const table = extractBlock(workspace, 'resource "aws_dynamodb_table" "workspace"').text;
    const appPolicy = extractBlock(hosting, 'data "aws_iam_policy_document" "lambda_auth"').text;
    const migrationPolicy = extractBlock(workspace, 'data "aws_iam_policy_document" "workspace_migration"').text;
    const gcPolicy = extractBlock(workspace, 'data "aws_iam_policy_document" "workspace_content_gc"').text;
    const aiRoutes = extractBlock(hosting, 'resource "aws_wafv2_regex_pattern_set" "ai_routes"').text;
    const bucketPolicy = extractBlock(workspace, 'data "aws_iam_policy_document" "workspace_content_bucket"').text;

    expect(table).toContain('stream_view_type            = "NEW_IMAGE"');
    expect(table).toContain("deletion_protection_enabled = var.data_deletion_protection_enabled");
    expect(table).toContain("point_in_time_recovery");
    expect(table).toContain("kms_key_arn = aws_kms_key.workspace.arn");
    expect(table.match(/global_secondary_index\s*\{/g)).toHaveLength(2);
    expect(table).toContain('attribute_name = "expiresAt"');
    expect(appPolicy).not.toContain('"dynamodb:Scan"');
    expect(appPolicy).not.toContain('"s3:DeleteObjectVersion"');
    expect(appPolicy).toContain('actions   = ["s3:GetObject", "s3:PutObject"]');
    expect(migrationPolicy).toContain('actions   = ["dynamodb:GetItem", "dynamodb:Scan"]');
    expect(migrationPolicy).toContain('"dynamodb:ConditionCheckItem"');
    expect(migrationPolicy).toContain('sid       = "DecryptLegacyAccountStateViaDynamoDB"');
    expect(migrationPolicy).toContain('actions   = ["kms:Decrypt"]');
    expect(migrationPolicy).toContain("resources = [aws_kms_key.tenant.arn]");
    expect(migrationPolicy).toContain('variable = "kms:ViaService"');
    expect(migrationPolicy).toContain('values   = ["dynamodb.${var.aws_region}.amazonaws.com"]');
    expect(migrationPolicy).toContain('variable = "kms:CallerAccount"');
    expect(gcPolicy).toContain('actions   = ["dynamodb:Scan"]');
    expect(gcPolicy).toContain('actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]');
    expect(gcPolicy).toContain('variable = "dynamodb:LeadingKeys"');
    expect(gcPolicy).toContain('values   = ["TENANT#${var.tenant_slug}#SYSTEM"]');
    expect(gcPolicy).not.toContain('"dynamodb:DeleteItem"');
    expect(gcPolicy).not.toContain('"dynamodb:PutItem"');
    expect(gcPolicy).not.toContain('"dynamodb:TransactWriteItems"');
    expect(hosting).toContain('sid = "AuthTableCommands"');
    expect(hosting).toContain('sid = "NormalizedWorkspaceCommands"');
    expect(hosting.match(/"dynamodb:ConditionCheckItem"/g)).toHaveLength(2);
    expect(gcPolicy).toContain('actions   = ["s3:DeleteObjectVersion"]');
    expect(gcPolicy).not.toContain('"s3:PutObject"');
    expect(gcPolicy).toContain("resources = [aws_kms_key.workspace.arn]");
    expect(gcPolicy).toContain('variable = "kms:ViaService"');
    expect(aiRoutes).toContain('regex_string = "^/api/ai/memo-builder-chat$"');
    expect(aiRoutes).not.toContain("public-memo-draft");
    expect(aiRoutes).not.toContain("ai/(review|");
    expect(bucketPolicy).toContain('sid       = "DenyWrongEncryption"');
    expect(bucketPolicy).toContain('sid       = "DenyWrongKmsKey"');
    expect(workspace).toContain('resource "aws_cloudwatch_metric_alarm" "workspace_kms_access_denied"');
  });

  it("limits deployment updates to the app and isolated audit Lambda", () => {
    const deployPolicy = extractBlock(
      githubActions,
      'data "aws_iam_policy_document" "github_actions_deploy"'
    ).text;
    const updateTargets = [
      "arn:${data.aws_partition.current.partition}:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${local.fn_name}",
      "arn:${data.aws_partition.current.partition}:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${local.audit_lambda_name}"
    ];

    expect(deployPolicy).toContain('"lambda:UpdateFunctionCode"');
    for (const target of updateTargets) expect(deployPolicy).toContain(`"${target}"`);
    expect(deployPolicy.match(/:function:\$\{local\.[^}]+\}/g)).toHaveLength(2);
    expect(deployPolicy).not.toContain(":function:*");
    expect(deployPolicy).not.toContain('resources = ["*"]');
  });
});
