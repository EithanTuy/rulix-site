import { ChangeEvent, useRef, useState } from "react";
import {
  FileText,
  Filter,
  Search,
  ShieldCheck,
  UploadCloud
} from "lucide-react";
import type { MemoRecord } from "../types";

type SortMode = "newest" | "oldest" | "status" | "title";
type StatusFilter = "all" | MemoRecord["status"];

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
  const [intakeAcknowledged, setIntakeAcknowledged] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("newest");

  const visibleMemos = [...memos]
    .filter((memo) => statusFilter === "all" || memo.status === statusFilter)
    .sort((a, b) => compareMemos(a, b, sortMode));
  const queueCount = memos.filter((memo) => memo.status !== "signed-off").length;

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    if (!intakeAcknowledged) {
      event.currentTarget.value = "";
      return;
    }
    await onFile(file);
    event.currentTarget.value = "";
  };

  const submitPaste = () => {
    if (!pasteText.trim() || !intakeAcknowledged) return;
    onPasteMemo(pasteTitle, pasteText);
    setPasteTitle("");
    setPasteText("");
    setPasteOpen(false);
  };

  return (
    <aside className="review-list">
      <div className="queue-header">
        <div>
          <strong>Review Queue</strong>
          <span>{queueCount} need action</span>
        </div>
      </div>

      <section className="intake-section" aria-label="Intake and new review">
        <div className="section-title">Add a Memo</div>
        <label className="intake-acknowledgement">
          <input
            type="checkbox"
            checked={intakeAcknowledged}
            onChange={(event) => setIntakeAcknowledged(event.target.checked)}
          />
          <span>
            <ShieldCheck size={16} />
            Use sanitized, public, or approved memo text only. Do not upload CUI, ITAR technical data,
            controlled attachments, or customer secrets.
          </span>
        </label>
        <div className="intake-card">
          <button
            className="button small"
            type="button"
            disabled={!intakeAcknowledged}
            onClick={() => inputRef.current?.click()}
          >
            <UploadCloud size={16} />
            Upload File
          </button>
          <button
            className="button small"
            type="button"
            disabled={!intakeAcknowledged}
            onClick={() => setPasteOpen((value) => !value)}
          >
            <FileText size={16} />
            Paste Text
          </button>
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
            <button
              className="button primary small full"
              type="button"
              disabled={!pasteText.trim() || !intakeAcknowledged}
              onClick={submitPaste}
            >
              Add Memo
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
        <button
          className={filterOpen ? "filter-button active" : "filter-button"}
          type="button"
          aria-label="Filter reviews"
          title="Filter"
          onClick={() => setFilterOpen((value) => !value)}
        >
          <Filter size={18} />
        </button>
      </div>
      {filterOpen && (
        <div className="filter-panel" aria-label="Status filters">
          {(["all", "ready", "needs-info", "conflict", "draft", "signed-off"] as const).map((status) => (
            <button
              type="button"
              className={statusFilter === status ? "filter-chip active" : "filter-chip"}
              onClick={() => setStatusFilter(status)}
              key={status}
            >
              {status === "all" ? "All" : statusLabel(status)}
            </button>
          ))}
        </div>
      )}

      <div className="sort-row">
        <label>
          Sort
          <select
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as SortMode)}
          >
            {SORT_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="memo-cards" aria-label="Review list">
        {visibleMemos.map((memo) => (
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
        {visibleMemos.length === 0 && (
          <div className="empty-list">No reviews match this view.</div>
        )}
      </div>
      <div className="list-footer">Showing {visibleMemos.length ? `1-${visibleMemos.length}` : "0"} of {memos.length}</div>
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

function compareMemos(a: MemoRecord, b: MemoRecord, sortMode: SortMode) {
  if (sortMode === "oldest") return a.updatedAt.localeCompare(b.updatedAt);
  if (sortMode === "title") return a.title.localeCompare(b.title);
  if (sortMode === "status") {
    const rank = { conflict: 0, "needs-info": 1, draft: 2, ready: 3, "signed-off": 4 };
    return rank[a.status] - rank[b.status] || b.updatedAt.localeCompare(a.updatedAt);
  }
  return b.updatedAt.localeCompare(a.updatedAt);
}

const SORT_OPTIONS: Array<{ value: SortMode; label: string }> = [
  { value: "newest", label: "Updated (Newest)" },
  { value: "oldest", label: "Updated (Oldest)" },
  { value: "status", label: "Status" },
  { value: "title", label: "Title" }
];
