import { ApiError, isApiError } from "./apiErrors";
import { withCloudFrontPayloadHash } from "../../lib/cloudfrontPayloadHash";

const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_TIMEOUT_MS = 25;
const MAX_TIMEOUT_MS = 180_000;
const DEFAULT_READ_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 300;
const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;
const CSRF_HEADER = "x-rulix-csrf";
const IDEMPOTENCY_HEADER = "Idempotency-Key";

export type UnauthorizedHandler = (error: ApiError) => void;
type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export interface HttpClientOptions {
  baseUrl?: string;
  csrfPath?: string;
  defaultTimeoutMs?: number;
  maxReadRetries?: number;
  retryBaseDelayMs?: number;
  maxRetryDelayMs?: number;
  retryJitterRatio?: number;
  fetch?: typeof fetch;
  onUnauthorized?: UnauthorizedHandler;
  sleep?: Sleep;
  now?: () => number;
  random?: () => number;
  idempotencyKeyFactory?: () => string;
}

export interface HttpRequestOptions extends Omit<RequestInit, "body" | "method" | "signal"> {
  method?: string;
  body?: BodyInit | null;
  json?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  parseAs?: "json" | "text" | "void";
  /** Number of retry attempts after the initial safe-read request. */
  retries?: number | false;
  /** Protected mutations fetch and attach a CSRF token by default. */
  csrf?: boolean;
  /** Mutations receive a generated key by default. Pass false only for legacy endpoints. */
  idempotencyKey?: string | false;
  /** Authentication endpoints can suppress the global signed-out notification. */
  notifyOnUnauthorized?: boolean;
}

export interface HttpClient {
  request<T>(path: string, options?: HttpRequestOptions): Promise<T>;
  get<T>(path: string, options?: Omit<HttpRequestOptions, "method" | "json">): Promise<T>;
  post<T>(path: string, json?: unknown, options?: Omit<HttpRequestOptions, "method" | "json">): Promise<T>;
  put<T>(path: string, json?: unknown, options?: Omit<HttpRequestOptions, "method" | "json">): Promise<T>;
  patch<T>(path: string, json?: unknown, options?: Omit<HttpRequestOptions, "method" | "json">): Promise<T>;
  delete<T>(path: string, options?: Omit<HttpRequestOptions, "method" | "json">): Promise<T>;
  setCsrfToken(token: string | undefined): void;
  clearCsrfToken(): void;
  setUnauthorizedHandler(handler: UnauthorizedHandler | undefined): void;
}

interface ParsedErrorBody {
  code?: string;
  message?: string;
  requestId?: string;
  details?: unknown;
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new Error("A fetch implementation is required.");

  const baseUrl = options.baseUrl?.replace(/\/$/, "") ?? "";
  const csrfPath = options.csrfPath ?? (baseUrl ? "auth/me" : "/api/auth/me");
  const defaultTimeoutMs = boundedTimeout(options.defaultTimeoutMs, DEFAULT_TIMEOUT_MS);
  const maxReadRetries = nonNegativeInteger(options.maxReadRetries, DEFAULT_READ_RETRIES);
  const retryBaseDelayMs = nonNegativeNumber(options.retryBaseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS);
  const maxRetryDelayMs = nonNegativeNumber(options.maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS);
  const retryJitterRatio = clamp(options.retryJitterRatio ?? 0.2, 0, 1);
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const makeIdempotencyKey = options.idempotencyKeyFactory ?? defaultIdempotencyKey;

  let csrfToken: string | undefined;
  let csrfRefreshPromise: Promise<string> | undefined;
  let unauthorizedHandler = options.onUnauthorized;

  const notifyUnauthorized = (error: ApiError) => {
    csrfToken = undefined;
    try {
      unauthorizedHandler?.(error);
    } catch {
      // Session UI callbacks must never mask the original request failure.
    }
  };

  const loadCsrfToken = async () => {
    const url = resolveUrl(baseUrl, csrfPath);
    const deadline = createDeadline(undefined, defaultTimeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          credentials: "include",
          headers: { Accept: "application/json" },
          signal: deadline.signal
        });
      } catch (error) {
        throw requestFailure(error, deadline, "GET", url);
      }

      if (!response.ok) {
        const apiError = await responseError(response, "GET", url, now);
        if (apiError.status === 401) notifyUnauthorized(apiError);
        throw apiError;
      }

      const payload = await parseSuccess<{ csrfToken?: unknown }>(response, "json", "GET", url);
      const token = typeof payload?.csrfToken === "string" ? payload.csrfToken.trim() : "";
      if (!token) {
        throw new ApiError({
          status: response.status,
          code: "CSRF_TOKEN_MISSING",
          message: "The server did not provide a CSRF token.",
          method: "GET",
          url
        });
      }
      csrfToken = token;
      return token;
    } finally {
      deadline.cleanup();
    }
  };

  const ensureCsrfToken = () => {
    if (csrfToken) return Promise.resolve(csrfToken);
    if (csrfRefreshPromise) return csrfRefreshPromise;

    const pending = loadCsrfToken();
    csrfRefreshPromise = pending;
    const clearPending = () => {
      if (csrfRefreshPromise === pending) csrfRefreshPromise = undefined;
    };
    pending.then(clearPending, clearPending);
    return pending;
  };

  const request = async <T>(path: string, requestOptions: HttpRequestOptions = {}): Promise<T> => {
    const {
      method: requestedMethod,
      body: requestedBody,
      json,
      signal: externalSignal,
      timeoutMs: requestedTimeout,
      parseAs = "json",
      retries,
      csrf = true,
      idempotencyKey,
      notifyOnUnauthorized = true,
      ...fetchOptions
    } = requestOptions;
    const method = (requestedMethod ?? "GET").toUpperCase();
    const safeRead = isSafeRead(method);
    const url = resolveUrl(baseUrl, path);
    const timeoutMs = boundedTimeout(requestedTimeout, defaultTimeoutMs);
    const deadline = createDeadline(externalSignal, timeoutMs);
    const headers = new Headers(fetchOptions.headers);
    const hasJson = json !== undefined;

    if (hasJson && requestedBody !== undefined) {
      deadline.cleanup();
      throw new TypeError("Use either json or body, not both.");
    }

    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (hasJson && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    if (!safeRead) {
      if (idempotencyKey !== false && !headers.has(IDEMPOTENCY_HEADER)) {
        headers.set(
          IDEMPOTENCY_HEADER,
          typeof idempotencyKey === "string" && idempotencyKey.trim()
            ? idempotencyKey.trim()
            : makeIdempotencyKey()
        );
      }

      if (csrf && !headers.has(CSRF_HEADER)) {
        try {
          headers.set(CSRF_HEADER, await waitForSharedPromise(ensureCsrfToken(), deadline.signal));
        } catch (error) {
          deadline.cleanup();
          if (deadline.signal.aborted) throw requestFailure(error, deadline, method, url);
          throw error;
        }
      }
    }

    const retryLimit = safeRead
      ? retries === false
        ? 0
        : nonNegativeInteger(retries, maxReadRetries)
      : 0;
    const body = hasJson ? JSON.stringify(json) : requestedBody;

    try {
      for (let attempt = 0; ; attempt += 1) {
        throwIfAborted(deadline, method, url);

        let response: Response;
        try {
          response = await fetchImpl(url, await withCloudFrontPayloadHash({
            ...fetchOptions,
            method,
            body,
            credentials: fetchOptions.credentials ?? "include",
            headers,
            signal: deadline.signal
          }));
        } catch (error) {
          const apiError = requestFailure(error, deadline, method, url);
          if (attempt < retryLimit && apiError.code === "NETWORK_ERROR") {
            await waitBeforeRetry(retryDelay(attempt), deadline, method, url);
            continue;
          }
          throw apiError;
        }

        if (!response.ok) {
          const apiError = await responseError(response, method, url, now);
          if (apiError.status === 401 && notifyOnUnauthorized) {
            notifyUnauthorized(apiError);
          }
          if (attempt < retryLimit && isRetryableStatus(apiError.status)) {
            await waitBeforeRetry(apiError.retryAfterMs ?? retryDelay(attempt), deadline, method, url);
            continue;
          }
          throw apiError;
        }

        const result = await parseSuccess<T>(response, parseAs, method, url);
        if (isRecord(result) && typeof result.csrfToken === "string" && result.csrfToken.trim()) {
          csrfToken = result.csrfToken.trim();
        }
        return result;
      }
    } finally {
      deadline.cleanup();
    }
  };

  const retryDelay = (attempt: number) => {
    const exponential = Math.min(maxRetryDelayMs, retryBaseDelayMs * 2 ** attempt);
    const jitter = 1 + (random() * 2 - 1) * retryJitterRatio;
    return Math.max(0, Math.round(exponential * jitter));
  };

  const waitBeforeRetry = async (milliseconds: number, deadline: Deadline, method: string, url: string) => {
    const delay = Math.min(maxRetryDelayMs, Math.max(0, milliseconds));
    try {
      await sleep(delay, deadline.signal);
    } catch (error) {
      throw requestFailure(error, deadline, method, url);
    }
    throwIfAborted(deadline, method, url);
  };

  return {
    request,
    get: <T>(path: string, requestOptions?: Omit<HttpRequestOptions, "method" | "json">) =>
      request<T>(path, { ...requestOptions, method: "GET" }),
    post: <T>(path: string, json?: unknown, requestOptions?: Omit<HttpRequestOptions, "method" | "json">) =>
      request<T>(path, { ...requestOptions, method: "POST", json }),
    put: <T>(path: string, json?: unknown, requestOptions?: Omit<HttpRequestOptions, "method" | "json">) =>
      request<T>(path, { ...requestOptions, method: "PUT", json }),
    patch: <T>(path: string, json?: unknown, requestOptions?: Omit<HttpRequestOptions, "method" | "json">) =>
      request<T>(path, { ...requestOptions, method: "PATCH", json }),
    delete: <T>(path: string, requestOptions?: Omit<HttpRequestOptions, "method" | "json">) =>
      request<T>(path, { ...requestOptions, method: "DELETE" }),
    setCsrfToken(token: string | undefined) {
      csrfToken = token?.trim() || undefined;
    },
    clearCsrfToken() {
      csrfToken = undefined;
    },
    setUnauthorizedHandler(handler: UnauthorizedHandler | undefined) {
      unauthorizedHandler = handler;
    }
  };
}

interface Deadline {
  signal: AbortSignal;
  timedOut(): boolean;
  externallyAborted(): boolean;
  cleanup(): void;
}

function createDeadline(externalSignal: AbortSignal | undefined, timeoutMs: number): Deadline {
  const controller = new AbortController();
  let didTimeOut = false;

  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  const timer = globalThis.setTimeout(() => {
    didTimeOut = true;
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    externallyAborted: () => Boolean(externalSignal?.aborted),
    cleanup() {
      globalThis.clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  };
}

function throwIfAborted(deadline: Deadline, method: string, url: string) {
  if (deadline.signal.aborted) throw requestFailure(deadline.signal.reason, deadline, method, url);
}

function requestFailure(error: unknown, deadline: Deadline, method: string, url: string) {
  if (isApiError(error)) return error;
  if (deadline.timedOut()) {
    return new ApiError({
      status: 0,
      code: "REQUEST_TIMEOUT",
      message: "The request timed out. Try again.",
      method,
      url
    });
  }
  if (deadline.externallyAborted() || deadline.signal.aborted) {
    return new ApiError({
      status: 0,
      code: "REQUEST_ABORTED",
      message: "The request was canceled.",
      method,
      url
    });
  }
  return new ApiError({
    status: 0,
    code: "NETWORK_ERROR",
    message: "Rulix could not reach the server. Check your connection and try again.",
    details: error instanceof Error ? { name: error.name, message: error.message } : undefined,
    method,
    url
  });
}

async function responseError(response: Response, method: string, url: string, now: () => number) {
  const body = await readResponseBody(response);
  const parsed = parseErrorBody(body);
  return new ApiError({
    status: response.status,
    code: parsed.code ?? defaultCode(response.status),
    message: parsed.message ?? (response.statusText || `Request failed with status ${response.status}.`),
    requestId:
      parsed.requestId ??
      response.headers.get("x-request-id") ??
      response.headers.get("x-amzn-requestid") ??
      undefined,
    details: parsed.details,
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now()),
    method,
    url
  });
}

async function parseSuccess<T>(response: Response, parseAs: "json" | "text" | "void", method: string, url: string) {
  if (parseAs === "void" || response.status === 204 || response.status === 205) return undefined as T;
  const text = await response.text();
  if (parseAs === "text") return text as T;
  if (!text.trim()) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError({
      status: response.status,
      code: "INVALID_RESPONSE",
      message: "The server returned an invalid JSON response.",
      method,
      url
    });
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseErrorBody(body: unknown): ParsedErrorBody {
  if (typeof body === "string") return { message: body };
  if (!isRecord(body)) return {};

  const nested = isRecord(body.error) ? body.error : undefined;
  return {
    code: stringValue(nested?.code) ?? stringValue(body.code),
    message:
      stringValue(nested?.message) ??
      (typeof body.error === "string" ? body.error : undefined) ??
      stringValue(body.message),
    requestId: stringValue(nested?.requestId) ?? stringValue(body.requestId),
    details: nested?.details ?? body.details
  };
}

function parseRetryAfter(value: string | null, now: number) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - now);
}

function defaultCode(status: number) {
  if (status === 400) return "BAD_REQUEST";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 408) return "REQUEST_TIMEOUT";
  if (status === 409) return "CONFLICT";
  if (status === 422) return "VALIDATION_ERROR";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER_ERROR";
  return "HTTP_ERROR";
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isSafeRead(method: string) {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function resolveUrl(baseUrl: string, path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  if (!baseUrl) return path;
  return `${baseUrl}/${path.replace(/^\//, "")}`;
}

function boundedTimeout(value: number | undefined, fallback: number) {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.round(clamp(candidate, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS));
}

function nonNegativeInteger(value: number | false | undefined, fallback: number) {
  if (value === false) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function nonNegativeNumber(value: number | undefined, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultIdempotencyKey() {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("Secure random UUID generation is unavailable.");
  }
  return globalThis.crypto.randomUUID();
}

function abortableSleep(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = globalThis.setTimeout(finish, milliseconds);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    function finish() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForSharedPromise<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
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
