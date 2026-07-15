import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Save } from "lucide-react";
import {
  getOutreachPage,
  updateLeadWorkflow,
  type OutreachLeadRow
} from "../lib/apiClient";
import type { LeadWorkflow, OutreachDraft, OutreachLead } from "../types";
import { SafeExternalLink } from "./SafeExternalLink";

export function LeadReviewQueue() {
  const [leads, setLeads] = useState<OutreachLead[]>([]);
  const [drafts, setDrafts] = useState<Record<string, OutreachDraft>>({});
  const [workflows, setWorkflows] = useState<Record<string, LeadWorkflow>>({});
  const [filter, setFilter] = useState<LeadWorkflow["reviewStatus"] | "all">("pending-review");
  const [busyId, setBusyId] = useState("");
  const [leadCursor, setLeadCursor] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const page = await getOutreachPage<OutreachLeadRow>("lead-rows", { limit: 25 });
      setLeads(page.items.map((row) => row.lead));
      setDrafts(Object.fromEntries(page.items.flatMap((row) => row.draft ? [[row.lead.leadId, row.draft]] : [])));
      setWorkflows(Object.fromEntries(page.items.flatMap((row) => row.workflow ? [[row.lead.leadId, row.workflow]] : [])));
      setLeadCursor(page.nextCursor);
    } catch (loadError) {
      setError(message(loadError, "Could not load the review queue."));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loadMore = async () => {
    if (!leadCursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const page = await getOutreachPage<OutreachLeadRow>("lead-rows", { limit: 25, cursor: leadCursor });
      setLeads((current) => mergeLeads(current, page.items.map((row) => row.lead)));
      setDrafts((current) => ({
        ...current,
        ...Object.fromEntries(page.items.flatMap((row) => row.draft ? [[row.lead.leadId, row.draft]] : []))
      }));
      setWorkflows((current) => ({
        ...current,
        ...Object.fromEntries(page.items.flatMap((row) => row.workflow ? [[row.lead.leadId, row.workflow]] : []))
      }));
      setLeadCursor(page.nextCursor);
    } catch (loadError) {
      setError(message(loadError, "Could not load more review rows."));
    } finally {
      setLoadingMore(false);
    }
  };

  const rows = useMemo(() => leads
    .map((lead) => ({ lead, draft: drafts[lead.leadId], workflow: workflowFor(lead.leadId, workflows[lead.leadId], drafts[lead.leadId]) }))
    .filter(({ workflow }) => filter === "all" || workflow.reviewStatus === filter), [leads, drafts, workflows, filter]);

  const save = async (workflow: LeadWorkflow) => {
    setBusyId(workflow.leadId);
    try {
      const result = await updateLeadWorkflow(workflow.leadId, {
        reviewStatus: workflow.reviewStatus,
        lifecycleStatus: workflow.lifecycleStatus,
        assignedOwner: workflow.assignedOwner,
        notes: workflow.notes,
        lastContactedAt: workflow.lastContactedAt,
        followUpAt: workflow.followUpAt,
        replyStatus: workflow.replyStatus
      });
      setWorkflows((current) => ({ ...current, [workflow.leadId]: result.workflow }));
    } catch (saveError) {
      setError(message(saveError, "Could not save lead workflow."));
    } finally {
      setBusyId("");
    }
  };

  const patch = (leadId: string, next: Partial<LeadWorkflow>) => {
    setWorkflows((current) => ({
      ...current,
      [leadId]: { ...workflowFor(leadId, current[leadId], drafts[leadId]), ...next, updatedAt: new Date().toISOString() }
    }));
  };

  return (
    <section className="review-queue">
      <div className="review-queue-head">
        <div>
          <span className="dash-eyebrow">Human approval gate</span>
          <h2>Lead review queue</h2>
          <p>Approve, reject, assign, schedule follow-up, and track the loaded outreach lifecycle.</p>
        </div>
        <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
          <option value="all">All review states</option>
          {REVIEW_STATUSES.map((status) => <option value={status} key={status}>{label(status)}</option>)}
        </select>
      </div>
      {error && <div className="dash-error">{error}</div>}
      <div className="review-cards">
        {rows.map(({ lead, draft, workflow }) => (
          <article className="review-card" key={lead.leadId}>
            <div className="review-card-title">
              <div><strong>{lead.organization}</strong><span>{lead.email}</span></div>
              <span className={`review-badge ${workflow.reviewStatus}`}>{label(workflow.reviewStatus)}</span>
            </div>
            <div className="review-source">
              <span>{draft?.personalizationStatus ?? (draft ? "generic draft" : "no draft")}</span>
              {draft?.personalizationSourceUrl && <SafeExternalLink href={draft.personalizationSourceUrl}>Evidence <ExternalLink size={12} /></SafeExternalLink>}
            </div>
            <div className="review-fields">
              <label>Review
                <select value={workflow.reviewStatus} onChange={(event) => patch(lead.leadId, { reviewStatus: event.target.value as LeadWorkflow["reviewStatus"] })}>
                  {REVIEW_STATUSES.map((status) => <option value={status} key={status}>{label(status)}</option>)}
                </select>
              </label>
              <label>Lifecycle
                <select value={workflow.lifecycleStatus} onChange={(event) => patch(lead.leadId, { lifecycleStatus: event.target.value as LeadWorkflow["lifecycleStatus"] })}>
                  {LIFECYCLE_STATUSES.map((status) => <option value={status} key={status}>{label(status)}</option>)}
                </select>
              </label>
              <label>Owner<input value={workflow.assignedOwner ?? ""} onChange={(event) => patch(lead.leadId, { assignedOwner: event.target.value })} /></label>
              <label>Follow-up<input type="datetime-local" value={toLocalInput(workflow.followUpAt)} onChange={(event) => patch(lead.leadId, { followUpAt: event.target.value ? new Date(event.target.value).toISOString() : undefined })} /></label>
              <label>Reply status<input value={workflow.replyStatus ?? ""} onChange={(event) => patch(lead.leadId, { replyStatus: event.target.value })} /></label>
            </div>
            <label className="review-notes">Notes<textarea rows={3} value={workflow.notes ?? ""} onChange={(event) => patch(lead.leadId, { notes: event.target.value })} /></label>
            <button className="dash-primary" type="button" onClick={() => void save(workflow)} disabled={busyId === lead.leadId}>
              <Save size={14} /> {busyId === lead.leadId ? "Saving..." : "Save workflow"}
            </button>
          </article>
        ))}
        {!rows.length && <div className="dash-empty">No leads match this review state.</div>}
      </div>
      {leadCursor && (
        <button className="dash-secondary" type="button" onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? "Loading more reviews..." : "Load 25 more leads"}
        </button>
      )}
    </section>
  );
}

const REVIEW_STATUSES: LeadWorkflow["reviewStatus"][] = ["new", "pending-review", "approved", "rejected", "needs-research", "ready-to-send"];
const LIFECYCLE_STATUSES: LeadWorkflow["lifecycleStatus"][] = ["not-contacted", "drafted", "personalized", "approved", "sent", "replied", "follow-up-due", "closed", "opted-out"];

function workflowFor(leadId: string, existing: LeadWorkflow | undefined, draft: OutreachDraft | undefined): LeadWorkflow {
  return existing ?? {
    leadId,
    reviewStatus: draft ? "pending-review" : "new",
    lifecycleStatus: draft?.sentAt ? "sent" : draft?.personalizationStatus === "personalized" ? "personalized" : draft ? "drafted" : "not-contacted",
    updatedAt: new Date().toISOString()
  };
}
function mergeLeads(current: OutreachLead[], incoming: OutreachLead[]) {
  return [...new Map([...current, ...incoming].map((lead) => [lead.leadId, lead])).values()];
}
function label(value: string) { return value.replaceAll("-", " ").replace(/\b\w/g, (character) => character.toUpperCase()); }
function toLocalInput(value?: string) { return value ? new Date(value).toISOString().slice(0, 16) : ""; }
function message(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  try { return (JSON.parse(error.message) as { error?: string }).error ?? error.message; } catch { return error.message || fallback; }
}
