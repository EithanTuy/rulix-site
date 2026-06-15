import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Edit3,
  FileText,
  Highlighter,
  MessageSquare,
  Send,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { createHighlightSegments } from "../lib/highlights";
import type { MemoChatMessage, MemoRecord, ReviewResult } from "../types";

interface MemoWorkspaceProps {
  memo: MemoRecord;
  result?: ReviewResult;
  selectedFindingId?: string;
  chatMessages: MemoChatMessage[];
  onMemoTextChange: (memoId: string, memoText: string) => void;
  onSendChat: (memoId: string, message: string) => Promise<void>;
  onApplyChatSuggestion: (memoId: string, messageId: string, proposedMemoText: string) => void;
}

export function MemoWorkspace({
  memo,
  result,
  selectedFindingId,
  chatMessages,
  onMemoTextChange,
  onSendChat,
  onApplyChatSuggestion
}: MemoWorkspaceProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memo.memoText);
  const [zoom, setZoom] = useState(100);
  const [highlightsVisible, setHighlightsVisible] = useState(true);
  const [chatDraft, setChatDraft] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
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
    onMemoTextChange(memo.id, draft);
    setEditing(false);
  };

  const submitChat = async () => {
    if (!chatDraft.trim()) return;
    const message = chatDraft.trim();
    setChatDraft("");
    setChatBusy(true);
    try {
      await onSendChat(memo.id, message);
    } finally {
      setChatBusy(false);
    }
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
          onClick={() => {
            setDraft(memo.memoText);
            setEditing((value) => !value);
          }}
        >
          <Edit3 size={17} /> {editing ? "Cancel Edit" : "Edit Text"}
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

      <section className="memo-chat" aria-label="Memo chat">
        <div className="memo-chat-title">
          <MessageSquare size={19} />
          <div>
            <strong>Chat About This Memo</strong>
            <span>Add reviewer context or ask Rulix to draft memo edits.</span>
          </div>
        </div>
        <div className="memo-chat-thread">
          {chatMessages.length === 0 && (
            <div className="memo-chat-empty">
              Try: "Add that the vendor confirmed the system has no radiation hardening."
            </div>
          )}
          {chatMessages.map((message) => (
            <div className={`chat-message ${message.role}`} key={message.id}>
              <p>{message.text}</p>
              {message.proposedMemoText && (
                <div className="chat-proposal">
                  <strong>Proposed memo update</strong>
                  <pre>{previewDiff(memo.memoText, message.proposedMemoText)}</pre>
                  <button
                    type="button"
                    className={message.applied ? "button small applied" : "button primary small"}
                    disabled={message.applied}
                    onClick={() => onApplyChatSuggestion(memo.id, message.id, message.proposedMemoText!)}
                  >
                    {message.applied ? <CheckCircle2 size={16} /> : <Edit3 size={16} />}
                    {message.applied ? "Applied" : "Apply to Memo"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="memo-chat-input">
          <textarea
            value={chatDraft}
            onChange={(event) => setChatDraft(event.target.value)}
            placeholder="Ask a question or tell Rulix what to add, revise, or clarify..."
            rows={3}
          />
          <button className="button primary small" type="button" onClick={submitChat} disabled={chatBusy || !chatDraft.trim()}>
            <Send size={16} />
            Send
          </button>
        </div>
      </section>
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

function previewDiff(currentMemoText: string, proposedMemoText: string) {
  const addition = proposedMemoText.replace(currentMemoText.trim(), "").trim();
  return addition || proposedMemoText.slice(-500);
}
