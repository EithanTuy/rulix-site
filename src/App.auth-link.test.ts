import { afterEach, describe, expect, it } from "vitest";
import { consumeAuthLinkFragment } from "./App";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("auth link fragment consumption", () => {
  it("captures an invite fragment and immediately removes the secret from history", () => {
    const token = "invite_secret_token_1234567890abcdefghi";
    window.history.replaceState(null, "", `/app?keep=yes#invite=${token}&tab=review`);

    expect(consumeAuthLinkFragment()).toEqual({ mode: "invite", token });
    expect(window.location.pathname).toBe("/app");
    expect(window.location.search).toBe("?keep=yes");
    expect(window.location.hash).toBe("#tab=review");
    expect(window.location.href).not.toContain(token);
  });

  it("captures a reset fragment and never treats a legacy query token as usable", () => {
    const token = "reset_secret_token_1234567890abcdefghij";
    window.history.replaceState(null, "", `/app?invite=legacy-secret&keep=yes#reset=${token}`);

    expect(consumeAuthLinkFragment()).toEqual({ mode: "reset-complete", token });
    expect(window.location.search).toBe("?keep=yes");
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain("legacy-secret");
    expect(window.location.href).not.toContain(token);
  });

  it("strips ambiguous fragments without selecting either credential", () => {
    const invite = "invite_secret_token_1234567890abcdefghi";
    const reset = "reset_secret_token_1234567890abcdefghij";
    window.history.replaceState(null, "", `/app#invite=${invite}&reset=${reset}`);

    expect(consumeAuthLinkFragment()).toEqual({ token: "" });
    expect(window.location.hash).toBe("");
  });
});
