import { useEffect, useRef, useState } from "react";
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
import type { EvidenceFinding, MemoRecord, ReviewResult } from "../types";
import { MemoDiffPreview } from "./MemoDiffPreview";
import { PublicDraftPanel } from "./PublicDraftPanel";

type WorkspaceMode = "read" | "edit" | "compare" | "draft";

interface MemoWorkspaceProps {
  memo: MemoRecord;
  result?: ReviewResult;
  selectedFindingId?: string;
  analysisLocked: boolean;
  onMemoTextChange: (memoId: string, memoText: string) => void;
  onArchiveMemo: (memoId: string) => void;
  onCreatePublicDraft: (title: string, memoText: string) => void;
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

  const saveDraft = () => {
    if (analysisLocked) return;
    if (draftDirty) {
      onMemoTextChange(memo.id, draft);
      onDirtyChange(false);
    }
    setMode("read");
  };

  const discardDraft = () => {
    setDraft(memo.memoText);
    onDirtyChange(false);
    setMode("read");
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
          disabled={analysisLocked}
          onClick={() => onArchiveMemo(memo.id)}
        >
          <Archive size={17} /> Archive
        </button>
      </div>

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
          <button className="button primary small" type="button" onClick={saveDraft} disabled={analysisLocked || !draftDirty}>
            Save changes
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
    </main>
  );
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
  const segments = createHighlightSegments(memoText, findings);

  return (
    <article className={className} style={style}>
      {segments.map((segment, index) =>
        segment.finding ? (
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
  );
}

function SelectedFindingCard({ finding }: { finding: EvidenceFinding }) {
  return (
    <div className={`selected-finding-card ${finding.status}`}>
      <strong>{finding.title}</strong>
      <span>{finding.status}</span>
      <p>{finding.rationale}</p>
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
