import { describe, expect, it } from "vitest";
import { sampleMemos } from "../data/sampleMemos";
import { analyzeMemo, verifyCitations } from "./eccnReview";
import { createHighlightSegments } from "./highlights";

describe("ECCN council review engine", () => {
  it("recommends 3A001.a.5 for the cryostat memo and flags missing evidence", () => {
    const result = analyzeMemo(sampleMemos[0]);

    expect(result.recommended.eccn).toBe("3A001.a.5");
    expect(result.findings.some((finding) => finding.status === "strong")).toBe(true);
    expect(result.findings.some((finding) => finding.status === "missing")).toBe(true);
    expect(result.infoRequests.length).toBeGreaterThan(0);
  });

  it("does not allow findings to cite chunks outside the official corpus", () => {
    const result = analyzeMemo(sampleMemos[0]);

    expect(verifyCitations(result)).toEqual([]);
  });

  it("creates text segments for inline highlights", () => {
    const result = analyzeMemo(sampleMemos[0]);
    const segments = createHighlightSegments(sampleMemos[0].memoText, result.findings);

    expect(segments.length).toBeGreaterThan(3);
    expect(segments.some((segment) => segment.finding?.status === "strong")).toBe(true);
    expect(segments.map((segment) => segment.text).join("")).toBe(sampleMemos[0].memoText);
  });

  it("treats university-use-only EAR99 reasoning as a conflict for lasers", () => {
    const laserMemo = sampleMemos.find((memo) => memo.id === "memo-laser-2026-0406")!;
    const result = analyzeMemo(laserMemo);

    expect(result.recommended.eccn).toBe("6A005 review");
    expect(result.findings.some((finding) => finding.status === "conflict")).toBe(true);
  });

  it("flags explicit omission language as missing evidence", () => {
    const cameraMemo = sampleMemos.find((memo) => memo.id === "memo-camera-2026-0412")!;
    const result = analyzeMemo(cameraMemo);

    expect(result.recommended.eccn).toBe("6A003 review");
    expect(result.findings.some((finding) => finding.status === "missing")).toBe(true);
    expect(result.infoRequests.join(" ")).toContain("spectral sensitivity");
  });
});
