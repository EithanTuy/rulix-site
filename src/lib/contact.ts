export const CONTACT_EMAILS = ["tuyilin2@msu.edu"] as const;

export const CONTACT_EMAIL_TO = CONTACT_EMAILS[0];
export const CONTACT_EMAIL_DISPLAY = CONTACT_EMAILS[0];

export function createContactMailto(subject: string, body: string) {
  return `mailto:${CONTACT_EMAIL_TO}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
