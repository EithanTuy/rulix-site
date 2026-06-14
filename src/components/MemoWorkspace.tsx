import { useState } from "react";
import {
  Bookmark,
  Edit3,
  FileText,
  Highlighter,
  MessageSquare,
  MoreVertical,
  PanelLeft,
  Search,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { createHighlightSegments } from "../lib/highlights";
import type { MemoRecord, ReviewResult } from "../types";

interface MemoWorkspaceProps {
  memo: MemoRecord;
  result: ReviewResult;
  onMemoTextChange: (memoId: string, memoText: string) => void;
}

export function MemoWorkspace({ memo, result, onMemoTextChange }: MemoWorkspaceProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memo.memoText);
  const segments = createHighlightSegments(memo.memoText, result.findings);

  const saveDraft = () => {
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
          <span className={`needs-pill ${memo.status}`}>{statusPillLabel(memo.status, result.infoRequests.length)}</span>
          <button type="button" className="icon-button" aria-label="Comments" title="Comments">
            <MessageSquare size={18} />
          </button>
          <button type="button" className="icon-button" aria-label="More actions" title="More actions">
            <MoreVertical size={18} />
          </button>
        </div>
      </div>

      <div className="memo-toolbar">
        <div className="toolbar-group">
          <button type="button" className="tool active" aria-label="Document view" title="Document view">
            <PanelLeft size={17} />
          </button>
          <button type="button" className="tool" aria-label="Search memo" title="Search memo">
            <Search size={17} />
          </button>
        </div>
        <div className="toolbar-group">
          <button type="button" className="tool">100%</button>
          <button type="button" className="tool" aria-label="Zoom out" title="Zoom out">
            <ZoomOut size={17} />
          </button>
          <button type="button" className="tool" aria-label="Zoom in" title="Zoom in">
            <ZoomIn size={17} />
          </button>
        </div>
        <div className="toolbar-spacer" />
        <button type="button" className="tool">
          <Highlighter size={17} /> Highlight
        </button>
        <button
          type="button"
          className="tool"
          onClick={() => {
            setDraft(memo.memoText);
            setEditing((value) => !value);
          }}
        >
          <Edit3 size={17} /> {editing ? "Cancel Edit" : "Edit Text"}
        </button>
        <button type="button" className="tool icon-only" aria-label="Bookmark" title="Bookmark">
          <Bookmark size={17} />
        </button>
      </div>

      <div className="document-frame">
        {editing ? (
          <div className="editor-frame">
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
            <div className="editor-actions">
              <button className="button primary small" type="button" onClick={saveDraft}>
                Save &amp; Re-run
              </button>
            </div>
          </div>
        ) : (
          <article className="memo-document">
            {segments.map((segment, index) =>
              segment.finding ? (
                <mark
                  className={`highlight ${segment.finding.status}`}
                  title={segment.finding.title}
                  key={`${segment.finding.id}-${index}`}
                >
                  {segment.text}
                  <span className={`finding-badge ${segment.finding.status}`}>
                    {indexBadge(result.findings, segment.finding.id)}
                  </span>
                </mark>
              ) : (
                <span key={`text-${index}`}>{segment.text}</span>
              )
            )}
            {result.findings
              .filter(
                (finding) =>
                  finding.status === "missing" &&
                  typeof finding.start !== "number" &&
                  typeof finding.end !== "number"
              )
              .map((finding) => (
                <p className="missing-inline" key={finding.id}>
                  [Add: {finding.claim}]
                  <span className="finding-badge missing">
                    {indexBadge(result.findings, finding.id)}
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
        <div className="autosave">Auto-saved 10:32 AM</div>
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
