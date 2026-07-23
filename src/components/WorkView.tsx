import { useMemo, useState } from "react";
import {
  ArrowRight,
  Filter,
  FolderOpen,
  Search,
  SlidersHorizontal,
  X
} from "lucide-react";
import type {
  CasePriority,
  MemoRecord,
  ReviewLifecycleStage,
  SavedReviewView,
  UserProfile
} from "../types";

type WorkTab = "next" | "information" | "decision" | "active" | "completed";

type WorkFilters = {
  lifecycleStage: "" | ReviewLifecycleStage;
  priority: "" | CasePriority;
  due: "" | "overdue" | "today" | "next-7-days" | "none";
  assignee: string;
  tags: string;
  sort: "priority" | "due" | "updated";
};

const emptyFilters: WorkFilters = {
  lifecycleStage: "",
  priority: "",
  due: "",
  assignee: "",
  tags: "",
  sort: "priority"
};

const tabs: Array<{ id: WorkTab; label: string }> = [
  { id: "next", label: "Next up" },
  { id: "information", label: "Needs information" },
  { id: "decision", label: "Needs decision" },
  { id: "active", label: "All active" },
  { id: "completed", label: "Completed" }
];

interface WorkViewProps {
  reviews: MemoRecord[];
  user: UserProfile;
  members: Array<Pick<UserProfile, "id" | "name" | "email" | "role">>;
  savedViews: SavedReviewView[];
  hasMore: boolean;
  loadingMore: boolean;
  onOpenReview: (memoId: string) => void;
  onNewReview: () => void;
  onLoadMore: () => Promise<void>;
  onSaveView: (view: SavedReviewView) => void;
  onBulkUpdate: (
    memoIds: string[],
    patch: Partial<Pick<MemoRecord, "priority" | "tags" | "lifecycleStage">> & {
      assignedTo?: string | null;
      dueAt?: string | null;
    }
  ) => Promise<void>;
}

export function WorkView({
  reviews,
  user,
  members,
  savedViews,
  hasMore,
  loadingMore,
  onOpenReview,
  onNewReview,
  onLoadMore,
  onSaveView,
  onBulkUpdate
}: WorkViewProps) {
  const [tab, setTab] = useState<WorkTab>("next");
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filters, setFilters] = useState<WorkFilters>(emptyFilters);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const activeFilterCount = Object.entries(filters).filter(
    ([key, value]) => value !== emptyFilters[key as keyof WorkFilters]
  ).length;

  const visibleReviews = useMemo(() => {
    const now = new Date();
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);
    const nextWeek = new Date(todayEnd);
    nextWeek.setDate(nextWeek.getDate() + 7);

    const filtered = reviews.filter((review) => {
      const completed = isCompleted(review);
      if (tab === "completed" && !completed) return false;
      if (tab !== "completed" && completed) return false;
      if (tab === "information" && !needsInformation(review)) return false;
      if (tab === "decision" && !needsDecision(review)) return false;
      if (tab === "next" && (review.assignedTo && review.assignedTo !== user.id) && review.ownerId !== user.id) return false;
      if (
        normalizedQuery
        && ![
          review.title,
          review.documentCode,
          review.owner,
          review.itemFamily,
          ...(review.tags ?? [])
        ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
      ) return false;
      if (filters.lifecycleStage && review.lifecycleStage !== filters.lifecycleStage) return false;
      if (filters.priority && (review.priority ?? "normal") !== filters.priority) return false;
      if (filters.assignee && review.assignedTo !== filters.assignee) return false;
      const filterTags = filters.tags.split(",").map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean);
      if (filterTags.length && !filterTags.every((tag) => review.tags?.some((item) => item.toLocaleLowerCase() === tag))) return false;
      if (filters.due === "none" && review.dueAt) return false;
      if (filters.due && filters.due !== "none") {
        if (!review.dueAt) return false;
        const due = new Date(review.dueAt);
        if (filters.due === "overdue" && due >= now) return false;
        if (filters.due === "today" && (due < now || due > todayEnd)) return false;
        if (filters.due === "next-7-days" && (due < now || due > nextWeek)) return false;
      }
      return true;
    });

    return [...filtered].sort((left, right) => {
      if (filters.sort === "updated") return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      if (filters.sort === "due") {
        return (left.dueAt ? Date.parse(left.dueAt) : Number.MAX_SAFE_INTEGER)
          - (right.dueAt ? Date.parse(right.dueAt) : Number.MAX_SAFE_INTEGER);
      }
      const priorityDelta = priorityRank(right.priority) - priorityRank(left.priority);
      if (priorityDelta) return priorityDelta;
      return (left.dueAt ? Date.parse(left.dueAt) : Number.MAX_SAFE_INTEGER)
        - (right.dueAt ? Date.parse(right.dueAt) : Number.MAX_SAFE_INTEGER);
    });
  }, [filters, normalizedQuery, reviews, tab, user.id]);

  const applyBulk = async (patch: Parameters<WorkViewProps["onBulkUpdate"]>[1]) => {
    if (!selected.size || bulkBusy) return;
    setBulkBusy(true);
    try {
      await onBulkUpdate([...selected], patch);
      setSelected(new Set());
    } finally {
      setBulkBusy(false);
    }
  };

  const saveCurrentView = () => {
    const name = window.prompt("Name this view");
    if (!name?.trim()) return;
    onSaveView({
      id: `view-${crypto.randomUUID()}`,
      name: name.trim().slice(0, 60),
      query: new URLSearchParams(
        Object.entries(filters).filter(([, value]) => value).map(([key, value]) => [key, value])
      ).toString(),
      createdAt: new Date().toISOString()
    });
  };

  return (
    <main className="work-page" id="main-content">
      <header className="work-heading">
        <div>
          <h1>Work</h1>
          <p>Prioritized reviews and the next human action, in one place.</p>
        </div>
        <button className="button primary work-start" type="button" onClick={onNewReview}>
          Start review
        </button>
      </header>

      <nav className="work-tabs" aria-label="Work queues">
        {tabs.map((item) => (
          <button
            type="button"
            key={item.id}
            className={tab === item.id ? "active" : ""}
            aria-current={tab === item.id ? "page" : undefined}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="work-toolbar">
        <label className="work-search">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">Search reviews</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search reviews"
          />
        </label>
        <button
          type="button"
          className={drawerOpen ? "button active" : "button"}
          aria-expanded={drawerOpen}
          aria-controls="work-filter-drawer"
          onClick={() => setDrawerOpen((open) => !open)}
        >
          <SlidersHorizontal size={17} />
          Filters
          {activeFilterCount ? <b>{activeFilterCount}</b> : null}
        </button>
      </div>

      <section className="work-table-shell" aria-live="polite" aria-label={`${tabs.find((item) => item.id === tab)?.label} reviews`}>
        <div className="work-table" role="table" aria-label="Prioritized reviews">
          <div className="work-table-head" role="row">
            {drawerOpen ? <span role="columnheader" aria-label="Selection" /> : null}
            <span role="columnheader">Title</span>
            <span role="columnheader">Stage</span>
            <span role="columnheader">Priority</span>
            <span role="columnheader">Owner</span>
            <span role="columnheader">Due date</span>
            <span role="columnheader">Next action</span>
          </div>
          {visibleReviews.map((review) => {
            const stage = stageForReview(review);
            const assignee = members.find((member) => member.id === review.assignedTo);
            const overdue = Boolean(review.dueAt && Date.parse(review.dueAt) < Date.now() && !isCompleted(review));
            return (
              <div className={`work-row${selected.has(review.id) ? " selected" : ""}`} role="row" key={review.id}>
                {drawerOpen ? (
                  <span role="cell" data-label="Select">
                    <input
                      type="checkbox"
                      checked={selected.has(review.id)}
                      aria-label={`Select ${review.title}`}
                      onChange={() => setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(review.id)) next.delete(review.id);
                        else next.add(review.id);
                        return next;
                      })}
                    />
                  </span>
                ) : null}
                <span role="cell" data-label="Title">
                  <button className="work-review-title" type="button" onClick={() => onOpenReview(review.id)}>
                    <strong>{review.title}</strong>
                    <small>{review.documentCode}</small>
                  </button>
                </span>
                <span role="cell" data-label="Stage"><span className={`work-stage ${stage.id}`}>{stage.label}</span></span>
                <span role="cell" data-label="Priority"><span className={`work-priority ${review.priority ?? "normal"}`}><i />{labelize(review.priority ?? "normal")}</span></span>
                <span role="cell" data-label="Owner">{assignee?.name ?? review.owner ?? "Unassigned"}</span>
                <span role="cell" data-label="Due date" className={overdue ? "overdue" : ""}>
                  {review.dueAt ? (
                    <>
                      {new Date(review.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      {overdue ? <small>Overdue</small> : null}
                    </>
                  ) : "—"}
                </span>
                <span role="cell" data-label="Next action">
                  <button type="button" className="work-next-action" onClick={() => onOpenReview(review.id)}>
                    {stage.action}<ArrowRight size={16} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
        {!visibleReviews.length ? (
          <div className="work-empty">
            <FolderOpen size={28} />
            <h2>No reviews here</h2>
            <p>Try another queue, clear the filters, or start a review.</p>
            <div>
              <button type="button" className="button" onClick={() => { setFilters(emptyFilters); setQuery(""); }}>Clear filters</button>
              <button type="button" className="button primary" onClick={onNewReview}>Start review</button>
            </div>
          </div>
        ) : null}
        {hasMore ? (
          <button className="work-load-more" type="button" disabled={loadingMore} onClick={() => void onLoadMore()}>
            {loadingMore ? "Loading…" : "Load more reviews"} <ArrowRight size={16} />
          </button>
        ) : null}
      </section>

      {drawerOpen ? (
        <aside className="work-filter-drawer" id="work-filter-drawer" aria-label="Advanced filters and bulk actions">
          <header>
            <div><Filter size={18} /><h2>Advanced filters</h2></div>
            <button type="button" className="px-icon-button" onClick={() => setDrawerOpen(false)} aria-label="Close filters"><X size={18} /></button>
          </header>
          <div className="work-filter-grid">
            <label>Lifecycle
              <select value={filters.lifecycleStage} onChange={(event) => setFilters((current) => ({ ...current, lifecycleStage: event.target.value as WorkFilters["lifecycleStage"] }))}>
                <option value="">All stages</option>
                <option value="draft">Draft</option>
                <option value="needs-information">Needs information</option>
                <option value="ready-for-analysis">Ready for analysis</option>
                <option value="in-review">In review</option>
                <option value="changes-requested">Changes requested</option>
                <option value="ready-for-decision">Ready for decision</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </select>
            </label>
            <label>Priority
              <select value={filters.priority} onChange={(event) => setFilters((current) => ({ ...current, priority: event.target.value as WorkFilters["priority"] }))}>
                <option value="">All priorities</option>
                <option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option>
              </select>
            </label>
            <label>Due date
              <select value={filters.due} onChange={(event) => setFilters((current) => ({ ...current, due: event.target.value as WorkFilters["due"] }))}>
                <option value="">Any due date</option><option value="overdue">Overdue</option><option value="today">Due today</option><option value="next-7-days">Next 7 days</option><option value="none">No due date</option>
              </select>
            </label>
            <label>Assignee
              <select value={filters.assignee} onChange={(event) => setFilters((current) => ({ ...current, assignee: event.target.value }))}>
                <option value="">Anyone</option>{members.map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}
              </select>
            </label>
            <label>Tags
              <input value={filters.tags} onChange={(event) => setFilters((current) => ({ ...current, tags: event.target.value }))} placeholder="legal, urgent" />
            </label>
            <label>Sort
              <select value={filters.sort} onChange={(event) => setFilters((current) => ({ ...current, sort: event.target.value as WorkFilters["sort"] }))}>
                <option value="priority">Priority, then due</option><option value="due">Due date</option><option value="updated">Recently updated</option>
              </select>
            </label>
          </div>
          <div className="work-saved-views">
            <strong>Saved views</strong>
            <div>
              {savedViews.map((view) => <button type="button" key={view.id} onClick={() => setFilters(filtersFromSavedView(view))}>{view.name}</button>)}
              <button type="button" onClick={saveCurrentView}>+ Save current view</button>
            </div>
          </div>
          {user.role !== "submitter" ? (
            <div className="work-bulk-actions">
              <strong>{selected.size ? `${selected.size} selected` : "Bulk actions"}</strong>
              <p>Select rows while this drawer is open, then update them together.</p>
              <div>
                <button type="button" className="button" disabled={!selected.size || bulkBusy} onClick={() => void applyBulk({ assignedTo: user.id })}>Assign to me</button>
                <button type="button" className="button" disabled={!selected.size || bulkBusy} onClick={() => void applyBulk({ priority: "high" })}>Set high priority</button>
              </div>
            </div>
          ) : null}
          <footer>
            <button type="button" className="button" onClick={() => setFilters(emptyFilters)}>Reset</button>
            <button type="button" className="button primary" onClick={() => setDrawerOpen(false)}>Show {visibleReviews.length} reviews</button>
          </footer>
        </aside>
      ) : null}
    </main>
  );
}

function stageForReview(review: MemoRecord) {
  if (isCompleted(review)) return { id: "completed", label: "Completed", action: "View decision" };
  if (needsInformation(review)) return { id: "information", label: "Needs information", action: "Provide information" };
  if (needsDecision(review)) return { id: "decision", label: "Needs decision", action: "Record decision" };
  if (review.lifecycleStage === "in-review" || review.status === "ready") return { id: "review", label: "Review", action: "Review findings" };
  return { id: "prepare", label: "Prepare", action: "Prepare review" };
}

function isCompleted(review: MemoRecord) {
  return ["approved", "rejected", "superseded", "archived"].includes(review.lifecycleStage ?? "");
}

function needsInformation(review: MemoRecord) {
  return review.lifecycleStage === "needs-information"
    || review.lifecycleStage === "changes-requested"
    || review.status === "needs-info";
}

function needsDecision(review: MemoRecord) {
  return review.lifecycleStage === "ready-for-decision"
    || review.status === "ready";
}

function priorityRank(priority: MemoRecord["priority"]) {
  return { low: 0, normal: 1, high: 2, urgent: 3 }[priority ?? "normal"];
}

function labelize(value: string) {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function filtersFromSavedView(view: SavedReviewView): WorkFilters {
  const query = new URLSearchParams(view.query);
  return {
    lifecycleStage: query.get("lifecycleStage") as WorkFilters["lifecycleStage"] ?? "",
    priority: query.get("priority") as WorkFilters["priority"] ?? "",
    due: query.get("due") as WorkFilters["due"] ?? "",
    assignee: query.get("assignee") ?? "",
    tags: query.get("tags") ?? "",
    sort: query.get("sort") as WorkFilters["sort"] ?? "priority"
  };
}
