// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewFixtures } from "../test/reviewFixtures";
import {
  getCurrentUser,
  requestCouncilApproval,
  requestMemoChatApproval,
  requestMemoBuilderApproval,
  resetAiRequestIdsForTests,
  resetAiRequestMemoryForTests,
  setCsrfToken,
  signOut
} from "./apiClient";

beforeEach(() => {
  localStorage.clear();
  resetAiRequestIdsForTests();
  setCsrfToken("csrf-test");
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAiRequestIdsForTests();
  localStorage.clear();
  setCsrfToken(undefined);
});

describe("durable AI approval request identity", () => {
  it("deduplicates concurrent clicks and a reload while the request is pending", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ status: "pending" });
    }));

    await Promise.all([
      requestCouncilApproval(reviewFixtures[0], "standard"),
      requestCouncilApproval(reviewFixtures[0], "standard")
    ]);
    expect(bodies[0].requestId).toBe(bodies[1].requestId);

    resetAiRequestMemoryForTests();
    await requestCouncilApproval(reviewFixtures[0], "standard");
    expect(bodies[2].requestId).toBe(bodies[0].requestId);
  });

  it("retires rejected IDs once, preserves approved IDs, and creates a fresh pending request", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let phase: "seed" | "rejected" | "approved" = "seed";
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (phase === "seed") return json({ status: "pending" });
      if (phase === "rejected") {
        phase = "approved";
        return json({ status: "rejected" });
      }
      return json({ status: "approved" });
    }));

    await requestCouncilApproval(reviewFixtures[0], "standard");
    const original = bodies[0].requestId;
    phase = "rejected";
    const terminal = await requestCouncilApproval(reviewFixtures[0], "standard");
    expect(terminal.status).toBe("approved");
    expect(bodies[1].requestId).toBe(original);
    expect(bodies[2].requestId).not.toBe(original);

    resetAiRequestMemoryForTests();
    await requestCouncilApproval(reviewFixtures[0], "standard");
    expect(bodies[3].requestId).toBe(bodies[2].requestId);
  });

  it("drops malformed records and clears durable IDs on account switch and sign-out", async () => {
    const queueBodies: Array<Record<string, unknown>> = [];
    let user = "user-a";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/me") {
        return json({
          user: {
            id: user,
            email: `${user}@example.com`,
            name: user,
            role: "reviewer",
            createdAt: "2026-07-14T00:00:00.000Z"
          },
          csrfToken: "csrf-test"
        });
      }
      if (url === "/api/auth/logout") return new Response(null, { status: 204 });
      queueBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ status: "pending" });
    }));

    await getCurrentUser();
    await requestCouncilApproval(reviewFixtures[0], "standard");
    const first = last(queueBodies)?.requestId;
    const pendingKey = storageKeys().find((key) => key.startsWith("rulix.ai-request.v1."));
    expect(pendingKey).toBeDefined();
    localStorage.setItem(pendingKey!, "{malformed");
    resetAiRequestMemoryForTests();
    await requestCouncilApproval(reviewFixtures[0], "standard");
    expect(last(queueBodies)?.requestId).not.toBe(first);

    const beforeSwitch = last(queueBodies)?.requestId;
    user = "user-b";
    await getCurrentUser();
    await requestCouncilApproval(reviewFixtures[0], "standard");
    expect(last(queueBodies)?.requestId).not.toBe(beforeSwitch);

    const beforeLogout = last(queueBodies)?.requestId;
    await signOut();
    setCsrfToken("csrf-test");
    await requestCouncilApproval(reviewFixtures[0], "standard");
    expect(last(queueBodies)?.requestId).not.toBe(beforeLogout);
  });

  it("keeps the persistent crash-recovery cache bounded to 256 opaque entries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ status: "pending" })));
    for (let index = 0; index < 260; index += 1) {
      await requestMemoBuilderApproval(`builder-session-${index}`, `fingerprint-${index}`);
    }
    const keys = storageKeys().filter((key) => key.startsWith("rulix.ai-request.v1."));
    expect(keys.length).toBeLessThanOrEqual(256);
    expect(keys.join(" ")).not.toContain("fingerprint-");
  });

  it("accepts exactly 8,000 Unicode chat characters and rejects the 8,001st before fetch", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ status: "pending" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const exact = "😀".repeat(8_000);
    await requestMemoChatApproval(reviewFixtures[0], exact);
    expect(bodies[0].message).toBe(exact);

    await expect(requestMemoChatApproval(reviewFixtures[0], `${exact}😀`))
      .rejects.toThrow("1 to 8,000 Unicode characters");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function storageKeys() {
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "");
}

function last<T>(values: T[]) {
  return values[values.length - 1];
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
