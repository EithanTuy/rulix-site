import type { EvidenceFinding } from "../types";

export interface HighlightSegment {
  text: string;
  finding?: EvidenceFinding;
}

export function createHighlightSegments(
  memoText: string,
  findings: EvidenceFinding[]
): HighlightSegment[] {
  const ranges = findings
    .filter(
      (finding): finding is EvidenceFinding & { start: number; end: number } =>
        typeof finding.start === "number" &&
        typeof finding.end === "number" &&
        finding.start >= 0 &&
        finding.end > finding.start
    )
    .sort((a, b) => a.start - b.start);

  const segments: HighlightSegment[] = [];
  let cursor = 0;

  ranges.forEach((finding) => {
    if (finding.start < cursor) return;
    if (finding.start > cursor) {
      segments.push({ text: memoText.slice(cursor, finding.start) });
    }
    segments.push({ text: memoText.slice(finding.start, finding.end), finding });
    cursor = finding.end;
  });

  if (cursor < memoText.length) {
    segments.push({ text: memoText.slice(cursor) });
  }

  return segments;
}

