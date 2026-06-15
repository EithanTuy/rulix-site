import { useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Database,
  ExternalLink,
  FileText,
  Filter,
  LockKeyhole,
  Search,
  ShieldCheck,
  UsersRound
} from "lucide-react";
import type {
  AppView,
  AuditEvent,
  CorpusSnapshot,
  EvidenceStatus,
  MemoRecord,
  ReviewerDecision,
  ReviewResult
} from "../types";
import { summarizeReadiness } from "../lib/reviewLifecycle";

interface AdminConsoleProps {
  view: AppView;
  memos: MemoRecord[];
  decisions: Record<string, ReviewerDecision>;
  auditEvents: AuditEvent[];
  reviewResults: Record<string, ReviewResult | undefined>;
  corpus: CorpusSnapshot;
  onSelectMemo: (memoId: string) => void;
}

export function AdminConsole({
  view,
  memos,
  decisions,
  auditEvents,
  reviewResults,
  corpus,
  onSelectMemo
}: AdminConsoleProps) {
  const title = viewTitle(view);
  const signed = memos.filter((memo) => memo.status === "signed-off").length;
  const blocked = memos.filter((memo) => memo.status === "conflict" || memo.status === "needs-info").length;
  const evidenceCounts = memos.reduce(
    (acc, memo) => {
      const result = reviewResults[memo.id];
      result?.findings.forEach((finding) => {
        acc[finding.status] += 1;
      });
      return acc;
    },
    { strong: 0, weak: 0, missing: 0, conflict: 0 }
  );

  return (
    <main className="admin-console">
      <header className="console-header">
        <div>
          <h1>{title.heading}</h1>
          <p>{title.description}</p>
        </div>
        <div className="console-kpis">
          <Kpi label="Reviews" value={memos.length} />
          <Kpi label="Blocked" value={blocked} tone={blocked ? "amber" : "green"} />
          <Kpi label="Signed" value={signed} tone="green" />
        </div>
      </header>

      {view === "corpus" && <CorpusPanel corpus={corpus} />}
      {view === "evidence" && (
        <EvidencePanel memos={memos} reviewResults={reviewResults} counts={evidenceCounts} onSelectMemo={onSelectMemo} />
      )}
      {view === "controls" && <ControlsPanel />}
      {view === "users" && <UsersPanel />}
      {view === "settings" && <SettingsPanel />}
      {view !== "corpus" && (
        <AuditPanel memos={memos} auditEvents={auditEvents} decisions={decisions} reviewResults={reviewResults} onSelectMemo={onSelectMemo} />
      )}
    </main>
  );
}

function Kpi({ label, value, tone = "default" }: { label: string; value: number; tone?: "default" | "green" | "amber" }) {
  return (
    <div className={`console-kpi ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CorpusPanel({ corpus }: { corpus: CorpusSnapshot }) {
  const [query, setQuery] = useState("");
  const [authority, setAuthority] = useState<"all" | "EAR" | "ITAR" | "BIS" | "ITA">("all");
  const authorityCounts = useMemo(
    () =>
      corpus.documents.reduce(
        (acc, doc) => {
          acc[doc.authority] += 1;
          return acc;
        },
        { EAR: 0, ITAR: 0, BIS: 0, ITA: 0 }
      ),
    [corpus.documents]
  );
  const chunkCounts = useMemo(
    () =>
      corpus.chunks.reduce(
        (acc, chunk) => {
          const doc = corpus.documents.find((item) => item.id === chunk.documentId);
          if (doc) acc[doc.authority] += 1;
          return acc;
        },
        { EAR: 0, ITAR: 0, BIS: 0, ITA: 0 }
      ),
    [corpus.chunks, corpus.documents]
  );
  const filteredDocuments = corpus.documents.filter((doc) => {
    const matchesAuthority = authority === "all" || doc.authority === authority;
    const matchesQuery = `${doc.title} ${doc.authority}`.toLowerCase().includes(query.toLowerCase());
    return matchesAuthority && matchesQuery;
  });
  const filteredChunks = corpus.chunks.filter((chunk) => {
    const doc = corpus.documents.find((item) => item.id === chunk.documentId);
    const matchesAuthority = authority === "all" || doc?.authority === authority;
    const matchesQuery = `${chunk.title} ${chunk.locator} ${chunk.tags.join(" ")} ${chunk.text}`
      .toLowerCase()
      .includes(query.toLowerCase());
    return matchesAuthority && matchesQuery;
  });

  return (
    <section className="console-section">
      <div className="console-section-title">
        <BookOpen size={20} />
        <h2>{corpus.label}</h2>
        <span>{corpus.documents.length} sources | {corpus.chunks.length} chunks</span>
      </div>

      <div className="corpus-overview">
        {(["EAR", "ITAR", "BIS", "ITA"] as const).map((item) => (
          <button
            className={authority === item ? "corpus-metric selected" : "corpus-metric"}
            type="button"
            onClick={() => setAuthority(authority === item ? "all" : item)}
            key={item}
          >
            <strong>{item}</strong>
            <span>{authorityCounts[item]} sources</span>
            <small>{chunkCounts[item]} cited chunks</small>
          </button>
        ))}
      </div>

      <div className="console-filter-row">
        <label className="search-box compact">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search source, locator, tag..."
          />
        </label>
        <button className={authority === "all" ? "filter-chip active" : "filter-chip"} type="button" onClick={() => setAuthority("all")}>
          All sources
        </button>
      </div>

      <div className="corpus-grid">
        {filteredDocuments.map((doc) => (
          <a className="corpus-source" href={doc.url} target="_blank" rel="noreferrer" key={doc.id}>
            <strong>{doc.title}</strong>
            <span>{doc.authority} | Snapshot {doc.snapshotDate}</span>
            <ExternalLink size={15} />
          </a>
        ))}
        {filteredDocuments.length === 0 && <div className="empty-list">No sources match this filter.</div>}
      </div>
      <div className="chunk-table">
        {filteredChunks.map((chunk) => (
          <div className="chunk-row" key={chunk.id}>
            <FileText size={17} />
            <strong>{chunk.locator}</strong>
            <span>{chunk.tags.slice(0, 4).join(", ")}</span>
            <small>{chunk.text}</small>
          </div>
        ))}
        {filteredChunks.length === 0 && <div className="empty-list">No chunks match this filter.</div>}
      </div>
    </section>
  );
}

function EvidencePanel({
  memos,
  reviewResults,
  counts,
  onSelectMemo
}: {
  memos: MemoRecord[];
  reviewResults: Record<string, ReviewResult | undefined>;
  counts: Record<"strong" | "weak" | "missing" | "conflict", number>;
  onSelectMemo: (memoId: string) => void;
}) {
  const [status, setStatus] = useState<"all" | EvidenceStatus>("all");
  const [query, setQuery] = useState("");
  const rows = memos.flatMap((memo) =>
    (reviewResults[memo.id]?.findings ?? []).map((finding) => ({ memo, finding }))
  );
  const visibleRows = rows.filter(({ memo, finding }) => {
    const matchesStatus = status === "all" || finding.status === status;
    const matchesQuery = `${finding.title} ${finding.rationale} ${memo.title}`
      .toLowerCase()
      .includes(query.toLowerCase());
    return matchesStatus && matchesQuery;
  });
  const attentionCount = counts.weak + counts.missing + counts.conflict;

  return (
    <section className="console-section">
      <div className="evidence-brief">
        <div>
          <strong>{attentionCount} finding{attentionCount === 1 ? "" : "s"} need reviewer attention</strong>
          <span>Filter by status, then open the memo to see the highlighted claim in context.</span>
        </div>
        <div className="evidence-filter-icon">
          <Filter size={19} />
        </div>
      </div>
      <div className="evidence-summary">
        {(["strong", "weak", "missing", "conflict"] as const).map((item) => (
          <button
            className={status === item ? `evidence-status-tile ${item} selected` : `evidence-status-tile ${item}`}
            type="button"
            onClick={() => setStatus(status === item ? "all" : item)}
            key={item}
          >
            <span>{statusLabel(item)}</span>
            <strong>{counts[item]}</strong>
          </button>
        ))}
      </div>
      <div className="console-filter-row">
        <label className="search-box compact">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search finding or memo..."
          />
        </label>
        <button className={status === "all" ? "filter-chip active" : "filter-chip"} type="button" onClick={() => setStatus("all")}>
          All findings
        </button>
      </div>
      <div className="evidence-table">
        {visibleRows.slice(0, 24).map(({ memo, finding }) => (
          <button className="evidence-table-row" type="button" onClick={() => onSelectMemo(memo.id)} key={`${memo.id}-${finding.id}`}>
            <span className={`finding-badge ${finding.status}`}>{finding.status[0].toUpperCase()}</span>
            <span className="evidence-row-main">
              <strong>{finding.title}</strong>
              <span>{memo.title}</span>
            </span>
            <small>{finding.rationale}</small>
          </button>
        ))}
        {visibleRows.length === 0 && <div className="empty-list">No evidence findings match this view.</div>}
      </div>
    </section>
  );
}

function ControlsPanel() {
  const controls = [
    ["Jurisdiction first", "USML/ITAR risk is reviewed before EAR/CCL reliance.", true],
    ["Human signoff gate", "AI recommendation cannot become final without reviewer action.", true],
    ["Citation verifier", "Findings cite only official corpus chunk IDs.", true],
    ["GovCloud migration", "IaC starter is partition-aware; service validation remains deployment work.", false],
    ["Controlled data boundary", "Commercial AWS should stay sample/redacted unless compliance approves.", false]
  ] as const;

  return (
    <section className="console-section control-grid">
      {controls.map(([label, detail, complete]) => (
        <div className="control-card" key={label}>
          {complete ? <CheckCircle2 size={21} /> : <AlertTriangle size={21} />}
          <strong>{label}</strong>
          <p>{detail}</p>
          <span className={complete ? "control-pass" : "control-review"}>{complete ? "Implemented" : "Requires deployment validation"}</span>
        </div>
      ))}
    </section>
  );
}

function statusLabel(status: EvidenceStatus) {
  if (status === "strong") return "Strong";
  if (status === "weak") return "Weak";
  if (status === "missing") return "Missing";
  return "Conflict";
}

function UsersPanel() {
  const roles = [
    ["Export Control Officer", "Can approve, override, and export records"],
    ["Research Compliance Reviewer", "Can request info and prepare evidence maps"],
    ["Principal Investigator", "Can submit memos and answer technical requests"],
    ["Counsel", "Can review escalations and jurisdiction conflicts"]
  ];

  return (
    <section className="console-section users-grid">
      {roles.map(([role, permissions]) => (
        <div className="user-role-card" key={role}>
          <UsersRound size={22} />
          <strong>{role}</strong>
          <p>{permissions}</p>
        </div>
      ))}
    </section>
  );
}

function SettingsPanel() {
  return (
    <section className="console-section settings-grid">
      <div className="setting-card">
        <LockKeyhole size={22} />
        <strong>Single-tenant data boundary</strong>
        <p>S3, KMS, audit, and corpus resources are modeled per tenant in the Terraform starter.</p>
      </div>
      <div className="setting-card">
        <Database size={22} />
        <strong>Account-linked storage</strong>
        <p>Reviews, decisions, chat edits, and audit records are saved under the signed-in account.</p>
      </div>
      <div className="setting-card">
        <ShieldCheck size={22} />
        <strong>Model policy</strong>
        <p>Live analysis is optional; deterministic review remains clearly labeled and never replaces human signoff.</p>
      </div>
    </section>
  );
}

function AuditPanel({
  memos,
  auditEvents,
  decisions,
  reviewResults,
  onSelectMemo
}: {
  memos: MemoRecord[];
  auditEvents: AuditEvent[];
  decisions: Record<string, ReviewerDecision>;
  reviewResults: Record<string, ReviewResult | undefined>;
  onSelectMemo: (memoId: string) => void;
}) {
  return (
    <section className="console-section">
      <div className="console-section-title">
        <ShieldCheck size={20} />
        <h2>Review Readiness and Audit</h2>
      </div>
      <div className="readiness-list">
        {memos.map((memo) => {
          const result = reviewResults[memo.id];
          const readiness = result ? summarizeReadiness(result) : undefined;
          return (
            <button className="readiness-row" type="button" onClick={() => onSelectMemo(memo.id)} key={memo.id}>
              <strong>{memo.title}</strong>
              <span>{memo.status}</span>
              <span>{readiness?.label ?? "Unanalyzed"}</span>
              <small>{decisions[memo.id]?.action ?? "No reviewer decision"}</small>
            </button>
          );
        })}
      </div>
      <div className="audit-table">
        {auditEvents.slice(0, 16).map((event) => (
          <div className="audit-row" key={event.id}>
            <span className={`status-dot ${event.severity === "info" ? "green" : "amber"}`} />
            <strong>{event.action}</strong>
            <span>{event.actor}</span>
            <span>{formatDateTime(event.at)}</span>
            <p>{event.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function viewTitle(view: AppView) {
  const titles = {
    reviews: ["Reviews", "AI-assisted memo review workspace."],
    controls: ["Controls", "Safety gates and compliance controls for AI classification review."],
    evidence: ["Evidence", "Cross-memo finding queue and evidence quality map."],
    corpus: ["Corpus", "Official source snapshots and retrieved source chunks."],
    users: ["Users", "Role model for research-facility review workflows."],
    settings: ["Settings", "Tenant deployment, persistence, and model policy settings."]
  } satisfies Record<AppView, [string, string]>;

  return {
    heading: titles[view][0],
    description: titles[view][1]
  };
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}
