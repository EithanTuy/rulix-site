import { describe, expect, it } from "vitest";
import { primaryModifierForPlatform } from "./keyboard";

describe("primaryModifierForPlatform", () => {
  it("uses the command symbol on Apple platforms", () => {
    expect(primaryModifierForPlatform("MacIntel")).toBe("⌘");
    expect(primaryModifierForPlatform("iPhone")).toBe("⌘");
  });

  it("uses Ctrl on Windows and Linux", () => {
    expect(primaryModifierForPlatform("Win32")).toBe("Ctrl");
    expect(primaryModifierForPlatform("Linux x86_64")).toBe("Ctrl");
  });
});
