const MAX_EXTERNAL_URL_LENGTH = 4_096;

/**
 * Returns a canonical, browser-safe external URL or undefined. Source URLs can
 * originate in imports and model output, so React's href escaping is not the
 * security boundary: only ordinary, credential-free HTTP(S) navigation is
 * permitted.
 */
export function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  if (
    !candidate ||
    candidate.length > MAX_EXTERNAL_URL_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return undefined;
  }

  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      !url.hostname
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}
