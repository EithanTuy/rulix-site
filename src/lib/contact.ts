export const CONTACT_EMAILS = ["pgcuber20@gmail.com", "tuyilin2@msu.edu"] as const;

export const CONTACT_EMAIL_TO = CONTACT_EMAILS.join(",");
export const CONTACT_EMAIL_DISPLAY = CONTACT_EMAILS.join(" and ");

export function createContactMailto(subject: string, body: string) {
  return `mailto:${CONTACT_EMAIL_TO}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
