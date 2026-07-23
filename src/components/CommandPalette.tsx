import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Library, MessageSquareText, Search, Settings, WandSparkles } from "lucide-react";
import type { AppView, MemoRecord } from "../types";

interface CommandPaletteProps {
  open: boolean;
  reviews: MemoRecord[];
  onClose: () => void;
  onNavigate: (view: AppView) => void;
  onOpenReview: (memoId: string) => void;
  onNewReview: () => void;
}

export function CommandPalette({ open, reviews, onClose, onNavigate, onOpenReview, onNewReview }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? reviews.filter((review) => `${review.title} ${review.documentCode}`.toLocaleLowerCase().includes(normalized)).slice(0, 6)
      : reviews.slice(0, 4);
  }, [query, reviews]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    window.setTimeout(() => inputRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;
  const run = (callback: () => void) => {
    callback();
    onClose();
  };
  return (
    <div className="px-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="px-command" role="dialog" aria-modal="true" aria-label="Command search">
        <label className="px-command-input">
          <Search size={20} />
          <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search reviews, memos, and actions…" />
          <kbd>Esc</kbd>
        </label>
        <div className="px-command-groups">
          <div>
            <p className="px-command-label">Go to</p>
            <button type="button" onClick={() => run(() => onNavigate("work"))}><FileText size={17} />Work</button>
            <button type="button" onClick={() => run(() => onNavigate("memo-builder"))}><WandSparkles size={17} />Memo Builder</button>
            <button type="button" onClick={() => run(() => onNavigate("evidence"))}><Library size={17} />Evidence Library</button>
            <button type="button" onClick={() => run(() => onNavigate("settings"))}><Settings size={17} />Settings</button>
          </div>
          <div>
            <div className="px-command-label-row">
              <p className="px-command-label">{query ? "Matching reviews" : "Recent reviews"}</p>
              <button type="button" className="px-command-link" onClick={() => run(onNewReview)}>New review</button>
            </div>
            {matches.length ? matches.map((review) => (
              <button type="button" key={review.id} onClick={() => run(() => onOpenReview(review.id))}>
                <MessageSquareText size={17} />
                <span><strong>{review.title}</strong><small>{review.documentCode}</small></span>
              </button>
            )) : <p className="px-command-empty">No reviews match that search.</p>}
          </div>
        </div>
      </section>
    </div>
  );
}
