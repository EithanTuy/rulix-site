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

# ---- App hosting (App Runner) ----

variable "repository_url" {
  description = "HTTPS URL of the GitHub repo App Runner builds from."
  type        = string
  default     = "https://github.com/Daculguy/Rulix"
}

variable "repository_branch" {
  description = "Branch App Runner tracks for auto-deploys."
  type        = string
  default     = "main"
}

variable "apprunner_connection_arn" {
  description = "ARN of the authorized App Runner <-> GitHub connection (create once in the console)."
  type        = string
  default     = ""
}

variable "anthropic_secret_arn" {
  description = "Secrets Manager ARN holding the ANTHROPIC_API_KEY. Empty = run in local-rules mode."
  type        = string
  default     = ""
}

variable "custom_domain" {
  description = "Public custom domain for the app, e.g. app.rulix.cloud. Empty = use the default App Runner URL only."
  type        = string
  default     = "app.rulix.cloud"
}
