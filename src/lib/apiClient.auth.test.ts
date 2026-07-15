import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setCsrfToken,
  validateInvite,
  validatePasswordReset
} from "./apiClient";

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken(undefined);
});

describe("auth token inspection transport", () => {
  it("posts invite tokens in JSON without putting them in a URL or prefetching CSRF", async () => {
    const token = "invite_secret_token_1234567890abcdefghi";
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      invite: {
        email: "invite@example.com",
        name: "Invite Reviewer",
        role: "reviewer",
        expiresAt: "2026-07-15T00:00:00.000Z",
        status: "pending"
      }
    }));
    vi.stubGlobal("fetch", fetch);

    await validateInvite(token);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/invite/inspect");
    expect(url).not.toContain(token);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ token });
  });

  it("posts password-reset tokens in JSON without putting them in a URL", async () => {
    const token = "reset_secret_token_1234567890abcdefghij";
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      reset: {
        email: "reset@example.com",
        expiresAt: "2026-07-15T00:00:00.000Z",
        status: "pending"
      }
    }));
    vi.stubGlobal("fetch", fetch);

    await validatePasswordReset(token);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/password-reset/inspect");
    expect(url).not.toContain(token);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ token });
  });
});

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
