import { useEffect, useRef } from "react";
import {
  BookOpenCheck,
  ClipboardCheck,
  FilePlus2,
  ScanSearch,
  ShieldCheck,
  Wand2,
  X
} from "lucide-react";
import type { UserProfile } from "../types";

interface HelpCenterProps {
  open: boolean;
  userRole: UserProfile["role"];
  onClose: () => void;
  onNewReview: () => void;
  onMemoBuilder: () => void;
}

export function HelpCenter({
  open,
  userRole,
  onClose,
  onNewReview,
  onMemoBuilder
}: HelpCenterProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeActionRef = useRef(onClose);

  useEffect(() => {
    closeActionRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    closeRef.current?.focus();
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeActionRef.current();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => {
      window.removeEventListener("keydown", handleKeyboard);
      previousFocus?.focus();
    };
  }, [open]);

  if (!open) return null;
  const isOfficer = userRole === "export-control-officer";

  return (
    <div className="help-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        ref={dialogRef}
        className="help-center"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-center-title"
        aria-describedby="help-center-description"
      >
        <header className="help-center-header">
          <div>
            <span className="help-eyebrow"><BookOpenCheck size={16} /> Rulix guide</span>
            <h2 id="help-center-title">From memo to defensible decision</h2>
            <p id="help-center-description">
              Rulix helps you inspect a classification memo, surface evidence gaps, and preserve the human decision record.
            </p>
          </div>
          <button ref={closeRef} type="button" className="help-close" onClick={onClose} aria-label="Close Rulix guide">
            <X size={20} />
          </button>
        </header>

        <ol className="help-steps">
          <li>
            <FilePlus2 size={20} />
            <div><strong>1. Add the exact memo</strong><span>Paste text, upload a classified file, or use Memo Builder. Choose the data class before any file extraction.</span></div>
          </li>
          <li>
            <ScanSearch size={20} />
            <div><strong>2. Check the source record</strong><span>Confirm the memo text, item facts, intended use, attachments, and data classification before analysis.</span></div>
          </li>
          <li>
            <ShieldCheck size={20} />
            <div>
              <strong>3. Approve the exact AI request</strong>
              <span>{isOfficer
                ? "As an export-control officer, you can approve the exact current content and provider lane. Editing the memo makes that approval stale."
                : "Request officer approval for the exact current content. Do not edit it while approval is pending; any change intentionally makes the request stale."}</span>
            </div>
          </li>
          <li>
            <ClipboardCheck size={20} />
            <div><strong>4. Resolve and sign off</strong><span>Inspect cited evidence, answer information requests, record notes, and make the human accept, request-info, or override decision.</span></div>
          </li>
        </ol>

        <div className="help-callouts">
          <article>
            <strong>What AI can do</strong>
            <p>Draft, summarize, compare evidence, and recommend review paths from the exact approved snapshot.</p>
          </article>
          <article>
            <strong>What AI cannot do</strong>
            <p>Send outreach automatically, change your memo silently, or replace a qualified export-control determination.</p>
          </article>
          <article>
            <strong>Where the record lives</strong>
            <p>Reviews, revisions, approvals, chat suggestions, decisions, and audit events remain account-linked and version-bound.</p>
          </article>
        </div>

        <footer className="help-actions">
          <button type="button" className="button" onClick={() => { onClose(); onMemoBuilder(); }}>
            <Wand2 size={16} /> Open Memo Builder
          </button>
          <button type="button" className="button primary" onClick={() => { onClose(); onNewReview(); }}>
            <FilePlus2 size={16} /> Start a review
          </button>
        </footer>
      </section>
    </div>
  );
}
