import { describe, expect, it } from "vitest";
import { officialCorpus } from "./data/corpus";

describe("authoritative browser corpus metadata", () => {
  it("exposes exact source snapshot metadata without paraphrased seed chunks", () => {
    expect(officialCorpus.id).toMatch(/^ecfr-ccl-/);
    expect(officialCorpus.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(officialCorpus.documents.length).toBeGreaterThanOrEqual(15);
    expect(officialCorpus.documents.every((document) =>
      Boolean(document.contentHash?.match(/^[a-f0-9]{64}$/)) && Boolean(document.url) && Boolean(document.snapshotDate)
    )).toBe(true);
    expect(officialCorpus.chunks).toEqual([]);
    expect(officialCorpus.approvalStatus).toBe("pending");
  });
});
