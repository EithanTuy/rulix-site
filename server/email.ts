import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { InviteCreationResult, PasswordResetResult } from "./store";

export interface EmailDeliveryResult {
  sent: boolean;
  reason?: string;
}

const ses = new SESv2Client({});

export async function sendInviteEmail(invite: InviteCreationResult): Promise<EmailDeliveryResult> {
  const subject = "You're invited to Rulix";
  const text = [
    `You have been invited to Rulix as ${invite.invite.role}.`,
    "",
    "Use this one-time link to set your password:",
    invite.inviteLink,
    "",
    `This invite expires at ${invite.invite.expiresAt}.`
  ].join("\n");
  return sendAuthEmail(invite.invite.email, subject, text);
}

export async function sendPasswordResetEmail(reset: PasswordResetResult): Promise<EmailDeliveryResult> {
  if (!reset.resetLink) return { sent: false, reason: "No matching user." };
  const subject = "Reset your Rulix password";
  const text = [
    "A password reset was requested for your Rulix account.",
    "",
    "Use this one-time link to set a new password:",
    reset.resetLink,
    "",
    `This link expires at ${reset.expiresAt}.`,
    "",
    "If you did not request this reset, ignore this email."
  ].join("\n");
  return sendAuthEmail(reset.email, subject, text);
}

async function sendAuthEmail(to: string, subject: string, text: string): Promise<EmailDeliveryResult> {
  const from = process.env.AUTH_EMAIL_FROM?.trim();
  if (!from) return { sent: false, reason: "AUTH_EMAIL_FROM is not configured." };

  try {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: from,
      Destination: {
        ToAddresses: [to]
      },
      Content: {
        Simple: {
          Subject: { Data: subject },
          Body: {
            Text: { Data: text }
          }
        }
      }
    }));
  } catch (error) {
    return {
      sent: false,
      reason: error instanceof Error ? error.message : "SES send failed."
    };
  }

  return { sent: true };
}
