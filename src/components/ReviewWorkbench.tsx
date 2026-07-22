import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Archive,
  ArrowLeft,
  Check,
  CheckCircle2,
  ClipboardCopy,
  Clock3,
  Download,
  FileDiff,
  FileText,
  History,
  Link2,
  MessageSquare,
  MoreHorizontal,
  PanelRightOpen,
  Paperclip,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  XCircle
} from "lucide-react";
import type { CouncilApprovalView } from "../lib/apiClient";
import { createReviewComment, listReviewComments, resolveReviewComment } from "../lib/apiClient";
import type {
  AuditEvent,
  CaseComment,
  MemoRecord,
  ReviewResult,
  ReviewerDecision,
  UserProfile
} from "../types";
import type { ReviewSection } from "../lib/appRoutes";
import { ContextMenu, type ContextMenuAction } from "./ui/ContextMenu";

interface ReviewWorkbenchProps {
  memo: MemoRecord;
  result?: ReviewResult;
  decision?: ReviewerDecision;
  auditEvents: AuditEvent[];
  user: UserProfile;
  members: Array<Pick<UserProfile, "id" | "name" | "email" | "role">>;
  section: ReviewSection;
  analysisStatus: "unanalyzed" | "running" | "live" | "failed";
  analysisMessage: string;
  councilApproval?: CouncilApprovalView;
  approvalBusy: boolean;
  memoEditor: ReactNode;
  reviewTools: ReactNode;
  onSectionChange: (section: ReviewSection) => void;
  onBack: () => void;
  onRunAnalysis: () => void;
  onCancelAnalysis?: () => void;
  onExport: () => void;
  onOpenMemoBuilder: () => void;
  onDuplicate: () => Promise<void>;
  onArchive: () => Promise<void>;
  onUpdateMetadata: (patch: Partial<Pick<MemoRecord, "priority" | "tags" | "lifecycleStage">> & { assignedTo?: string | null; dueAt?: string | null }) => Promise<void>;
  onDecision: (action: ReviewerDecision["action"], notes: string) => Promise<void>;
}

const steps = ["Intake", "Evidence", "AI approval", "Resolve findings", "Human decision", "Export"] as const;

export function ReviewWorkbench({
  memo,
  result,
  decision,
  auditEvents,
  user,
  members,
  section,
  analysisStatus,
  analysisMessage,
  councilApproval,
  approvalBusy,
  memoEditor,
  reviewTools,
  onSectionChange,
  onBack,
  onRunAnalysis,
  onCancelAnalysis,
  onExport,
  onOpenMemoBuilder,
  onDuplicate,
  onArchive,
  onUpdateMetadata,
  onDecision
}: ReviewWorkbenchProps) {
  const [selectedFindingId, setSelectedFindingId] = useState(result?.findings[0]?.id);
  const [context, setContext] = useState<{ x: number; y: number }>();
  const [notes, setNotes] = useState("");
  const [comments, setComments] = useState<CaseComment[]>([]);
  const [commentText, setCommentText] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(section === "conversation");
  const stale = Boolean(result && result.memoRevision !== undefined && result.memoRevision !== memo.revision);
  const progress = progressIndex(memo, result, decision);
  const selectedFinding = result?.findings.find((finding) => finding.id === selectedFindingId) ?? result?.findings[0];

  useEffect(() => {
    const controller = new AbortController();
    void listReviewComments(memo.id, { limit: 50 }, controller.signal)
      .then((page) => setComments(page.items))
      .catch(() => undefined);
    return () => controller.abort();
  }, [memo.id]);

  const actions = useMemo<ContextMenuAction[]>(() => [
    { id: "split", label: "Open in split view", icon: PanelRightOpen, shortcut: "⌘ ↵", onSelect: () => setToolsOpen(true) },
    { id: "compare", label: "Compare with approved version", icon: FileDiff, onSelect: () => onSectionChange("memo") },
    { id: "link", label: "Copy secure link", icon: Link2, shortcut: "⌘ L", onSelect: () => void navigator.clipboard.writeText(window.location.href) },
    { id: "attach", label: "Attach to review", icon: Paperclip, onSelect: onOpenMemoBuilder },
    { id: "duplicate", label: "Duplicate as draft", icon: ClipboardCopy, onSelect: () => void onDuplicate() },
    { id: "download", label: "Download memo", icon: Download, onSelect: () => downloadText(memo) },
    { id: "history", label: "View audit history", icon: History, onSelect: () => onSectionChange("activity") },
    { id: "archive", label: "Archive review…", icon: Archive, tone: "danger", separatorBefore: true, disabled: user.role === "submitter", onSelect: () => void onArchive() }
  ], [memo, onArchive, onDuplicate, onOpenMemoBuilder, onSectionChange, user.role]);

  const submitComment = async (kind: "comment" | "request-information") => {
    const body = commentText.trim();
    if (!body) return;
    setCommentBusy(true);
    try {
      const mentions = members.filter((member) => body.includes(`@${member.name}`)).map((member) => member.id);
      const created = await createReviewComment(memo.id, body, mentions, kind);
      setComments((current) => [created, ...current]);
      setCommentText("");
    } finally {
      setCommentBusy(false);
    }
  };

  return (
    <main className="px-workbench" id="main-content">
      <header className="px-review-context">
        <button type="button" className="px-icon-button" onClick={onBack} aria-label="Back to Review Queue"><ArrowLeft size={19} /></button>
        <div className="px-review-identity"><FileText size={22} /><span><h1>{memo.title}</h1><small>{memo.documentCode}</small></span></div>
        <label><span>Assignee</span><select value={memo.assignedTo ?? ""} disabled={user.role === "submitter"} onChange={(event) => void onUpdateMetadata({ assignedTo: event.target.value || null })}><option value="">Unassigned</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
        <label><span>Due date</span><input type="date" value={memo.dueAt?.slice(0, 10) ?? ""} disabled={user.role === "submitter"} onChange={(event) => void onUpdateMetadata({ dueAt: event.target.value ? `${event.target.value}T17:00:00.000Z` : null })} /></label>
        <label><span>Priority</span><select value={memo.priority ?? "normal"} disabled={user.role === "submitter"} onChange={(event) => void onUpdateMetadata({ priority: event.target.value as MemoRecord["priority"] })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
        <button type="button" className="button" onClick={() => document.querySelector<HTMLTextAreaElement>(".px-comment-composer textarea")?.focus()}><MessageSquare size={16} />Request information</button>
        <button type="button" className="px-icon-button" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setContext({ x: rect.right, y: rect.bottom + 4 }); }} aria-label="Review actions"><MoreHorizontal size={19} /></button>
      </header>

      <nav className="px-review-progress" aria-label="Review progress">
        {steps.map((step, index) => <button type="button" key={step} className={index < progress ? "complete" : index === progress ? "current" : "future"} onClick={() => index <= 1 ? onSectionChange("memo") : index === 5 ? onExport() : onSectionChange("analysis")}><span>{index < progress ? <Check size={14} /> : index + 1}</span>{step}</button>)}
      </nav>

      <div className={`px-approval-banner${stale ? " warning" : ""}`}>
        {stale ? <RefreshCw size={17} /> : <ShieldCheck size={17} />}
        <span><strong>{stale ? "AI result is stale because the review changed." : "Approval scope"}</strong>{stale ? "Re-approve the exact current content before using AI findings." : "A human reviewer records the final determination for the exact content shown."}</span>
        <button type="button" className="px-text-button" onClick={() => onSectionChange("activity")}>View audit trail</button>
      </div>

      <nav className="px-workbench-tabs" aria-label="Review sections">
        {(["overview", "memo", "analysis", "conversation", "activity"] as ReviewSection[]).map((item) => <button type="button" key={item} className={section === item ? "active" : ""} onClick={() => onSectionChange(item)}>{labelize(item)}</button>)}
      </nav>

      {section === "memo" ? <section className="px-embedded-workspace">{memoEditor}</section> : null}
      {section === "conversation" ? <section className="px-embedded-tools">{reviewTools}</section> : null}
      {section === "activity" ? (
        <section className="px-activity-page"><div className="px-section-head"><div><h2>Activity and audit trail</h2><p>Edits, assignments, approvals, comments, decisions, and exports in authoritative order.</p></div></div>{combinedActivity(auditEvents, comments).map((item) => <article key={item.id}><span className={`px-activity-icon ${item.severity}`}>{item.icon}</span><div><strong>{item.title}</strong><p>{item.detail}</p><small>{new Date(item.at).toLocaleString()} · {item.actor}</small></div></article>)}</section>
      ) : null}
      {(section === "overview" || section === "analysis") ? (
        <div className="px-workbench-grid">
          <aside className="px-case-overview">
            <h2>Case overview</h2>
            <dl><div><dt>Classification</dt><dd>{result?.recommended.eccn ?? "Pending analysis"}</dd></div><div><dt>Requester</dt><dd>{memo.owner}</dd></div><div><dt>Item description</dt><dd>{memo.itemFamily}</dd></div><div><dt>Review ID</dt><dd>{memo.id}</dd></div><div><dt>Created</dt><dd>{new Date(memo.createdAt ?? memo.updatedAt).toLocaleString()}</dd></div></dl>
            <div className="px-provenance"><h3>Source provenance</h3><span><FileText size={16} /><span><strong>{memo.attachments?.[0] ?? "Pasted memo"}</strong><small>{dataClassLabel(memo.dataClass)}</small></span></span><small>SHA-256: {memo.contentHash?.slice(0, 12)}… <button type="button" onClick={() => void navigator.clipboard.writeText(memo.contentHash ?? "")}>Copy</button></small></div>
            <div className="px-review-record"><h3>Review record</h3><span className={result ? "approved" : "pending"}><ShieldCheck size={17} /><span><strong>{result ? "AI run completed" : "AI approval pending"}</strong><small>{result ? `${result.provider.label} · ${new Date(result.generatedAt).toLocaleString()}` : analysisMessage}</small></span></span></div>
            <div className="px-mini-activity"><h3>Activity</h3>{auditEvents.slice(0, 4).map((event) => <button type="button" key={event.id} onClick={() => onSectionChange("activity")}><Clock3 size={15} /><span><strong>{event.action}</strong><small>{new Date(event.at).toLocaleString()}</small></span></button>)}</div>
          </aside>

          <section className="px-evidence-analysis">
            <header><div><h2>Evidence and AI findings</h2><nav><button type="button" className="active" onClick={() => document.querySelector(".px-ai-summary")?.scrollIntoView({ behavior: "smooth", block: "start" })}>AI summary</button><button type="button" onClick={() => document.querySelector(".px-findings")?.scrollIntoView({ behavior: "smooth", block: "start" })}>Key findings {result?.findings.length ? <b>{result.findings.length}</b> : null}</button><button type="button" onClick={() => onSectionChange("memo")}>Full evidence</button><button type="button" onClick={() => document.querySelector(".px-citations")?.scrollIntoView({ behavior: "smooth", block: "start" })}>Citations</button></nav></div><button type="button" className="button" onClick={onExport}><Download size={15} />Download report</button></header>
            {analysisStatus === "running" ? <AnalysisProgress message={analysisMessage} onCancel={onCancelAnalysis} /> : null}
            {analysisStatus === "failed" ? <div className="px-inline-error"><strong>AI analysis did not finish</strong><span>{analysisMessage}</span><button className="button" type="button" onClick={onRunAnalysis}>Retry analysis</button></div> : null}
            {!result && analysisStatus !== "running" && analysisStatus !== "failed" ? <div className="px-empty-state"><Sparkles size={28} /><h2>Ready for exact-content AI review</h2><p>Rulix will bind approval to this revision, data class, provider lane, and analysis depth.</p><button className="button primary" type="button" onClick={onRunAnalysis} disabled={approvalBusy}>{approvalBusy ? "Preparing approval…" : "Request / run AI"}</button></div> : null}
            {result ? (
              <>
                <div className="px-ai-classification"><CheckCircle2 size={18} /><span><strong>AI classification: {result.recommended.eccn}</strong><small>{result.recommended.label} · {result.provider.label}</small></span><time>{new Date(result.generatedAt).toLocaleString()}</time></div>
                <article className="px-ai-summary"><h3>What the AI found</h3><p>{result.recommended.summary}</p><h3>Exact content reviewed (scope)</h3><p>AI approval applies only to revision {result.memoRevision ?? memo.revision} of the current memo and the cited source material.</p><button type="button" className="px-text-button" onClick={() => onSectionChange("memo")}>View full evidence</button></article>
                <section className="px-findings"><h3>Findings ({result.findings.length})</h3>{result.findings.length ? <div className="px-findings-grid"><div>{result.findings.map((finding, index) => <button type="button" key={finding.id} className={selectedFinding?.id === finding.id ? "active" : ""} onClick={() => setSelectedFindingId(finding.id)}><span>{index + 1}</span><span><strong>{finding.title}</strong><small>{labelize(finding.severity)} · {labelize(finding.status)}</small></span></button>)}</div>{selectedFinding ? <article><div><h4>{selectedFinding.title}</h4><span className={`px-severity ${selectedFinding.severity}`}>{labelize(selectedFinding.severity)}</span></div><strong>Claim</strong><p>{selectedFinding.claim}</p><strong>Rationale</strong><p>{selectedFinding.rationale}</p>{selectedFinding.excerpt ? <blockquote>{selectedFinding.excerpt}</blockquote> : null}</article> : null}</div> : <div className="px-success-state"><CheckCircle2 size={20} /><strong>No unresolved evidence findings</strong></div>}</section>
                <section className="px-citations"><h3>Citations ({uniqueCitations(result).length})</h3>{uniqueCitations(result).map((citation) => <button type="button" key={citation} onClick={() => onSectionChange("memo")}><FileText size={14} /><span>{citation}</span><Link2 size={13} /></button>)}</section>
              </>
            ) : null}
          </section>

          <aside className="px-artifact-pane">
            <header><h2>Memos and artifacts</h2><button type="button" className="button" onClick={onOpenMemoBuilder}>+ New</button></header>
            <button type="button" className="px-artifact selected" onContextMenu={(event) => { event.preventDefault(); setContext({ x: event.clientX, y: event.clientY }); }}><MessageSquare size={17} /><span><strong>AI memo draft</strong><small>Review context ready · Updated {new Date(memo.updatedAt).toLocaleString()}</small></span><MessageSquare size={15} /><MoreHorizontal size={16} /></button>
            <div className="px-artifact-empty"><p>Attach or create</p><span>Add a document, screenshot, quote, or dataset to support your decision.</span><button type="button" className="button" onClick={onOpenMemoBuilder}><Paperclip size={15} />Attach document</button></div>
            <section className="px-notes"><h3>Notes</h3><textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Focus on the decision, evidence gaps, and storage scope." maxLength={1_000} /><div><span>{notes.length} / 1000</span><button type="button" onClick={() => setCommentText(notes)} disabled={!notes.trim()}><Save size={14} />Stage as comment</button></div></section>
            <section className="px-comment-composer"><h3>Collaboration</h3><textarea value={commentText} onChange={(event) => setCommentText(event.target.value)} placeholder="Comment or type @Name to mention a tenant member…" /><div><button type="button" className="button" disabled={!commentText.trim() || commentBusy} onClick={() => void submitComment("request-information")}>Request info</button><button type="button" className="button primary" disabled={!commentText.trim() || commentBusy} onClick={() => void submitComment("comment")}><Send size={15} />Comment</button></div></section>
            <div className="px-comment-list">{comments.slice(0, 4).map((comment) => <article className={comment.resolvedAt ? "resolved" : ""} key={comment.id}><span className="px-avatar small">{initials(comment.authorName)}</span><div><strong>{comment.authorName}</strong><p>{comment.body}</p><small>{new Date(comment.createdAt).toLocaleString()}</small>{!comment.resolvedAt && (comment.authorId === user.id || user.role === "export-control-officer") ? <button type="button" onClick={() => void resolveReviewComment(memo.id, comment.id).then((resolved) => setComments((current) => current.map((item) => item.id === resolved.id ? resolved : item)))}>Resolve</button> : null}</div></article>)}</div>
            <p className="px-human-note">Ctrl+Enter approves only the exact current action. Human signoff remains final.</p>
            {result && !decision ? <DecisionBar onDecision={onDecision} /> : decision ? <div className="px-decision-complete"><CheckCircle2 size={18} /><span><strong>Human decision recorded</strong><small>{labelize(decision.action)} · {decision.signedBy}</small></span><button type="button" className="button primary" onClick={onExport}>Export</button></div> : <button type="button" className="button primary px-primary-action" onClick={onRunAnalysis} disabled={analysisStatus === "running" || approvalBusy}>{analysisStatus === "running" ? <><RefreshCw className="spin" size={17} />Analysis running</> : <><ShieldCheck size={17} />Review AI findings</>}</button>}
          </aside>
        </div>
      ) : null}

      {toolsOpen && section !== "conversation" ? <div className="px-tools-drawer"><header><h2>Review tools</h2><button type="button" onClick={() => setToolsOpen(false)} aria-label="Close review tools"><XCircle size={19} /></button></header>{reviewTools}</div> : null}
      <ContextMenu open={Boolean(context)} x={context?.x ?? 0} y={context?.y ?? 0} label="Artifact actions" actions={actions} onClose={() => setContext(undefined)} />
    </main>
  );
}

function DecisionBar({ onDecision }: { onDecision: ReviewWorkbenchProps["onDecision"] }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (action: ReviewerDecision["action"]) => {
    if (!notes.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await onDecision(action, notes);
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "The decision was not recorded. Review the current findings and try again.");
    } finally {
      setBusy(false);
    }
  };
  if (!open) return <button type="button" className="button primary px-primary-action" onClick={() => setOpen(true)}><ShieldCheck size={17} />Record human decision</button>;
  return <div className="px-decision-bar"><textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Decision rationale is required for the audit trail." />{error ? <p className="px-decision-error" role="alert">{error}</p> : null}<div><button type="button" className="button" onClick={() => void submit("request-info")} disabled={!notes.trim() || busy}>Request info</button><button type="button" className="button" onClick={() => void submit("override")} disabled={!notes.trim() || busy}>Override</button><button type="button" className="button primary" onClick={() => void submit("accept")} disabled={!notes.trim() || busy}>{busy ? "Recording…" : "Accept & sign"}</button></div></div>;
}

function AnalysisProgress({ message, onCancel }: { message: string; onCancel?: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => { const started = Date.now(); const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1_000)), 1_000); return () => window.clearInterval(timer); }, []);
  return <div className="px-analysis-progress"><div><RefreshCw className="spin" size={19} /><span><strong>AI council is working</strong><small>{message}</small></span><time>{elapsed}s</time></div><div className="px-indeterminate"><i /></div>{onCancel ? <button type="button" className="px-text-button" onClick={onCancel}>Cancel run</button> : null}</div>;
}

function progressIndex(memo: MemoRecord, result?: ReviewResult, decision?: ReviewerDecision) {
  if (decision) return 5;
  if (result?.findings.length) return 3;
  if (result) return 4;
  if (memo.memoText?.trim()) return 2;
  if (memo.attachments?.length) return 1;
  return 0;
}

function combinedActivity(audit: AuditEvent[], comments: CaseComment[]) {
  return [...audit.map((event) => ({ id: event.id, at: event.at, actor: event.actor, title: event.action, detail: event.detail, severity: event.severity, icon: <History size={16} /> })), ...comments.map((comment) => ({ id: comment.id, at: comment.createdAt, actor: comment.authorName, title: comment.resolvedAt ? "Comment resolved" : "Comment added", detail: comment.body, severity: "info" as const, icon: <MessageSquare size={16} /> }))].sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
}

function uniqueCitations(result: ReviewResult) {
  return [...new Set(result.findings.flatMap((finding) => finding.sourceChunkIds))];
}

function downloadText(memo: MemoRecord) { const url = URL.createObjectURL(new Blob([memo.memoText], { type: "text/markdown" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${memo.documentCode}.md`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1_000); }
function dataClassLabel(value: MemoRecord["dataClass"]) { if (value === "public") return "Public/sample"; if (value === "export-controlled") return "Export-controlled"; if (value === "itar-risk") return "ITAR risk"; if (value === "cui") return "CUI"; if (value === "proprietary") return "Proprietary"; return "Classification required"; }
function labelize(value: string) { return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "RU"; }
