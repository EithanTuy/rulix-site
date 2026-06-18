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

variable "custom_domain" {
  description = "Public custom domain for the app, e.g. app.rulix.cloud. Empty = use the default Function URL only (no CloudFront)."
  type        = string
  default     = "app.rulix.cloud"
}
