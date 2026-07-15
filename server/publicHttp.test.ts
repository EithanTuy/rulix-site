// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  createPublicHttpClient,
  isPublicAddress,
  PublicHttpSecurityError,
  type PinnedHttpResponse,
  type PublicHttpDependencies,
  type ResolvedAddress
} from "./publicHttp";

function response({
  status = 200,
  body = "ok",
  location,
  peerAddress = "1.1.1.1"
}: {
  status?: number;
  body?: string;
  location?: string;
  peerAddress?: string;
} = {}): PinnedHttpResponse {
  const headers = new Headers({ "content-type": "text/plain" });
  if (location) headers.set("location", location);
  return { status, headers, body, peerAddress };
}

function client({
  resolve,
  request
}: {
  resolve: PublicHttpDependencies["resolve"];
  request: PublicHttpDependencies["request"];
}) {
  return createPublicHttpClient({ resolve, request });
}

describe("connection-bound public HTTP", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "192.31.196.1",
    "192.52.193.1",
    "192.175.48.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:c0a8:1",
    "::192.168.0.1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "2620:4f:8000::1",
    "3fff::1",
    "5f00::1"
  ])("classifies non-public address %s as unsafe", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2001:4860:4860::8888", "2606:4700:4700::1111"])(
    "allows globally routable address %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    }
  );

  it("passes the vetted address to the transport and accepts only that peer", async () => {
    const request = vi.fn(async (_url: URL, address: ResolvedAddress) =>
      response({ body: "public page", peerAddress: address.address })
    );
    const fetchPublic = client({
      resolve: async () => [{ address: "1.1.1.1", family: 4 }],
      request
    });

    const result = await fetchPublic("https://example.test/page");

    expect(await result.text()).toBe("public page");
    expect(result.url).toBe("https://example.test/page");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toEqual({ address: "1.1.1.1", family: 4 });
  });

  it("fails closed when the connected peer differs from the vetted address", async () => {
    const fetchPublic = client({
      resolve: async () => [{ address: "1.1.1.1", family: 4 }],
      request: async () => response({ peerAddress: "8.8.8.8" })
    });

    await expect(fetchPublic("https://example.test/page")).rejects.toThrow(
      /connected peer did not match/i
    );
  });

  it("normalizes an IPv4-mapped peer address before comparison", async () => {
    const fetchPublic = client({
      resolve: async () => [{ address: "1.1.1.1", family: 4 }],
      request: async () => response({ peerAddress: "::ffff:101:101" })
    });

    await expect(fetchPublic("https://example.test/page").then((item) => item.text()))
      .resolves.toBe("ok");
  });

  it("rejects a mixed public/private DNS answer before opening a connection", async () => {
    const request = vi.fn<PublicHttpDependencies["request"]>();
    const fetchPublic = client({
      resolve: async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "169.254.169.254", family: 4 }
      ],
      request
    });

    await expect(fetchPublic("https://example.test/page")).rejects.toThrow(/non-public address/i);
    expect(request).not.toHaveBeenCalled();
  });

  it("bounds a resolver that never completes with the per-hop timeout", async () => {
    const request = vi.fn<PublicHttpDependencies["request"]>();
    const fetchPublic = client({
      resolve: async () => new Promise<ResolvedAddress[]>(() => undefined),
      request
    });
    const startedAt = Date.now();

    await expect(
      fetchPublic("https://never-resolves.test/", { timeoutMs: 25 })
    ).rejects.toMatchObject({ name: "TimeoutError" });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(request).not.toHaveBeenCalled();
  });

  it("resolves, validates, and pins every redirect target independently", async () => {
    const resolve = vi.fn(async (hostname: string): Promise<ResolvedAddress[]> => [{
      address: hostname === "first.test" ? "1.1.1.1" : "8.8.8.8",
      family: 4
    }]);
    const request = vi.fn(async (url: URL, address: ResolvedAddress) =>
      url.hostname === "first.test"
        ? response({ status: 302, location: "https://second.test/final", peerAddress: address.address })
        : response({ body: "final", peerAddress: address.address })
    );
    const fetchPublic = client({ resolve, request });

    const result = await fetchPublic("https://first.test/start", { maxRedirects: 1 });

    expect(await result.text()).toBe("final");
    expect(result.url).toBe("https://second.test/final");
    expect(resolve.mock.calls.map(([hostname]) => hostname)).toEqual(["first.test", "second.test"]);
    expect(request.mock.calls.map(([, address]) => address.address)).toEqual(["1.1.1.1", "8.8.8.8"]);
  });

  it("applies one deadline to the entire redirect chain", async () => {
    const resolve = vi.fn(async (hostname: string): Promise<ResolvedAddress[]> => {
      // Keep the first hop far below the shared deadline and make only the
      // second lookup exceed it. This proves that the original deadline is
      // reused without depending on scheduler jitter between two 15 ms waits.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, hostname === "first.test" ? 1 : 100));
      return [{ address: "1.1.1.1", family: 4 }];
    });
    const request = vi.fn(async (url: URL, address: ResolvedAddress) => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
      return url.hostname === "first.test"
        ? response({
            status: 302,
            location: "https://second.test/final",
            peerAddress: address.address
          })
        : response({ body: "should not complete", peerAddress: address.address });
    });
    const fetchPublic = client({ resolve, request });

    await expect(
      fetchPublic("https://first.test/start", { maxRedirects: 1, timeoutMs: 40 })
    ).rejects.toMatchObject({ name: "TimeoutError" });

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects an HTTPS redirect downgrade before resolving the plaintext target", async () => {
    const resolve = vi.fn(async (): Promise<ResolvedAddress[]> => [{ address: "1.1.1.1", family: 4 }]);
    const request = vi.fn(async (_url: URL, address: ResolvedAddress) => response({
      status: 302,
      location: "http://second.test/plaintext",
      peerAddress: address.address
    }));
    const fetchPublic = client({ resolve, request });

    await expect(
      fetchPublic("https://first.test/start", { maxRedirects: 1 })
    ).rejects.toThrow(/plaintext HTTP/i);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("allows an initial HTTP URL to redirect to HTTPS", async () => {
    const resolve = vi.fn(async (hostname: string): Promise<ResolvedAddress[]> => [{
      address: hostname === "first.test" ? "1.1.1.1" : "8.8.8.8",
      family: 4
    }]);
    const request = vi.fn(async (url: URL, address: ResolvedAddress) =>
      url.protocol === "http:"
        ? response({ status: 301, location: "https://second.test/final", peerAddress: address.address })
        : response({ body: "upgraded", peerAddress: address.address })
    );
    const fetchPublic = client({ resolve, request });

    const result = await fetchPublic("http://first.test/start", { maxRedirects: 1 });

    expect(result.url).toBe("https://second.test/final");
    await expect(result.text()).resolves.toBe("upgraded");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("blocks a redirect that re-resolves to a private address", async () => {
    const request = vi.fn(async (_url: URL, address: ResolvedAddress) =>
      response({
        status: 302,
        location: "https://metadata.test/latest/meta-data",
        peerAddress: address.address
      })
    );
    const fetchPublic = client({
      resolve: async (hostname) => [{
        address: hostname === "metadata.test" ? "169.254.169.254" : "1.1.1.1",
        family: 4
      }],
      request
    });

    await expect(
      fetchPublic("https://first.test/start", { maxRedirects: 1 })
    ).rejects.toThrow(/non-public address/i);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects URL credentials and custom ports before DNS resolution", async () => {
    const resolve = vi.fn<PublicHttpDependencies["resolve"]>();
    const request = vi.fn<PublicHttpDependencies["request"]>();
    const fetchPublic = client({ resolve, request });

    await expect(fetchPublic("https://user:pass@example.test/")).rejects.toBeInstanceOf(
      PublicHttpSecurityError
    );
    await expect(fetchPublic("https://example.test:8443/")).rejects.toBeInstanceOf(
      PublicHttpSecurityError
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["authorization", "cookie", "x-api-key", "x-rulix-edge-secret"])(
    "rejects credential-bearing %s headers before DNS resolution",
    async (header) => {
      const resolve = vi.fn<PublicHttpDependencies["resolve"]>();
      const request = vi.fn<PublicHttpDependencies["request"]>();
      const fetchPublic = client({ resolve, request });

      await expect(
        fetchPublic("https://example.test/", { headers: { [header]: "secret" } })
      ).rejects.toBeInstanceOf(PublicHttpSecurityError);
      expect(resolve).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    }
  );

  it("tries another vetted address after an ordinary connection failure", async () => {
    const request = vi.fn(async (_url: URL, address: ResolvedAddress) => {
      if (address.address === "1.1.1.1") throw new Error("connect failed");
      return response({ body: "fallback", peerAddress: address.address });
    });
    const fetchPublic = client({
      resolve: async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "8.8.8.8", family: 4 }
      ],
      request
    });

    await expect(fetchPublic("https://example.test/").then((item) => item.text())).resolves.toBe(
      "fallback"
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not try another address after the shared signal is aborted", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("cancelled", "AbortError");
    const request = vi.fn(async () => {
      controller.abort(abortError);
      throw new Error("connection failed after cancellation");
    });
    const fetchPublic = client({
      resolve: async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "8.8.8.8", family: 4 }
      ],
      request
    });

    await expect(
      fetchPublic("https://example.test/", { signal: controller.signal })
    ).rejects.toBe(abortError);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
