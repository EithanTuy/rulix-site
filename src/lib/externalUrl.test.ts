import { describe, expect, it } from "vitest";
import { safeExternalUrl } from "./externalUrl";

describe("safeExternalUrl", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "https://user:secret@example.com/private",
    "//example.com/path",
    "https://example.com/line\nbreak"
  ])("rejects an unsafe external target: %s", (value) => {
    expect(safeExternalUrl(value)).toBeUndefined();
  });

  it("canonicalizes ordinary HTTP and HTTPS links", () => {
    expect(safeExternalUrl(" https://Example.COM/evidence?q=1 ")).toBe(
      "https://example.com/evidence?q=1"
    );
    expect(safeExternalUrl("http://example.com")).toBe("http://example.com/");
  });
});
