import { describe, expect, it } from "vitest";
import { generatedCclIndex, getApprovedCclEntry, validateGeneratedCclIndex } from "../cclIndex";
import {
  inspectRegulatoryCorpus,
  verifyExactQuotation,
  verifyPointInTimeSource,
  verifySupportIntegrity
} from "./corpus";

describe("regulatory source and citation integrity", () => {
  it("loads the complete required primary-source set but blocks pending review", () => {
    const status = inspectRegulatoryCorpus("2026-07-30");
    expect(status.structurallyValid).toBe(true);
    expect(status.missingSourceIds).toEqual([]);
    expect(status.reviewStatus).toBe("pending_review");
    expect(status.consequentialUseAllowed).toBe(false);
  });

  it("rejects a fake quotation even when the source and ECCN identifiers are valid", () => {
    const entry = getApprovedCclEntry("5A002")!;
    const result = verifyExactQuotation(entry, "This is invented text that does not occur in the stored snapshot.");
    expect(result.quotationIntegrity).toBe("failed");
  });

  it("accepts exact application-inserted stored text but not an unrelated conclusion", () => {
    const entry = getApprovedCclEntry("5A002")!;
    const quote = entry.blocks.find((block) => block.kind === "paragraph")!.text;
    const quotation = verifyExactQuotation(entry, quote);
    expect(quotation.quotationIntegrity).toBe("passed");
    const support = verifySupportIntegrity({
      classification: "6A003",
      elementResults: [],
      quotationIntegrity: quotation
    });
    expect(support.supportIntegrity).toBe("failed");
  });

  it("fails a valid source used for the wrong point-in-time date", () => {
    expect(verifyPointInTimeSource("ear-774-supp-1", "2026-07-01")).toMatchObject({ passed: false });
    expect(verifyPointInTimeSource("ear-774-supp-1", generatedCclIndex.currentThrough)).toMatchObject({ passed: true });
  });

  it("detects corrupted source metadata and missing CCL content", () => {
    const corrupted = structuredClone(generatedCclIndex);
    corrupted.source.rawByteHash = "0".repeat(64);
    expect(validateGeneratedCclIndex(corrupted).valid).toBe(false);

    const incomplete = structuredClone(generatedCclIndex);
    incomplete.entries = [];
    incomplete.entryCount = 0;
    expect(validateGeneratedCclIndex(incomplete).valid).toBe(false);
  });
});
