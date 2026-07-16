export const REVIEW_ID_PREFIXES = ["review-", "paste-", "upload-", "ai-draft-"] as const;

export type ReviewIdPrefix = (typeof REVIEW_ID_PREFIXES)[number];

const REVIEW_ID_PATTERN = /^(?:review|paste|upload|ai-draft)-[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const REVIEW_ID_MAX_LENGTH = 128;

/**
 * Review identities are durable references. New records use `review-*`, while
 * normalized workspaces can legitimately contain identifiers created by the
 * earlier paste, upload, and AI-draft intake paths.
 */
export function isReviewId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= REVIEW_ID_MAX_LENGTH
    && REVIEW_ID_PATTERN.test(value);
}

export function reviewIdPrefix(value: string): ReviewIdPrefix | undefined {
  return REVIEW_ID_PREFIXES.find((prefix) => value.startsWith(prefix));
}
