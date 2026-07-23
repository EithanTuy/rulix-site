import React, { useEffect, useRef, useState } from "react";
import type { CSSProperties, MutableRefObject } from "react";
import {
  Archive,
  Edit3,
  FileEdit,
  FileText,
  Highlighter,
  Wand2,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { createHighlightSegments } from "../lib/highlights";
import { renderMarkdown } from "../lib/markdown";
import type { EvidenceFinding, MemoRecord, ReviewResult } from "../types";
import { MemoDiffPreview } from "./MemoDiffPreview";
import { PublicDraftPanel } from "./PublicDraftPanel";

type WorkspaceMode = "read" | "edit" | "compare" | "draft";

interface MemoWorkspaceProps {
  memo: MemoRecord;
  result?: ReviewResult;
  selectedFindingId?: string;
  analysisLocked: boolean;
  onMemoTextChange: (memoId: string, memoText: string) => Promise<void>;
  onArchiveMemo: (memoId: string) => Promise<void>;
  onCreatePublicDraft: (title: string, memoText: string) => Promise<void>;
  onImproveWithAi: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

export function MemoWorkspace({
  memo,
  result,
  selectedFindingId,
  analysisLocked,
  onMemoTextChange,
  onArchiveMemo,
  onCreatePublicDraft,
  onImproveWithAi,
  onDirtyChange
}: MemoWorkspaceProps) {
  const [mode, setMode] = useState<WorkspaceMode>("read");
  const [draft, setDraft] = useState(memo.memoText);
  const [zoom, setZoom] = useState(100);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const selectedFindingRef = useRef<HTMLElement | null>(null);
  const findings = result?.findings ?? [];
  const selectedFinding = findings.find((finding) => finding.id === selectedFindingId);
  const draftDirty = draft !== memo.memoText;

  useEffect(() => {
    setDraft(memo.memoText);
    setMode("read");
    onDirtyChange(false);
  }, [memo.id, memo.memoText, onDirtyChange]);

  useEffect(() => {
    onDirtyChange(draftDirty);
  }, [draftDirty, onDirtyChange]);

  useEffect(() => {
    if (selectedFindingId) {
      selectedFindingRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [selectedFindingId, mode]);

  const switchMode = (nextMode: WorkspaceMode) => {
    if (nextMode === "edit" && analysisLocked) return;
    if (nextMode === "draft" && draftDirty) return;
    setMode(nextMode);
  };

  const saveDraft = async () => {
    if (analysisLocked || mutationBusy) return;
    if (!draftDirty) {
      setMode("read");
      return;
    }
    setMutationBusy(true);
    setMutationError("");
    try {
      await onMemoTextChange(memo.id, draft);
      onDirtyChange(false);
      setMode("read");
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Memo changes were not saved.");
    } finally {
      setMutationBusy(false);
    }
  };

  const discardDraft = () => {
    setDraft(memo.memoText);
    onDirtyChange(false);
    setMode("read");
  };

  return (
    <section className="memo-workspace" aria-label="Memo editor">
      <div className="memo-header">
        <div className="memo-title">
          <FileText size={24} strokeWidth={1.5} />
          <div>
            <h2>{memo.title}</h2>
            <p>
              {memo.documentCode} | {formatDate(memo.updatedAt)} | Owner: {memo.owner}
            </p>
            <div className="memo-meta-row" aria-label="Memo context">
              <span>{dataClassLabel(memo.dataClass)}</span>
              <span>{sourcePathLabel(memo.sourcePath)}</span>
              {memo.manufacturer && <span>{memo.manufacturer}</span>}
              {memo.intendedUse && <span>{memo.intendedUse}</span>}
            </div>
          </div>
        </div>
        <div className="memo-header-actions">
          {draftDirty && <span className="dirty-pill">Unsaved edits</span>}
          <span className={`needs-pill ${memo.status}`}>{statusPillLabel(memo.status, result?.infoRequests.length ?? 0)}</span>
        </div>
      </div>

      <div className="memo-toolbar">
        {mode === "read" && (
          <div className="toolbar-group">
            <button type="button" className="tool" onClick={() => setZoom(100)}>{zoom}%</button>
            <button type="button" className="tool" aria-label="Zoom out" title="Zoom out" onClick={() => setZoom((value) => Math.max(75, value - 10))}>
              <ZoomOut size={17} />
            </button>
            <button type="button" className="tool" aria-label="Zoom in" title="Zoom in" onClick={() => setZoom((value) => Math.min(150, value + 10))}>
              <ZoomIn size={17} />
            </button>
          </div>
        )}
        <div className="toolbar-group editor-mode-tabs" aria-label="Document editing mode">
          <button
            type="button"
            className={mode === "read" ? "tool active" : "tool"}
            onClick={() => switchMode("read")}
          >
            <Highlighter size={17} /> Read
          </button>
          <button
            type="button"
            className={mode === "edit" ? "tool active" : "tool"}
            disabled={analysisLocked}
            onClick={() => switchMode("edit")}
          >
            <Edit3 size={17} /> Edit
          </button>
          <button
            type="button"
            className={mode === "compare" ? "tool active" : "tool"}
            onClick={() => switchMode("compare")}
          >
            <FileText size={17} /> Compare
          </button>
        </div>
        <div className="toolbar-spacer" />
        <button
          type="button"
          className={mode === "draft" ? "tool active" : "tool"}
          disabled={draftDirty}
          title={draftDirty ? "Save or discard memo edits before drafting a new memo." : "Draft Memo"}
          onClick={() => switchMode(mode === "draft" ? "read" : "draft")}
        >
          <FileEdit size={17} /> Draft Memo
        </button>
        <button
          type="button"
          className="tool"
          disabled={draftDirty}
          title={draftDirty ? "Save or discard memo edits before improving with AI." : "Improve with AI"}
          onClick={onImproveWithAi}
        >
          <Wand2 size={17} /> Improve with AI
        </button>
        <button
          type="button"
          className="tool danger"
          disabled={analysisLocked || mutationBusy}
          onClick={() => {
            setMutationBusy(true);
            setMutationError("");
            void onArchiveMemo(memo.id)
              .catch((error) => setMutationError(error instanceof Error ? error.message : "Review was not archived."))
              .finally(() => setMutationBusy(false));
          }}
        >
          <Archive size={17} /> Archive
        </button>
      </div>

      {mutationError && <p className="memo-chat-error">{mutationError}</p>}

      <div className={mode === "draft" ? "document-frame draft-document-frame" : "document-frame"}>
        {mode === "draft" ? (
          <PublicDraftPanel onCreateMemo={onCreatePublicDraft} />
        ) : mode === "edit" ? (
          <div className="editor-frame evidence-editor-frame">
            <section className="editor-pane" aria-label="Memo text editing pane">
              <div className="editor-pane-title">
                <strong>Memo text</strong>
                <span>{draftDirty ? "Draft has unsaved changes" : "Saved text"}</span>
              </div>
              <textarea
                aria-label="Memo text editor"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={analysisLocked}
              />
            </section>
            <aside className="editor-evidence-pane" aria-label="Saved evidence context">
              <div className="editor-pane-title">
                <strong>Saved evidence</strong>
                <span>{findings.length ? `${findings.length} finding${findings.length === 1 ? "" : "s"}` : "No analysis yet"}</span>
              </div>
              {selectedFinding && <SelectedFindingCard finding={selectedFinding} />}
              <MemoDocumentView
                memoText={memo.memoText}
                findings={findings}
                selectedFindingId={selectedFindingId}
                selectedFindingRef={selectedFindingRef}
                className="memo-document editor-evidence-document"
              />
            </aside>
          </div>
        ) : mode === "compare" ? (
          <section className="compare-frame" aria-label="Draft comparison">
            <div className="compare-title">
              <strong>Draft comparison</strong>
              <span>{draftDirty ? "Review changes before saving" : "No draft changes yet"}</span>
            </div>
            {draftDirty ? (
              <MemoDiffPreview
                currentMemoText={memo.memoText}
                proposedMemoText={draft}
                label="Draft memo changes"
                contextTokens={42}
              />
            ) : (
              <div className="compare-empty">Edit the memo text to compare draft changes.</div>
            )}
          </section>
        ) : (
          <MemoDocumentView
            memoText={memo.memoText}
            findings={findings}
            selectedFindingId={selectedFindingId}
            selectedFindingRef={selectedFindingRef}
            style={{ fontSize: `${16 * (zoom / 100)}px` }}
          />
        )}
      </div>

      {mode !== "draft" && (draftDirty || mode === "edit" || mode === "compare") && (
        <div className="editor-actions sticky-editor-actions">
          <span>
            {draftDirty
              ? "Saving will clear prior analysis and reviewer decisions."
              : "No unsaved changes."}
          </span>
          <button className="button small" type="button" onClick={discardDraft} disabled={!draftDirty}>
            Discard
          </button>
          <button className="button primary small" type="button" onClick={() => void saveDraft()} disabled={analysisLocked || mutationBusy || !draftDirty}>
            {mutationBusy ? "Saving..." : "Save changes"}
          </button>
        </div>
      )}

      <div className="document-footer">
        <div className="legend">
          <LegendItem status="strong" label="Strong Evidence" />
          <LegendItem status="weak" label="Weak Reasoning" />
          <LegendItem status="missing" label="Missing Info" />
          <LegendItem status="conflict" label="Conflicting Claim" />
        </div>
      </div>
    </section>
  );
}

// A segment after splitting on newlines — belongs to one line only.
interface LineSegment {
  text: string;
  finding?: EvidenceFinding;
}

function renderLineSegments(
  segs: LineSegment[],
  findings: ReviewResult["findings"],
  selectedFindingId: string | undefined,
  selectedFindingRef: MutableRefObject<HTMLElement | null>,
  keyPrefix: string
) {
  return segs.map((seg, si) => {
    const html = renderInlineText(seg.text);
    if (!seg.finding) {
      return <span key={`${keyPrefix}-${si}`} dangerouslySetInnerHTML={{ __html: html }} />;
    }
    const isSelected = seg.finding.id === selectedFindingId;
    return (
      <mark
        key={`${keyPrefix}-${si}`}
        className={isSelected ? `highlight ${seg.finding.status} selected` : `highlight ${seg.finding.status}`}
        title={seg.finding.title}
        ref={(el) => { if (isSelected) selectedFindingRef.current = el; }}
      >
        <span dangerouslySetInnerHTML={{ __html: html }} />
        <span className={`finding-badge ${seg.finding.status}`}>
          {indexBadge(findings, seg.finding.id)}
        </span>
      </mark>
    );
  });
}

function renderInlineText(text: string): string {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function stripLeadingChars(segs: LineSegment[], count: number): LineSegment[] {
  let remaining = count;
  return segs
    .map((seg) => {
      if (remaining <= 0) return seg;
      const skip = Math.min(remaining, seg.text.length);
      remaining -= skip;
      return { ...seg, text: seg.text.slice(skip) };
    })
    .filter((seg) => seg.text.length > 0);
}

function MemoDocumentView({
  memoText,
  findings,
  selectedFindingId,
  selectedFindingRef,
  className = "memo-document",
  style
}: {
  memoText: string;
  findings: ReviewResult["findings"];
  selectedFindingId?: string;
  selectedFindingRef: MutableRefObject<HTMLElement | null>;
  className?: string;
  style?: CSSProperties;
}) {
  // 1. Get character-level segments, then split each on '\n' so every sub-segment
  //    stays within a single line.
  const rawSegments = createHighlightSegments(memoText, findings);
  type MaybeNewline = LineSegment & { isNewline?: boolean };
  const flat: MaybeNewline[] = [];
  for (const seg of rawSegments) {
    const parts = seg.text.split("\n");
    parts.forEach((part, i) => {
      flat.push({ text: part, finding: seg.finding });
      if (i < parts.length - 1) flat.push({ text: "", isNewline: true });
    });
  }

  // 2. Group into lines
  const lines: LineSegment[][] = [[]];
  for (const item of flat) {
    if (item.isNewline) {
      lines.push([]);
    } else if (item.text.length > 0) {
      lines[lines.length - 1].push({ text: item.text, finding: item.finding });
    }
  }

  // 3. Render line by line with markdown structure
  const nodes: React.ReactNode[] = [];
  let listItems: React.ReactNode[] = [];
  let listKey = 0;

  const flushList = () => {
    if (!listItems.length) return;
    nodes.push(<ul key={`ul-${listKey++}`}>{listItems}</ul>);
    listItems = [];
  };

  lines.forEach((lineSegs, li) => {
    const lineText = lineSegs.map((s) => s.text).join("");
    const trimmed = lineText.trim();

    if (!trimmed) {
      flushList();
      return;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      const Tag = (level === 1 ? "h2" : level === 2 ? "h3" : "h4") as "h2" | "h3" | "h4";
      const stripped = stripLeadingChars(lineSegs, lineText.indexOf(trimmed) + headingMatch[0].length);
      nodes.push(
        <Tag key={`h-${li}`}>
          {renderLineSegments(stripped, findings, selectedFindingId, selectedFindingRef, `h-${li}`)}
        </Tag>
      );
      return;
    }

    const bulletMatch = trimmed.match(/^[-*]\s+/);
    if (bulletMatch) {
      const stripped = stripLeadingChars(lineSegs, lineText.indexOf(trimmed) + bulletMatch[0].length);
      listItems.push(
        <li key={`li-${li}`}>
          {renderLineSegments(stripped, findings, selectedFindingId, selectedFindingRef, `li-${li}`)}
        </li>
      );
      return;
    }

    if (/^>\s?/.test(trimmed)) {
      flushList();
      const markerLen = lineText.match(/^(\s*>\s?)/)![1].length;
      const stripped = stripLeadingChars(lineSegs, markerLen);
      nodes.push(
        <blockquote key={`bq-${li}`}>
          {renderLineSegments(stripped, findings, selectedFindingId, selectedFindingRef, `bq-${li}`)}
        </blockquote>
      );
      return;
    }

    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushList();
      nodes.push(<hr key={`hr-${li}`} />);
      return;
    }

    flushList();
    nodes.push(
      <p key={`p-${li}`}>
        {renderLineSegments(lineSegs, findings, selectedFindingId, selectedFindingRef, `p-${li}`)}
      </p>
    );
  });

  flushList();

  return (
    <article className={className} style={style}>
      {nodes}
      {findings
        .filter((f) => f.status === "missing" && typeof f.start !== "number")
        .map((finding) => (
          <p
            className={finding.id === selectedFindingId ? "missing-inline selected" : "missing-inline"}
            key={finding.id}
            ref={(el) => { if (finding.id === selectedFindingId) selectedFindingRef.current = el; }}
          >
            [Add: {finding.claim}]
            <span className="finding-badge missing">{indexBadge(findings, finding.id)}</span>
          </p>
        ))}
    </article>
  );
}

function SelectedFindingCard({ finding }: { finding: EvidenceFinding }) {
  return (
    <div className={`selected-finding-card ${finding.status}`}>
      <strong>{finding.title}</strong>
      <span>{finding.status}</span>
      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(finding.rationale) }} />
    </div>
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

function dataClassLabel(value: MemoRecord["dataClass"]) {
  if (value === "public") return "Public/sample";
  if (value === "export-controlled") return "Export-controlled";
  if (value === "itar-risk") return "ITAR risk";
  if (value === "cui") return "CUI";
  return "Proprietary";
}

function sourcePathLabel(value: MemoRecord["sourcePath"]) {
  if (value === "manufacturer") return "Manufacturer source";
  if (value === "ccats") return "BIS CCATS";
  if (value === "cj") return "DDTC CJ";
  if (value === "unknown") return "Unknown path";
  return "Self-classification";
}
