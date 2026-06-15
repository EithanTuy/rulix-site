import { useEffect, useMemo, useState } from "react";
import { officialCorpus } from "./data/corpus";
import { sampleMemos } from "./data/sampleMemos";
import {
  analyzeMemoWithBackend,
  getBackendHealth,
  type AnalysisMode,
  ANALYSIS_MODE_CONFIG,
  type BackendHealth
} from "./lib/apiClient";
import { analyzeMemo } from "./lib/eccnReview";
import { memoFromFile } from "./lib/documentIntake";
import { buildReviewReport } from "./lib/report";
import { createAuditEvent, deriveReviewStatus, seedAuditEvents } from "./lib/reviewLifecycle";
import { loadJson, saveJson } from "./lib/storage";
import type { AppView, AuditEvent, MemoRecord, NewReviewInput, ReviewerDecision, ReviewResult } from "./types";
import { AdminConsole } from "./components/AdminConsole";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { MemoWorkspace } from "./components/MemoWorkspace";
import { NewReviewModal } from "./components/NewReviewModal";
import { ReviewList } from "./components/ReviewList";
import { SidebarRail } from "./components/SidebarRail";
import { TopBar } from "./components/TopBar";

const STORAGE_KEYS = {
  memos: "rulix-eccn:memos",
  decisions: "rulix-eccn:decisions",
  auditEvents: "rulix-eccn:audit-events",
  selectedMemoId: "rulix-eccn:selected-memo-id",
  analysisResults: "rulix-eccn:analysis-results",
  analysisStates: "rulix-eccn:analysis-states",
  analysisMode: "rulix-eccn:analysis-mode"
};

type AnalysisRunState =
  | { status: "unanalyzed"; message: string }
  | { status: "running"; message: string }
  | { status: "live"; message: string }
  | { status: "deterministic"; message: string }
  | { status: "failed"; message: string };

export function App() {
  const [memos, setMemos] = useState<MemoRecord[]>(() =>
    loadJson(STORAGE_KEYS.memos, sampleMemos)
  );
  const [selectedMemoId, setSelectedMemoId] = useState(() =>
    loadJson(STORAGE_KEYS.selectedMemoId, sampleMemos[0].id)
  );
  const [search, setSearch] = useState("");
  const [intakeWarning, setIntakeWarning] = useState<string | undefined>();
  const [decisions, setDecisions] = useState<Record<string, ReviewerDecision>>(() =>
    loadJson(STORAGE_KEYS.decisions, {})
  );
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>(() =>
    loadJson(STORAGE_KEYS.auditEvents, seedAuditEvents(sampleMemos))
  );
  const [activeView, setActiveView] = useState<AppView>("reviews");
  const [newReviewOpen, setNewReviewOpen] = useState(false);
  const [exportNotice, setExportNotice] = useState("");
  const [backendHealth, setBackendHealth] = useState<BackendHealth | undefined>();
  const [backendNotice, setBackendNotice] = useState("Checking backend AI service...");
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>(() =>
    loadJson(STORAGE_KEYS.analysisMode, "standard")
  );
  const [analysisResults, setAnalysisResults] = useState<Record<string, ReviewResult>>(() =>
    loadJson(
      STORAGE_KEYS.analysisResults,
      Object.fromEntries(sampleMemos.map((memo) => [memo.id, analyzeMemo(memo)]))
    )
  );
  const [analysisStates, setAnalysisStates] = useState<Record<string, AnalysisRunState>>(() =>
    normalizeAnalysisStates(
      loadJson(
        STORAGE_KEYS.analysisStates,
        Object.fromEntries(
          sampleMemos.map((memo) => [
            memo.id,
            {
              status: "deterministic",
              message: "Seed sample has deterministic analysis. Run AI Analysis to refresh it."
            }
          ])
        )
      )
    )
  );
  const [selectedFindingId, setSelectedFindingId] = useState<string | undefined>();

  const selectedMemo = memos.find((memo) => memo.id === selectedMemoId) ?? memos[0] ?? sampleMemos[0];
  const reviewResult = analysisResults[selectedMemo.id];
  const analysisState = analysisStates[selectedMemo.id] ?? {
    status: "unanalyzed",
    message: "This memo has not been analyzed yet."
  };
  const decision = decisions[selectedMemo.id];
  const reviewResults = useMemo(() => analysisResults, [analysisResults]);

  useEffect(() => {
    const controller = new AbortController();
    getBackendHealth(controller.signal)
      .then((health) => {
        setBackendHealth(health);
        setBackendNotice(
          health.provider.configured
            ? `AI provider configured: ${health.provider.model}.`
            : "No AI provider key is configured. Analysis will use deterministic rules."
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setBackendNotice("Backend unavailable. Showing deterministic local analysis.");
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => saveJson(STORAGE_KEYS.memos, memos), [memos]);
  useEffect(() => saveJson(STORAGE_KEYS.decisions, decisions), [decisions]);
  useEffect(() => saveJson(STORAGE_KEYS.auditEvents, auditEvents), [auditEvents]);
  useEffect(() => saveJson(STORAGE_KEYS.analysisResults, analysisResults), [analysisResults]);
  useEffect(() => saveJson(STORAGE_KEYS.analysisStates, analysisStates), [analysisStates]);
  useEffect(() => saveJson(STORAGE_KEYS.analysisMode, analysisMode), [analysisMode]);
  useEffect(() => saveJson(STORAGE_KEYS.selectedMemoId, selectedMemo.id), [selectedMemo.id]);
  useEffect(() => {
    if (memos.length > 0 && !memos.some((memo) => memo.id === selectedMemoId)) {
      setSelectedMemoId(memos[0].id);
    }
  }, [memos, selectedMemoId]);
  useEffect(() => setSelectedFindingId(undefined), [selectedMemo.id]);

  const filteredMemos = memos.filter((memo) =>
    `${memo.title} ${memo.documentCode} ${memo.itemFamily}`
      .toLowerCase()
      .includes(search.toLowerCase())
  );

  const handleFile = async (file: File) => {
    const result = await memoFromFile(file);
    const reviewedMemo = {
      ...result.memo,
      status: "draft" as const
    };
    setIntakeWarning(result.warning);
    setMemos((current) => [reviewedMemo, ...current]);
    setAuditEvents((current) => [
      createAuditEvent(
        reviewedMemo.id,
        "Document intake",
        result.warning ?? `Uploaded ${file.name}. Analysis has not been run yet.`,
        result.warning ? "review" : "info"
      ),
      ...current
    ]);
    setAnalysisStates((current) => ({
      ...current,
      [reviewedMemo.id]: {
        status: "unanalyzed",
        message: "Uploaded memo is waiting for reviewer-initiated AI analysis."
      }
    }));
    setSelectedMemoId(reviewedMemo.id);
    setActiveView("reviews");
  };

  const handlePasteMemo = (title: string, text: string) => {
    const now = new Date().toISOString().slice(0, 10);
    const memo: MemoRecord = {
      id: `paste-${Date.now()}`,
      title: title.trim() || "Pasted ECCN Memo",
      itemFamily: "Pasted memo",
      owner: "You",
      updatedAt: now,
      documentCode: `PASTE-${now.replaceAll("-", "")}`,
      status: "draft",
      dataClass: "proprietary",
      sourcePath: "self-classification",
      attachments: [],
      memoText: text
    };
    setMemos((current) => [memo, ...current]);
    setAuditEvents((current) => [
      createAuditEvent(memo.id, "Memo pasted", "Pasted memo text. Analysis has not been run yet.", "info"),
      ...current
    ]);
    setAnalysisStates((current) => ({
      ...current,
      [memo.id]: {
        status: "unanalyzed",
        message: "Pasted memo is waiting for reviewer-initiated AI analysis."
      }
    }));
    setSelectedMemoId(memo.id);
    setIntakeWarning(undefined);
    setActiveView("reviews");
  };

  const handleCreateReview = (input: NewReviewInput) => {
    const now = new Date().toISOString().slice(0, 10);
    const memo: MemoRecord = {
      id: `review-${Date.now()}`,
      title: input.title.trim() || "New ECCN Classification Memo",
      itemFamily: input.itemFamily.trim() || "Research equipment",
      owner: "You",
      updatedAt: now,
      documentCode: `REV-${now.replaceAll("-", "")}-${memos.length + 1}`,
      status: "draft",
      memoText: input.memoText,
      attachments: input.attachments,
      dataClass: input.dataClass,
      sourcePath: input.sourcePath,
      manufacturer: input.manufacturer,
      intendedUse: input.intendedUse
    };
    setMemos((current) => [memo, ...current]);
    setAuditEvents((current) => [
      createAuditEvent(
        memo.id,
        "Review created",
        `New ${input.sourcePath ?? "classification"} review created with ${input.dataClass} data marking. Analysis has not been run yet.`,
        input.dataClass === "itar-risk" || input.dataClass === "cui" ? "escalate" : "info"
      ),
      ...current
    ]);
    setAnalysisStates((current) => ({
      ...current,
      [memo.id]: {
        status: "unanalyzed",
        message: "New review is waiting for reviewer-initiated AI analysis."
      }
    }));
    setSelectedMemoId(memo.id);
    setActiveView("reviews");
    setIntakeWarning(undefined);
  };

  const updateMemoText = (memoId: string, memoText: string) => {
    setMemos((current) =>
      current.map((memo) =>
        memo.id === memoId
          ? {
              ...memo,
              memoText,
              updatedAt: new Date().toISOString().slice(0, 10),
              status: "draft"
            }
          : memo
      )
    );
    setAnalysisResults((current) => {
      const next = { ...current };
      delete next[memoId];
      return next;
    });
    setAnalysisStates((current) => ({
      ...current,
      [memoId]: {
        status: "unanalyzed",
        message: "Memo text changed. Run AI Analysis again before recording a decision."
      }
    }));
    setDecisions((current) => {
      const next = { ...current };
      delete next[memoId];
      return next;
    });
    setAuditEvents((current) => [
      createAuditEvent(memoId, "Memo edited", "Memo text changed; prior signoff was cleared.", "review"),
      ...current
    ]);
  };

  const handleDecision = (action: ReviewerDecision["action"], notes: string) => {
    if (!reviewResult) return;
    const nextDecision = {
      action,
      notes,
      signedBy: action === "accept" ? "Reviewer JW" : undefined,
      signedAt: action === "accept" ? new Date().toISOString() : undefined
    };
    setDecisions((current) => ({
      ...current,
      [selectedMemo.id]: nextDecision
    }));
    setMemos((current) =>
      current.map((memo) =>
        memo.id === selectedMemo.id
          ? { ...memo, status: deriveReviewStatus(reviewResult, nextDecision) }
          : memo
      )
    );
    setAuditEvents((current) => [
      createAuditEvent(
        selectedMemo.id,
        `Reviewer decision: ${action}`,
        notes,
        action === "override" ? "escalate" : action === "request-info" ? "review" : "info"
      ),
      ...current
    ]);
  };

  const exportReport = () => {
    if (!reviewResult) {
      setExportNotice("Run analysis before export");
      window.setTimeout(() => setExportNotice(""), 3200);
      return;
    }
    const report = buildReviewReport(
      selectedMemo,
      reviewResult,
      decision,
      auditEvents.filter((event) => event.memoId === selectedMemo.id)
    );
    const blob = new Blob([report], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${selectedMemo.documentCode}-eccn-review.md`;
    anchor.click();
    setExportNotice("Report exported");
    window.setTimeout(() => setExportNotice(""), 3200);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const runAnalysis = async () => {
    const memo = selectedMemo;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 180000);
    setAnalysisStates((current) => ({
      ...current,
      [memo.id]: {
        status: "running",
        message: backendHealth?.provider.configured
          ? `${ANALYSIS_MODE_CONFIG[analysisMode].label} is analyzing this memo with ${ANALYSIS_MODE_CONFIG[analysisMode].model}. If it does not finish in 3 minutes, deterministic analysis will be recorded.`
          : "No AI provider is configured. Running deterministic analysis."
      }
    }));

    try {
      const result = await analyzeMemoWithBackend(memo, analysisMode, controller.signal);
      window.clearTimeout(timeoutId);
      const failedToUseLiveAi = backendHealth?.provider.configured && result.provider.source !== "anthropic";
      setAnalysisResults((current) => ({ ...current, [memo.id]: result }));
      setAnalysisStates((current) => ({
        ...current,
        [memo.id]: failedToUseLiveAi
          ? {
              status: "failed",
              message: `${result.provider.message} Deterministic rules were used for this result.`
            }
          : result.provider.live
            ? {
                status: "live",
                message: "Live AI analysis completed. Reviewer signoff is still required."
              }
            : {
                status: "deterministic",
                message: "Deterministic analysis completed because no live AI provider was used."
              }
      }));
      setMemos((current) =>
        current.map((item) =>
          item.id === memo.id
            ? { ...item, status: deriveReviewStatus(result, decisions[memo.id]) }
            : item
        )
      );
      setAuditEvents((current) => [
        createAuditEvent(
          memo.id,
          failedToUseLiveAi ? "Deterministic analysis recorded" : "Analysis completed",
          failedToUseLiveAi
            ? "Live AI did not complete; deterministic analysis is shown."
            : `${ANALYSIS_MODE_CONFIG[analysisMode].label}: ${result.provider.message}`,
          failedToUseLiveAi ? "review" : "info"
        ),
        ...current
      ]);
    } catch {
      window.clearTimeout(timeoutId);
      const result = analyzeMemo(memo);
      setAnalysisResults((current) => ({ ...current, [memo.id]: result }));
      setAnalysisStates((current) => ({
        ...current,
        [memo.id]: {
          status: "failed",
          message: "AI analysis request failed. Deterministic rules were used for this result."
        }
      }));
      setMemos((current) =>
        current.map((item) =>
          item.id === memo.id
            ? { ...item, status: deriveReviewStatus(result, decisions[memo.id]) }
            : item
        )
      );
      setAuditEvents((current) => [
        createAuditEvent(
          memo.id,
          "AI analysis failed",
          "Backend AI analysis failed; deterministic analysis was recorded instead.",
          "review"
        ),
        ...current
      ]);
    }
  };

  return (
    <div className="app-shell">
      <TopBar
        tenant="Research Facility Pilot"
        onNewReview={() => setNewReviewOpen(true)}
        onExport={exportReport}
        onSignoff={() => {
          setActiveView("reviews");
          window.setTimeout(() => {
            document.querySelector(".decision-box")?.scrollIntoView({ behavior: "smooth", block: "start" });
          }, 0);
        }}
        signoffReady={decision?.action === "accept"}
        exportNotice={exportNotice}
      />
      <div className={activeView === "reviews" ? "workspace-grid" : "workspace-grid console-mode"}>
        <SidebarRail activeView={activeView} onViewChange={setActiveView} />
        {activeView === "reviews" ? (
          <>
            <ReviewList
              memos={filteredMemos}
              selectedMemoId={selectedMemo.id}
              search={search}
              warning={intakeWarning}
              corpusLabel={officialCorpus.label}
              onSearch={setSearch}
              onSelect={setSelectedMemoId}
              onFile={handleFile}
              onPasteMemo={handlePasteMemo}
            />
            <MemoWorkspace
              memo={selectedMemo}
              result={reviewResult}
              selectedFindingId={selectedFindingId}
              onMemoTextChange={updateMemoText}
            />
            <AnalysisPanel
              memo={selectedMemo}
              result={reviewResult}
              analysisState={analysisState}
              analysisMode={analysisMode}
              onAnalysisModeChange={setAnalysisMode}
              backendNotice={backendNotice}
              onRunAnalysis={runAnalysis}
              decision={decision}
              auditEvents={auditEvents.filter((event) => event.memoId === selectedMemo.id)}
              onDecision={handleDecision}
              selectedFindingId={selectedFindingId}
              onFindingSelect={setSelectedFindingId}
            />
          </>
        ) : (
          <AdminConsole
            view={activeView}
            memos={memos}
            decisions={decisions}
            auditEvents={auditEvents}
            reviewResults={reviewResults}
            corpus={officialCorpus}
            onSelectMemo={(memoId) => {
              setSelectedMemoId(memoId);
              setActiveView("reviews");
            }}
          />
        )}
      </div>
      <NewReviewModal
        open={newReviewOpen}
        onClose={() => setNewReviewOpen(false)}
        onCreate={handleCreateReview}
      />
    </div>
  );
}

function normalizeAnalysisStates(states: Record<string, AnalysisRunState>) {
  return Object.fromEntries(
    Object.entries(states).map(([memoId, state]) => [
      memoId,
      state.status === "running"
        ? {
            status: "failed",
            message:
              "Previous AI analysis did not finish before the app was closed or reloaded. Run AI Analysis to try again."
          }
        : state
    ])
  ) as Record<string, AnalysisRunState>;
}
