import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { officialCorpus } from "./data/corpus";
import {
  ANALYSIS_MODE_CONFIG,
  type AnalysisMode,
  type BackendHealth,
  type MemoBuildDraft,
  acceptInvite,
  analyzeMemoWithBackend,
  completePasswordReset,
  getBackendHealth,
  getCurrentUser,
  loadAccountState,
  requestPasswordReset,
  saveAccountState,
  sendMemoChat,
  signIn,
  signOut,
  validateInvite,
  validatePasswordReset,
  type InvitePublicInfo,
  type PasswordResetPublicInfo
} from "./lib/apiClient";
import { memoFromFile } from "./lib/documentIntake";
import { buildReviewReport } from "./lib/report";
import { createAuditEvent, deriveReviewStatus } from "./lib/reviewLifecycle";
import type {
  AccountReviewState,
  AppView,
  AuditEvent,
  MemoBuilderSession,
  MemoChatMessage,
  MemoRecord,
  NewReviewInput,
  ReviewerDecision,
  ReviewResult,
  UserProfile
} from "./types";
import { AdminConsole } from "./components/AdminConsole";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { MemoDraftChatPanel } from "./components/MemoDraftChatPanel";
import { MemoWorkspace } from "./components/MemoWorkspace";
import { NewReviewModal } from "./components/NewReviewModal";
import { ReviewList } from "./components/ReviewList";
import { SidebarRail } from "./components/SidebarRail";
import { TopBar } from "./components/TopBar";

type AnalysisRunState =
  | { status: "unanalyzed"; message: string }
  | { status: "running"; message: string }
  | { status: "live"; message: string }
  | { status: "deterministic"; message: string }
  | { status: "failed"; message: string };

type AuthState =
  | { status: "checking" }
  | { status: "signed-out"; error?: string }
  | { status: "signed-in"; user: UserProfile };

const emptyAccountState = (): AccountReviewState => ({
  memos: [],
  decisions: {},
  auditEvents: [],
  analysisResults: {},
  chatMessages: {},
  memoBuilder: { messages: [], sessions: [] }
});

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "checking" });
  const [stateReady, setStateReady] = useState(false);
  const [memos, setMemos] = useState<MemoRecord[]>([]);
  const [selectedMemoId, setSelectedMemoId] = useState<string | undefined>();
  const [search, setSearch] = useState("");
  const [intakeWarning, setIntakeWarning] = useState<string | undefined>();
  const [decisions, setDecisions] = useState<Record<string, ReviewerDecision>>({});
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [analysisResults, setAnalysisResults] = useState<Record<string, ReviewResult>>({});
  const [analysisStates, setAnalysisStates] = useState<Record<string, AnalysisRunState>>({});
  const [chatMessages, setChatMessages] = useState<Record<string, MemoChatMessage[]>>({});
  const [memoBuilderSessions, setMemoBuilderSessions] = useState<MemoBuilderSession[]>([]);
  const [activeMemoBuilderSessionId, setActiveMemoBuilderSessionId] = useState<string | undefined>();
  const [activeView, setActiveView] = useState<AppView>("reviews");
  const [newReviewOpen, setNewReviewOpen] = useState(false);
  const [exportNotice, setExportNotice] = useState("");
  const [syncNotice, setSyncNotice] = useState("Saved to account");
  const [backendHealth, setBackendHealth] = useState<BackendHealth | undefined>();
  const [backendNotice, setBackendNotice] = useState("Checking analysis service...");
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("standard");
  const [selectedFindingId, setSelectedFindingId] = useState<string | undefined>();
  const [memoDraftDirty, setMemoDraftDirty] = useState(false);
  const [panelSizes, setPanelSizes] = useState({ reviewList: 400, analysis: 456 });
  const memosRef = useRef<MemoRecord[]>([]);
  const workspaceRef = useRef<HTMLDivElement | null>(null);

  const activeMemos = useMemo(() => memos.filter((memo) => !memo.archivedAt), [memos]);
  const selectedMemo = selectedMemoId
    ? activeMemos.find((memo) => memo.id === selectedMemoId)
    : activeMemos[0];
  const reviewResult = selectedMemo ? analysisResults[selectedMemo.id] : undefined;
  const analysisState = selectedMemo
    ? analysisStates[selectedMemo.id] ?? {
        status: "unanalyzed" as const,
        message: "This memo has not been analyzed yet."
      }
    : {
        status: "unanalyzed" as const,
        message: "Create or upload a memo to start a review."
      };
  const decision = selectedMemo ? decisions[selectedMemo.id] : undefined;
  const reviewResults = useMemo(() => analysisResults, [analysisResults]);
  const currentUser = auth.status === "signed-in" ? auth.user : undefined;

  useEffect(() => {
    memosRef.current = memos;
  }, [memos]);

  useEffect(() => {
    const controller = new AbortController();
    getCurrentUser(controller.signal)
      .then(async ({ user }) => {
        if (!user) {
          hydrateAccountState(emptyAccountState());
          setAuth({ status: "signed-out" });
          setStateReady(false);
          return;
        }
        const state = await loadAccountState(controller.signal);
        hydrateAccountState(state);
        setAuth({ status: "signed-in", user });
        setStateReady(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          hydrateAccountState(emptyAccountState());
          setAuth({ status: "signed-out" });
          setStateReady(false);
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    getBackendHealth(controller.signal)
      .then((health) => {
        setBackendHealth(health);
        setBackendNotice(
          health.provider.configured
            ? "Live AI analysis is available for authenticated reviews."
            : "Live AI is unavailable. Deterministic rules will be clearly marked."
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setBackendNotice("Backend unavailable. Sign-in, saves, and AI analysis may be unavailable.");
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (auth.status !== "signed-in" || !stateReady) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSyncNotice("Saving...");
      saveAccountState(buildCurrentAccountState(), controller.signal)
        .then(() => setSyncNotice("Saved to account"))
        .catch((error) => {
          if (!controller.signal.aborted) {
            setSyncNotice(readableApiError(error instanceof Error ? error.message : "Save failed"));
          }
        });
    }, 450);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    auth.status,
    stateReady,
    memos,
    selectedMemoId,
    decisions,
    auditEvents,
    analysisResults,
    chatMessages,
    memoBuilderSessions,
    activeMemoBuilderSessionId
  ]);

  useEffect(() => {
    if (activeMemos.length === 0 && selectedMemoId) {
      setSelectedMemoId(undefined);
      return;
    }
    if (activeMemos.length > 0 && selectedMemoId && !activeMemos.some((memo) => memo.id === selectedMemoId)) {
      setSelectedMemoId(activeMemos[0].id);
    }
    if (activeMemos.length > 0 && !selectedMemoId) {
      setSelectedMemoId(activeMemos[0].id);
    }
  }, [activeMemos, selectedMemoId]);
  useEffect(() => setSelectedFindingId(undefined), [selectedMemo?.id]);

  const filteredMemos = activeMemos.filter((memo) =>
    `${memo.title} ${memo.documentCode} ${memo.itemFamily}`
      .toLowerCase()
      .includes(search.toLowerCase())
  );

  const blockDirtyDraft = (action: string) => {
    if (!memoDraftDirty) return false;
    setSyncNotice(`Save or discard memo edits before ${action}.`);
    return true;
  };

  const selectMemo = (memoId: string) => {
    if (memoId === selectedMemo?.id) return;
    if (blockDirtyDraft("switching memos")) return;
    setSelectedMemoId(memoId);
  };

  const changeActiveView = (view: AppView) => {
    if (view === activeView) return;
    if (blockDirtyDraft("opening another workspace")) return;
    setActiveView(view);
  };

  const openNewReview = () => {
    if (blockDirtyDraft("creating a new review")) return;
    setNewReviewOpen(true);
  };

  const focusSignoff = () => {
    if (blockDirtyDraft("recording a decision")) return;
    setActiveView("reviews");
    window.setTimeout(() => {
      document.querySelector(".decision-box")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  };

  const beginPanelResize = (
    panel: "reviewList" | "analysis",
    event: PointerEvent<HTMLButtonElement>
  ) => {
    const workspace = workspaceRef.current;
    if (!workspace || window.matchMedia("(max-width: 980px)").matches) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startSizes = panelSizes;
    const workspaceWidth = workspace.getBoundingClientRect().width;
    const railWidth = 76;
    const handleWidth = 12;
    const minimumMemoWidth = 440;

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      setPanelSizes(() => {
        if (panel === "reviewList") {
          const maxReviewList = Math.max(
            260,
            workspaceWidth - railWidth - handleWidth - startSizes.analysis - handleWidth - minimumMemoWidth
          );
          return {
            reviewList: clamp(startSizes.reviewList + delta, 260, Math.min(560, maxReviewList)),
            analysis: startSizes.analysis
          };
        }

        const maxAnalysis = Math.max(
          300,
          workspaceWidth - railWidth - startSizes.reviewList - handleWidth - handleWidth - minimumMemoWidth
        );
        return {
          reviewList: startSizes.reviewList,
          analysis: clamp(startSizes.analysis - delta, 300, Math.min(640, maxAnalysis))
        };
      });
    };

    const onUp = () => {
      document.body.classList.remove("resizing-layout");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    document.body.classList.add("resizing-layout");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  const completeAuthentication = async (response: { user: UserProfile | null }) => {
    if (!response.user) throw new Error("Sign in failed.");
    const state = await loadAccountState();
    hydrateAccountState(state);
    setAuth({ status: "signed-in", user: response.user });
    setStateReady(true);
    window.history.replaceState(null, "", window.location.pathname);
  };

  const handleSignIn = async (email: string, password: string) => {
    try {
      setAuth({ status: "checking" });
      await completeAuthentication(await signIn(email, password));
    } catch (error) {
      setAuth({
        status: "signed-out",
        error: error instanceof Error ? readableApiError(error.message) : "Sign in failed."
      });
    }
  };

  const handleAcceptInvite = async (token: string, password: string, name?: string) => {
    try {
      setAuth({ status: "checking" });
      await completeAuthentication(await acceptInvite(token, password, name));
    } catch (error) {
      setAuth({
        status: "signed-out",
        error: error instanceof Error ? readableApiError(error.message) : "Invite acceptance failed."
      });
    }
  };

  const handleCompletePasswordReset = async (token: string, password: string) => {
    try {
      setAuth({ status: "checking" });
      await completeAuthentication(await completePasswordReset(token, password));
    } catch (error) {
      setAuth({
        status: "signed-out",
        error: error instanceof Error ? readableApiError(error.message) : "Password reset failed."
      });
    }
  };

  const handleSignOut = async () => {
    if (blockDirtyDraft("signing out")) return;
    await signOut().catch(() => undefined);
    hydrateAccountState(emptyAccountState());
    setStateReady(false);
    setAuth({ status: "signed-out" });
  };

  const handleFile = async (file: File) => {
    if (blockDirtyDraft("uploading another memo")) return;
    try {
      setIntakeWarning(`Reading ${file.name}...`);
      const result = await memoFromFile(file);
      const reviewedMemo = {
        ...result.memo,
        owner: currentUser?.name ?? "You",
        status: "draft" as const
      };
      setIntakeWarning(result.warning);
      addMemo(reviewedMemo);
      addAuditEvent(
        reviewedMemo.id,
        "Document intake",
        result.warning ?? `Uploaded ${file.name}. Analysis has not been run yet.`,
        result.warning ? "review" : "info"
      );
      setAnalysisStates((current) => ({
        ...current,
        [reviewedMemo.id]: {
          status: "unanalyzed",
          message: "Uploaded memo is waiting for reviewer-initiated AI analysis."
        }
      }));
      setActiveView("reviews");
    } catch (error) {
      setIntakeWarning(readableApiError(error instanceof Error ? error.message : "Document extraction failed."));
    }
  };

  const handlePasteMemo = (title: string, text: string) => {
    if (blockDirtyDraft("pasting another memo")) return;
    const now = new Date().toISOString().slice(0, 10);
    const memo: MemoRecord = {
      id: `paste-${Date.now()}`,
      title: title.trim() || "Pasted ECCN Memo",
      itemFamily: "Pasted memo",
      owner: currentUser?.name ?? "You",
      updatedAt: now,
      documentCode: `PASTE-${now.replaceAll("-", "")}`,
      status: "draft",
      dataClass: "proprietary",
      sourcePath: "self-classification",
      attachments: [],
      memoText: text
    };
    addMemo(memo);
    addAuditEvent(memo.id, "Memo pasted", "Pasted memo text. Analysis has not been run yet.", "info");
    setAnalysisStates((current) => ({
      ...current,
      [memo.id]: {
        status: "unanalyzed",
        message: "Pasted memo is waiting for reviewer-initiated AI analysis."
      }
    }));
    setIntakeWarning(undefined);
    setActiveView("reviews");
  };

  const handleCreatePublicDraftMemo = (title: string, memoText: string) => {
    if (blockDirtyDraft("creating a public draft")) return;
    const now = new Date().toISOString().slice(0, 10);
    const memo: MemoRecord = {
      id: `public-draft-${Date.now()}`,
      title: title.trim() || "Public-source ECCN memo draft",
      itemFamily: "Public-source draft",
      owner: currentUser?.name ?? "You",
      updatedAt: now,
      documentCode: `PUB-${now.replaceAll("-", "")}-${memos.length + 1}`,
      status: "draft",
      dataClass: "public",
      sourcePath: "self-classification",
      attachments: [],
      memoText
    };
    addMemo(memo);
    addAuditEvent(
      memo.id,
      "Public-source draft created",
      "Draft memo generated from Bedrock model knowledge. Public manufacturer and official-source verification is required before signoff.",
      "review"
    );
    setAnalysisStates((current) => ({
      ...current,
      [memo.id]: {
        status: "unanalyzed",
        message: "Public-source draft is waiting for reviewer-initiated AI analysis."
      }
    }));
    setActiveView("reviews");
  };

  const handleCreateBuilderMemo = (draft: MemoBuildDraft) => {
    if (blockDirtyDraft("creating another memo")) return;
    const now = new Date().toISOString().slice(0, 10);
    const memo: MemoRecord = {
      id: `ai-draft-${Date.now()}`,
      title: draft.title || "AI-drafted ECCN Memo",
      itemFamily: draft.itemFamily || "AI-drafted item",
      owner: currentUser?.name ?? "You",
      updatedAt: now,
      documentCode: `AI-${now.replaceAll("-", "")}-${memos.length + 1}`,
      status: "draft",
      memoText: draft.memoText,
      attachments: draft.attachments ?? [],
      dataClass: draft.dataClass ?? "proprietary",
      sourcePath: "self-classification",
      manufacturer: draft.manufacturer,
      intendedUse: draft.intendedUse
    };
    addMemo(memo);
    addAuditEvent(
      memo.id,
      "AI-assisted memo created",
      "Memo drafted via Memo Builder with Sonnet. Analysis has not been run.",
      "info"
    );
    setAnalysisStates((current) => ({
      ...current,
      [memo.id]: {
        status: "unanalyzed",
        message: "AI-drafted memo is waiting for reviewer-initiated AI analysis."
      }
    }));
    setActiveView("reviews");
    setIntakeWarning(undefined);
  };

  const handleCreateAndAnalyzeBuilderMemo = (draft: MemoBuildDraft) => {
    if (blockDirtyDraft("creating and analyzing another memo")) return;
    const now = new Date().toISOString().slice(0, 10);
    const memo: MemoRecord = {
      id: `ai-draft-${Date.now()}`,
      title: draft.title || "AI-drafted ECCN Memo",
      itemFamily: draft.itemFamily || "AI-drafted item",
      owner: currentUser?.name ?? "You",
      updatedAt: now,
      documentCode: `AI-${now.replaceAll("-", "")}-${memos.length + 1}`,
      status: "draft",
      memoText: draft.memoText,
      attachments: draft.attachments ?? [],
      dataClass: draft.dataClass ?? "proprietary",
      sourcePath: "self-classification",
      manufacturer: draft.manufacturer,
      intendedUse: draft.intendedUse
    };

    // Build the state with the new memo so saveAccountState has it before analysis runs.
    const stateWithMemo: AccountReviewState = {
      ...buildCurrentAccountState(),
      memos: [memo, ...memos],
      selectedMemoId: memo.id
    };

    addMemo(memo);
    addAuditEvent(
      memo.id,
      "AI-assisted memo created",
      "Memo drafted via Memo Builder with Sonnet. Auto-analysis queued.",
      "info"
    );
    setAnalysisStates((current) => ({
      ...current,
      [memo.id]: {
        status: "running",
        message: backendHealth?.provider.configured
          ? "AI Council is analyzing this Memo Builder draft…"
          : "Live AI is unavailable. Running deterministic analysis."
      }
    }));
    setActiveView("reviews");
    setIntakeWarning(undefined);

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 180000);

    void saveAccountState(stateWithMemo)
      .then(() => analyzeMemoWithBackend(memo, analysisMode, controller.signal))
      .then(({ review, result, auditEvents: serverAuditEvents }) => {
        window.clearTimeout(timeoutId);
        setAnalysisResults((current) => ({ ...current, [memo.id]: result }));
        if (serverAuditEvents?.length) mergeAuditEvents(serverAuditEvents);
        setAnalysisStates((current) => ({
          ...current,
          [memo.id]: result.provider.live
            ? { status: "live", message: "Live AI analysis completed. Reviewer signoff is still required." }
            : { status: "deterministic", message: result.provider.message }
        }));
        setMemos((current) => current.map((item) => (item.id === memo.id ? review : item)));
      })
      .catch((error) => {
        window.clearTimeout(timeoutId);
        const message = readableApiError(error instanceof Error ? error.message : "AI analysis failed.");
        setAnalysisStates((current) => ({
          ...current,
          [memo.id]: {
            status: "failed",
            message: `${message} Retry when the backend is available.`
          }
        }));
        addAuditEvent(memo.id, "AI analysis failed", "Analysis failed after Memo Builder creation.", "review");
      });
  };

  const handleCreateReview = (input: NewReviewInput) => {
    if (blockDirtyDraft("creating a new review")) return;
    const now = new Date().toISOString().slice(0, 10);
    const memo: MemoRecord = {
      id: `review-${Date.now()}`,
      title: input.title.trim() || "New ECCN Classification Memo",
      itemFamily: input.itemFamily.trim() || "Research equipment",
      owner: currentUser?.name ?? "You",
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
    addMemo(memo);
    addAuditEvent(
      memo.id,
      "Review created",
      `New ${input.sourcePath ?? "classification"} review created with ${input.dataClass} data marking. Analysis has not been run yet.`,
      input.dataClass === "itar-risk" || input.dataClass === "cui" ? "escalate" : "info"
    );
    setAnalysisStates((current) => ({
      ...current,
      [memo.id]: {
        status: "unanalyzed",
        message: "New review is waiting for reviewer-initiated AI analysis."
      }
    }));
    setActiveView("reviews");
    setIntakeWarning(undefined);
  };

  const updateMemoText = (memoId: string, memoText: string, detail = "Memo text changed; prior signoff was cleared.") => {
    if (analysisStates[memoId]?.status === "running") {
      setSyncNotice("Wait for the running analysis before editing this memo.");
      return;
    }
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
    addAuditEvent(memoId, "Memo edited", detail, "review");
    setMemoDraftDirty(false);
  };

  const archiveMemo = (memoId: string) => {
    if (memoId === selectedMemo?.id && blockDirtyDraft("archiving this memo")) return;
    if (analysisStates[memoId]?.status === "running") {
      setSyncNotice("Wait for the running analysis before archiving this memo.");
      return;
    }
    const archivedAt = new Date().toISOString();
    setMemos((current) =>
      current.map((memo) =>
        memo.id === memoId
          ? {
              ...memo,
              archivedAt,
              archivedBy: currentUser?.name ?? "Reviewer",
              updatedAt: archivedAt.slice(0, 10)
            }
          : memo
      )
    );
    setSelectedMemoId((current) => {
      if (current !== memoId) return current;
      return activeMemos.find((memo) => memo.id !== memoId)?.id;
    });
    addAuditEvent(
      memoId,
      "Memo archived",
      "Memo was removed from the active review queue but retained in account history.",
      "review"
    );
  };

  const handleDecision = (action: ReviewerDecision["action"], notes: string) => {
    if (blockDirtyDraft("recording a decision")) return;
    if (!selectedMemo || !reviewResult) return;
    const nextDecision = {
      action,
      notes,
      signedBy: action === "accept" ? currentUser?.name ?? "Reviewer" : undefined,
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
    addAuditEvent(
      selectedMemo.id,
      `Reviewer decision: ${action}`,
      notes,
      action === "override" ? "escalate" : action === "request-info" ? "review" : "info"
    );
  };

  const exportReport = () => {
    if (blockDirtyDraft("exporting a report")) return;
    if (!selectedMemo || !reviewResult) {
      setExportNotice("Run analysis before export");
      window.setTimeout(() => setExportNotice(""), 3200);
      return;
    }
    if (!decision) {
      setExportNotice("Record decision before export");
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
    if (blockDirtyDraft("running analysis")) return;
    if (!selectedMemo) return;
    const memo = selectedMemo;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 180000);
    setAnalysisStates((current) => ({
      ...current,
      [memo.id]: {
        status: "running",
        message: backendHealth?.provider.configured
          ? `${ANALYSIS_MODE_CONFIG[analysisMode].label} is analyzing this memo. If it does not finish in 3 minutes, deterministic analysis will be recorded.`
          : "Live AI is unavailable. Running deterministic analysis."
      }
    }));

    try {
      await saveAccountState(buildCurrentAccountState(), controller.signal);
      const { review, result, auditEvents: serverAuditEvents } = await analyzeMemoWithBackend(memo, analysisMode, controller.signal);
      window.clearTimeout(timeoutId);
      const currentMemo = memosRef.current.find((item) => item.id === memo.id);
      if (!currentMemo || currentMemo.memoText !== memo.memoText) {
        setAnalysisStates((current) => ({
          ...current,
          [memo.id]: {
            status: "failed",
            message: "Memo changed while analysis was running. The stale result was discarded; run analysis again."
          }
        }));
        return;
      }
      const failedToUseLiveAi = backendHealth?.provider.configured && result.provider.source !== "bedrock";
      setAnalysisResults((current) => ({ ...current, [memo.id]: result }));
      if (serverAuditEvents?.length) mergeAuditEvents(serverAuditEvents);
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
      setMemos((current) => current.map((item) => (item.id === memo.id ? review : item)));
    } catch (error) {
      window.clearTimeout(timeoutId);
      const message = readableApiError(error instanceof Error ? error.message : "AI analysis request failed.");
      setAnalysisStates((current) => ({
        ...current,
        [memo.id]: {
          status: "failed",
          message: `${message} Deterministic rules were not recorded; retry when the backend is available.`
        }
      }));
      addAuditEvent(memo.id, "AI analysis failed", "Backend AI analysis failed; no new result was recorded.", "review");
    }
  };

  const handleSendMemoChat = async (memoId: string, message: string) => {
    if (memoId === selectedMemo?.id && blockDirtyDraft("using memo chat")) {
      throw new Error("Save or discard memo edits before using memo chat.");
    }
    if (analysisStates[memoId]?.status === "running") {
      throw new Error("Wait for the running analysis before changing this memo.");
    }
    await saveAccountState(buildCurrentAccountState());
    const { messages, auditEvents: serverAuditEvents } = await sendMemoChat(memoId, message);
    setChatMessages((current) => ({ ...current, [memoId]: messages }));
    if (serverAuditEvents?.length) mergeAuditEvents(serverAuditEvents);
  };

  const handleApplyChatSuggestion = (memoId: string, messageId: string, proposedMemoText: string) => {
    if (memoId === selectedMemo?.id && blockDirtyDraft("applying a chat edit")) return;
    updateMemoText(memoId, proposedMemoText, "Memo text updated from a chat-assisted reviewer edit.");
    setChatMessages((current) => ({
      ...current,
      [memoId]: (current[memoId] ?? []).map((message) =>
        message.id === messageId ? { ...message, applied: true } : message
      )
    }));
  };

  const hydrateAccountState = (state: AccountReviewState) => {
    setMemoDraftDirty(false);
    setMemos(state.memos ?? []);
    setSelectedMemoId(state.selectedMemoId ?? state.memos?.[0]?.id);
    setDecisions(state.decisions ?? {});
    setAuditEvents(state.auditEvents ?? []);
    setAnalysisResults(state.analysisResults ?? {});
    setAnalysisStates(deriveAnalysisStates(state.analysisResults ?? {}));
    setChatMessages(state.chatMessages ?? {});
    const builderSessions = normalizeMemoBuilderSessions(state.memoBuilder);
    setMemoBuilderSessions(builderSessions);
    setActiveMemoBuilderSessionId(state.memoBuilder?.activeSessionId ?? builderSessions[0]?.id);
  };

  const buildCurrentAccountState = (): AccountReviewState => ({
    memos,
    selectedMemoId: selectedMemo?.id,
    decisions,
    auditEvents,
    analysisResults,
    chatMessages,
    memoBuilder: {
      activeSessionId: activeMemoBuilderSessionId,
      sessions: memoBuilderSessions,
      messages: memoBuilderSessions.find((session) => session.id === activeMemoBuilderSessionId)?.messages ?? [],
      draft: memoBuilderSessions.find((session) => session.id === activeMemoBuilderSessionId)?.draft
    }
  });

  const addMemo = (memo: MemoRecord) => {
    setMemos((current) => [memo, ...current]);
    setSelectedMemoId(memo.id);
  };

  const addAuditEvent = (
    memoId: string,
    action: string,
    detail: string,
    severity: AuditEvent["severity"] = "info"
  ) => {
    setAuditEvents((current) => [
      createAuditEvent(memoId, action, detail, severity, currentUser?.name ?? "Reviewer"),
      ...current
    ]);
  };

  const mergeAuditEvents = (events: AuditEvent[]) => {
    setAuditEvents((current) => {
      const seen = new Set<string>();
      return [...events, ...current].filter((event) => {
        if (seen.has(event.id)) return false;
        seen.add(event.id);
        return true;
      });
    });
  };

  if (auth.status === "checking") {
    return (
      <div className="auth-shell">
        <div className="auth-card compact">
          <RulixLogo />
          <h1>Checking secure session</h1>
          <p>Loading your account-linked review workspace.</p>
        </div>
      </div>
    );
  }

  if (auth.status === "signed-out") {
    return (
      <AuthScreen
        error={auth.error}
        onSignIn={handleSignIn}
        onAcceptInvite={handleAcceptInvite}
        onRequestPasswordReset={requestPasswordReset}
        onCompletePasswordReset={handleCompletePasswordReset}
      />
    );
  }

  return (
    <div className="app-shell">
      <TopBar
        tenant="Research Facility Pilot"
        user={auth.user}
        syncNotice={syncNotice}
        onNewReview={openNewReview}
        onExport={exportReport}
        onSignoff={focusSignoff}
        onSignOut={handleSignOut}
        signoffReady={decision?.action === "accept"}
        exportNotice={exportNotice}
      />
      <div
        ref={workspaceRef}
        className={activeView === "reviews" ? "workspace-grid" : "workspace-grid console-mode"}
        style={{
          "--review-list-width": `${panelSizes.reviewList}px`,
          "--analysis-panel-width": `${panelSizes.analysis}px`
        } as CSSProperties}
      >
        <SidebarRail activeView={activeView} onViewChange={changeActiveView} />
        {activeView === "reviews" ? (
          <>
            <ReviewList
              memos={filteredMemos}
              selectedMemoId={selectedMemo?.id ?? ""}
              search={search}
              warning={intakeWarning}
              corpusLabel={officialCorpus.label}
              onSearch={setSearch}
              onSelect={selectMemo}
              onFile={handleFile}
              onPasteMemo={handlePasteMemo}
            />
            <PanelResizeHandle
              label="Resize review queue"
              onPointerDown={(event) => beginPanelResize("reviewList", event)}
            />
            {selectedMemo ? (
              <>
                <MemoWorkspace
                  memo={selectedMemo}
                  result={reviewResult}
                  selectedFindingId={selectedFindingId}
                  analysisLocked={analysisState.status === "running"}
                  onMemoTextChange={updateMemoText}
                  onArchiveMemo={archiveMemo}
                  onCreatePublicDraft={handleCreatePublicDraftMemo}
                  onDirtyChange={setMemoDraftDirty}
                />
                <PanelResizeHandle
                  label="Resize analysis panel"
                  onPointerDown={(event) => beginPanelResize("analysis", event)}
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
                  chatMessages={chatMessages[selectedMemo.id] ?? []}
                  analysisLocked={analysisState.status === "running"}
                  memoDraftDirty={memoDraftDirty}
                  onDecision={handleDecision}
                  onSendChat={handleSendMemoChat}
                  onApplyChatSuggestion={handleApplyChatSuggestion}
                  selectedFindingId={selectedFindingId}
                  onFindingSelect={setSelectedFindingId}
                />
              </>
            ) : (
              <>
                <main className="memo-workspace empty-workspace">
                  <RulixLogo />
                  <h1>No memos yet</h1>
                  <p>Create, upload, or paste a memo to begin an account-linked ECCN review.</p>
                  <button className="button primary" type="button" onClick={openNewReview}>
                    New Review
                  </button>
                </main>
                <PanelResizeHandle
                  label="Resize analysis panel"
                  onPointerDown={(event) => beginPanelResize("analysis", event)}
                />
                <aside className="analysis-panel empty-panel">
                  <h2>Secure Workspace</h2>
                  <p>
                    Memos, decisions, chat edits, and audit events are stored under {auth.user.email}.
                  </p>
                </aside>
              </>
            )}
          </>
        ) : activeView === "memo-builder" ? (
          <MemoDraftChatPanel
            sessions={memoBuilderSessions}
            activeSessionId={activeMemoBuilderSessionId}
            onSessionsChange={setMemoBuilderSessions}
            onActiveSessionChange={setActiveMemoBuilderSessionId}
            onCreateMemo={handleCreateBuilderMemo}
            onCreateAndAnalyze={handleCreateAndAnalyzeBuilderMemo}
          />
        ) : (
          <AdminConsole
            view={activeView}
            memos={memos}
            decisions={decisions}
            auditEvents={auditEvents}
            reviewResults={reviewResults}
            corpus={officialCorpus}
            onSelectMemo={(memoId) => {
              if (memoId === selectedMemo?.id) {
                setActiveView("reviews");
                return;
              }
              if (blockDirtyDraft("opening another memo")) return;
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

function normalizeMemoBuilderSessions(builder: AccountReviewState["memoBuilder"]): MemoBuilderSession[] {
  const sessions = (builder?.sessions ?? [])
    .filter((session) => session.id && Array.isArray(session.messages))
    .map((session) => ({
      ...session,
      title: session.title?.trim() || session.messages[0]?.content?.replace(/\s+/g, " ").slice(0, 46) || "Memo chat",
      updatedAt: session.updatedAt || new Date().toISOString()
    }));

  if (sessions.length) return sessions;
  if ((builder?.messages?.length ?? 0) || builder?.draft) {
    return [
      {
        id: "builder-migrated",
        title: builder?.messages?.[0]?.content?.replace(/\s+/g, " ").slice(0, 46) || "Saved memo chat",
        messages: builder?.messages ?? [],
        draft: builder?.draft,
        updatedAt: new Date().toISOString()
      }
    ];
  }
  return [];
}

function PanelResizeHandle({
  label,
  onPointerDown
}: {
  label: string;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className="panel-resize-handle"
      aria-label={label}
      title={label}
      onPointerDown={onPointerDown}
    >
      <span />
    </button>
  );
}

type AuthMode = "signin" | "invite" | "reset-request" | "reset-complete";

interface AuthFormValues {
  email: string;
  password: string;
  token: string;
}

function AuthScreen({
  error,
  onSignIn,
  onAcceptInvite,
  onRequestPasswordReset,
  onCompletePasswordReset
}: {
  error?: string;
  onSignIn: (email: string, password: string) => Promise<void>;
  onAcceptInvite: (token: string, password: string, name?: string) => Promise<void>;
  onRequestPasswordReset: (email: string) => Promise<void>;
  onCompletePasswordReset: (token: string, password: string) => Promise<void>;
}) {
  const params = new URLSearchParams(window.location.search);
  const initialInviteToken = params.get("invite") ?? "";
  const initialResetToken = params.get("reset") ?? "";
  const [mode, setMode] = useState<AuthMode>(
    initialInviteToken ? "invite" : initialResetToken ? "reset-complete" : "signin"
  );
  const [values, setValues] = useState<AuthFormValues>({
    email: "",
    password: "",
    token: initialInviteToken || initialResetToken
  });
  const [inviteInfo, setInviteInfo] = useState<InvitePublicInfo | undefined>();
  const [resetInfo, setResetInfo] = useState<PasswordResetPublicInfo | undefined>();
  const [localError, setLocalError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const token = values.token.trim();
    setLocalError(undefined);
    setNotice(undefined);
    setInviteInfo(undefined);
    setResetInfo(undefined);

    if (!token || (mode !== "invite" && mode !== "reset-complete")) return;

    const controller = new AbortController();
    const validation = mode === "invite"
      ? validateInvite(token, controller.signal).then((invite) => {
          setInviteInfo(invite);
          setValues((current) => ({ ...current, email: invite.email }));
        })
      : validatePasswordReset(token, controller.signal).then((reset) => {
          setResetInfo(reset);
          setValues((current) => ({ ...current, email: reset.email }));
        });

    validation.catch((validationError) => {
      if (!controller.signal.aborted) {
        setLocalError(
          validationError instanceof Error
            ? readableApiError(validationError.message)
            : "This link is invalid or expired."
        );
      }
    });

    return () => controller.abort();
  }, [mode, values.token]);

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setValues((current) => ({
      email: nextMode === "signin" ? current.email : "",
      password: "",
      token: nextMode === "invite" ? initialInviteToken : nextMode === "reset-complete" ? initialResetToken : ""
    }));
    setInviteInfo(undefined);
    setResetInfo(undefined);
    setLocalError(undefined);
    setNotice(undefined);
    if (nextMode === "signin" || nextMode === "reset-request") {
      window.history.replaceState(null, "", window.location.pathname);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setLocalError(undefined);
    setNotice(undefined);
    try {
      if (mode === "signin") {
        await onSignIn(values.email, values.password);
      } else if (mode === "invite") {
        await onAcceptInvite(values.token, values.password, inviteInfo?.name);
      } else if (mode === "reset-request") {
        await onRequestPasswordReset(values.email);
        setNotice("If that account exists, a reset link has been sent.");
      } else {
        await onCompletePasswordReset(values.token, values.password);
      }
    } catch (submitError) {
      setLocalError(
        submitError instanceof Error ? readableApiError(submitError.message) : "Request failed."
      );
    }
    setBusy(false);
  };

  const activeError = localError ?? (mode === "signin" ? error : undefined);
  const linkValidated = mode === "invite" ? Boolean(inviteInfo) : mode === "reset-complete" ? Boolean(resetInfo) : true;
  const primaryLabel = mode === "signin"
    ? "Sign in"
    : mode === "invite"
      ? "Set password"
      : mode === "reset-request"
        ? "Send reset link"
        : "Reset password";

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <RulixLogo />
        <div>
          <h1>{authHeading(mode)}</h1>
          <p>
            Store memos, decisions, evidence chats, and audit events under your account.
          </p>
        </div>
        <div className="auth-toggle" aria-label="Authentication mode">
          <button
            type="button"
            className={mode === "signin" ? "active" : ""}
            onClick={() => switchMode("signin")}
          >
            Sign in
          </button>
          <button
            type="button"
            className={mode === "invite" ? "active" : ""}
            onClick={() => switchMode("invite")}
          >
            Use invite link
          </button>
          <button
            type="button"
            className={mode === "reset-request" || mode === "reset-complete" ? "active" : ""}
            onClick={() => switchMode("reset-request")}
          >
            Forgot password
          </button>
        </div>
        {mode === "invite" && (
          <>
            <label>
              Invite token
              <input
                value={values.token}
                onChange={(event) => setValues((current) => ({ ...current, token: event.target.value }))}
                autoComplete="one-time-code"
                required
              />
            </label>
            {inviteInfo && (
              <div className="auth-link-status">
                <strong>{inviteInfo.name}</strong>
                <span>{inviteInfo.email}</span>
                <small>{roleLabel(inviteInfo.role)} | Expires {formatDateTime(inviteInfo.expiresAt)}</small>
              </div>
            )}
          </>
        )}
        {mode === "reset-complete" && (
          <>
            <label>
              Reset token
              <input
                value={values.token}
                onChange={(event) => setValues((current) => ({ ...current, token: event.target.value }))}
                autoComplete="one-time-code"
                required
              />
            </label>
            {resetInfo && (
              <div className="auth-link-status">
                <strong>{resetInfo.email}</strong>
                <span>Password reset link verified</span>
                <small>Expires {formatDateTime(resetInfo.expiresAt)}</small>
              </div>
            )}
          </>
        )}
        {(mode === "signin" || mode === "reset-request") && (
          <label>
            Email
            <input
              value={values.email}
              onChange={(event) => setValues((current) => ({ ...current, email: event.target.value }))}
              autoComplete="email"
              type="email"
              required
            />
          </label>
        )}
        {mode !== "reset-request" && (
          <label>
            Password
            <input
              value={values.password}
              onChange={(event) => setValues((current) => ({ ...current, password: event.target.value }))}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              type="password"
              minLength={12}
              required
            />
          </label>
        )}
        {(mode === "invite" || mode === "reset-complete") && (
          <p className="auth-hint">
            Minimum 12 characters with a mix of upper/lowercase letters, numbers, and symbols.
          </p>
        )}
        {notice && <div className="auth-success">{notice}</div>}
        {activeError && <div className="auth-error">{activeError}</div>}
        <button className="button primary full" type="submit" disabled={busy || !linkValidated}>
          {busy ? "Securing..." : primaryLabel}
        </button>
        {mode === "reset-request" && (
          <button className="button ghost full" type="button" onClick={() => switchMode("reset-complete")}>
            I already have a reset link
          </button>
        )}
      </form>
    </div>
  );
}

function authHeading(mode: AuthMode) {
  if (mode === "invite") return "Accept Rulix invite";
  if (mode === "reset-request") return "Reset password";
  if (mode === "reset-complete") return "Set new password";
  return "Sign in to Rulix";
}

function roleLabel(role: UserProfile["role"]) {
  if (role === "export-control-officer") return "Export Control Officer";
  if (role === "submitter") return "Submitter";
  if (role === "counsel") return "Counsel";
  return "Reviewer";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function RulixLogo() {
  return (
    <div className="rulix-logo" aria-label="Rulix">
      <svg viewBox="0 0 44 44" role="img">
        <path d="M7 8.5h19.5c6.1 0 10.5 4 10.5 9.7 0 4-2.2 7.2-5.7 8.7L38 35.5h-8.4l-5.8-7.6h-8.9v7.6H7V8.5Zm7.9 6.6v6.5h10.7c2 0 3.3-1.3 3.3-3.2 0-2-1.3-3.3-3.3-3.3H14.9Z" />
        <path d="M15.8 23.7h9.4l4 5.3H15.8v-5.3Z" />
      </svg>
      <span>Rulix</span>
    </div>
  );
}

function deriveAnalysisStates(results: Record<string, ReviewResult>) {
  return Object.fromEntries(
    Object.entries(results).map(([memoId, result]) => [
      memoId,
      result.provider.live
        ? {
            status: "live",
            message: "Live AI analysis completed. Reviewer signoff is still required."
          }
        : {
            status: result.provider.source === "fallback" ? "failed" : "deterministic",
            message: result.provider.message
          }
    ])
  ) as Record<string, AnalysisRunState>;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readableApiError(message: string) {
  if (message.trimStart().startsWith("<")) return "Request failed.";
  try {
    const parsed = JSON.parse(message) as { error?: string };
    return parsed.error ?? message;
  } catch {
    return message;
  }
}
