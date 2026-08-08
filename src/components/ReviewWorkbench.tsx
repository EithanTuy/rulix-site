import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  History,
  MessageSquare,
  PanelRight,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  X
} from "lucide-react";
import {
  ANALYSIS_MODE_CONFIG,
  createReviewComment,
  listReviewComments,
  resolveReviewComment,
  type AnalysisMode,
  type AgentWorkflowApprovalView
} from "../lib/apiClient";
import type { ReviewPanel, ReviewStage } from "../lib/appRoutes";
import { summarizeReadiness } from "../lib/reviewLifecycle";
import type {
  AuditEvent,
  AnalysisRun,
  CaseComment,
  MemoChatMessage,
  MemoRecord,
  RegulatoryCitation,
  ReviewResult,
  ReviewerDecision,
  UserProfile
} from "../types";
import { MemoChatPanel } from "./MemoChatPanel";

interface ReviewWorkbenchProps {
  memo: MemoRecord;
  result?: ReviewResult;
  decision?: ReviewerDecision;
  auditEvents: AuditEvent[];
  user: UserProfile;
  members: Array<Pick<UserProfile, "id" | "name" | "email" | "role">>;
  stage: ReviewStage;
  panel?: ReviewPanel;
  analysisStatus: "unanalyzed" | "running" | "live" | "failed";
  analysisMessage: string;
  analysisRun?: AnalysisRun;
  analysisMode: AnalysisMode;
  backendNotice: string;
  liveAnalysisAvailable: boolean;
  workflowApproval?: AgentWorkflowApprovalView;
  approvalBusy: boolean;
  memoEditor: ReactNode;
  memoDraftDirty: boolean;
  chatMessages: MemoChatMessage[];
  chatHasMore: boolean;
  auditHasMore: boolean;
  selectedFindingId?: string;
  onFindingSelect: (findingId: string | undefined) => void;
  onStageChange: (stage: ReviewStage, panel?: ReviewPanel) => void;
  onBack: () => void;
  onRunAnalysis: () => void;
  onCancelAnalysis?: () => void;
  onAnalysisModeChange: (mode: AnalysisMode) => void;
  onRevokeWorkflowApproval: () => Promise<void> | void;
  onExport: () => void;
  onOpenMemoBuilder: () => void;
  onUpdateMetadata: (
    patch: Partial<Pick<MemoRecord, "priority" | "tags" | "lifecycleStage">> & {
      assignedTo?: string | null;
      dueAt?: string | null;
    }
  ) => Promise<void>;
  onDecision: (action: ReviewerDecision["action"], notes: string) => Promise<void>;
  onSendChat: (memoId: string, message: string) => Promise<"sent" | "queued">;
  onApplyChatSuggestion: (memoId: string, messageId: string) => Promise<void>;
  onLoadMoreChat: (memoId: string) => Promise<void>;
  onLoadMoreAudit: (memoId: string) => Promise<void>;
}

const stages: Array<{ id: ReviewStage; label: string; short: string }> = [
  { id: "prepare", label: "Prepare", short: "Prepare" },
  { id: "review", label: "Review", short: "Review" },
  { id: "decide", label: "Decide & Export", short: "Decide" }
];

export function ReviewWorkbench({
  memo,
  result,
  decision,
  auditEvents,
  user,
  members,
  stage,
  panel,
  analysisStatus,
  analysisMessage,
  analysisRun,
  analysisMode,
  backendNotice,
  liveAnalysisAvailable,
  workflowApproval,
  approvalBusy,
  memoEditor,
  memoDraftDirty,
  chatMessages,
  chatHasMore,
  auditHasMore,
  selectedFindingId,
  onFindingSelect,
  onStageChange,
  onBack,
  onRunAnalysis,
  onCancelAnalysis,
  onAnalysisModeChange,
  onRevokeWorkflowApproval,
  onExport,
  onOpenMemoBuilder,
  onUpdateMetadata,
  onDecision,
  onSendChat,
  onApplyChatSuggestion,
  onLoadMoreChat,
  onLoadMoreAudit
}: ReviewWorkbenchProps) {
  const [drawerOpen, setDrawerOpen] = useState(Boolean(panel));
  const [activePanel, setActivePanel] = useState<ReviewPanel>(panel ?? defaultPanel(stage));
  const [comments, setComments] = useState<CaseComment[]>([]);
  const [commentText, setCommentText] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [decisionNotes, setDecisionNotes] = useState(decision?.notes ?? "");
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const stale = Boolean(result && result.memoRevision !== undefined && result.memoRevision !== memo.revision);
  const readiness = result ? summarizeReadiness(result) : undefined;
  const blockingFinding = result?.findings.find((finding) => finding.status === "conflict" || finding.status === "missing");
  const selectedFinding = result?.findings.find((finding) => finding.id === selectedFindingId) ?? result?.findings[0];
  const decisionCurrent = Boolean(
    decision
    && (!decision.memoRevision || decision.memoRevision === memo.revision)
    && (!decision.memoHash || decision.memoHash === memo.contentHash)
    && (!decision.analysisId || decision.analysisId === result?.id)
  );
  const exportReady = Boolean(decisionCurrent && decision && decision.action !== "request-info" && result && !stale);
  const canDecide = user.role !== "submitter";
  const canOverride = user.role === "export-control-officer" || user.role === "counsel";

  const citations = useMemo(() => uniqueRegulatoryCitations(result), [result]);

  useEffect(() => {
    const controller = new AbortController();
    void listReviewComments(memo.id, { limit: 50 }, controller.signal)
      .then((page) => setComments(page.items))
      .catch(() => undefined);
    return () => controller.abort();
  }, [memo.id]);

  useEffect(() => {
    setDecisionNotes(decision?.notes ?? "");
    setDecisionError("");
  }, [decision?.notes, memo.id]);

  useEffect(() => {
    if (!panel) return;
    setActivePanel(panel);
    setDrawerOpen(true);
  }, [panel]);

  useEffect(() => {
    if (!selectedFindingId && result?.findings[0]) onFindingSelect(result.findings[0].id);
  }, [onFindingSelect, result?.generatedAt, selectedFindingId]);

  const openPanel = (next: ReviewPanel) => {
    setActivePanel(next);
    setDrawerOpen(true);
    onStageChange(stage, next);
  };

  const submitComment = async (kind: "comment" | "request-information") => {
    const body = commentText.trim();
    if (!body || commentBusy) return;
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

  const submitDecision = async (action: ReviewerDecision["action"]) => {
    if (!decisionNotes.trim() || decisionBusy || !canDecide) return;
    setDecisionBusy(true);
    setDecisionError("");
    try {
      await onDecision(action, decisionNotes.trim());
    } catch (reason) {
      setDecisionError(reason instanceof Error ? reason.message : "The decision was not recorded. Review the current revision and try again.");
    } finally {
      setDecisionBusy(false);
    }
  };

  return (
    <main className="review-workbench" id="main-content">
      <header className="review-heading">
        <button type="button" className="review-back" onClick={onBack}><ArrowLeft size={17} />Back to Work</button>
        <div className="review-title-row">
          <div>
            <h1>{memo.title}</h1>
            <p>
              {memo.documentCode}
              <span aria-hidden="true">•</span>
              Revision {memo.revision ?? 1}
              <span aria-hidden="true">•</span>
              Updated {new Date(memo.updatedAt).toLocaleString()}
            </p>
          </div>
          <button type="button" className="button review-context-toggle" aria-expanded={drawerOpen} onClick={() => setDrawerOpen((open) => !open)}>
            <PanelRight size={17} />Context
          </button>
        </div>
      </header>

      <nav className="review-stages" aria-label="Review stages">
        {stages.map((item, index) => (
          <button
            type="button"
            key={item.id}
            className={stage === item.id ? "active" : ""}
            aria-current={stage === item.id ? "step" : undefined}
            onClick={() => onStageChange(item.id)}
          >
            <span>{index + 1}</span>
            <strong>{item.label}</strong>
          </button>
        ))}
      </nav>

      <div className={`review-layout${drawerOpen ? " with-drawer" : ""}`}>
        <div className="review-focus">
          {memoDraftDirty ? (
            <div className="review-inline-notice warning" role="status">
              <AlertCircle size={17} />
              <span><strong>Unsaved memo edits</strong>Save or discard them before changing stages, running AI, deciding, or exporting.</span>
            </div>
          ) : null}
          {stage === "prepare" ? (
            <PrepareStage
              memo={memo}
              memoEditor={memoEditor}
              onOpenMemoBuilder={onOpenMemoBuilder}
              onContinue={() => onStageChange("review")}
              onOpenDetails={() => openPanel("details")}
            />
          ) : null}
          {stage === "review" ? (
            <ReviewStageView
              memo={memo}
              result={result}
              selectedFinding={selectedFinding}
              stale={stale}
              analysisStatus={analysisStatus}
              analysisMessage={analysisMessage}
              analysisRun={analysisRun}
              analysisMode={analysisMode}
              backendNotice={backendNotice}
              liveAnalysisAvailable={liveAnalysisAvailable}
              workflowApproval={workflowApproval}
              approvalBusy={approvalBusy}
              user={user}
              memoDraftDirty={memoDraftDirty}
              onRunAnalysis={onRunAnalysis}
              onCancelAnalysis={onCancelAnalysis}
              onAnalysisModeChange={onAnalysisModeChange}
              onRevokeWorkflowApproval={onRevokeWorkflowApproval}
              onFindingSelect={onFindingSelect}
              onResolveFinding={(findingId) => {
                onFindingSelect(findingId);
                onStageChange("prepare");
              }}
              onRequestInformation={(findingId) => {
                onFindingSelect(findingId);
                setCommentText(`Please provide information needed to resolve: ${result?.findings.find((finding) => finding.id === findingId)?.title ?? "this finding"}`);
                openPanel("comments");
              }}
              onContinue={() => onStageChange("decide")}
            />
          ) : null}
          {stage === "decide" ? (
            <DecideStage
              result={result}
              decision={decision}
              stale={stale}
              readiness={readiness}
              blockingFinding={blockingFinding}
              notes={decisionNotes}
              busy={decisionBusy}
              error={decisionError}
              canDecide={canDecide}
              canOverride={canOverride}
              exportReady={exportReady}
              memoDraftDirty={memoDraftDirty}
              onNotesChange={setDecisionNotes}
              onDecision={submitDecision}
              onExport={onExport}
              onReviewBlocker={() => {
                if (blockingFinding) onFindingSelect(blockingFinding.id);
                onStageChange("review");
              }}
              onOpenAudit={() => openPanel("activity")}
            />
          ) : null}
        </div>

        {drawerOpen ? (
          <aside className="review-context" aria-label="Review context">
            <header>
              <h2>Context</h2>
              <button type="button" className="px-icon-button" onClick={() => setDrawerOpen(false)} aria-label="Close context"><X size={18} /></button>
            </header>
            <nav aria-label="Context sections">
              {contextTabs(stage).map((item) => (
                <button type="button" key={item.id} className={activePanel === item.id ? "active" : ""} onClick={() => setActivePanel(item.id)}>
                  {item.label}
                </button>
              ))}
            </nav>
            <div className="review-context-body" tabIndex={0} aria-label="Context content">
              {activePanel === "details" ? (
                <DetailsPanel memo={memo} user={user} members={members} onUpdateMetadata={onUpdateMetadata} />
              ) : null}
              {activePanel === "sources" ? <SourcesPanel memo={memo} citations={citations} result={result} /> : null}
              {activePanel === "comments" ? (
                <CommentsPanel
                  comments={comments}
                  commentText={commentText}
                  busy={commentBusy}
                  user={user}
                  onTextChange={setCommentText}
                  onSubmit={submitComment}
                  onResolve={(commentId) => void resolveReviewComment(memo.id, commentId).then((resolved) => {
                    setComments((current) => current.map((comment) => comment.id === resolved.id ? resolved : comment));
                  })}
                />
              ) : null}
              {activePanel === "chat" ? (
                <MemoChatPanel
                  memo={memo}
                  chatMessages={chatMessages}
                  analysisLocked={analysisStatus === "running"}
                  memoDraftDirty={memoDraftDirty}
                  onSendChat={onSendChat}
                  onApplyChatSuggestion={onApplyChatSuggestion}
                  hasMore={chatHasMore}
                  onLoadMore={onLoadMoreChat}
                  userRole={user.role}
                />
              ) : null}
              {activePanel === "activity" ? (
                <ActivityPanel memoId={memo.id} events={auditEvents} hasMore={auditHasMore} onLoadMore={onLoadMoreAudit} />
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>
    </main>
  );
}

function PrepareStage({
  memo,
  memoEditor,
  onOpenMemoBuilder,
  onContinue,
  onOpenDetails
}: {
  memo: MemoRecord;
  memoEditor: ReactNode;
  onOpenMemoBuilder: () => void;
  onContinue: () => void;
  onOpenDetails: () => void;
}) {
  return (
    <>
      <section className="review-primary-card">
        <div>
          <p className="review-stage-label">Prepare</p>
          <h2>Confirm the review package</h2>
          <p>Check the current memo, attachments, provenance, and essential metadata before requesting AI review.</p>
        </div>
        <button type="button" className="button primary" disabled={!memo.memoText.trim()} onClick={onContinue}>
          Continue to Review <ChevronRight size={17} />
        </button>
      </section>
      <section className="review-package-summary" aria-label="Review package">
        <button type="button" onClick={onOpenDetails}>
          <FileText size={18} />
          <span><strong>Data and provenance</strong><small>{dataClassLabel(memo.dataClass)} · {sourcePathLabel(memo.sourcePath)}</small></span>
          <ChevronRight size={16} />
        </button>
        <button type="button" onClick={onOpenMemoBuilder}>
          <Sparkles size={18} />
          <span><strong>Improve with Memo Builder</strong><small>Draft changes remain subject to exact-content approval.</small></span>
          <ChevronRight size={16} />
        </button>
      </section>
      <section className="review-memo-section" aria-label="Current memo">{memoEditor}</section>
    </>
  );
}

function ReviewStageView({
  memo,
  result,
  selectedFinding,
  stale,
  analysisStatus,
  analysisMessage,
  analysisRun,
  analysisMode,
  backendNotice,
  liveAnalysisAvailable,
  workflowApproval,
  approvalBusy,
  user,
  memoDraftDirty,
  onRunAnalysis,
  onCancelAnalysis,
  onAnalysisModeChange,
  onRevokeWorkflowApproval,
  onFindingSelect,
  onResolveFinding,
  onRequestInformation,
  onContinue
}: {
  memo: MemoRecord;
  result?: ReviewResult;
  selectedFinding?: ReviewResult["findings"][number];
  stale: boolean;
  analysisStatus: ReviewWorkbenchProps["analysisStatus"];
  analysisMessage: string;
  analysisRun?: AnalysisRun;
  analysisMode: AnalysisMode;
  backendNotice: string;
  liveAnalysisAvailable: boolean;
  workflowApproval?: AgentWorkflowApprovalView;
  approvalBusy: boolean;
  user: UserProfile;
  memoDraftDirty: boolean;
  onRunAnalysis: () => void;
  onCancelAnalysis?: () => void;
  onAnalysisModeChange: (mode: AnalysisMode) => void;
  onRevokeWorkflowApproval: () => Promise<void> | void;
  onFindingSelect: (findingId: string | undefined) => void;
  onResolveFinding: (findingId: string) => void;
  onRequestInformation: (findingId: string) => void;
  onContinue: () => void;
}) {
  const isOfficer = user.role === "export-control-officer";
  const actionLabel = analysisStatus === "running"
    ? "Analysis running"
    : isOfficer
      ? "Approve & run AI review"
      : workflowApproval?.usable
        ? "Run approved AI review"
        : "Request officer approval";
  const readiness = result ? summarizeReadiness(result) : undefined;

  return (
    <>
      <section className={`review-primary-card${stale ? " warning" : ""}`}>
        <div>
          <p className="review-stage-label">Review</p>
          <h2>{stale ? "Re-review the current revision" : "Review the current revision"}</h2>
          <p>{stale ? "The memo changed after this AI result. Approve and run the exact current content again." : "AI findings support this review; a human remains responsible for the decision."}</p>
          <label className="review-analysis-mode">
            Analysis depth
            <select value={analysisMode} disabled={analysisStatus === "running"} onChange={(event) => onAnalysisModeChange(event.target.value as AnalysisMode)}>
              {(Object.keys(ANALYSIS_MODE_CONFIG) as AnalysisMode[]).map((mode) => <option key={mode} value={mode}>{ANALYSIS_MODE_CONFIG[mode].label}</option>)}
            </select>
          </label>
        </div>
        <button
          type="button"
          className="button primary"
          disabled={analysisStatus === "running" || approvalBusy || memoDraftDirty || !liveAnalysisAvailable}
          onClick={onRunAnalysis}
        >
          {analysisStatus === "running" ? <RefreshCw className="spin" size={17} /> : <Sparkles size={17} />}
          {approvalBusy ? "Preparing approval…" : actionLabel}
        </button>
      </section>

      <div className={`review-approval-scope${workflowApproval?.usable ? " approved" : ""}`}>
        <ShieldCheck size={18} />
        <span>
          <strong>{workflowApproval?.usable ? "Approved for one exact dispatch" : "Exact-content approval"}</strong>
          <small>Revision {memo.revision ?? 1} · {analysisMode} · hash {(memo.contentHash ?? "not loaded").slice(0, 10)}…</small>
        </span>
        {isOfficer && workflowApproval?.approval?.current && workflowApproval.approval.dispatchesReserved === 0 ? (
          <button type="button" className="review-link-button" disabled={approvalBusy} onClick={() => void onRevokeWorkflowApproval()}>Revoke</button>
        ) : null}
      </div>

      {analysisStatus === "running" ? (
        <WorkflowProgress run={analysisRun} message={analysisMessage} onCancel={onCancelAnalysis} />
      ) : null}
      {analysisStatus === "failed" ? (
        <div className="review-inline-notice error" role="alert">
          <AlertCircle size={18} /><span><strong>AI review did not finish</strong>{analysisMessage} {backendNotice}</span>
        </div>
      ) : null}

      {!result ? (
        <section className="review-empty-analysis">
          <Sparkles size={28} />
          <h2>No AI review for this revision</h2>
          <p>Run or request an exact-content review to see the summary and evidence findings.</p>
        </section>
      ) : (
        <>
          <section className="review-ai-summary">
            <header>
              <div><p className="review-stage-label">AI summary</p><h2>{result.recommended.eccn}</h2></div>
              <span className={readiness?.blockers ? "blocked" : "ready"}>{readiness?.label}</span>
            </header>
            <p>{result.recommended.summary}</p>
            <dl>
              <div><dt>Jurisdiction</dt><dd>{labelize(result.jurisdiction.outcome)}</dd></div>
              <div><dt>Provider</dt><dd>{result.provider.label}</dd></div>
              <div><dt>Reviewed</dt><dd>{new Date(result.generatedAt).toLocaleString()}</dd></div>
            </dl>
          </section>

          <WorkflowResults result={result} />

          <section className="review-findings">
            <header><div><p className="review-stage-label">Findings</p><h2>{result.findings.length ? `${result.findings.length} to inspect` : "No evidence findings"}</h2></div></header>
            {result.findings.length ? (
              <div className="review-findings-layout">
                <div className="review-finding-list">
                  {result.findings.map((finding) => (
                    <button type="button" className={selectedFinding?.id === finding.id ? "active" : ""} key={finding.id} onClick={() => onFindingSelect(finding.id)}>
                      <span className={`review-finding-state ${finding.status}`}>{finding.status === "strong" ? <Check size={14} /> : <AlertCircle size={14} />}</span>
                      <span><strong>{finding.title}</strong><small>{labelize(finding.status)} · {labelize(finding.severity)}</small></span>
                    </button>
                  ))}
                </div>
                {selectedFinding ? (
                  <article className="review-finding-detail" id={`finding-${selectedFinding.id}`}>
                    <header><h3>{selectedFinding.title}</h3><span>{labelize(selectedFinding.status)}</span></header>
                    <strong>Claim</strong><p>{selectedFinding.claim}</p>
                    <strong>Rationale</strong><p>{selectedFinding.rationale}</p>
                    {selectedFinding.excerpt ? <blockquote>{selectedFinding.excerpt}</blockquote> : null}
                    <div>
                      <button type="button" className="button" onClick={() => onRequestInformation(selectedFinding.id)}>Request information</button>
                      <button type="button" className="button primary" onClick={() => onResolveFinding(selectedFinding.id)}>Resolve in memo</button>
                    </div>
                  </article>
                ) : null}
              </div>
            ) : <div className="review-success"><CheckCircle2 size={20} />No unresolved evidence findings.</div>}
          </section>
          <div className="review-stage-next">
            <span><strong>Finished reviewing?</strong><small>Decision and export stay in the final stage.</small></span>
            <button type="button" className="button primary" onClick={onContinue}>Continue to Decide & Export <ChevronRight size={17} /></button>
          </div>
        </>
      )}
    </>
  );
}

function WorkflowProgress({
  run,
  message,
  onCancel
}: {
  run?: AnalysisRun;
  message: string;
  onCancel?: () => void;
}) {
  return (
    <section className="review-agent-workflow running" aria-live="polite">
      <header>
        <div>
          <p className="review-stage-label">Live multi-agent workflow</p>
          <h2><RefreshCw className="spin" size={19} />{run ? labelize(run.stage) : "Starting worker"}</h2>
          <p>{message}</p>
        </div>
        {onCancel ? <button type="button" className="review-link-button" onClick={onCancel}>Cancel run</button> : null}
      </header>
      {run ? (
        <>
          <div className="review-workflow-meter" aria-label={`${run.progress}% complete`}>
            <span style={{ width: `${run.progress}%` }} />
          </div>
          <dl className="review-workflow-budget">
            <div><dt>Model calls</dt><dd>{run.callBudget.used} / {run.callBudget.maximum}</dd></div>
            <div><dt>Tokens</dt><dd>{run.tokenBudget.used.toLocaleString()} / {run.tokenBudget.maximum.toLocaleString()}</dd></div>
            <div><dt>Challenge round</dt><dd>{run.challengeRound} / {run.bindings.maximumChallengeRounds}</dd></div>
          </dl>
          <div className="review-workflow-stages">
            {run.stages.map((stage) => (
              <span className={stage.status} key={stage.stage}>
                {stage.status === "completed" ? <Check size={13} /> : stage.status === "running" ? <RefreshCw className="spin" size={13} /> : <Clock3 size={13} />}
                {labelize(stage.stage)}
              </span>
            ))}
          </div>
          <AgentInvocationList invocations={run.invocations} />
        </>
      ) : null}
    </section>
  );
}

function WorkflowResults({ result }: { result: ReviewResult }) {
  const invocations = result.workflowInvocations ?? [];
  return (
    <section className="review-agent-workflow">
      <header>
        <div>
          <p className="review-stage-label">AI Council · actual agent outputs</p>
          <h2>{result.workflowVersion ?? "Agent workflow"}</h2>
          <p>{result.reportNarrative ?? result.confidenceExplanation ?? "The recorded agent artifacts are available below for human inspection."}</p>
        </div>
        <span className={result.decisionReadiness?.status === "blocked" ? "blocked" : "ready"}>
          {result.decisionReadiness ? labelize(result.decisionReadiness.status) : labelize(result.outcome ?? "unresolved")}
        </span>
      </header>

      <AgentInvocationList invocations={invocations} />

      {result.caseEvidence ? (
        <details>
          <summary>Intake evidence ledger · {result.caseEvidence.evidence.length} record{result.caseEvidence.evidence.length === 1 ? "" : "s"}</summary>
          <div className="review-workflow-detail-list">
            {result.caseEvidence.evidence.map((evidence) => (
              <article key={evidence.id}>
                <header><strong>{evidence.subject}</strong><span>{labelize(evidence.evidenceKind)}</span></header>
                <p>{evidence.value}{evidence.units ? ` ${evidence.units}` : ""}</p>
                <blockquote>{evidence.excerpt}</blockquote>
                <small>{evidence.location.label} · hash {evidence.contentHash.slice(0, 12)}…</small>
              </article>
            ))}
          </div>
        </details>
      ) : null}

      {result.candidateResearch ? (
        <details open>
          <summary>Candidate research · {result.candidateResearch.candidates.length} candidate{result.candidateResearch.candidates.length === 1 ? "" : "s"}</summary>
          <p>{result.candidateResearch.searchSummary}</p>
          <div className="review-workflow-detail-list">
            {result.candidateResearch.candidates.map((candidate) => (
              <article key={candidate.id}>
                <header><strong>{candidate.classification}</strong><span>{candidate.label}</span></header>
                <p>{candidate.inclusionReason}</p>
                {candidate.factualQuestions.length ? <ul>{candidate.factualQuestions.map((question) => <li key={question}>{question}</li>)}</ul> : null}
                <small>{candidate.regulatoryCitations.length} exact regulatory citation{candidate.regulatoryCitations.length === 1 ? "" : "s"}</small>
              </article>
            ))}
          </div>
        </details>
      ) : null}

      {result.candidateAnalyses?.length ? (
        <details open>
          <summary>Element-by-element candidate analysis · {result.candidateAnalyses.length}</summary>
          <div className="review-workflow-detail-list">
            {result.candidateAnalyses.map((analysis) => (
              <article key={analysis.candidateId}>
                <header><strong>{analysis.classification}</strong><span className={analysis.outcome}>{labelize(analysis.outcome)}</span></header>
                <p>{analysis.summary}</p>
                {[...analysis.criteria, ...analysis.exclusionsAndNotes].map((criterion) => (
                  <div className="review-workflow-criterion" key={criterion.id}>
                    <strong>{criterion.locator} · {criterion.criterion}</strong>
                    <span>{labelize(criterion.disposition)}</span>
                    <p>{criterion.explanation}</p>
                  </div>
                ))}
                {analysis.missingInformationQuestions.length ? (
                  <ul>{analysis.missingInformationQuestions.map((question) => <li key={question}>{question}</li>)}</ul>
                ) : null}
              </article>
            ))}
          </div>
        </details>
      ) : null}

      {result.adversarialChallenge ? (
        <details open>
          <summary>Adversarial challenge · {result.adversarialChallenge.challenges.length} finding{result.adversarialChallenge.challenges.length === 1 ? "" : "s"}</summary>
          <p>{result.adversarialChallenge.summary}</p>
          <div className="review-workflow-detail-list">
            {result.adversarialChallenge.challenges.map((challenge) => (
              <article key={challenge.id}>
                <header><strong>{challenge.summary}</strong><span>{labelize(challenge.severity)}</span></header>
                <small>Affects {challenge.affectedCandidateIds.join(", ") || "the synthesis"}</small>
              </article>
            ))}
          </div>
        </details>
      ) : null}

      {result.citationAudit ? (
        <details open>
          <summary>Citation verification · {result.citationAudit.passed ? "passed" : "blocked"}</summary>
          <p>{result.citationAudit.summary}</p>
          <div className="review-citation-audit">
            {result.citationAudit.claims.map((claim) => (
              <span className={claim.status === "verified" ? "verified" : "failed"} key={claim.claimId}>
                {claim.status === "verified" ? <Check size={13} /> : <AlertCircle size={13} />}
                <strong>{claim.claimId}</strong> · {labelize(claim.status)} · {claim.explanation}
              </span>
            ))}
          </div>
        </details>
      ) : null}

      {result.infoRequests.length ? (
        <details open>
          <summary>Missing information · {result.infoRequests.length}</summary>
          <ul>{result.infoRequests.map((request) => <li key={request}>{request}</li>)}</ul>
        </details>
      ) : null}
    </section>
  );
}

function AgentInvocationList({ invocations }: { invocations: AnalysisRun["invocations"] }) {
  if (!invocations.length) return <p className="review-workflow-empty">Agent invocation records will appear as work starts.</p>;
  return (
    <div className="review-agent-invocations" aria-label="Agent invocation records">
      {invocations.map((invocation) => (
        <article key={invocation.invocationId}>
          <span className={`review-agent-status ${invocation.status}`}>
            {invocation.status === "completed" ? <Check size={13} /> : invocation.status === "running" ? <RefreshCw className="spin" size={13} /> : <Clock3 size={13} />}
          </span>
          <div>
            <strong>{labelize(invocation.role)}{invocation.candidateId ? ` · ${invocation.candidateId}` : ""}</strong>
            <small>{invocation.model} · attempt {invocation.attempt}{invocation.usage ? ` · ${invocation.usage.totalTokens.toLocaleString()} tokens` : ""}{invocation.latencyMs ? ` · ${invocation.latencyMs} ms` : ""}</small>
          </div>
          <code>{invocation.invocationId.slice(0, 12)}</code>
        </article>
      ))}
    </div>
  );
}

function DecideStage({
  result,
  decision,
  stale,
  readiness,
  blockingFinding,
  notes,
  busy,
  error,
  canDecide,
  canOverride,
  exportReady,
  memoDraftDirty,
  onNotesChange,
  onDecision,
  onExport,
  onReviewBlocker,
  onOpenAudit
}: {
  result?: ReviewResult;
  decision?: ReviewerDecision;
  stale: boolean;
  readiness?: ReturnType<typeof summarizeReadiness>;
  blockingFinding?: ReviewResult["findings"][number];
  notes: string;
  busy: boolean;
  error: string;
  canDecide: boolean;
  canOverride: boolean;
  exportReady: boolean;
  memoDraftDirty: boolean;
  onNotesChange: (value: string) => void;
  onDecision: (action: ReviewerDecision["action"]) => Promise<void>;
  onExport: () => void;
  onReviewBlocker: () => void;
  onOpenAudit: () => void;
}) {
  const blocker = !result
    ? "Run AI review before recording a decision."
    : stale
      ? "The AI result belongs to an older memo revision."
      : readiness?.blockers
        ? `${readiness.blockers} blocking finding${readiness.blockers === 1 ? "" : "s"} must be resolved or explicitly overridden.`
        : undefined;

  return (
    <>
      <section className="review-primary-card decide">
        <div>
          <p className="review-stage-label">Decide & Export</p>
          <h2>Record the human decision</h2>
          <p>Confirm remaining blockers, enter the rationale, and sign the authoritative current revision.</p>
        </div>
        {exportReady ? <button type="button" className="button primary" onClick={onExport}><Download size={17} />Export signed result</button> : null}
      </section>

      {blocker ? (
        <div className="review-export-blocker" role="status">
          <AlertCircle size={19} />
          <span><strong>Export is blocked</strong>{blocker}</span>
          <button type="button" className="review-link-button" onClick={onReviewBlocker}>
            {blockingFinding ? `Open “${blockingFinding.title}”` : "Return to Review"}
          </button>
        </div>
      ) : null}

      <section className="review-decision-card">
        <header>
          <div><h2>Decision rationale</h2><p>This note becomes part of the audit trail.</p></div>
          {decision ? <span className="review-decision-status"><CheckCircle2 size={16} />{labelize(decision.action)} recorded</span> : null}
        </header>
        {!canDecide ? <p className="review-role-note">A reviewer, counsel, or export-control officer must record the human decision.</p> : null}
        <label>
          Rationale
          <textarea value={notes} onChange={(event) => onNotesChange(event.target.value)} rows={7} placeholder="Explain the evidence, judgment, and any conditions for this decision." />
        </label>
        {error ? <p className="review-decision-error" role="alert">{error}</p> : null}
        <div className="review-decision-actions">
          <button type="button" className="button" disabled={!notes.trim() || busy || !canDecide || memoDraftDirty} onClick={() => void onDecision("request-info")}>Request more information</button>
          {canOverride ? <button type="button" className="button" disabled={!notes.trim() || busy || memoDraftDirty || !result || stale} onClick={() => void onDecision("override")}>Override with rationale</button> : null}
          <button type="button" className="button primary" disabled={!notes.trim() || busy || !canDecide || memoDraftDirty || Boolean(blocker)} onClick={() => void onDecision("accept")}>
            <ShieldCheck size={17} />{busy ? "Recording…" : "Accept & sign"}
          </button>
        </div>
      </section>

      <section className="review-export-card">
        <div>
          {exportReady ? <CheckCircle2 size={20} /> : <Clock3 size={20} />}
          <span>
            <strong>{exportReady ? "Signed result ready to export" : "Export waits for a current-revision decision"}</strong>
            <small>{exportReady ? "The report includes the memo, AI provenance, human rationale, and audit events." : "A transient notification is not used for this gate; the reason remains visible here."}</small>
          </span>
        </div>
        {exportReady ? <button type="button" className="button primary" onClick={onExport}><Download size={17} />Export signed result</button> : null}
        <button type="button" className="review-link-button" onClick={onOpenAudit}><History size={15} />View audit history</button>
      </section>
    </>
  );
}

function DetailsPanel({
  memo,
  user,
  members,
  onUpdateMetadata
}: {
  memo: MemoRecord;
  user: UserProfile;
  members: ReviewWorkbenchProps["members"];
  onUpdateMetadata: ReviewWorkbenchProps["onUpdateMetadata"];
}) {
  const canManage = user.role !== "submitter";
  return (
    <div className="review-details-panel">
      <dl>
        <div><dt>Data class</dt><dd>{dataClassLabel(memo.dataClass)}</dd></div>
        <div><dt>Classification path</dt><dd>{sourcePathLabel(memo.sourcePath)}</dd></div>
        <div><dt>Manufacturer</dt><dd>{memo.manufacturer || "Not provided"}</dd></div>
        <div><dt>Intended use</dt><dd>{memo.intendedUse || "Not provided"}</dd></div>
        <div><dt>Content hash</dt><dd><code>{memo.contentHash?.slice(0, 16) ?? "Not loaded"}…</code></dd></div>
      </dl>
      <label>Assignee
        <select value={memo.assignedTo ?? ""} disabled={!canManage} onChange={(event) => void onUpdateMetadata({ assignedTo: event.target.value || null })}>
          <option value="">Unassigned</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select>
      </label>
      <label>Due date
        <input type="date" value={memo.dueAt?.slice(0, 10) ?? ""} disabled={!canManage} onChange={(event) => void onUpdateMetadata({ dueAt: event.target.value ? `${event.target.value}T17:00:00.000Z` : null })} />
      </label>
      <label>Priority
        <select value={memo.priority ?? "normal"} disabled={!canManage} onChange={(event) => void onUpdateMetadata({ priority: event.target.value as MemoRecord["priority"] })}>
          <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
        </select>
      </label>
      <section>
        <h3>Attachments</h3>
        {memo.attachments.length ? memo.attachments.map((attachment) => <span className="review-attachment" key={attachment}><FileText size={15} />{attachment}</span>) : <p>Pasted memo · no file attachments</p>}
      </section>
    </div>
  );
}

function uniqueRegulatoryCitations(result?: ReviewResult) {
  if (!result) return [];
  const citations: RegulatoryCitation[] = [
    ...(result.candidateResearch?.candidates.flatMap((candidate) => candidate.regulatoryCitations) ?? []),
    ...(result.candidateAnalyses?.flatMap((analysis) => [
      ...analysis.criteria.flatMap((criterion) => criterion.regulatoryCitations),
      ...analysis.exclusionsAndNotes.flatMap((criterion) => criterion.regulatoryCitations)
    ]) ?? []),
    ...(result.adversarialChallenge?.challenges.flatMap((challenge) => challenge.regulatoryCitations) ?? []),
    ...(result.adversarialChallenge?.additionalCandidates.flatMap((candidate) => candidate.regulatoryCitations) ?? [])
  ];
  return [...new Map(citations.map((citation) => [
    `${citation.sourceId}:${citation.locator}:${citation.contentHash}:${citation.exactText}`,
    citation
  ])).values()];
}

function SourcesPanel({
  memo,
  citations,
  result
}: {
  memo: MemoRecord;
  citations: RegulatoryCitation[];
  result?: ReviewResult;
}) {
  return (
    <div className="review-sources-panel">
      <div className="review-provenance-card">
        <FileText size={18} />
        <span><strong>{memo.attachments[0] ?? "Pasted memo"}</strong><small>{dataClassLabel(memo.dataClass)} · revision {memo.revision ?? 1}</small></span>
      </div>
      <h3>Cited sources</h3>
      {citations.length ? citations.map((citation) => (
        <article className="review-regulatory-citation" key={`${citation.sourceId}:${citation.locator}:${citation.contentHash}`}>
          <header><strong>{citation.sourceId}</strong><small>{citation.locator} · source date {citation.sourceDate}</small></header>
          <blockquote>{citation.exactText}</blockquote>
          <code>sha256:{citation.contentHash}</code>
        </article>
      )) : <p>{result ? "No exact regulatory citations were bound to this result." : "Sources appear after AI review."}</p>}
      {result ? (
        <details>
          <summary>AI provenance</summary>
          <dl>
            <div><dt>Provider</dt><dd>{result.provider.label}</dd></div>
            <div><dt>Model policy</dt><dd>{result.modelPolicy}</dd></div>
            <div><dt>Corpus</dt><dd>{result.corpusId}</dd></div>
            <div><dt>Workflow</dt><dd>{result.workflowVersion ?? "Unavailable"}</dd></div>
            <div><dt>Memo revision</dt><dd>{result.memoRevision ?? memo.revision ?? 1}</dd></div>
            <div><dt>Result hash</dt><dd>{result.resultHash?.slice(0, 12) ?? "Unavailable"}…</dd></div>
          </dl>
        </details>
      ) : null}
    </div>
  );
}

function CommentsPanel({
  comments,
  commentText,
  busy,
  user,
  onTextChange,
  onSubmit,
  onResolve
}: {
  comments: CaseComment[];
  commentText: string;
  busy: boolean;
  user: UserProfile;
  onTextChange: (value: string) => void;
  onSubmit: (kind: "comment" | "request-information") => Promise<void>;
  onResolve: (commentId: string) => void;
}) {
  return (
    <div className="review-comments-panel">
      <label>
        Comment or request
        <textarea value={commentText} onChange={(event) => onTextChange(event.target.value)} rows={5} placeholder="Add context or @mention a teammate…" />
      </label>
      <div>
        <button type="button" className="button" disabled={!commentText.trim() || busy} onClick={() => void onSubmit("request-information")}>Request information</button>
        <button type="button" className="button primary" disabled={!commentText.trim() || busy} onClick={() => void onSubmit("comment")}><Send size={15} />Comment</button>
      </div>
      <section>
        {comments.map((comment) => (
          <article className={comment.resolvedAt ? "resolved" : ""} key={comment.id}>
            <span>{initials(comment.authorName)}</span>
            <div><strong>{comment.authorName}</strong><p>{comment.body}</p><small>{new Date(comment.createdAt).toLocaleString()}</small>
              {!comment.resolvedAt && (comment.authorId === user.id || user.role === "export-control-officer") ? <button type="button" onClick={() => onResolve(comment.id)}>Resolve</button> : null}
            </div>
          </article>
        ))}
        {!comments.length ? <p>No comments yet.</p> : null}
      </section>
    </div>
  );
}

function ActivityPanel({
  memoId,
  events,
  hasMore,
  onLoadMore
}: {
  memoId: string;
  events: AuditEvent[];
  hasMore: boolean;
  onLoadMore: (memoId: string) => Promise<void>;
}) {
  return (
    <div className="review-activity-panel">
      {events.map((event) => (
        <article key={event.id}>
          <span className={`review-activity-icon ${event.severity}`}><History size={15} /></span>
          <div><strong>{event.action}</strong><p>{event.detail}</p><small>{new Date(event.at).toLocaleString()} · {event.actor}</small></div>
        </article>
      ))}
      {!events.length ? <p>No audit events loaded.</p> : null}
      {hasMore ? <button type="button" className="button" onClick={() => void onLoadMore(memoId)}>Load earlier activity</button> : null}
    </div>
  );
}

function contextTabs(stage: ReviewStage): Array<{ id: ReviewPanel; label: string }> {
  if (stage === "prepare") return [
    { id: "details", label: "Details" },
    { id: "activity", label: "History" }
  ];
  return [
    { id: "sources", label: "Sources" },
    { id: "comments", label: "Comments" },
    { id: "chat", label: "AI chat" },
    { id: "activity", label: "Activity" }
  ];
}

function defaultPanel(stage: ReviewStage): ReviewPanel {
  return stage === "prepare" ? "details" : "sources";
}

function dataClassLabel(value: MemoRecord["dataClass"]) {
  if (value === "public") return "Public/sample";
  if (value === "export-controlled") return "Export-controlled";
  if (value === "itar-risk") return "ITAR risk";
  if (value === "cui") return "CUI";
  if (value === "proprietary") return "Proprietary";
  return "Classification required";
}

function sourcePathLabel(value: MemoRecord["sourcePath"]) {
  if (value === "self-classification") return "Self-classification";
  if (value === "manufacturer") return "Manufacturer classification";
  if (value === "ccats") return "BIS CCATS";
  if (value === "cj") return "DDTC CJ";
  return "Path not specified";
}

function labelize(value: string) {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "RU";
}
