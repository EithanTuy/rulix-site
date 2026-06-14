import { ChangeEvent, useRef, useState } from "react";
import {
  ChevronDown,
  FileText,
  Filter,
  Search,
  UploadCloud,
  WandSparkles
} from "lucide-react";
import type { MemoRecord } from "../types";

interface ReviewListProps {
  memos: MemoRecord[];
  selectedMemoId: string;
  search: string;
  warning?: string;
  corpusLabel: string;
  onSearch: (search: string) => void;
  onSelect: (memoId: string) => void;
  onFile: (file: File) => Promise<void>;
  onPasteMemo: (title: string, text: string) => void;
}

export function ReviewList({
  memos,
  selectedMemoId,
  search,
  warning,
  corpusLabel,
  onSearch,
  onSelect,
  onFile,
  onPasteMemo
}: ReviewListProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteText, setPasteText] = useState("");

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    await onFile(file);
    event.currentTarget.value = "";
  };

  const submitPaste = () => {
    if (!pasteText.trim()) return;
    onPasteMemo(pasteTitle, pasteText);
    setPasteTitle("");
    setPasteText("");
    setPasteOpen(false);
  };

  return (
    <aside className="review-list">
      <div className="review-tabs">
        <button className="tab active" type="button">
          My Reviews
        </button>
        <button className="tab" type="button">
          Reviewer Queue <span>12</span>
        </button>
      </div>

      <section className="intake-section" aria-label="Intake and new review">
        <div className="section-title">Intake &amp; New Review</div>
        <div className="dropzone">
          <UploadCloud size={31} strokeWidth={1.5} />
          <div>Drag &amp; drop memo or files here</div>
          <span>or</span>
          <div className="intake-actions">
            <button className="button small" type="button" onClick={() => inputRef.current?.click()}>
              Upload Files
            </button>
            <button
              className="button small icon-only"
              type="button"
              onClick={() => setPasteOpen((value) => !value)}
              aria-label="Paste memo text"
              title="Paste memo text"
            >
              <WandSparkles size={15} />
            </button>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".txt,.md,.csv,.json,.pdf,.docx,.png,.jpg,.jpeg"
            onChange={handleFileChange}
            hidden
          />
        </div>
        {pasteOpen && (
          <div className="paste-box">
            <input
              value={pasteTitle}
              onChange={(event) => setPasteTitle(event.target.value)}
              placeholder="Memo title"
            />
            <textarea
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              placeholder="Paste memo text"
              rows={6}
            />
            <button className="button primary small full" type="button" onClick={submitPaste}>
              Run Review
            </button>
          </div>
        )}
        {warning && <div className="intake-warning">{warning}</div>}
        <div className="corpus-status">
          <span className="status-dot green" />
          {corpusLabel}
        </div>
      </section>

      <div className="search-row">
        <label className="search-box">
          <Search size={18} />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search memos..."
          />
        </label>
        <button className="filter-button" type="button" aria-label="Filter reviews" title="Filter">
          <Filter size={18} />
        </button>
      </div>

      <div className="sort-row">
        <span>Sort:</span>
        <button type="button">
          Updated (Newest) <ChevronDown size={15} />
        </button>
      </div>

      <div className="memo-cards" aria-label="Review list">
        {memos.map((memo) => (
          <button
            type="button"
            className={memo.id === selectedMemoId ? "memo-card selected" : "memo-card"}
            onClick={() => onSelect(memo.id)}
            key={memo.id}
          >
            <FileText size={25} strokeWidth={1.5} />
            <span className="memo-card-main">
              <strong>{memo.title}</strong>
              <span>{memo.documentCode}</span>
              <span>
                {formatDate(memo.updatedAt)} | {memo.owner}
              </span>
            </span>
            <span className={`memo-status ${memo.status}`}>{statusLabel(memo.status)}</span>
          </button>
        ))}
      </div>
      <div className="list-footer">Showing 1-{memos.length} of {memos.length}</div>
    </aside>
  );
}

function statusLabel(status: MemoRecord["status"]) {
  if (status === "needs-info") return "Needs Info";
  if (status === "signed-off") return "Signed";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(`${value}T12:00:00`));
}
