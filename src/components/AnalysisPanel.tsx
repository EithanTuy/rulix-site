import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Check,
  CheckSquare,
  Cloud,
  Cpu,
  ExternalLink,
  FileText,
  ShieldCheck,
  UserRound,
  WifiOff,
  X,
  XSquare
} from "lucide-react";
import { getSourceChunk } from "../data/corpus";
import {
  ANALYSIS_MODE_CONFIG,
  type AnalysisMode,
  type CouncilApprovalView
} from "../lib/apiClient";
import { summarizeReadiness } from "../lib/reviewLifecycle";
import type {
  AuditEvent,
  MemoChatMessage,
  MemoRecord,
  ReviewerDecision,
  ReviewResult,
  UserProfile
} from "../types";
import { MemoChatPanel } from "./MemoChatPanel";
import { renderMarkdown, renderInline } from "../lib/markdown";
import { SafeExternalLink } from "./SafeExternalLink";

type SupportTab = "chat" | "analysis" | "decision" | "audit";

interface AnalysisPanelProps {
  memo: MemoRecord;
  result?: ReviewResult;
  analysisState: {
    status: "unanalyzed" | "running" | "live" | "failed";
    message: string;
  };
  analysisMode: AnalysisMode;
  onAnalysisModeChange: (mode: AnalysisMode) => void;
  backendNotice: string;
  liveAnalysisAvailable: boolean;
  onRunAnalysis: () => void;
  userRole: UserProfile["role"];
  councilApproval?: CouncilApprovalView;
  approvalBusy: boolean;
  onRevokeCouncilApproval: () => Promise<void> | void;
  decision?: ReviewerDecision;
  auditEvents: AuditEvent[];
  chatMessages: MemoChatMessage[];
  analysisLocked: boolean;
  memoDraftDirty: boolean;
  onDecision: (action: ReviewerDecision["action"], notes: string) => Promise<void>;
  onSendChat: (memoId: string, message: string) => Promise<"sent" | "queued">;
  onApplyChatSuggestion: (memoId: string, messageId: string) => Promise<void>;
  chatHasMore?: boolean;
  auditHasMore?: boolean;
  onLoadMoreChat?: (memoId: string) => Promise<void>;
  onLoadMoreAudit?: (memoId: string) => Promise<void>;

  selectedFindingId?: string;
  onFindingSelect: (findingId: string | undefined) => void;
}

export function AnalysisPanel({
  memo,
  result,
  analysisState,
  analysisMode,
  onAnalysisModeChange,
  backendNotice,
  liveAnalysisAvailable,
  onRunAnalysis,
  userRole,
  councilApproval,
  approvalBusy,
  onRevokeCouncilApproval,
  decision,
  auditEvents,
  chatMessages,
  analysisLocked,
  memoDraftDirty,
  onDecision,
  onSendChat,
  onApplyChatSuggestion,
  chatHasMore = false,
  auditHasMore = false,
  onLoadMoreChat = async () => undefined,
  onLoadMoreAudit = async () => undefined,

  selectedFindingId,
  onFindingSelect
}: AnalysisPanelProps) {
  const [activeTab, setActiveTab] = useState<SupportTab>("analysis");
  const [notes, setNotes] = useState(decision?.notes ?? "");
  const [selectedAction, setSelectedAction] = useState<ReviewerDecision["action"] | undefined>(
    decision?.action
  );
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const isOfficer = userRole === "export-control-officer";
  const analysisActionLabel = analysisState.status === "running"
    ? "Analyzing..."
    : isOfficer
      ? "Approve & Analyze"
      : councilApproval?.usable
        ? "Run Approved Analysis"
        : "Request Officer Approval";
  useEffect(() => {
    setNotes(decision?.notes ?? "");
    setSelectedAction(decision?.action);
  }, [decision?.action, decision?.notes, memo.id]);
  const citations = result
    ? [
    ...new Set([
      ...result.jurisdiction.sourceChunkIds,
      ...result.recommended.sourceChunkIds,
      ...result.findings.flatMap((finding) => finding.sourceChunkIds)
    ])
  ]
    .map((id) => getSourceChunk(id))
    .filter(Boolean)
    : [];
  const readiness = result ? summarizeReadiness(result) : undefined;
  const hasBlockingEvidence = Boolean(readiness?.blockers);
  const acceptBlocked = selectedAction === "accept" && hasBlockingEvidence;
  const canSubmit = Boolean(selectedAction && notes.trim()) && !acceptBlocked && !memoDraftDirty;
  const selectedFinding = result?.findings.find((finding) => finding.id === selectedFindingId);
  useEffect(() => {
    setActiveTab(
      preferredSupportTab({
        result,
        analysisStatus: analysisState.status,
        hasBlockingEvidence,
        decisionAction: decision?.action
      })
    );
  }, [memo.id, result?.generatedAt, analysisState.status, hasBlockingEvidence, decision?.action]);
  const tabs = (
    <SupportTabs activeTab={activeTab} onTabChange={setActiveTab} />
  );
  const chatPanel = (
    <MemoChatPanel
      memo={memo}
      chatMessages={chatMessages}
      analysisLocked={analysisLocked}
      memoDraftDirty={memoDraftDirty}
      onSendChat={onSendChat}
      onApplyChatSuggestion={onApplyChatSuggestion}
      hasMore={chatHasMore}
      onLoadMore={onLoadMoreChat}
      userRole={userRole}
    />
  );

  if (!result || analysisState.status === "unanalyzed" || analysisState.status === "running") {
    return (
      <aside className="analysis-panel">
        <div className="analysis-title">
          <div>
            <h2>Review Decision Support</h2>
            <span>{analysisState.status === "running" ? "AI working" : "Unanalyzed"}</span>
          </div>
        </div>
        {tabs}

        {activeTab === "chat" ? chatPanel : (
          <>
            <section className={`analysis-status-card ${analysisState.status}`}>
              <strong>{analysisState.status === "running" ? "AI analysis is running" : "This memo is unanalyzed"}</strong>
              <p>{analysisState.message}</p>
              <small>{backendNotice}</small>
              <AnalysisModeSelector
                mode={analysisMode}
                onModeChange={onAnalysisModeChange}
                disabled={analysisState.status === "running"}
              />
              <CouncilApprovalCard
                memo={memo}
                approval={councilApproval}
                isOfficer={isOfficer}
                busy={approvalBusy}
                onRevoke={onRevokeCouncilApproval}
              />
              <button
                type="button"
                className="button primary full"
                onClick={onRunAnalysis}
                disabled={analysisState.status === "running" || approvalBusy || memoDraftDirty || !liveAnalysisAvailable}
                title={
                  memoDraftDirty
                    ? "Save or discard memo edits before running analysis."
                    : !liveAnalysisAvailable
                      ? "Live AI analysis is unavailable."
                      : undefined
                }
              >
                {analysisActionLabel}
              </button>
            </section>

            <section className="analysis-section">
              <h3>{activeTab === "decision" ? "Decision Pending" : activeTab === "audit" ? "Audit Trail" : "What happens next"}</h3>
              <p className="empty-note">
                {activeTab === "decision"
                  ? "Run analysis before recording a reviewer decision."
                  : activeTab === "audit"
                    ? "Audit events will appear here as intake, analysis, chat edits, and decisions are recorded."
                    : "Rulix requires live AI analysis for reviewer-facing results. If live AI fails or is unavailable, no analysis result is recorded."}
              </p>
            </section>
          </>
        )}
      </aside>
    );
  }

  return (
    <aside className="analysis-panel">
      <div className="analysis-title">
        <div>
          <h2>Review Decision Support</h2>
          <span>{readiness?.label}</span>
        </div>
      </div>
      {tabs}

      {activeTab === "chat" && chatPanel}

      {activeTab === "analysis" && (
        <>
          <section className={`analysis-status-banner ${analysisState.status}`}>
            <strong>{analysisStatusTitle(analysisState.status)}</strong>
            <span>{analysisState.message}</span>
            <button
              type="button"
              className="button small"
              onClick={onRunAnalysis}
              disabled={approvalBusy || memoDraftDirty || !liveAnalysisAvailable}
              title={
                memoDraftDirty
                  ? "Save or discard memo edits before rerunning analysis."
                  : !liveAnalysisAvailable
                    ? "Live AI analysis is unavailable."
                    : undefined
              }
            >
              {isOfficer ? "Approve & Re-run" : councilApproval?.usable ? "Run Approved Analysis" : "Request Approval"}
            </button>
          </section>

          <section className="analysis-section">
            <h3>Analysis Mode</h3>
            <AnalysisModeSelector mode={analysisMode} onModeChange={onAnalysisModeChange} />
            <CouncilApprovalCard
              memo={memo}
              approval={councilApproval}
              isOfficer={isOfficer}
              busy={approvalBusy}
              onRevoke={onRevokeCouncilApproval}
            />
            <div className="run-metadata">
              <strong>Last result</strong>
              <span>
                {result.provider.label} | {result.provider.model} | {depthLabel(result.provider.depth)}
              </span>
            </div>
          </section>

          <section className="review-checklist">
            <ChecklistItem
              label="Jurisdiction"
              value={result.jurisdiction.outcome === "ear-likely" ? "EAR path likely" : "Review needed"}
              tone={result.jurisdiction.outcome === "ear-likely" ? "pass" : "review"}
            />
            <ChecklistItem
              label="Blocking evidence"
              value={`${readiness!.counts.conflict + readiness!.counts.missing} item${
                readiness!.counts.conflict + readiness!.counts.missing === 1 ? "" : "s"
              }`}
              tone={readiness!.blockers ? "review" : "pass"}
            />
            <ChecklistItem
              label="Recommendation"
              value={result.recommended.eccn}
              tone={result.recommended.risk === "high" ? "review" : "pass"}
            />
          </section>

          {result.formatChecks && result.formatChecks.length > 0 && (
            <section className="format-compliance">
              <h3>Analysis Quality</h3>
              <div className="format-check-list">
                {result.formatChecks.map((fc) => (
                  <div key={fc.key} className={`format-check-row ${fc.pass ? "pass" : "fail"}`}>
                    {fc.pass
                      ? <CheckSquare size={14} className="fc-icon pass" />
                      : <XSquare size={14} className="fc-icon fail" />}
                    <span className="fc-label">{fc.label}</span>
                    {fc.note && <span className="fc-note">{fc.note}</span>}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="jurisdiction-box">
        <div className="box-heading">
          <ShieldCheck size={21} />
          <strong>Jurisdiction Gate</strong>
          <span className={`gate-status ${result.jurisdiction.outcome}`}>
            {result.jurisdiction.outcome === "ear-likely" ? "Pass" : "Review"}
          </span>
        </div>
        <p dangerouslySetInnerHTML={{ __html: renderInline(result.jurisdiction.summary) }} />
        <p>
          <strong>Reason:</strong>{" "}
          <span dangerouslySetInnerHTML={{ __html: renderInline(result.jurisdiction.rationale) }} />
        </p>
      </section>

          <section className="recommendation">
            <h3>{result.recommended.eccn}</h3>
            <p>{result.recommended.label}</p>
            <div className="eccn-explanation">
              <strong>Why this recommendation</strong>
              <p dangerouslySetInnerHTML={{ __html: renderInline(result.recommended.summary) }} />
              <small>
                Confidence {Math.round(result.recommended.confidence * 100)}% | Risk {result.recommended.risk}
              </small>
              {result.findings.length > 0 && (
                <ul>
                  {result.findings.slice(0, 3).map((finding) => (
                    <li key={finding.id}>
                      <strong>{finding.status}:</strong>{" "}
                      <span dangerouslySetInnerHTML={{ __html: renderInline(finding.claim) }} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <SafeExternalLink href={firstSourceUrl(result)}>
              View ECCN Guidance <ExternalLink size={15} />
            </SafeExternalLink>
          </section>

          <section className="analysis-section">
        <h3>Evidence Map</h3>
        <div className="finding-list">
          {result.findings.map((finding, index) => (
            <button
              className={finding.id === selectedFindingId ? "finding-row selected" : "finding-row"}
              type="button"
              key={finding.id}
              onClick={() => onFindingSelect(finding.id === selectedFindingId ? undefined : finding.id)}
            >
              <span className={`finding-badge ${finding.status}`}>{index + 1}</span>
              <span>{finding.title}</span>
              <strong className={finding.status}>{finding.status}</strong>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
        {selectedFinding && (
          <div className="finding-detail">
            <div>
              <strong>{selectedFinding.title}</strong>
              <span className={selectedFinding.severity}>{selectedFinding.severity}</span>
            </div>
            <p>{selectedFinding.rationale}</p>
            <small>{selectedFinding.claim}</small>
            {selectedFinding.sourceChunkIds.length > 0 && (
              <div className="finding-sources">
                {selectedFinding.sourceChunkIds.map((id) => {
                  const source = getSourceChunk(id);
                  return source ? (
                    <SafeExternalLink href={source.url} key={id}>
                      {source.locator}
                    </SafeExternalLink>
                  ) : null;
                })}
              </div>
            )}
          </div>
        )}
      </section>

          {result.infoRequests.length > 0 && (
            <section className="analysis-section info-request-section">
              <h3>Information to Request</h3>
              <ul>
                {result.infoRequests.slice(0, 6).map((request) => (
                  <li key={request}>{request}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="analysis-section">
        <h3>Source Citations</h3>
        <div className="citation-list">
          {citations.slice(0, 6).map((chunk) => (
            <SafeExternalLink href={chunk!.url} key={chunk!.id}>
              <FileText size={18} />
              <span>
                <strong>{chunk!.locator}</strong>
                <small>{chunk!.title}</small>
              </span>
              <small>Official Corpus v2026.06</small>
              <ExternalLink size={14} />
            </SafeExternalLink>
          ))}
        </div>
      </section>

          <section className={`provider-box compact ${result.provider.source}`}>
            {result.provider.live ? (
              <Cloud size={16} />
            ) : result.provider.source === "fallback" ? (
              <WifiOff size={16} />
            ) : (
              <Cpu size={16} />
            )}
            <p>{result.provider.message}</p>
          </section>
        </>
      )}

      {activeTab === "audit" && (
        <section className="analysis-section">
        <h3>Audit Trail</h3>
        <div className="audit-mini-list">
          {auditEvents.map((event) => (
            <div className="audit-mini-row" key={event.id}>
              <span className={`status-dot ${event.severity === "info" ? "green" : "amber"}`} />
              <strong>{event.action}</strong>
              <span>{formatAuditTime(event.at)}</span>
            </div>
          ))}
          {auditEvents.length === 0 && <p className="empty-note">No audit events recorded yet.</p>}
          {auditHasMore && (
            <button type="button" className="button small full" onClick={() => void onLoadMoreAudit(memo.id)}>
              Load more audit events
            </button>
          )}
        </div>
      </section>
      )}

      {activeTab === "decision" && (
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
            className={selectedAction === "accept" ? "decision-button accept selected" : "decision-button accept"}
            disabled={hasBlockingEvidence || memoDraftDirty}
            title={
              memoDraftDirty
                ? "Save or discard memo edits before recording a decision."
                : hasBlockingEvidence
                  ? "Resolve missing or conflicting evidence before accepting."
                  : "Accept recommendation"
            }
            onClick={() => setSelectedAction("accept")}
          >
            <Check size={16} /> Accept Recommendation
          </button>
          <button
            type="button"
            className={selectedAction === "request-info" ? "decision-button info selected" : "decision-button info"}
            disabled={memoDraftDirty}
            title={memoDraftDirty ? "Save or discard memo edits before recording a decision." : undefined}
            onClick={() => setSelectedAction("request-info")}
          >
            <AlertTriangle size={16} /> Request More Info
          </button>
          <button
            type="button"
            className={selectedAction === "override" ? "decision-button override selected" : "decision-button override"}
            disabled={memoDraftDirty}
            title={memoDraftDirty ? "Save or discard memo edits before recording a decision." : undefined}
            onClick={() => setSelectedAction("override")}
          >
            <X size={16} /> Override / Change ECCN
          </button>
        </div>
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Add decision notes (required for signoff)..."
          rows={4}
          disabled={memoDraftDirty}
        />
        <button
          type="button"
          className="button signoff full"
          disabled={!canSubmit || decisionBusy}
          onClick={() => {
            if (selectedAction && notes.trim()) {
              setDecisionBusy(true);
              setDecisionError("");
              void onDecision(selectedAction, notes.trim())
                .catch((error) => {
                  setDecisionError(error instanceof Error ? error.message : "Decision was not recorded.");
                })
                .finally(() => setDecisionBusy(false));
            }
          }}
        >
          <UserRound size={17} /> {decisionBusy ? "Recording..." : "Record Decision"}
        </button>
        {decisionError && <p className="decision-state warning">{decisionError}</p>}
        {acceptBlocked && (
          <p className="decision-state warning">
            Missing or conflicting evidence is still blocking acceptance. Request more info or override instead.
          </p>
        )}
        {memoDraftDirty && (
          <p className="decision-state warning">
            Save or discard memo edits before recording a decision.
          </p>
        )}
        {decision && <p className="decision-state">Current action: {decision.action}</p>}
      </section>
      )}
    </aside>
  );
}

function CouncilApprovalCard({
  memo,
  approval,
  isOfficer,
  busy,
  onRevoke
}: {
  memo: MemoRecord;
  approval?: CouncilApprovalView;
  isOfficer: boolean;
  busy: boolean;
  onRevoke: () => Promise<void> | void;
}) {
  const status = approval?.approval;
  const label = approval?.usable
    ? "Approved for one exact dispatch"
    : status?.revocation
      ? "Approval revoked"
      : status && status.dispatchesReserved >= status.approval.dispatchLimit
        ? "Approval already used"
        : status
          ? "Approval no longer matches"
          : "Officer approval required";
  return (
    <div className={`ai-approval-card ${approval?.usable ? "approved" : "pending"}`}>
      <div>
        <strong>{label}</strong>
        <span>
          Revision {memo.revision ?? 1} · {approval?.depth === "deep" ? "deep" : "standard"} · hash {(memo.contentHash ?? "not-loaded").slice(0, 10)}…
        </span>
        {status?.approval.expiresAt && (
          <small>Expires {formatAuditTime(status.approval.expiresAt)}; any memo or mode edit invalidates it.</small>
        )}
      </div>
      {isOfficer && status?.current && !status.revocation && status.dispatchesReserved === 0 && (
        <button type="button" className="button small" disabled={busy} onClick={() => void onRevoke()}>
          Revoke
        </button>
      )}
    </div>
  );
}

function SupportTabs({
  activeTab,
  onTabChange
}: {
  activeTab: SupportTab;
  onTabChange: (tab: SupportTab) => void;
}) {
  const tabs: Array<{ id: SupportTab; label: string }> = [
    { id: "chat", label: "Chat" },
    { id: "analysis", label: "Analysis" },
    { id: "decision", label: "Decision" },
    { id: "audit", label: "Audit" }
  ];

  return (
    <div className="support-tabs" aria-label="Support panel sections">
      {tabs.map((tab) => (
        <button
          type="button"
          className={activeTab === tab.id ? "active" : ""}
          onClick={() => onTabChange(tab.id)}
          key={tab.id}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function analysisStatusTitle(status: AnalysisPanelProps["analysisState"]["status"]) {
  if (status === "live") return "Live AI analysis";
  if (status === "failed") return "AI analysis unavailable";
  if (status === "running") return "AI analysis running";
  return "Unanalyzed";
}

function preferredSupportTab({
  result,
  analysisStatus,
  hasBlockingEvidence,
  decisionAction
}: {
  result?: ReviewResult;
  analysisStatus: AnalysisPanelProps["analysisState"]["status"];
  hasBlockingEvidence: boolean;
  decisionAction?: ReviewerDecision["action"];
}): SupportTab {
  if (!result || analysisStatus === "unanalyzed" || analysisStatus === "running") return "analysis";
  if (decisionAction) return "audit";
  if (hasBlockingEvidence) return "analysis";
  return "decision";
}

function depthLabel(depth: ReviewResult["provider"]["depth"]) {
  return depth === "deep" ? "Deep Council Pass" : "Full AI Council";
}

function formatAuditTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function ChecklistItem({
  label,
  value,
  tone
}: {
  label: string;
  value: string;
  tone: "pass" | "review";
}) {
  return (
    <div className={`checklist-item ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AnalysisModeSelector({
  mode,
  onModeChange,
  disabled = false
}: {
  mode: AnalysisMode;
  onModeChange: (mode: AnalysisMode) => void;
  disabled?: boolean;
}) {
  return (
    <div className="analysis-mode-selector" aria-label="Analysis mode">
      {(Object.keys(ANALYSIS_MODE_CONFIG) as AnalysisMode[]).map((option) => {
        const config = ANALYSIS_MODE_CONFIG[option];
        return (
          <button
            type="button"
            className={mode === option ? "analysis-mode-card selected" : "analysis-mode-card"}
            onClick={() => onModeChange(option)}
            disabled={disabled}
            key={option}
          >
            <strong>{config.label}</strong>
            <span>{config.cost}</span>
            <small>{config.description}</small>
          </button>
        );
      })}
    </div>
  );
}

function firstSourceUrl(result: ReviewResult) {
  const first = getSourceChunk(result.recommended.sourceChunkIds[0]);
  return first?.url ?? "https://www.bis.gov/licensing/classify-your-item";
}
