export interface ApiErrorOptions {
  status: number;
  code: string;
  message: string;
  requestId?: string;
  details?: unknown;
  retryAfterMs?: number;
  method?: string;
  url?: string;
}

/**
 * A normalized, user-safe API failure. Network and timeout failures use a
 * status of 0 so callers can handle them without parsing browser exceptions.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: unknown;
  readonly retryAfterMs?: number;
  readonly method?: string;
  readonly url?: string;

  constructor(options: ApiErrorOptions) {
    super(options.message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.details = options.details;
    this.retryAfterMs = options.retryAfterMs;
    this.method = options.method;
    this.url = options.url;

    // Required when targeting runtimes that do not repair the prototype chain
    // for Error subclasses after transpilation.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function apiErrorMessage(error: unknown, fallback = "The request could not be completed.") {
  if (isApiError(error)) return error.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}
