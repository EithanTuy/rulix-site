resource "aws_sesv2_email_identity" "auth" {
  email_identity = var.auth_email_domain

  tags = {
    Name = "rulix-${var.tenant_slug}-auth-email"
  }
}

resource "aws_sesv2_email_identity_mail_from_attributes" "auth" {
  email_identity         = aws_sesv2_email_identity.auth.email_identity
  mail_from_domain       = var.auth_mail_from_domain
  behavior_on_mx_failure = "REJECT_MESSAGE"
}
