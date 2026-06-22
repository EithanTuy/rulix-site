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
  description = "Allowed Bedrock model, agent, or knowledge base ARNs. Use explicit ARNs for production."
  type        = list(string)
  default     = ["*"]
}

# ---- App hosting (Lambda + Function URL + CloudFront) ----

variable "bedrock_enabled" {
  description = "Enables live Bedrock AI calls when true. False keeps the app in deterministic local-rules mode."
  type        = bool
  default     = false
}

variable "bedrock_model" {
  description = "Server-owned Bedrock model or inference-profile id. Default uses global Claude Haiku 4.5 routing."
  type        = string
  default     = "global.anthropic.claude-haiku-4-5-20251001-v1:0"

  validation {
    condition     = can(regex("^(global|us|eu|apac|jp)\\.anthropic\\.claude-[a-z0-9-]+-[0-9]{8}-v[0-9]:[0-9]$", var.bedrock_model))
    error_message = "bedrock_model must be a Bedrock Anthropic inference-profile id, for example global.anthropic.claude-haiku-4-5-20251001-v1:0."
  }
}

variable "bedrock_deep_model" {
  description = "Server-owned Bedrock inference-profile id for deep council reviews."
  type        = string
  default     = "global.anthropic.claude-sonnet-4-6"

  validation {
    condition     = can(regex("^(global|us|eu|apac|jp)\\.anthropic\\.claude-[a-z0-9-]+(?:-[0-9]{8}-v[0-9]:[0-9])?$", var.bedrock_deep_model))
    error_message = "bedrock_deep_model must be a Bedrock Anthropic inference-profile id."
  }
}

variable "bedrock_outreach_model" {
  description = "Bedrock inference-profile id used by the authenticated operations outreach writer."
  type        = string
  default     = "us.anthropic.claude-opus-4-6-v1"
}

variable "bedrock_personalization_model" {
  description = "Bedrock model used for source-grounded outreach personalization."
  type        = string
  default     = "global.anthropic.claude-sonnet-4-6"
}

variable "bedrock_lead_search_model" {
  description = "Bedrock model used to assess public-web lead-search evidence."
  type        = string
  default     = "global.anthropic.claude-sonnet-4-6"
}

variable "custom_domain" {
  description = "Public custom domain for the app, e.g. app.rulix.cloud. Empty = use the default Function URL only (no CloudFront)."
  type        = string
  default     = "app.rulix.cloud"
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
  default     = ""
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

variable "enable_waf" {
  description = "Attach an AWS WAF Web ACL to CloudFront for managed protections and route-specific rate limits."
  type        = bool
  default     = true
}

variable "waf_global_rate_limit" {
  description = "Maximum requests per 5-minute window per IP across the CloudFront distribution."
  type        = number
  default     = 2000
}

variable "waf_auth_rate_limit" {
  description = "Maximum requests per 5-minute window per IP for /api/auth/* routes."
  type        = number
  default     = 300
}

variable "waf_admin_rate_limit" {
  description = "Maximum requests per 5-minute window per IP for /api/admin/* operations routes."
  type        = number
  default     = 200
}
