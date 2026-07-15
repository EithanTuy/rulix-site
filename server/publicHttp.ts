import { lookup } from "node:dns/promises";
import { request as requestHttp, type IncomingHttpHeaders } from "node:http";
import { request as requestHttps } from "node:https";
import { BlockList, isIP, type LookupFunction, type Socket } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export interface PublicHttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly url: string;
  text(): Promise<string>;
}

export interface PublicHttpOptions {
  headers?: Readonly<Record<string, string>>;
  maxRedirects?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface PinnedHttpResponse {
  status: number;
  headers: Headers;
  body: string;
  peerAddress: string;
}

export interface PublicHttpDependencies {
  resolve(hostname: string): Promise<ResolvedAddress[]>;
  request(
    url: URL,
    address: ResolvedAddress,
    options: Required<Pick<PublicHttpOptions, "headers" | "maxResponseBytes">> &
      Pick<PublicHttpOptions, "signal">
  ): Promise<PinnedHttpResponse>;
}

export class PublicHttpSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicHttpSecurityError";
  }
}

const NON_PUBLIC_IPV4 = new BlockList();
// Fail closed for private, local, reserved, documentation, non-forwardable,
// and otherwise non-global ranges from IANA's special-purpose registries:
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  NON_PUBLIC_IPV4.addSubnet(network, prefix, "ipv4");
}

const NON_PUBLIC_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3ffe::", 16],
  ["3fff::", 20],
  ["5f00::", 8],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8]
] as const) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, "ipv6");
}

const GLOBAL_UNICAST_IPV6 = new BlockList();
GLOBAL_UNICAST_IPV6.addSubnet("2000::", 3, "ipv6");

const FORBIDDEN_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "transfer-encoding",
  "upgrade",
  "www-authenticate",
  "x-api-key",
  "x-rulix-edge-secret"
]);

export function isPublicAddress(address: string) {
  const mappedIpv4 = ipv4FromMappedAddress(address);
  if (mappedIpv4) return isPublicAddress(mappedIpv4);
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC_IPV4.check(address, "ipv4");
  if (family === 6 && !address.includes("%")) {
    return GLOBAL_UNICAST_IPV6.check(address, "ipv6") &&
      !NON_PUBLIC_IPV6.check(address, "ipv6");
  }
  return false;
}

export function createPublicHttpClient(dependencies: PublicHttpDependencies) {
  return async function fetchPublicHttp(
    rawUrl: string | URL,
    options: PublicHttpOptions = {}
  ): Promise<PublicHttpResponse> {
    const headers = safeHeaders(options.headers ?? {});
    const maxRedirects = boundedInteger(options.maxRedirects ?? 0, 0, 10, "maxRedirects");
    const maxResponseBytes = boundedInteger(
      options.maxResponseBytes ?? 300_000,
      1,
      2_000_000,
      "maxResponseBytes"
    );
    const timeoutMs = boundedInteger(options.timeoutMs ?? 10_000, 1, 60_000, "timeoutMs");
    const requestSignal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    let url = rawUrl instanceof URL ? new URL(rawUrl) : new URL(rawUrl);

    for (let redirectCount = 0; ; redirectCount += 1) {
      validatePublicUrl(url);
      const hostname = hostnameForLookup(url);
      // DNS, every redirect, connection setup, and the response body share one
      // deadline. A redirect chain must not multiply the outbound time budget.
      const resolved = deduplicateAddresses(
        await settleBeforeAbort(dependencies.resolve(hostname), requestSignal)
      );
      if (!resolved.length) {
        throw new PublicHttpSecurityError("The public hostname did not resolve to an address.");
      }
      if (resolved.some(({ address }) => !isPublicAddress(address))) {
        throw new PublicHttpSecurityError("The public hostname resolved to a non-public address.");
      }

      const response = await requestResolvedAddress(
        dependencies,
        url,
        resolved,
        {
          headers,
          maxResponseBytes,
          signal: requestSignal
        }
      );
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400) {
        const body = response.body;
        return {
          status: response.status,
          ok: response.status >= 200 && response.status < 300,
          headers: response.headers,
          url: url.toString(),
          text: async () => body
        };
      }
      if (!location) {
        throw new PublicHttpSecurityError("The redirect did not include a destination.");
      }
      if (redirectCount >= maxRedirects) {
        throw new PublicHttpSecurityError("The public request exceeded its redirect limit.");
      }
      const redirectUrl = new URL(location, url);
      if (url.protocol === "https:" && redirectUrl.protocol === "http:") {
        throw new PublicHttpSecurityError("A public HTTPS request cannot redirect to plaintext HTTP.");
      }
      url = redirectUrl;
    }
  };
}

function settleBeforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function abortReason(signal: AbortSignal) {
  return signal.reason ?? new DOMException("The public request was aborted.", "AbortError");
}

async function requestResolvedAddress(
  dependencies: PublicHttpDependencies,
  url: URL,
  addresses: ResolvedAddress[],
  options: Required<Pick<PublicHttpOptions, "headers" | "maxResponseBytes">> &
    Pick<PublicHttpOptions, "signal">
) {
  let lastError: unknown;
  for (const address of addresses) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    try {
      const pendingResponse = dependencies.request(url, address, options);
      const response = options.signal
        ? await settleBeforeAbort(pendingResponse, options.signal)
        : await pendingResponse;
      if (!sameAddress(response.peerAddress, address.address)) {
        throw new PublicHttpSecurityError("The connected peer did not match the vetted address.");
      }
      return response;
    } catch (error) {
      if (error instanceof PublicHttpSecurityError) throw error;
      if (options.signal?.aborted) throw abortReason(options.signal);
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("The public request failed.");
}

async function resolvePublicHostname(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.flatMap((entry) =>
    entry.family === 4 || entry.family === 6
      ? [{ address: entry.address, family: entry.family }]
      : []
  );
}

async function requestPinnedAddress(
  url: URL,
  address: ResolvedAddress,
  options: Required<Pick<PublicHttpOptions, "headers" | "maxResponseBytes">> &
    Pick<PublicHttpOptions, "signal">
): Promise<PinnedHttpResponse> {
  const request = url.protocol === "https:" ? requestHttps : requestHttp;
  const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions?.all) {
      callback(null, [{ address: address.address, family: address.family }]);
    } else {
      callback(null, address.address, address.family);
    }
  };

  return new Promise((resolve, reject) => {
    const requestHeaders = {
      "accept-encoding": "identity",
      ...options.headers,
      host: url.host
    };
    const req = request(
      url,
      {
        agent: false,
        family: address.family,
        headers: requestHeaders,
        lookup: pinnedLookup,
        method: "GET",
        signal: options.signal
      },
      async (response) => {
        try {
          const peerAddress = peerAddressOf(response.socket);
          if (!sameAddress(peerAddress, address.address)) {
            throw new PublicHttpSecurityError("The connected peer did not match the vetted address.");
          }
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            response.destroy();
            resolve({
              status,
              headers: responseHeaders(response.headers),
              body: "",
              peerAddress
            });
            return;
          }
          const body = await readResponseBody(
            response,
            response.headers,
            options.maxResponseBytes
          );
          resolve({
            status,
            headers: responseHeaders(response.headers),
            body,
            peerAddress
          });
        } catch (error) {
          response.destroy();
          reject(error);
        }
      }
    );
    req.once("error", reject);
    req.end();
  });
}

function validatePublicUrl(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PublicHttpSecurityError("Only public HTTP sources are allowed.");
  }
  if (url.username || url.password || url.port) {
    throw new PublicHttpSecurityError("Credentials and custom ports are not allowed in public URLs.");
  }
  if (!url.hostname) throw new PublicHttpSecurityError("The public URL is missing a hostname.");
}

function safeHeaders(headers: Readonly<Record<string, string>>) {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.trim().toLowerCase();
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(normalized) || FORBIDDEN_REQUEST_HEADERS.has(normalized)) {
      throw new PublicHttpSecurityError(`The request header ${name} is not allowed.`);
    }
    if (typeof value !== "string" || /[^\t\x20-\x7e\x80-\xff]/.test(value)) {
      throw new PublicHttpSecurityError(`The request header ${name} contains unsafe characters.`);
    }
    result[normalized] = value;
  }
  return result;
}

function hostnameForLookup(url: URL) {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function deduplicateAddresses(addresses: ResolvedAddress[]) {
  const seen = new Set<string>();
  return addresses.filter((entry) => {
    if ((entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family) {
      throw new PublicHttpSecurityError("The hostname resolver returned an invalid address.");
    }
    const key = `${entry.family}:${entry.address.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameAddress(actual: string, expected: string) {
  const actualMapped = ipv4FromMappedAddress(actual);
  const expectedMapped = ipv4FromMappedAddress(expected);
  if (actualMapped || expectedMapped) {
    return (actualMapped ?? actual) === (expectedMapped ?? expected);
  }
  const family = isIP(expected);
  const actualFamily = isIP(actual);
  if (!family || !actualFamily) return false;
  const blockList = new BlockList();
  blockList.addAddress(expected, family === 4 ? "ipv4" : "ipv6");
  return blockList.check(actual, actualFamily === 4 ? "ipv4" : "ipv6");
}

function ipv4FromMappedAddress(address: string) {
  const match = address.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return match?.[1];
}

function peerAddressOf(socket: Socket) {
  if (!socket.remoteAddress) {
    throw new PublicHttpSecurityError("The connected peer address was unavailable.");
  }
  return socket.remoteAddress;
}

function responseHeaders(headers: IncomingHttpHeaders) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      result.append(name, String(item));
    }
  }
  return result;
}

async function readResponseBody(
  response: Readable,
  headers: IncomingHttpHeaders,
  maxResponseBytes: number
) {
  const encoding = String(headers["content-encoding"] ?? "identity").trim().toLowerCase();
  let stream: Readable = response;
  if (encoding === "gzip") stream = response.pipe(createGunzip());
  else if (encoding === "deflate") stream = response.pipe(createInflate());
  else if (encoding === "br") stream = response.pipe(createBrotliDecompress());
  else if (encoding && encoding !== "identity") {
    response.destroy();
    throw new Error(`Unsupported public response encoding: ${encoding}.`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxResponseBytes) {
      stream.destroy();
      response.destroy();
      throw new Error("The public response exceeded the permitted size.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export const fetchPublicHttp = createPublicHttpClient({
  resolve: resolvePublicHostname,
  request: requestPinnedAddress
});
