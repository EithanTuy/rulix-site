import { describe, expect, it } from "vitest";
import { generatedCclIndex, getApprovedCclEntry, searchApprovedCcl, validateGeneratedCclIndex } from "./cclIndex";

describe("generated full CCL index", () => {
  it("preserves a complete, unique, checksum-bound snapshot without treating parser output as approval", () => {
    expect(generatedCclIndex.entryCount).toBeGreaterThanOrEqual(600);
    expect(generatedCclIndex.entries).toHaveLength(generatedCclIndex.entryCount);
    expect(new Set(generatedCclIndex.entries.map((entry) => entry.eccn)).size).toBe(generatedCclIndex.entryCount);
    expect(generatedCclIndex.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(generatedCclIndex.source.rawByteHash).toMatch(/^[a-f0-9]{64}$/);
    expect(generatedCclIndex.currentThrough).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(generatedCclIndex.reviewStatus).toBe("pending_review");
    expect(validateGeneratedCclIndex()).toMatchObject({ valid: true, consequentialUseAllowed: false });
  });

  it("preserves headings, controls, items, notes, definitions, and cross-references", () => {
    const encryption = getApprovedCclEntry("5A002");
    expect(encryption?.heading.length).toBeGreaterThan(20);
    expect(encryption?.controls.length).toBeGreaterThan(20);
    expect(encryption?.items.length).toBeGreaterThan(20);
    expect(encryption?.sections.length).toBeGreaterThan(2);
    expect(encryption?.blocks.length).toBeGreaterThan(encryption?.sections.length ?? 0);
    expect(encryption?.definitions.length).toBeGreaterThan(0);
    expect(encryption?.crossReferences).toContain("5A992");
  });

  it("retrieves targeted entries without sending the full index to a caller", () => {
    const hits = searchApprovedCcl("mass market encryption information security 5A992", 5);
    expect(hits.length).toBeLessThanOrEqual(5);
    expect(hits.some((hit) => hit.entry.eccn === "5A992")).toBe(true);
  });
});
