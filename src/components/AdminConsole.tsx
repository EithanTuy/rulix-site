import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Database,
  ExternalLink,
  FileText,
  LockKeyhole,
  ShieldCheck,
  UsersRound
} from "lucide-react";
import type {
  AppView,
  AuditEvent,
  CorpusSnapshot,
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
  reviewResults: Record<string, ReviewResult>;
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
  return (
    <section className="console-section">
      <div className="console-section-title">
        <BookOpen size={20} />
        <h2>{corpus.label}</h2>
        <span>{corpus.documents.length} sources | {corpus.chunks.length} chunks</span>
      </div>
      <div className="corpus-grid">
        {corpus.documents.map((doc) => (
          <a className="corpus-source" href={doc.url} target="_blank" rel="noreferrer" key={doc.id}>
            <strong>{doc.title}</strong>
            <span>{doc.authority} | Snapshot {doc.snapshotDate}</span>
            <ExternalLink size={15} />
          </a>
        ))}
      </div>
      <div className="chunk-table">
        {corpus.chunks.map((chunk) => (
          <div className="chunk-row" key={chunk.id}>
            <FileText size={17} />
            <strong>{chunk.locator}</strong>
            <span>{chunk.tags.join(", ")}</span>
            <small>{chunk.text}</small>
          </div>
        ))}
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
  reviewResults: Record<string, ReviewResult>;
  counts: Record<"strong" | "weak" | "missing" | "conflict", number>;
  onSelectMemo: (memoId: string) => void;
}) {
  const rows = memos.flatMap((memo) =>
    (reviewResults[memo.id]?.findings ?? []).map((finding) => ({ memo, finding }))
  );

  return (
    <section className="console-section">
      <div className="evidence-summary">
        <Kpi label="Strong" value={counts.strong} tone="green" />
        <Kpi label="Weak" value={counts.weak} tone="amber" />
        <Kpi label="Missing" value={counts.missing} tone="amber" />
        <Kpi label="Conflict" value={counts.conflict} tone={counts.conflict ? "amber" : "green"} />
      </div>
      <div className="evidence-table">
        {rows.slice(0, 18).map(({ memo, finding }) => (
          <button className="evidence-table-row" type="button" onClick={() => onSelectMemo(memo.id)} key={`${memo.id}-${finding.id}`}>
            <span className={`finding-badge ${finding.status}`}>{finding.status[0].toUpperCase()}</span>
            <strong>{finding.title}</strong>
            <span>{memo.title}</span>
            <small>{finding.rationale}</small>
          </button>
        ))}
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
        <strong>Local persistence</strong>
        <p>Browser state persists reviews, decisions, and audit events for prototype evaluation.</p>
      </div>
      <div className="setting-card">
        <ShieldCheck size={22} />
        <strong>Model policy</strong>
        <p>Claude Sonnet council orchestration is represented as a deterministic local engine until Bedrock credentials are wired.</p>
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
  reviewResults: Record<string, ReviewResult>;
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
          const readiness = summarizeReadiness(reviewResults[memo.id]);
          return (
            <button className="readiness-row" type="button" onClick={() => onSelectMemo(memo.id)} key={memo.id}>
              <strong>{memo.title}</strong>
              <span>{memo.status}</span>
              <span>{readiness.label}</span>
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
