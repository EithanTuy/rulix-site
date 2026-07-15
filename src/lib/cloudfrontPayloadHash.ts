const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CloudFront Lambda origin access control signs an exact request payload.
 * Browser writes therefore carry the SHA-256 of the bytes fetch will send.
 * Rulix currently sends only JSON strings (or an empty body) through this
 * boundary; unsupported streaming or multipart bodies fail closed rather than
 * being signed with a digest for different bytes.
 */
export async function withCloudFrontPayloadHash(init: RequestInit = {}): Promise<RequestInit> {
  const method = (init.method ?? "GET").toUpperCase();
  if (BODYLESS_METHODS.has(method)) return init;

  const bytes = await requestBodyBytes(init.body);
  // Copy into an ordinary ArrayBuffer so a caller-supplied SharedArrayBuffer
  // view cannot race or change beneath the digest operation.
  const stableBytes = new Uint8Array(bytes.byteLength);
  stableBytes.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", stableBytes.buffer);
  const headers = new Headers(init.headers);
  headers.set("x-amz-content-sha256", toHex(new Uint8Array(digest)));
  return { ...init, headers };
}

async function requestBodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body === undefined || body === null) return new Uint8Array();
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  throw new Error(
    "This request body cannot be hashed safely for the private CloudFront origin."
  );
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
