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
