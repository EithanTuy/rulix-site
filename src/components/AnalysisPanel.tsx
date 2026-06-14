import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Cloud,
  Cpu,
  ExternalLink,
  FileText,
  ShieldCheck,
  UserRound,
  WifiOff,
  X
} from "lucide-react";
import { getSourceChunk } from "../data/corpus";
import type { AuditEvent, MemoRecord, ReviewerDecision, ReviewResult } from "../types";

interface AnalysisPanelProps {
  memo: MemoRecord;
  result: ReviewResult;
  decision?: ReviewerDecision;
  auditEvents: AuditEvent[];
  onDecision: (action: ReviewerDecision["action"], notes: string) => void;
}

export function AnalysisPanel({
  memo,
  result,
  decision,
  auditEvents,
  onDecision
}: AnalysisPanelProps) {
  const [notes, setNotes] = useState(decision?.notes ?? "");
  useEffect(() => setNotes(decision?.notes ?? ""), [decision?.notes, memo.id]);
  const citations = [
    ...new Set([
      ...result.jurisdiction.sourceChunkIds,
      ...result.recommended.sourceChunkIds,
      ...result.findings.flatMap((finding) => finding.sourceChunkIds)
    ])
  ]
    .map((id) => getSourceChunk(id))
    .filter(Boolean);

  return (
    <aside className="analysis-panel">
      <div className="analysis-title">
        <div>
          <h2>AI Council Analysis</h2>
          <span>{result.agents.length} Agents</span>
        </div>
        <button type="button" className="icon-button" aria-label="Collapse analysis" title="Collapse">
          <ChevronRight size={18} />
        </button>
      </div>

      <section className={`provider-box ${result.provider.source}`}>
        {result.provider.live ? (
          <Cloud size={19} />
        ) : result.provider.source === "fallback" ? (
          <WifiOff size={19} />
        ) : (
          <Cpu size={19} />
        )}
        <div>
          <strong>{result.provider.label}</strong>
          <span>
            {result.provider.model}
            {result.provider.latencyMs ? ` | ${result.provider.latencyMs} ms` : ""}
          </span>
        </div>
        <p>{result.provider.message}</p>
      </section>

      <section className="jurisdiction-box">
        <div className="box-heading">
          <ShieldCheck size={21} />
          <strong>Jurisdiction Gate</strong>
          <span className={`gate-status ${result.jurisdiction.outcome}`}>
            {result.jurisdiction.outcome === "ear-likely" ? "Pass" : "Review"}
          </span>
        </div>
        <p>{result.jurisdiction.summary}</p>
        <p>
          <strong>Reason:</strong> {result.jurisdiction.rationale}
        </p>
      </section>

      <section className="recommendation">
        <h3>Recommended: {result.recommended.eccn}</h3>
        <p>{result.recommended.label}</p>
        <a href={firstSourceUrl(result)} target="_blank" rel="noreferrer">
          View ECCN Guidance <ExternalLink size={15} />
        </a>
      </section>

      <div className="score-grid">
        <Metric label="Confidence" value={result.recommended.confidence} />
        <Metric label="Risk" value={riskValue(result.recommended.risk)} risk={result.recommended.risk} />
      </div>

      <section className="analysis-section">
        <h3>Evidence Map</h3>
        <div className="finding-list">
          {result.findings.map((finding, index) => (
            <button className="finding-row" type="button" key={finding.id}>
              <span className={`finding-badge ${finding.status}`}>{index + 1}</span>
              <span>{finding.title}</span>
              <strong className={finding.status}>{finding.status}</strong>
              <ChevronRight size={17} />
            </button>
          ))}
        </div>
      </section>

      <section className="analysis-section">
        <h3>Source Citations</h3>
        <div className="citation-list">
          {citations.slice(0, 6).map((chunk) => (
            <a href={chunk!.url} target="_blank" rel="noreferrer" key={chunk!.id}>
              <FileText size={18} />
              <span>
                <strong>{chunk!.locator}</strong>
                <small>{chunk!.title}</small>
              </span>
              <small>Official Corpus v2026.06</small>
              <ExternalLink size={14} />
            </a>
          ))}
        </div>
      </section>

      <section className="analysis-section agent-section">
        <h3>Council Runs</h3>
        {result.agents.map((agent) => (
          <div className="agent-row" key={agent.role}>
            <span className={agent.status === "complete" ? "status-dot green" : "status-dot amber"} />
            <strong>{agent.label}</strong>
            <span>{agent.summary}</span>
          </div>
        ))}
      </section>

      <section className="analysis-section">
        <h3>Audit Trail</h3>
        <div className="audit-mini-list">
          {auditEvents.slice(0, 4).map((event) => (
            <div className="audit-mini-row" key={event.id}>
              <span className={`status-dot ${event.severity === "info" ? "green" : "amber"}`} />
              <strong>{event.action}</strong>
              <span>{formatAuditTime(event.at)}</span>
            </div>
          ))}
          {auditEvents.length === 0 && <p className="empty-note">No audit events recorded yet.</p>}
        </div>
      </section>

      <section className="decision-box">
        <div className="decision-title">
          <span>Reviewer Decision</span>
          <strong>
            <UserRound size={17} />
            Human Signoff Required
          </strong>
        </div>
        <div className="decision-actions">
          <button
            type="button"
            className="decision-button accept"
            onClick={() => onDecision("accept", notes || "Accepted with human review.")}
          >
            <Check size={16} /> Accept Recommendation
          </button>
          <button
            type="button"
            className="decision-button info"
            onClick={() => onDecision("request-info", notes || "Request additional technical evidence.")}
          >
            <AlertTriangle size={16} /> Request More Info
          </button>
          <button
            type="button"
            className="decision-button override"
            onClick={() => onDecision("override", notes || "Reviewer override required.")}
          >
            <X size={16} /> Override / Change ECCN
          </button>
        </div>
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Add decision notes (required for signoff)..."
          rows={4}
        />
        <button
          type="button"
          className="button signoff full"
          disabled={!decision && !notes.trim()}
          onClick={() => onDecision("accept", notes || `Accepted recommendation for ${memo.documentCode}.`)}
        >
          <UserRound size={17} /> Submit for Human Signoff
        </button>
        {decision && <p className="decision-state">Current action: {decision.action}</p>}
      </section>
    </aside>
  );
}

function formatAuditTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function Metric({ label, value, risk }: { label: string; value: number; risk?: string }) {
  const labelValue = risk ? titleCase(risk) : value > 0.84 ? "High" : value > 0.55 ? "Medium" : "Low";
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{labelValue}</strong>
      <div className="dots" aria-hidden="true">
        {Array.from({ length: 5 }).map((_, index) => (
          <span className={index < Math.round(value * 5) ? "filled" : ""} key={index} />
        ))}
      </div>
    </div>
  );
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function riskValue(risk: "low" | "medium" | "high") {
  if (risk === "high") return 0.86;
  if (risk === "medium") return 0.58;
  return 0.28;
}

function firstSourceUrl(result: ReviewResult) {
  const first = getSourceChunk(result.recommended.sourceChunkIds[0]);
  return first?.url ?? "https://www.bis.gov/licensing/classify-your-item";
}
