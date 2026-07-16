variable "tenant_slug" {
  description = "Short lowercase tenant slug used in resource names."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]{3,32}$", var.tenant_slug))
    error_message = "tenant_slug must be 3-32 lowercase letters, numbers, or hyphens."
  }
}

variable "aws_region" {
  description = "AWS region for the tenant deployment, for example us-east-1 or us-gov-west-1."
  type        = string
}

variable "log_retention_days" {
  description = "CloudWatch log retention period."
  type        = number
  default     = 365
}

variable "bedrock_resource_arns" {
  description = "Explicit allowed Bedrock model, inference-profile, agent, or knowledge-base ARNs. Wildcards are forbidden."
  type        = set(string)

  validation {
    condition = length(var.bedrock_resource_arns) > 0 && alltrue([
      for arn in var.bedrock_resource_arns :
      arn != "*" && can(regex(
        "^arn:(aws|aws-us-gov|aws-cn):bedrock:[a-z0-9-]*:[0-9]*:[A-Za-z0-9_./:-]+$",
        arn
      ))
    ])
    error_message = "bedrock_resource_arns must contain one or more explicit Bedrock ARNs; '*' and malformed ARNs are not allowed. Regionless foundation-model ARNs returned by Bedrock are supported."
  }
}

variable "approved_model_ids" {
  description = "Exact Bedrock model or inference-profile IDs/ARNs approved by the application egress policy. Wildcards are forbidden."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for model in var.approved_model_ids :
      length(model) >= 1 && length(model) <= 512 && model != "*" &&
      can(regex("^[A-Za-z0-9][A-Za-z0-9._:/-]*$", model))
    ])
    error_message = "approved_model_ids must contain only exact 1-512 character Bedrock IDs or ARNs without wildcards."
  }
}

variable "bedrock_prices_json" {
  description = "Optional non-secret, non-empty JSON pricing table passed to the runtime for deterministic cost admission and reporting. Empty uses the runtime's conservative defaults."
  type        = string
  default     = ""

  validation {
    condition = var.bedrock_prices_json == "" || (
      can(jsondecode(var.bedrock_prices_json))
      && can(keys(jsondecode(var.bedrock_prices_json)))
      && try(length(keys(jsondecode(var.bedrock_prices_json))) > 0, false)
    )
    error_message = "bedrock_prices_json must be empty or a non-empty JSON object."
  }
}

variable "workspace_mode" {
  description = "Workspace storage cutover mode. Production should use normalized after migration verification."
  type        = string
  default     = "normalized"

  validation {
    condition     = contains(["legacy", "dual-read", "normalized"], var.workspace_mode)
    error_message = "workspace_mode must be legacy, dual-read, or normalized."
  }
}

variable "data_deletion_protection_enabled" {
  description = "Enable AWS deletion protection on durable DynamoDB tables. Disable only through an approved break-glass change."
  type        = bool
  default     = true
}

variable "workspace_cursor_key_id" {
  description = "Version identifier for the active dedicated workspace cursor HMAC key. Changing it rotates the generated key."
  type        = string
  default     = "v1"

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]{1,32}$", var.workspace_cursor_key_id))
    error_message = "workspace_cursor_key_id must be a 1-32 character safe identifier."
  }
}

variable "workspace_cursor_previous_keys_json" {
  description = "Sensitive JSON object of previous cursor key IDs to >=32-byte secrets retained only during rotation."
  type        = string
  default     = "{}"
  sensitive   = true

  validation {
    condition = can(jsondecode(var.workspace_cursor_previous_keys_json)) && alltrue([
      for key_id, secret in try(jsondecode(var.workspace_cursor_previous_keys_json), {}) :
      can(regex("^[A-Za-z0-9._-]{1,32}$", key_id)) && length(secret) >= 32
    ])
    error_message = "workspace_cursor_previous_keys_json must be a JSON object of safe key IDs to secrets at least 32 bytes long."
  }
}

variable "ai_approval_preview_key_id" {
  description = "Version identifier for the active generated AI approval preview AES key. Change only through the documented overlap rotation procedure."
  type        = string
  default     = "v1"

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]{1,64}$", var.ai_approval_preview_key_id))
    error_message = "ai_approval_preview_key_id must be a 1-64 character safe identifier."
  }
}

variable "ai_approval_preview_previous_keys_json" {
  description = "Sensitive JSON object of previous preview key IDs to canonical 32-byte base64url keys retained only for the <=72-hour rotation overlap."
  type        = string
  default     = "{}"
  sensitive   = true

  validation {
    condition = can(jsondecode(var.ai_approval_preview_previous_keys_json)) && alltrue([
      for key_id, encoded in try(jsondecode(var.ai_approval_preview_previous_keys_json), {}) :
      can(regex("^[A-Za-z0-9._-]{1,64}$", key_id)) &&
      can(regex("^[A-Za-z0-9_-]{43}$", encoded))
    ])
    error_message = "ai_approval_preview_previous_keys_json must map safe key IDs to canonical 43-character base64url AES-256 keys."
  }
}

variable "workspace_migration_principal_arns" {
  description = "Explicit IAM principal ARNs allowed to assume the isolated workspace migration role."
  type        = set(string)

  validation {
    condition = length(var.workspace_migration_principal_arns) > 0 && alltrue([
      for arn in var.workspace_migration_principal_arns :
      can(regex("^arn:(aws|aws-us-gov|aws-cn):iam::[0-9]{12}:(user|role)/[A-Za-z0-9+=,.@_/-]+$", arn))
    ])
    error_message = "workspace_migration_principal_arns must contain explicit IAM user or role ARNs."
  }
}

# ---- App hosting (Lambda + Function URL + CloudFront) ----

variable "bedrock_enabled" {
  description = "Enables live Bedrock AI calls when true. False keeps the app in deterministic local-rules mode."
  type        = bool
  default     = true
}

variable "ai_data_class" {
  description = "Minimum data classification enforced for every AI provider dispatch."
  type        = string
  default     = "proprietary"

  validation {
    condition = contains([
      "public",
      "proprietary",
      "export-controlled",
      "itar-risk",
      "cui"
    ], var.ai_data_class)
    error_message = "ai_data_class must be public, proprietary, export-controlled, itar-risk, or cui."
  }
}

variable "approved_provider" {
  description = "Provider identity allowed to receive AI requests from this deployment."
  type        = string
  default     = "amazon-bedrock"

  validation {
    condition     = contains(["amazon-bedrock", "anthropic-direct"], var.approved_provider)
    error_message = "approved_provider must be amazon-bedrock or anthropic-direct."
  }
}

variable "approved_region" {
  description = "Region identity approved for AI egress. Null inherits aws_region; anthropic-direct deployments must set global."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.approved_region == null || can(regex(
      "^(global|[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+)$",
      coalesce(var.approved_region, "")
    ))
    error_message = "approved_region must be null, global, or a lowercase AWS region identifier."
  }
}

variable "controlled_data_mode" {
  description = "Explicit controlled-data AI opt-in. Keep disabled unless the deployment provider and region have been approved for controlled data."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "approved"], var.controlled_data_mode)
    error_message = "controlled_data_mode must be disabled or approved."
  }
}

variable "ai_max_concurrent" {
  description = "Maximum concurrent AI provider leases per account."
  type        = number
  default     = 4

  validation {
    condition     = var.ai_max_concurrent >= 1 && var.ai_max_concurrent <= 1000 && floor(var.ai_max_concurrent) == var.ai_max_concurrent
    error_message = "ai_max_concurrent must be an integer from 1 through 1000."
  }
}

variable "ai_requests_per_minute" {
  description = "Maximum admitted AI requests per account in a rolling minute."
  type        = number
  default     = 60

  validation {
    condition     = var.ai_requests_per_minute >= 1 && var.ai_requests_per_minute <= 100000 && floor(var.ai_requests_per_minute) == var.ai_requests_per_minute
    error_message = "ai_requests_per_minute must be an integer from 1 through 100000."
  }
}

variable "ai_tokens_per_day" {
  description = "Maximum admitted AI tokens per account per UTC day."
  type        = number
  default     = 5000000

  validation {
    condition     = var.ai_tokens_per_day >= 1 && var.ai_tokens_per_day <= 1000000000 && floor(var.ai_tokens_per_day) == var.ai_tokens_per_day
    error_message = "ai_tokens_per_day must be an integer from 1 through 1000000000."
  }
}

variable "ai_spend_usd_per_day" {
  description = "Maximum admitted estimated AI spend in USD per account per UTC day."
  type        = number
  default     = 50

  validation {
    condition     = var.ai_spend_usd_per_day >= 0.01 && var.ai_spend_usd_per_day <= 100000
    error_message = "ai_spend_usd_per_day must be from 0.01 through 100000."
  }
}

variable "ai_max_tokens_per_call" {
  description = "Maximum conservatively estimated input and output tokens admitted for one AI call."
  type        = number
  default     = 200000

  validation {
    condition     = var.ai_max_tokens_per_call >= 1 && var.ai_max_tokens_per_call <= 10000000 && floor(var.ai_max_tokens_per_call) == var.ai_max_tokens_per_call
    error_message = "ai_max_tokens_per_call must be an integer from 1 through 10000000."
  }
}

variable "ai_max_cost_usd_per_call" {
  description = "Maximum conservatively estimated AI cost in USD admitted for one call."
  type        = number
  default     = 5

  validation {
    condition     = var.ai_max_cost_usd_per_call >= 0.01 && var.ai_max_cost_usd_per_call <= 10000
    error_message = "ai_max_cost_usd_per_call must be from 0.01 through 10000."
  }
}

variable "ai_lease_seconds" {
  description = "Lifetime in seconds for an in-flight AI admission reservation."
  type        = number
  default     = 240

  validation {
    condition     = var.ai_lease_seconds >= 1 && var.ai_lease_seconds <= 3600 && floor(var.ai_lease_seconds) == var.ai_lease_seconds
    error_message = "ai_lease_seconds must be an integer from 1 through 3600."
  }
}

variable "bedrock_model" {
  description = "Server-owned exact Bedrock model or inference-profile ID/ARN."
  type        = string
  default     = "global.anthropic.claude-haiku-4-5-20251001-v1:0"

  validation {
    condition     = length(var.bedrock_model) <= 512 && var.bedrock_model != "*" && can(regex("^[A-Za-z0-9][A-Za-z0-9._:/-]*$", var.bedrock_model))
    error_message = "bedrock_model must be an exact non-wildcard Bedrock model/profile ID or ARN."
  }
}

variable "bedrock_deep_model" {
  description = "Server-owned Bedrock inference-profile id for deep council reviews."
  type        = string
  default     = "global.anthropic.claude-sonnet-4-6"

  validation {
    condition     = length(var.bedrock_deep_model) <= 512 && var.bedrock_deep_model != "*" && can(regex("^[A-Za-z0-9][A-Za-z0-9._:/-]*$", var.bedrock_deep_model))
    error_message = "bedrock_deep_model must be an exact non-wildcard Bedrock model/profile ID or ARN."
  }
}

variable "bedrock_outreach_model" {
  description = "Bedrock inference-profile id used by the authenticated operations outreach writer."
  type        = string
  default     = "us.anthropic.claude-opus-4-6-v1"

  validation {
    condition     = length(var.bedrock_outreach_model) <= 512 && var.bedrock_outreach_model != "*" && can(regex("^[A-Za-z0-9][A-Za-z0-9._:/-]*$", var.bedrock_outreach_model))
    error_message = "bedrock_outreach_model must be an exact non-wildcard Bedrock model/profile ID or ARN."
  }
}

variable "bedrock_personalization_model" {
  description = "Bedrock model used for source-grounded outreach personalization."
  type        = string
  default     = "global.anthropic.claude-sonnet-4-6"

  validation {
    condition     = length(var.bedrock_personalization_model) <= 512 && var.bedrock_personalization_model != "*" && can(regex("^[A-Za-z0-9][A-Za-z0-9._:/-]*$", var.bedrock_personalization_model))
    error_message = "bedrock_personalization_model must be an exact non-wildcard Bedrock model/profile ID or ARN."
  }
}

variable "bedrock_lead_search_model" {
  description = "Bedrock model used to assess public-web lead-search evidence."
  type        = string
  default     = "global.anthropic.claude-sonnet-4-6"

  validation {
    condition     = length(var.bedrock_lead_search_model) <= 512 && var.bedrock_lead_search_model != "*" && can(regex("^[A-Za-z0-9][A-Za-z0-9._:/-]*$", var.bedrock_lead_search_model))
    error_message = "bedrock_lead_search_model must be an exact non-wildcard Bedrock model/profile ID or ARN."
  }
}

variable "custom_domain" {
  description = "Public custom domain for the app, e.g. app.rulix.cloud. Empty = use the default Function URL only (no CloudFront)."
  type        = string
  default     = "app.rulix.cloud"
}

variable "allow_public_function_url_bootstrap" {
  description = "Explicitly permit an anonymous Function URL only for a temporary no-domain bootstrap smoke test. Never enable this in production."
  type        = bool
  default     = false

  validation {
    condition     = !var.allow_public_function_url_bootstrap || var.custom_domain == ""
    error_message = "allow_public_function_url_bootstrap may be enabled only when custom_domain is empty."
  }
}

variable "dashboard_domain" {
  description = "Optional operations dashboard domain served by the same CloudFront distribution and Lambda bundle."
  type        = string
  default     = "dashboard.rulix.cloud"
}

variable "app_base_url" {
  description = "Public base URL used in invite and password reset emails."
  type        = string
  default     = "https://app.rulix.cloud"
}

variable "auth_email_from" {
  description = "Verified SES sender address for invite and password reset emails. Empty disables email delivery while still creating invite/reset tokens."
  type        = string
  default     = "security@rulix.cloud"
}

variable "auth_email_domain" {
  description = "SES domain identity used for transactional authentication email. Publish the generated DKIM CNAME records at the authoritative DNS provider."
  type        = string
  default     = "rulix.cloud"
}

variable "auth_mail_from_domain" {
  description = "Custom SES MAIL FROM domain. Publish the SES feedback MX and SPF TXT records at the authoritative DNS provider."
  type        = string
  default     = "mail.rulix.cloud"
}

variable "auth_bootstrap_secret" {
  description = "Optional one-time bootstrap secret for POST /api/auth/bootstrap-invite."
  type        = string
  default     = ""
  sensitive   = true
}

variable "auth_invite_ttl_hours" {
  description = "Invite token lifetime in hours."
  type        = number
  default     = 72
}

variable "auth_reset_ttl_minutes" {
  description = "Password reset token lifetime in minutes."
  type        = number
  default     = 30
}

variable "auth_session_ttl_hours" {
  description = "Authenticated session lifetime in hours."
  type        = number
  default     = 8
}

variable "app_reserved_concurrency" {
  description = "Hard ceiling for concurrent app Lambda executions, preserving account capacity and bounding downstream load. Use -1 when the account quota cannot reserve capacity while retaining AWS's required unreserved minimum."
  type        = number
  default     = 40

  validation {
    condition = (
      floor(var.app_reserved_concurrency) == var.app_reserved_concurrency
      && (
        var.app_reserved_concurrency == -1
        || (var.app_reserved_concurrency >= 2 && var.app_reserved_concurrency <= 1000)
      )
    )
    error_message = "app_reserved_concurrency must be -1 (unreserved) or an integer from 2 through 1000."
  }
}

variable "audit_reserved_concurrency" {
  description = "Hard ceiling for concurrent audit-writer Lambda executions. Use -1 when the account quota cannot reserve capacity while retaining AWS's required unreserved minimum."
  type        = number
  default     = 5

  validation {
    condition = (
      floor(var.audit_reserved_concurrency) == var.audit_reserved_concurrency
      && (
        var.audit_reserved_concurrency == -1
        || (var.audit_reserved_concurrency >= 1 && var.audit_reserved_concurrency <= 1000)
      )
    )
    error_message = "audit_reserved_concurrency must be -1 (unreserved) or an integer from 1 through 1000."
  }
}

variable "enable_waf" {
  description = "Attach an AWS WAF Web ACL to CloudFront for managed protections and route-specific rate limits."
  type        = bool
  default     = true
}

variable "waf_global_rate_limit" {
  description = "Maximum requests per 5-minute window per IP across the CloudFront distribution."
  type        = number
  default     = 2000

  validation {
    condition     = floor(var.waf_global_rate_limit) == var.waf_global_rate_limit && var.waf_global_rate_limit >= 100 && var.waf_global_rate_limit <= 2000000
    error_message = "waf_global_rate_limit must be an integer from 100 through 2000000."
  }
}

variable "waf_auth_rate_limit" {
  description = "Maximum requests per 5-minute window per IP for /api/auth/* routes."
  type        = number
  default     = 300

  validation {
    condition     = floor(var.waf_auth_rate_limit) == var.waf_auth_rate_limit && var.waf_auth_rate_limit >= 10 && var.waf_auth_rate_limit <= 100000
    error_message = "waf_auth_rate_limit must be an integer from 10 through 100000."
  }
}

variable "waf_admin_rate_limit" {
  description = "Maximum requests per 5-minute window per IP for /api/admin/* operations routes."
  type        = number
  default     = 200

  validation {
    condition     = floor(var.waf_admin_rate_limit) == var.waf_admin_rate_limit && var.waf_admin_rate_limit >= 10 && var.waf_admin_rate_limit <= 100000
    error_message = "waf_admin_rate_limit must be an integer from 10 through 100000."
  }
}

variable "waf_ai_rate_limit" {
  description = "Maximum POST requests per 5-minute window per IP for exact AI and document-processing routes."
  type        = number
  default     = 100

  validation {
    condition     = floor(var.waf_ai_rate_limit) == var.waf_ai_rate_limit && var.waf_ai_rate_limit >= 10 && var.waf_ai_rate_limit <= 100000
    error_message = "waf_ai_rate_limit must be an integer from 10 through 100000."
  }
}
