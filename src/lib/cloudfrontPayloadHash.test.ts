import { describe, expect, it } from "vitest";
import { withCloudFrontPayloadHash } from "./cloudfrontPayloadHash";

describe("CloudFront payload hashing", () => {
  it("hashes the exact UTF-8 JSON body and preserves caller headers", async () => {
    const result = await withCloudFrontPayloadHash({
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "request-1" },
      body: "hello"
    });
    const headers = new Headers(result.headers);

    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-request-id")).toBe("request-1");
    expect(headers.get("x-amz-content-sha256")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "signs an empty %s body with the canonical empty digest",
    async (method) => {
      const result = await withCloudFrontPayloadHash({ method });
      expect(new Headers(result.headers).get("x-amz-content-sha256")).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      );
    }
  );

  it.each(["GET", "HEAD", "OPTIONS"])("does not add a payload header to %s", async (method) => {
    const init = { method, headers: { accept: "application/json" } };
    const result = await withCloudFrontPayloadHash(init);
    expect(result).toBe(init);
    expect(new Headers(result.headers).has("x-amz-content-sha256")).toBe(false);
  });

  it("fails closed for multipart bodies whose fetch boundary bytes are not reproducible", async () => {
    const body = new FormData();
    body.set("file", "content");
    await expect(withCloudFrontPayloadHash({ method: "POST", body })).rejects.toThrow(
      "cannot be hashed safely"
    );
  });
});
