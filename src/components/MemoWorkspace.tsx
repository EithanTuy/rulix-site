import { useEffect, useRef, useState } from "react";
import {
  Archive,
  Edit3,
  FileText,
  Highlighter,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { createHighlightSegments } from "../lib/highlights";
import type { MemoRecord, ReviewResult } from "../types";

interface MemoWorkspaceProps {
  memo: MemoRecord;
  result?: ReviewResult;
  selectedFindingId?: string;
  analysisLocked: boolean;
  onMemoTextChange: (memoId: string, memoText: string) => void;
  onArchiveMemo: (memoId: string) => void;
}

export function MemoWorkspace({
  memo,
  result,
  selectedFindingId,
  analysisLocked,
  onMemoTextChange,
  onArchiveMemo
}: MemoWorkspaceProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memo.memoText);
  const [zoom, setZoom] = useState(100);
  const [highlightsVisible, setHighlightsVisible] = useState(true);
  const selectedFindingRef = useRef<HTMLElement | null>(null);
  const findings = result?.findings ?? [];
  const segments = createHighlightSegments(memo.memoText, findings);

  useEffect(() => {
    setDraft(memo.memoText);
    setEditing(false);
  }, [memo.id, memo.memoText]);

  useEffect(() => {
    if (selectedFindingId) {
      selectedFindingRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [selectedFindingId]);

  const saveDraft = () => {
    if (analysisLocked) return;
    onMemoTextChange(memo.id, draft);
    setEditing(false);
  };

  return (
    <main className="memo-workspace">
      <div className="memo-header">
        <div className="memo-title">
          <FileText size={24} strokeWidth={1.5} />
          <div>
            <h1>{memo.title}</h1>
            <p>
              {memo.documentCode} | {formatDate(memo.updatedAt)} | Owner: {memo.owner}
            </p>
          </div>
        </div>
        <div className="memo-header-actions">
          <span className={`needs-pill ${memo.status}`}>{statusPillLabel(memo.status, result?.infoRequests.length ?? 0)}</span>
        </div>
      </div>

      <div className="memo-toolbar">
        <div className="toolbar-group">
          <button type="button" className="tool" onClick={() => setZoom(100)}>{zoom}%</button>
          <button
            type="button"
            className="tool"
            aria-label="Zoom out"
            title="Zoom out"
            onClick={() => setZoom((value) => Math.max(75, value - 10))}
          >
            <ZoomOut size={17} />
          </button>
          <button
            type="button"
            className="tool"
            aria-label="Zoom in"
            title="Zoom in"
            onClick={() => setZoom((value) => Math.min(150, value + 10))}
          >
            <ZoomIn size={17} />
          </button>
        </div>
        <div className="toolbar-spacer" />
        <button
          type="button"
          className={highlightsVisible ? "tool active" : "tool"}
          onClick={() => setHighlightsVisible((value) => !value)}
        >
          <Highlighter size={17} /> Highlight
        </button>
        <button
          type="button"
          className="tool"
          disabled={analysisLocked}
          onClick={() => {
            setDraft(memo.memoText);
            setEditing((value) => !value);
          }}
        >
          <Edit3 size={17} /> {editing ? "Cancel Edit" : "Edit Text"}
        </button>
        <button
          type="button"
          className="tool danger"
          disabled={analysisLocked}
          onClick={() => onArchiveMemo(memo.id)}
        >
          <Archive size={17} /> Archive
        </button>
      </div>

      <div className="document-frame">
        {editing ? (
          <div className="editor-frame">
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
            <div className="editor-actions">
              <button className="button primary small" type="button" onClick={saveDraft}>
                Save Changes
              </button>
            </div>
          </div>
        ) : (
          <article
            className="memo-document"
            style={{ fontSize: `${16 * (zoom / 100)}px` }}
          >
            {segments.map((segment, index) =>
              segment.finding && highlightsVisible ? (
                <mark
                  className={
                    segment.finding.id === selectedFindingId
                      ? `highlight ${segment.finding.status} selected`
                      : `highlight ${segment.finding.status}`
                  }
                  title={segment.finding.title}
                  key={`${segment.finding.id}-${index}`}
                  ref={(element) => {
                    if (segment.finding?.id === selectedFindingId) selectedFindingRef.current = element;
                  }}
                >
                  {segment.text}
                  <span className={`finding-badge ${segment.finding.status}`}>
                    {indexBadge(findings, segment.finding.id)}
                  </span>
                </mark>
              ) : (
                <span key={`text-${index}`}>{segment.text}</span>
              )
            )}
            {findings
              .filter(
                (finding) =>
                  finding.status === "missing" &&
                  typeof finding.start !== "number" &&
                  typeof finding.end !== "number"
              )
              .map((finding) => (
                <p
                  className={
                    finding.id === selectedFindingId
                      ? "missing-inline selected"
                      : "missing-inline"
                  }
                  key={finding.id}
                  ref={(element) => {
                    if (finding.id === selectedFindingId) selectedFindingRef.current = element;
                  }}
                >
                  [Add: {finding.claim}]
                  <span className="finding-badge missing">
                    {indexBadge(findings, finding.id)}
                  </span>
                </p>
              ))}
          </article>
        )}
      </div>

      <div className="document-footer">
        <div className="legend">
          <LegendItem status="strong" label="Strong Evidence" />
          <LegendItem status="weak" label="Weak Reasoning" />
          <LegendItem status="missing" label="Missing Info" />
          <LegendItem status="conflict" label="Conflicting Claim" />
        </div>
      </div>
    </main>
  );
}

function statusPillLabel(status: MemoRecord["status"], infoRequestCount: number) {
  if (status === "signed-off") return "Human Signoff Complete";
  if (status === "conflict") return "Conflict / Escalation";
  if (status === "draft") return "Draft Review";
  if (status === "ready") return "Ready for Review";
  return infoRequestCount ? "Needs More Information" : "Ready for Review";
}

function LegendItem({ status, label }: { status: string; label: string }) {
  return (
    <span className="legend-item">
      <span className={`legend-swatch ${status}`} />
      {label}
    </span>
  );
}

function indexBadge(findings: ReviewResult["findings"], id: string) {
  return findings.findIndex((finding) => finding.id === id) + 1;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(`${value}T12:00:00`));
}

