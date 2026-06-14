import { useEffect, useMemo, useState } from "react";
import { officialCorpus } from "./data/corpus";
import { sampleMemos } from "./data/sampleMemos";
import { analyzeMemoWithBackend, getBackendHealth, type BackendHealth } from "./lib/apiClient";
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
  selectedMemoId: "rulix-eccn:selected-memo-id"
};

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
  const [backendReviewResult, setBackendReviewResult] = useState<ReviewResult | undefined>();

  const selectedMemo = memos.find((memo) => memo.id === selectedMemoId) ?? memos[0] ?? sampleMemos[0];
  const localReviewResult = useMemo(() => analyzeMemo(selectedMemo), [selectedMemo]);
  const reviewResult = useMemo(() => {
    if (backendReviewResult?.memoId === selectedMemo.id) return backendReviewResult;
    return {
      ...localReviewResult,
      provider: {
        ...localReviewResult.provider,
        message: backendNotice
      }
    };
  }, [backendNotice, backendReviewResult, localReviewResult, selectedMemo.id]);
  const decision = decisions[selectedMemo.id];
  const reviewResults = useMemo(
    () => Object.fromEntries(memos.map((memo) => [memo.id, analyzeMemo(memo)])),
    [memos]
  );

  useEffect(() => {
    const controller = new AbortController();
    getBackendHealth(controller.signal)
      .then((health) => {
        setBackendHealth(health);
        setBackendNotice(
          health.provider.configured
            ? `Backend connected to ${health.provider.model}. Running live council analysis...`
            : "Backend connected without an Anthropic key. Showing deterministic local analysis."
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setBackendNotice("Backend unavailable. Showing deterministic local analysis.");
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setBackendReviewResult(undefined);
    setBackendNotice(
      backendHealth?.provider.configured
        ? `Running ${backendHealth.provider.model} council analysis...`
        : "Checking backend council service..."
    );

    analyzeMemoWithBackend(selectedMemo, controller.signal)
      .then((result) => {
        setBackendReviewResult(result);
        setBackendNotice(result.provider.message);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setBackendNotice("Backend unavailable. Showing deterministic local analysis.");
        }
      });

    return () => controller.abort();
  }, [backendHealth?.provider.configured, backendHealth?.provider.model, selectedMemo]);

  useEffect(() => saveJson(STORAGE_KEYS.memos, memos), [memos]);
  useEffect(() => saveJson(STORAGE_KEYS.decisions, decisions), [decisions]);
  useEffect(() => saveJson(STORAGE_KEYS.auditEvents, auditEvents), [auditEvents]);
  useEffect(() => saveJson(STORAGE_KEYS.selectedMemoId, selectedMemo.id), [selectedMemo.id]);
  useEffect(() => {
    if (memos.length > 0 && !memos.some((memo) => memo.id === selectedMemoId)) {
      setSelectedMemoId(memos[0].id);
    }
  }, [memos, selectedMemoId]);

  const filteredMemos = memos.filter((memo) =>
    `${memo.title} ${memo.documentCode} ${memo.itemFamily}`
      .toLowerCase()
      .includes(search.toLowerCase())
  );

  const handleFile = async (file: File) => {
    const result = await memoFromFile(file);
    const reviewedMemo = {
      ...result.memo,
      status: deriveReviewStatus(analyzeMemo(result.memo))
    };
    setIntakeWarning(result.warning);
    setMemos((current) => [reviewedMemo, ...current]);
    setAuditEvents((current) => [
      createAuditEvent(
        reviewedMemo.id,
        "Document intake",
        result.warning ?? `Uploaded ${file.name} and queued local AI council review.`,
        result.warning ? "review" : "info"
      ),
      ...current
    ]);
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
    const reviewedMemo = { ...memo, status: deriveReviewStatus(analyzeMemo(memo)) };
    setMemos((current) => [reviewedMemo, ...current]);
    setAuditEvents((current) => [
      createAuditEvent(reviewedMemo.id, "Memo pasted", "Pasted memo text and started review.", "info"),
      ...current
    ]);
    setSelectedMemoId(reviewedMemo.id);
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
    const initialResult = analyzeMemo(memo);
    const status = deriveReviewStatus(initialResult);
    setMemos((current) => [{ ...memo, status }, ...current]);
    setAuditEvents((current) => [
      createAuditEvent(
        memo.id,
        "Review created",
        `New ${input.sourcePath ?? "classification"} review created with ${input.dataClass} data marking.`,
        input.dataClass === "itar-risk" || input.dataClass === "cui" ? "escalate" : "info"
      ),
      ...current
    ]);
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
              status: deriveReviewStatus(analyzeMemo({ ...memo, memoText }))
            }
          : memo
      )
    );
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

  return (
    <div className="app-shell">
      <TopBar
        tenant="Research Facility Pilot"
        onNewReview={() => setNewReviewOpen(true)}
        onExport={exportReport}
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
              onMemoTextChange={updateMemoText}
            />
            <AnalysisPanel
              memo={selectedMemo}
              result={reviewResult}
              decision={decision}
              auditEvents={auditEvents.filter((event) => event.memoId === selectedMemo.id)}
              onDecision={handleDecision}
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
