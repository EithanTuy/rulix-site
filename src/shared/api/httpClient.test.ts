import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./apiErrors";
import { createHttpClient } from "./httpClient";

describe("httpClient", () => {
  it("parses structured API errors and notifies the central unauthorized handler", async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "SESSION_EXPIRED",
            message: "Your session expired.",
            details: { reason: "idle-timeout" }
          },
          requestId: "request-from-body"
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json", "x-request-id": "request-from-header" }
        }
      )
    );
    const client = createHttpClient({ fetch: fetchImpl as typeof fetch, onUnauthorized });

    const failure = await client.get("/api/reviews", { retries: false }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 401,
      code: "SESSION_EXPIRED",
      message: "Your session expired.",
      requestId: "request-from-body",
      details: { reason: "idle-timeout" }
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledWith(failure);
  });

  it("deduplicates concurrent CSRF refreshes and adds a unique idempotency key to each mutation", async () => {
    let key = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/auth/me") {
        return new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ ok: true, method: init?.method }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    const client = createHttpClient({
      fetch: fetchImpl as typeof fetch,
      idempotencyKeyFactory: () => `mutation-${++key}`
    });

    await Promise.all([
      client.post("/api/reviews", { title: "First" }),
      client.post("/api/reviews", { title: "Second" })
    ]);

    const csrfCalls = fetchImpl.mock.calls.filter(([input]) => String(input) === "/api/auth/me");
    const mutationCalls = fetchImpl.mock.calls.filter(([input]) => String(input) === "/api/reviews");
    expect(csrfCalls).toHaveLength(1);
    expect(mutationCalls).toHaveLength(2);

    const headers = mutationCalls.map(([, init]) => new Headers(init?.headers));
    expect(headers.map((item) => item.get("x-rulix-csrf"))).toEqual(["csrf-token", "csrf-token"]);
    expect(new Set(headers.map((item) => item.get("Idempotency-Key"))).size).toBe(2);
  });

  it("retries safe reads with Retry-After and does not retry mutations", async () => {
    const sleep = vi.fn(async () => undefined);
    const readFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Busy" }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "1" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ reviews: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    const readClient = createHttpClient({
      fetch: readFetch as typeof fetch,
      maxReadRetries: 1,
      sleep,
      retryJitterRatio: 0
    });

    await expect(readClient.get<{ reviews: unknown[] }>("/api/reviews")).resolves.toEqual({ reviews: [] });
    expect(readFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));

    const mutationFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Busy" }), {
        status: 503,
        headers: { "Content-Type": "application/json" }
      })
    );
    const mutationClient = createHttpClient({ fetch: mutationFetch as typeof fetch });
    mutationClient.setCsrfToken("csrf-token");

    await expect(mutationClient.post("/api/reviews", { title: "No retry" })).rejects.toMatchObject({
      status: 503,
      code: "SERVER_ERROR"
    });
    expect(mutationFetch).toHaveBeenCalledTimes(1);
  });

  it("bounds stalled requests with a structured timeout error", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true }
        );
      })
    );
    const client = createHttpClient({ fetch: fetchImpl as typeof fetch, defaultTimeoutMs: 25 });

    await expect(client.get("/api/health", { retries: false })).rejects.toMatchObject({
      status: 0,
      code: "REQUEST_TIMEOUT",
      message: "The request timed out. Try again."
    });
  });

  it("uses caller idempotency keys and can omit CSRF for authentication endpoints", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, headers: Object.fromEntries(new Headers(init?.headers)) }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    const client = createHttpClient({ fetch: fetchImpl as typeof fetch });

    await client.post("/api/auth/login", { email: "person@example.com" }, {
      csrf: false,
      idempotencyKey: "login-attempt-1",
      notifyOnUnauthorized: false
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Idempotency-Key")).toBe("login-attempt-1");
    expect(headers.has("x-rulix-csrf")).toBe(false);
  });

  it("rejects malformed success JSON without leaking parser exceptions", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } })
    );
    const client = createHttpClient({ fetch: fetchImpl as typeof fetch });

    await expect(client.get("/api/reviews", { retries: false })).rejects.toMatchObject({
      status: 200,
      code: "INVALID_RESPONSE",
      message: "The server returned an invalid JSON response."
    });
  });
});
