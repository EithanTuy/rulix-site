import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArrowRight,
  CalendarDays,
  CheckSquare2,
  ClipboardCopy,
  Copy,
  Download,
  ExternalLink,
  Filter,
  Flag,
  FolderOpen,
  Link2,
  MoreHorizontal,
  Search,
  Tags,
  UserRoundCheck,
  X
} from "lucide-react";
import {
  createReview,
  getReviewDetail,
  listReviews,
  listTenantMembers,
  setReviewArchived,
  updateReviewMetadata,
  type ReviewSummary
} from "../lib/apiClient";
import type { SavedReviewView, UserProfile } from "../types";
import { ContextMenu, type ContextMenuAction } from "./ui/ContextMenu";

interface ReviewQueueViewProps {
  user: UserProfile;
  savedViews: SavedReviewView[];
  onOpenReview: (memoId: string) => void;
  onNewReview: () => void;
  onSaveView: (view: SavedReviewView) => void;
}

type QueueFilters = {
  search: string;
  state: "active" | "archived" | "all";
  lifecycleStage: string;
  priority: string;
  due: string;
  assignee: string;
  tags: string;
  sort: "updated-desc" | "updated-asc";
};

const emptyFilters: QueueFilters = {
  search: "", state: "active", lifecycleStage: "", priority: "", due: "", assignee: "", tags: "", sort: "updated-desc"
};

export function ReviewQueueView({ user, savedViews, onOpenReview, onNewReview, onSaveView }: ReviewQueueViewProps) {
  const [filters, setFilters] = useState<QueueFilters>(() => filtersFromHash());
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  const [members, setMembers] = useState<Array<Pick<UserProfile, "id" | "name" | "email" | "role">>>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ review: ReviewSummary; x: number; y: number }>();
  const [bulkTag, setBulkTag] = useState("");
  const canManage = user.role !== "submitter";

  const load = useCallback(async (append = false, nextCursor?: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const page = await listReviews({
        limit: 30,
        ...(nextCursor ? { cursor: nextCursor } : {}),
        state: filters.state,
        ...(filters.search ? { search: filters.search } : {}),
        ...(filters.lifecycleStage ? { lifecycleStage: filters.lifecycleStage as ReviewSummary["lifecycleStage"] } : {}),
        ...(filters.priority ? { priority: filters.priority as ReviewSummary["priority"] } : {}),
        ...(filters.due ? { due: filters.due as "overdue" | "today" | "next-7-days" | "none" } : {}),
        ...(filters.assignee ? { assignee: filters.assignee } : {}),
        ...(filters.tags ? { tags: filters.tags.split(",").map((tag) => tag.trim()).filter(Boolean) } : {}),
        sort: filters.sort
      });
      setReviews((current) => append ? [...current, ...page.items] : page.items);
      setCursor(page.nextCursor);
      if (!append) setSelected(new Set());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The review queue could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), filters.search ? 250 : 0);
    writeFiltersToHash(filters);
    return () => window.clearTimeout(timer);
  }, [filters, load]);

  useEffect(() => {
    if (!canManage) return;
    void listTenantMembers().then((response) => setMembers(response.items)).catch(() => undefined);
  }, [canManage]);

  const activeFilterCount = Object.entries(filters).filter(([key, value]) =>
    value && value !== emptyFilters[key as keyof QueueFilters]).length;
  const allSelected = reviews.length > 0 && reviews.every((review) => selected.has(review.id));
  const selectedReviews = useMemo(() => reviews.filter((review) => selected.has(review.id)), [reviews, selected]);

  const applyBulk = async (patch: Parameters<typeof updateReviewMetadata>[1]) => {
    if (!selectedReviews.length) return;
    setLoading(true);
    try {
      await Promise.all(selectedReviews.map((review) => updateReviewMetadata(review, patch)));
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The bulk update could not be completed.");
    } finally {
      setLoading(false);
    }
  };

  const contextActions = menu ? buildContextActions(menu.review, user, onOpenReview, async (patch) => {
    await updateReviewMetadata(menu.review, patch);
    await load();
  }, async () => {
    if (!window.confirm(`Archive “${menu.review.title}”? The review remains available in history.`)) return;
    await setReviewArchived(menu.review, true);
    await load();
  }, async () => {
    const { review } = await getReviewDetail(menu.review.id);
    const created = await createReview({
      title: `${review.title} (copy)`.slice(0, 240),
      itemFamily: review.itemFamily,
      manufacturer: review.manufacturer ?? "",
      intendedUse: review.intendedUse ?? "",
      dataClass: review.dataClass ?? "proprietary",
      sourcePath: review.sourcePath ?? "unknown",
      attachments: review.attachments,
      memoText: review.memoText
    });
    onOpenReview(created.review.id);
  }) : [];

  return (
    <main className="px-page px-queue" id="main-content">
      <header className="px-page-heading">
        <div><p className="px-eyebrow">Reviews</p><h1>Review Queue</h1><p>Find, prioritize, assign, and advance every export-control review without losing its audit trail.</p></div>
        <button className="button primary" type="button" onClick={onNewReview}>New review</button>
      </header>

      <section className="px-filter-bar" aria-label="Review filters">
        <label className="px-search-field"><Search size={17} /><input value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Search title, review ID, owner…" /></label>
        <select aria-label="Lifecycle stage" value={filters.lifecycleStage} onChange={(event) => setFilters((current) => ({ ...current, lifecycleStage: event.target.value }))}>
          <option value="">All stages</option><option value="draft">Draft</option><option value="needs-information">Needs information</option><option value="ready-for-analysis">Ready for analysis</option><option value="in-review">In review</option><option value="ready-for-decision">Ready for decision</option><option value="approved">Approved</option><option value="rejected">Rejected</option>
        </select>
        <select aria-label="Priority" value={filters.priority} onChange={(event) => setFilters((current) => ({ ...current, priority: event.target.value }))}>
          <option value="">All priorities</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option>
        </select>
        <select aria-label="Due date" value={filters.due} onChange={(event) => setFilters((current) => ({ ...current, due: event.target.value }))}>
          <option value="">Any due date</option><option value="overdue">Overdue</option><option value="today">Due today</option><option value="next-7-days">Next 7 days</option><option value="none">No due date</option>
        </select>
        <button type="button" className="px-filter-toggle"><Filter size={16} />Filters {activeFilterCount ? <b>{activeFilterCount}</b> : null}</button>
        {activeFilterCount ? <button type="button" className="px-clear-filters" onClick={() => setFilters(emptyFilters)}><X size={15} />Clear</button> : null}
      </section>

      <section className="px-queue-tools">
        <div className="px-saved-views">
          <button type="button" className="active" onClick={() => setFilters(emptyFilters)}>All active</button>
          {savedViews.map((view) => <button type="button" key={view.id} onClick={() => setFilters(filtersFromQuery(view.query))}>{view.name}</button>)}
          <button type="button" onClick={() => onSaveView({ id: `view-${crypto.randomUUID()}`, name: `View ${savedViews.length + 1}`, query: filtersToQuery(filters), createdAt: new Date().toISOString() })}>+ Save view</button>
        </div>
        <div className="px-queue-sort"><span>{reviews.length} loaded</span><select aria-label="Sort reviews" value={filters.sort} onChange={(event) => setFilters((current) => ({ ...current, sort: event.target.value as QueueFilters["sort"] }))}><option value="updated-desc">Updated newest</option><option value="updated-asc">Updated oldest</option></select></div>
      </section>

      {selected.size && canManage ? (
        <section className="px-bulk-bar" aria-label="Bulk actions">
          <strong>{selected.size} selected</strong>
          <select aria-label="Bulk assign" defaultValue="" onChange={(event) => event.target.value && void applyBulk({ assignedTo: event.target.value })}>
            <option value="">Assign to…</option><option value={user.id}>Assign to me</option>{members.filter((member) => member.id !== user.id).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
          </select>
          <label><Tags size={15} /><input value={bulkTag} onChange={(event) => setBulkTag(event.target.value)} placeholder="Add tag" /><button type="button" disabled={!bulkTag.trim()} onClick={() => void applyBulk({ tags: [bulkTag.trim()] })}>Apply</button></label>
          <button type="button" onClick={() => void applyBulk({ priority: "high" })}><Flag size={15} />Set high priority</button>
          <button type="button" className="px-icon-button" onClick={() => setSelected(new Set())} aria-label="Clear selection"><X size={17} /></button>
        </section>
      ) : null}

      <section className="px-table-shell" aria-live="polite">
        <div className="px-review-table" role="table" aria-label="Reviews">
          <div className="px-review-head" role="row">
            <span role="columnheader"><input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(reviews.map((review) => review.id)))} aria-label="Select all loaded reviews" /></span>
            <span role="columnheader">Review</span><span role="columnheader">Stage</span><span role="columnheader">Priority</span><span role="columnheader">Assignee</span><span role="columnheader">Due</span><span role="columnheader">Updated</span><span />
          </div>
          {reviews.map((review) => (
            <div className={`px-review-row${selected.has(review.id) ? " selected" : ""}`} role="row" key={review.id} onContextMenu={(event) => { event.preventDefault(); setMenu({ review, x: event.clientX, y: event.clientY }); }}>
              <span role="cell"><input type="checkbox" checked={selected.has(review.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(review.id)) next.delete(review.id); else next.add(review.id); return next; })} aria-label={`Select ${review.title}`} /></span>
              <span role="cell"><button type="button" className="px-review-title" onClick={() => onOpenReview(review.id)}><strong>{review.title}</strong><small>{review.documentCode} · {review.dataClass ?? "Unclassified"}</small>{review.tags?.length ? <em>{review.tags.slice(0, 2).map((tag) => <i key={tag}>{tag}</i>)}</em> : null}</button></span>
              <span role="cell"><span className={`px-stage ${review.lifecycleStage ?? "draft"}`}>{labelize(review.lifecycleStage ?? "draft")}</span></span>
              <span role="cell"><span className={`px-priority ${review.priority ?? "normal"}`}><i />{labelize(review.priority ?? "normal")}</span></span>
              <span role="cell">{members.find((member) => member.id === review.assignedTo)?.name ?? (review.assignedTo ? "Assigned" : "Unassigned")}</span>
              <span role="cell" className={review.dueAt && Date.parse(review.dueAt) < Date.now() ? "overdue" : ""}>{review.dueAt ? new Date(review.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—"}</span>
              <span role="cell">{new Date(review.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
              <span role="cell"><button type="button" className="px-icon-button" aria-label={`More actions for ${review.title}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ review, x: rect.right - 8, y: rect.bottom + 4 }); }}><MoreHorizontal size={17} /></button></span>
            </div>
          ))}
        </div>
        {loading && !reviews.length ? <div className="px-table-loading"><span /><span /><span /><span /></div> : null}
        {error ? <div className="px-inline-error"><strong>Queue unavailable</strong><span>{error}</span><button type="button" className="button" onClick={() => void load()}>Retry</button></div> : null}
        {!loading && !error && reviews.length === 0 ? <div className="px-empty-state"><FolderOpen size={28} /><h2>No reviews match</h2><p>Clear a filter or create a new review to keep work moving.</p><div><button type="button" className="button" onClick={() => setFilters(emptyFilters)}>Clear filters</button><button type="button" className="button primary" onClick={onNewReview}>New review</button></div></div> : null}
        {cursor ? <button className="px-load-more" type="button" disabled={loading} onClick={() => void load(true, cursor)}>Load more reviews <ArrowRight size={16} /></button> : null}
      </section>
      <p className="px-context-hint">Tip: right-click any review for quick, context-aware actions.</p>
      <ContextMenu open={Boolean(menu)} x={menu?.x ?? 0} y={menu?.y ?? 0} label={menu ? `Actions for ${menu.review.title}` : "Review actions"} actions={contextActions} onClose={() => setMenu(undefined)} />
    </main>
  );
}

function buildContextActions(
  review: ReviewSummary,
  user: UserProfile,
  onOpen: (memoId: string) => void,
  update: (patch: Parameters<typeof updateReviewMetadata>[1]) => Promise<void>,
  archive: () => Promise<void>,
  duplicate: () => Promise<void>
): ContextMenuAction[] {
  const link = `${window.location.origin}${window.location.pathname}#/reviews/${encodeURIComponent(review.id)}/overview`;
  return [
    { id: "open", label: "Open review", icon: FolderOpen, shortcut: "↵", onSelect: () => onOpen(review.id) },
    { id: "split", label: "Open in new window", icon: ExternalLink, onSelect: () => window.open(link, "_blank", "noopener,noreferrer") },
    { id: "copy-link", label: "Copy secure link", icon: Link2, shortcut: "⌘ L", onSelect: () => void navigator.clipboard.writeText(link) },
    { id: "copy-id", label: "Copy review ID", icon: Copy, onSelect: () => void navigator.clipboard.writeText(review.id) },
    { id: "assign", label: "Assign to me", icon: UserRoundCheck, separatorBefore: true, disabled: user.role === "submitter", onSelect: () => void update({ assignedTo: user.id }) },
    { id: "priority", label: "Mark high priority", icon: Flag, disabled: user.role === "submitter", onSelect: () => void update({ priority: "high" }) },
    { id: "duplicate", label: "Duplicate as draft", icon: ClipboardCopy, onSelect: () => void duplicate() },
    { id: "download", label: "Download metadata", icon: Download, onSelect: () => downloadReview(review) },
    { id: "archive", label: "Archive review…", icon: Archive, tone: "danger", separatorBefore: true, disabled: user.role === "submitter", onSelect: () => void archive() }
  ];
}

function downloadReview(review: ReviewSummary) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(review, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${review.documentCode}-metadata.json`; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function filtersFromHash() {
  const query = window.location.hash.split("?")[1] ?? "";
  return filtersFromQuery(query);
}

function filtersFromQuery(query: string): QueueFilters {
  const params = new URLSearchParams(query);
  return {
    search: params.get("search") ?? "",
    state: (params.get("state") as QueueFilters["state"]) ?? "active",
    lifecycleStage: params.get("lifecycleStage") ?? "",
    priority: params.get("priority") ?? "",
    due: params.get("due") ?? "",
    assignee: params.get("assignee") ?? "",
    tags: params.get("tags") ?? "",
    sort: (params.get("sort") as QueueFilters["sort"]) ?? "updated-desc"
  };
}

function filtersToQuery(filters: QueueFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value && value !== emptyFilters[key as keyof QueueFilters]) params.set(key, value);
  return params.toString();
}

function writeFiltersToHash(filters: QueueFilters) {
  const query = filtersToQuery(filters);
  const next = `#/reviews${query ? `?${query}` : ""}`;
  if (window.location.hash !== next) window.history.replaceState(null, "", next);
}

function labelize(value: string) {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
