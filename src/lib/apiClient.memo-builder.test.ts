// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetAiRequestIdsForTests,
  resetAiRequestMemoryForTests,
  sendMemoBuildChat,
  setCsrfToken
} from "./apiClient";

afterEach(() => {
  setCsrfToken(undefined);
  resetAiRequestIdsForTests();
  vi.unstubAllGlobals();
});

describe("Memo Builder client request bounds and retry identity", () => {
  it("sends one exact pending message against a server-owned saved session", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ reply: "ok" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);
    setCsrfToken("csrf-test");

    await expect(sendMemoBuildChat(
      "builder-session-1",
      "preserve exact content",
      "session-v1"
    )).resolves.toEqual({ reply: "ok" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      sessionId: "builder-session-1",
      pendingMessage: "preserve exact content"
    });
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.messages).toBeUndefined();
    expect(body.dataClass).toBeUndefined();
  });

  it.each([
    ["invalid", "bounded"],
    ["builder-session-1", ""],
    ["builder-session-1", "x".repeat(8_001)]
  ])("rejects invalid input before fetch %#", async (sessionId, message) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMemoBuildChat(sessionId, message, "session-v1")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reuses a logical request ID after transport failure and resets on content change or success", async () => {
    const seenBodies: Array<Record<string, string>> = [];
    let call = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenBodies.push(JSON.parse(String(init?.body)) as Record<string, string>);
      call += 1;
      if (call === 1 || call === 3) throw new TypeError("network dropped");
      return new Response(JSON.stringify({ reply: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    setCsrfToken("csrf-test");

    await expect(sendMemoBuildChat("builder-session-1", "same", "session-v1")).rejects.toThrow();
    await expect(sendMemoBuildChat("builder-session-1", "same", "session-v1")).resolves.toEqual({ reply: "ok" });
    expect(seenBodies[1].requestId).toBe(seenBodies[0].requestId);

    await expect(sendMemoBuildChat("builder-session-1", "same", "session-v1")).rejects.toThrow();
    expect(seenBodies[2].requestId).not.toBe(seenBodies[1].requestId);

    await expect(sendMemoBuildChat("builder-session-1", "changed", "session-v1")).resolves.toEqual({ reply: "ok" });
    expect(seenBodies[3].requestId).not.toBe(seenBodies[2].requestId);
  });

  it("recovers the same hashed request ID after a page reload without storing message content", async () => {
    const seenBodies: Array<Record<string, string>> = [];
    let fail = true;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenBodies.push(JSON.parse(String(init?.body)) as Record<string, string>);
      if (fail) {
        fail = false;
        throw new TypeError("response lost");
      }
      return new Response(JSON.stringify({ reply: "recovered" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    setCsrfToken("csrf-test");

    await expect(sendMemoBuildChat("builder-session-1", "sensitive exact message", "session-v1"))
      .rejects.toThrow();
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    expect(keys.some((key) => key?.startsWith("rulix.ai-request.v1."))).toBe(true);
    expect(keys.map((key) => key ? localStorage.getItem(key) : "").join(" "))
      .not.toContain("sensitive exact message");

    resetAiRequestMemoryForTests();
    await expect(sendMemoBuildChat("builder-session-1", "sensitive exact message", "session-v1"))
      .resolves.toEqual({ reply: "recovered" });
    expect(seenBodies[1].requestId).toBe(seenBodies[0].requestId);
  });
});
