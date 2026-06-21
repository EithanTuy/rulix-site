import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, RefreshCw, Search, Sparkles } from "lucide-react";
import { createOutreachJob, getOutreachWorkspace } from "../lib/apiClient";
import type { LeadSearchActivity, LeadSearchRun, OutreachJob, OutreachLead } from "../types";

const SEARCH_BUDGETS = [15, 30, 45] as const;

export function LeadsPanel() {
  const [leads, setLeads] = useState<OutreachLead[]>([]);
  const [runs, setRuns] = useState<LeadSearchRun[]>([]);
  const [model, setModel] = useState("global.anthropic.claude-sonnet-4-6");
  const [query, setQuery] = useState("");
  const [durationSeconds, setDurationSeconds] = useState<(typeof SEARCH_BUDGETS)[number]>(30);
  const [activity, setActivity] = useState<LeadSearchActivity[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeJob, setActiveJob] = useState<OutreachJob | undefined>();
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const workspace = await getOutreachWorkspace();
      setLeads(workspace.leads);
      setRuns(workspace.leadSearchRuns ?? []);
      setModel(workspace.bedrock.leadSearchModel);
      const job = workspace.outreachJobs?.find((candidate) =>
        candidate.type === "lead-search" && ["queued", "running"].includes(candidate.status)
      );
      setActiveJob(job);
      setSearching(Boolean(job));
      if (job) setActivity(job.logs.map((log) => ({ at: log.at, message: log.message })));
    } catch (loadError) {
      setError(message(loadError, "Could not load the lead pipeline."));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  const visibleLeads = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return leads;
    return leads.filter((lead) =>
      [
        lead.leadId,
        lead.organization,
        lead.organizationType,
        lead.segment,
        lead.website,
        lead.domain,
        lead.city,
        lead.state,
        lead.source,
        lead.email,
        lead.status,
        lead.outreachAngle,
        lead.notes
      ].join(" ").toLowerCase().includes(normalized)
    );
  }, [leads, query]);

  const runSearch = async () => {
    setSearching(true);
    setError("");
    const startedAt = new Date().toISOString();
    setActivity([
      { at: startedAt, message: `Opening a ${durationSeconds}-second lead-research budget.` },
      { at: startedAt, message: `Sending the existing ${leads.length}-lead exclusion list to Claude Sonnet 4.6.` },
      { at: startedAt, message: "Looking for source-backed public compliance contacts." }
    ]);
    try {
      const result = await createOutreachJob({
        type: "lead-search",
        maxCostUsd: 1,
        maxRetries: 2,
        searchDurationSeconds: durationSeconds
      });
      setActiveJob(result.job);
      setActivity(result.job.logs.map((log) => ({ at: log.at, message: log.message })));
    } catch (searchError) {
      setError(message(searchError, "Lead search failed."));
      setActivity((current) => [
        ...current,
        { at: new Date().toISOString(), message: "Search stopped before new leads were added." }
      ]);
    } finally {}
  };

  const latestRun = runs[0];

  return (
    <section className="leads-workspace">
      <div className="lead-search-card">
        <div>
          <span className="dash-eyebrow">AI lead discovery</span>
          <h2>Search for qualified leads</h2>
          <p>
            Claude Sonnet 4.6 reviews the existing pipeline, finds net-new candidates, and records
            public source URLs. AI candidates are marked for human verification.
          </p>
        </div>
        <div className="lead-search-controls">
          <label>
            Research time budget
            <select
              value={durationSeconds}
              onChange={(event) => setDurationSeconds(Number(event.target.value) as typeof durationSeconds)}
              disabled={searching}
            >
              {SEARCH_BUDGETS.map((seconds) => (
                <option value={seconds} key={seconds}>{seconds} seconds</option>
              ))}
            </select>
          </label>
          <button type="button" className="dash-primary" onClick={() => void runSearch()} disabled={searching}>
            <Sparkles size={16} />
            {searching ? "Researching..." : "Start lead search"}
          </button>
        </div>
        <div className="lead-search-meta">
          <span><strong>Model</strong>{friendlyModel(model)}</span>
          <span><strong>Pipeline</strong>{leads.length} leads</span>
          <span><strong>Last run</strong>{latestRun ? formatDateTime(latestRun.completedAt) : "Not run yet"}</span>
          {activeJob && <span><strong>Background job</strong>{activeJob.status} · ${activeJob.estimatedCostUsd.toFixed(3)} est.</span>}
        </div>
        {(searching || activity.length > 0) && (
          <div className="lead-search-activity" aria-live="polite">
            <div className="lead-search-activity-head">
              <span className={searching ? "dash-status-dot pulse" : "dash-status-dot"} />
              <strong>{searching ? "Search in progress" : "Latest search activity"}</strong>
            </div>
            {activity.map((item, index) => (
              <div className="lead-search-log" key={`${item.at}-${index}`}>
                <time>{formatTime(item.at)}</time>
                <span>{item.message}</span>
              </div>
            ))}
          </div>
        )}
        {error && <div className="dash-error">{error}</div>}
      </div>

      <div className="leads-table-panel">
        <div className="leads-table-toolbar">
          <div>
            <h2>Lead Master</h2>
            <p>{visibleLeads.length} of {leads.length} outreach-ready and AI-discovered leads</p>
          </div>
          <label className="leads-search">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the lead sheet..." />
          </label>
          <button type="button" className="dash-secondary" onClick={() => void load()}>
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
        <div className="leads-table-scroll">
          <div className="leads-table">
            <LeadRow header lead={undefined} />
            {visibleLeads.map((lead) => <LeadRow lead={lead} key={lead.leadId} />)}
          </div>
        </div>
      </div>
    </section>
  );
}

function LeadRow({ lead, header = false }: { lead: OutreachLead | undefined; header?: boolean }) {
  if (header) {
    return (
      <div className="leads-row leads-header">
        {[
          "lead_id", "organization", "organization_type", "segment", "website", "domain", "city",
          "state", "source", "source_url", "fit_score", "priority", "primary_contact_email",
          "status", "outreach_angle", "owner", "notes"
        ].map((label) => <span key={label}>{label}</span>)}
      </div>
    );
  }
  if (!lead) return null;
  return (
    <div className="leads-row">
      <span>{lead.leadId}</span>
      <span className="lead-organization">{lead.organization}</span>
      <span>{lead.organizationType}</span>
      <span>{lead.segment}</span>
      <span>{lead.website ? <a href={lead.website} target="_blank" rel="noreferrer">Website <ExternalLink size={12} /></a> : ""}</span>
      <span>{lead.domain}</span>
      <span>{lead.city}</span>
      <span>{lead.state}</span>
      <span>{lead.source}</span>
      <span>{lead.sourceUrl ? <a href={lead.sourceUrl} target="_blank" rel="noreferrer">Source <ExternalLink size={12} /></a> : ""}</span>
      <span>{lead.fitScore}</span>
      <span>{lead.priority}</span>
      <span className="lead-email">{lead.email}</span>
      <span><small className={lead.discoveredAt ? "lead-status ai" : "lead-status"}>{lead.status}</small></span>
      <span>{lead.outreachAngle}</span>
      <span>{lead.owner}</span>
      <span>{lead.notes}</span>
    </div>
  );
}

function friendlyModel(model: string) {
  if (model.includes("sonnet-4-6")) return "Claude Sonnet 4.6";
  return model;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    .format(new Date(value));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", second: "2-digit" })
    .format(new Date(value));
}

function message(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  try {
    const parsed = JSON.parse(error.message) as { error?: string };
    return parsed.error ?? error.message;
  } catch {
    return error.message || fallback;
  }
}
