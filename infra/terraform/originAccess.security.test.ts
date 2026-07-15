// @vitest-environment node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const terraformDirectory = fileURLToPath(new URL(".", import.meta.url));
const hosting = readFileSync(`${terraformDirectory}/hosting.tf`, "utf8");
const outputs = readFileSync(`${terraformDirectory}/outputs.tf`, "utf8");
const variables = readFileSync(`${terraformDirectory}/variables.tf`, "utf8");

describe("private Lambda URL origin", () => {
  it("uses IAM and SigV4 OAC for every custom-domain deployment", () => {
    expect(hosting).toContain(
      'authorization_type = var.custom_domain == "" && var.allow_public_function_url_bootstrap ? "NONE" : "AWS_IAM"'
    );
    expect(hosting).toMatch(
      /resource "aws_cloudfront_origin_access_control" "app"[\s\S]*origin_access_control_origin_type = "lambda"[\s\S]*signing_behavior\s+= "always"[\s\S]*signing_protocol\s+= "sigv4"/
    );
    expect(hosting).toContain(
      "origin_access_control_id = aws_cloudfront_origin_access_control.app[0].id"
    );
    expect(hosting).not.toContain("edge_shared_secret");
    expect(hosting).not.toContain("x-rulix-edge-secret");
    expect(hosting).not.toContain("RULIX_EDGE_SHARED_SECRET");
  });

  it("grants both URL and function invocation only to the owning distribution", () => {
    const urlPermission = terraformBlock(
      hosting,
      'resource "aws_lambda_permission" "cloudfront_function_url"'
    );
    const invokePermission = terraformBlock(
      hosting,
      'resource "aws_lambda_permission" "cloudfront_invoke_function"'
    );

    expect(urlPermission).toContain('action                 = "lambda:InvokeFunctionUrl"');
    expect(urlPermission).toContain('principal              = "cloudfront.amazonaws.com"');
    expect(urlPermission).toContain("source_arn             = aws_cloudfront_distribution.app[0].arn");
    expect(urlPermission).toContain('function_url_auth_type = "AWS_IAM"');
    expect(invokePermission).toContain('action                   = "lambda:InvokeFunction"');
    expect(invokePermission).toContain('principal                = "cloudfront.amazonaws.com"');
    expect(invokePermission).toContain("source_arn               = aws_cloudfront_distribution.app[0].arn");
    expect(invokePermission).toContain("invoked_via_function_url = true");
  });

  it("requires an explicit, no-domain-only acknowledgement for anonymous bootstrap", () => {
    const bootstrap = terraformBlock(
      variables,
      'variable "allow_public_function_url_bootstrap"'
    );
    expect(bootstrap).toContain("default     = false");
    expect(bootstrap).toContain(
      '!var.allow_public_function_url_bootstrap || var.custom_domain == ""'
    );
    expect(outputs).toContain("AWS_IAM rejects direct anonymous requests");
  });

  it("keeps queue creation behind both the AI rate limit and its exact origin cap", () => {
    const aiRoutes = terraformBlock(
      hosting,
      'resource "aws_wafv2_regex_pattern_set" "ai_routes"'
    );
    const largePostRoutes = terraformBlock(
      hosting,
      'resource "aws_wafv2_regex_pattern_set" "large_post_body_routes"'
    );
    expect(aiRoutes).toContain('regex_string = "^/api/ai-approval-requests$"');
    expect(largePostRoutes).toContain('regex_string = "^/api/ai-approval-requests$"');
  });

  it("provisions a KMS-protected, rotatable 32-byte approval-preview keyring", () => {
    const app = terraformBlock(hosting, 'resource "aws_lambda_function" "app"');
    const generatedKey = terraformBlock(hosting, 'resource "random_id" "ai_approval_preview"');
    const activeKey = terraformBlock(variables, 'variable "ai_approval_preview_key_id"');
    const priorKeys = terraformBlock(
      variables,
      'variable "ai_approval_preview_previous_keys_json"'
    );

    expect(generatedKey).toContain("byte_length = 32");
    expect(generatedKey).toContain("key_id = var.ai_approval_preview_key_id");
    expect(hosting).toContain("random_id.ai_approval_preview.b64_url");
    expect(hosting).toContain("sensitive(jsonencode(local.ai_approval_preview_keys))");
    expect(app).toContain("kms_key_arn                    = aws_kms_key.tenant.arn");
    expect(app).toContain(
      "RULIX_AI_APPROVAL_PREVIEW_ACTIVE_KEY_ID = var.ai_approval_preview_key_id"
    );
    expect(app).toContain(
      "RULIX_AI_APPROVAL_PREVIEW_KEYS_JSON     = local.ai_approval_preview_keys_json"
    );
    expect(activeKey).toContain('default     = "v1"');
    expect(priorKeys).toContain("sensitive   = true");
    expect(priorKeys).toContain('regex("^[A-Za-z0-9_-]{43}$", encoded)');
  });
});

function terraformBlock(source: string, declaration: string) {
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`Missing Terraform declaration: ${declaration}`);
  const opening = source.indexOf("{", start + declaration.length);
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unclosed Terraform declaration: ${declaration}`);
}
