import { describe, expect, it } from "vitest";
import { diffWords, trimUnchangedContext } from "./memoDiff";

describe("memoDiff", () => {
  it("returns word-level additions and removals", () => {
    const changes = diffWords("alpha beta gamma", "alpha delta gamma");

    expect(changes).toEqual([
      { type: "same", text: "alpha " },
      { type: "removed", text: "beta" },
      { type: "added", text: "delta" },
      { type: "same", text: " gamma" }
    ]);
  });

  it("trims unchanged context around meaningful changes", () => {
    const changes = diffWords(
      "one two three four five six seven eight nine ten",
      "one two three four changed six seven eight nine ten"
    );

    const visible = trimUnchangedContext(changes, 0);

    expect(visible.some((change) => change.type === "gap")).toBe(true);
    expect(visible).toEqual(
      expect.arrayContaining([
        { type: "removed", text: "five" },
        { type: "added", text: "changed" }
      ])
    );
  });

  it("falls back to a bounded preview for very large memo diffs", () => {
    const current = "controlled characteristic ".repeat(900);
    const proposed = `${current}Added license rationale.`;

    const changes = diffWords(current, proposed);

    expect(changes.length).toBeLessThan(5);
    expect(changes.some((change) => change.type === "gap")).toBe(true);
    expect(changes.some((change) => change.type === "added" && change.text.includes("Added license rationale."))).toBe(true);
  });
});
