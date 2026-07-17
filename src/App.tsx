import { FormEvent, startTransition, useEffect, useMemo, useRef, useState } from "react";
import { officialCorpus } from "./data/corpus";
import {
  ANALYSIS_MODE_CONFIG,
  ApiError,
  type AnalysisMode,
  type BackendHealth,
  type MemoBuildDraft,
  applyMemoChatSuggestion,
  approveCouncilAnalysis,
  acceptInvite,
  analyzeMemoWithBackend,
  completePasswordReset,
  createReview,
  deleteMemoBuilderSession,
  getBackendHealth,
  getCouncilApproval,
  getCurrentUser,
  getReviewDetail,
  listMemoBuilderSessions,
  listNotifications,
  listReviewAuditEvents,
  listReviewChatMessages,
  listReviews,
  listTenantMembers,
  loadWorkspacePreferences,
  recordReviewDecision,
  requestCouncilApproval,
  requestMemoChatApproval,
  requestPasswordReset,
  revokeAiApproval,
  sendMemoChat,
  setReviewArchived,
  signIn,
  signOut,
  updateReviewMemo,
  updateReviewMetadata,
  updateWorkspacePreferences,
  upsertMemoBuilderSession,
  sanitizeMemoBuilderSessionForStorage,
  validateInvite,
  validatePasswordReset,
  type InvitePublicInfo,
  type CouncilApprovalView,
  type PasswordResetPublicInfo
} from "./lib/apiClient";
import type { ReviewSummary } from "./lib/apiClient";
import { memoFromFile } from "./lib/documentIntake";
import { mergeChatPage } from "./lib/chatOrdering";
import { buildReviewReport } from "./lib/report";
import { isReviewId } from "./shared/reviewIds";
import type {
  AppView,
  AuditEvent,
  DataClass,
  MemoBuilderSession,
  MemoChatMessage,
  MemoRecord,
  NewReviewInput,
  ReviewerDecision,
  ReviewResult,
  SavedReviewView,
  UserProfile,
  WorkspacePreferences
} from "./types";
import { AdminConsole } from "./components/AdminConsole";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { BrandLogo } from "./components/BrandLogo";
import { MemoDraftChatPanel } from "./components/MemoDraftChatPanel";
import { MemoWorkspace } from "./components/MemoWorkspace";
import { NewReviewModal } from "./components/NewReviewModal";
import { ThemeToggle } from "./components/ThemeToggle";
import { SidebarRail } from "./components/SidebarRail";
import { HelpCenter } from "./components/HelpCenter";
import { TopBar } from "./components/TopBar";
import { CommandPalette } from "./components/CommandPalette";
import { EvidenceLibraryView } from "./components/EvidenceLibraryView";
import { HomeView } from "./components/HomeView";
import { NotificationsDrawer } from "./components/NotificationsDrawer";
import { ReviewQueueView } from "./components/ReviewQueueView";
import { ReviewWorkbench } from "./components/ReviewWorkbench";
import { navigateApp, parseAppHash, type ReviewSection } from "./lib/appRoutes";

type AnalysisRunState =
  | { status: "unanalyzed"; message: string }
  | { status: "running"; message: string }
  | { status: "live"; message: string }
  | { status: "failed"; message: string };

type AuthState =
  | { status: "checking" }
  | { status: "signed-out"; error?: string }
  | { status: "signed-in"; user: UserProfile };

type ReviewLoadFailure = {
  memoId: string;
  message: string;
  retryable: boolean;
};

export interface AuthLinkBootstrap {
  mode?: Extract<AuthMode, "invite" | "reset-complete">;
  token: string;
}

export function consumeAuthLinkFragment(): AuthLinkBootstrap {
  if (typeof window === "undefined") return { token: "" };
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const invite = fragment.get("invite");
  const reset = fragment.get("reset");
  const containsAuthSecret = invite !== null || reset !== null;

  fragment.delete("invite");
  fragment.delete("reset");
  const query = new URLSearchParams(window.location.search);
  const containedLegacyQuerySecret = query.has("invite") || query.has("reset");
  query.delete("invite");
  query.delete("reset");

  if (containsAuthSecret || containedLegacyQuerySecret) {
    const cleanQuery = query.toString();
    const cleanFragment = fragment.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ""}${cleanFragment ? `#${cleanFragment}` : ""}`
    );
  }

  if ((invite === null) === (reset === null)) return { token: "" };
  const token = (invite ?? reset ?? "").trim();
  if (token.length < 32 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return { mode: invite !== null ? "invite" : "reset-complete", token: "invalid" };
  }
  return { mode: invite !== null ? "invite" : "reset-complete", token };
}

export function App({ authLink = consumeAuthLinkFragment() }: { authLink?: AuthLinkBootstrap }) {
  const initialRouteRef = useRef(parseAppHash(typeof window === "undefined" ? "#/home" : window.location.hash));
  const [auth, setAuth] = useState<AuthState>({ status: "checking" });
  const [stateReady, setStateReady] = useState(false);
  const [memos, setMemos] = useState<MemoRecord[]>([]);
  const [reviewCursor, setReviewCursor] = useState<string | undefined>();
  const [reviewsLoadingMore, setReviewsLoadingMore] = useState(false);
  const [builderCursor, setBuilderCursor] = useState<string | undefined>();
  const [builderLoadingMore, setBuilderLoadingMore] = useState(false);
  const [auditCursors, setAuditCursors] = useState<Record<string, string | undefined>>({});
  const [chatCursors, setChatCursors] = useState<Record<string, string | undefined>>({});
  const [detailLoadingId, setDetailLoadingId] = useState<string | undefined>();
  const [detailFailure, setDetailFailure] = useState<ReviewLoadFailure | undefined>();
  const [selectedMemoId, setSelectedMemoId] = useState<string | undefined>();
  const [intakeWarning, setIntakeWarning] = useState<string | undefined>();
  const [decisions, setDecisions] = useState<Record<string, ReviewerDecision>>({});
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [analysisResults, setAnalysisResults] = useState<Record<string, ReviewResult>>({});
  const [analysisStates, setAnalysisStates] = useState<Record<string, AnalysisRunState>>({});
  const [chatMessages, setChatMessages] = useState<Record<string, MemoChatMessage[]>>({});
  const [memoBuilderSessions, setMemoBuilderSessions] = useState<MemoBuilderSession[]>([]);
  const [activeMemoBuilderSessionId, setActiveMemoBuilderSessionId] = useState<string | undefined>();
  const [activeView, setActiveView] = useState<AppView>(initialRouteRef.current.view);
  const [reviewSection, setReviewSection] = useState<ReviewSection>(
    initialRouteRef.current.view === "reviews" ? initialRouteRef.current.section ?? "overview" : "overview"
  );
  const [workspacePreferences, setWorkspacePreferences] = useState<WorkspacePreferences>({});
  const [tenantMembers, setTenantMembers] = useState<Array<Pick<UserProfile, "id" | "name" | "email" | "role">>>([]);
  const [commandOpen, setCommandOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [newReviewOpen, setNewReviewOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [exportNotice, setExportNotice] = useState("");
  const [syncNotice, setSyncNotice] = useState("Account loaded");
  const [backendHealth, setBackendHealth] = useState<BackendHealth | undefined>();
  const [backendNotice, setBackendNotice] = useState("Checking analysis service...");
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("standard");
  const [councilApproval, setCouncilApproval] = useState<CouncilApprovalView | undefined>();
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [selectedFindingId, setSelectedFindingId] = useState<string | undefined>();
  const [memoDraftDirty, setMemoDraftDirty] = useState(false);
  const memosRef = useRef<MemoRecord[]>([]);
  const preferenceVersionRef = useRef(0);
  const preferenceFingerprintRef = useRef("");
  const builderVersionsRef = useRef(new Map<string, number>());
  const builderFingerprintsRef = useRef(new Map<string, string>());
  const persistedBuilderIdsRef = useRef(new Set<string>());
  const workspaceSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const analysisControllersRef = useRef(new Map<string, AbortController>());
  const loadedReviewDetailsRef = useRef(new Set<string>());
  const detailRequestsRef = useRef(new Map<string, Promise<void>>());
  const restoredSelectionRef = useRef<string | undefined>(undefined);

  const activeMemos = useMemo(() => memos.filter((memo) => !memo.archivedAt), [memos]);
  const selectedMemo = selectedMemoId && loadedReviewDetailsRef.current.has(selectedMemoId)
    ? activeMemos.find((memo) => memo.id === selectedMemoId)
    : undefined;
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
    const applyRoute = () => {
      const route = parseAppHash(window.location.hash);
      if (memoDraftDirty && route.view !== activeView) {
        navigateApp(
          activeView === "reviews" && selectedMemoId
            ? { view: "reviews", memoId: selectedMemoId, section: reviewSection }
            : activeView === "memo-builder"
              ? { view: "memo-builder", sessionId: activeMemoBuilderSessionId }
              : { view: activeView } as Parameters<typeof navigateApp>[0],
          true
        );
        setSyncNotice("Save or discard memo edits before opening another workspace.");
        return;
      }
      setActiveView(route.view);
      setWorkspacePreferences((current) => current.lastAppRoute === window.location.hash
        ? current
        : { ...current, lastAppRoute: window.location.hash });
      if (route.view === "reviews") {
        setReviewSection(route.section ?? "overview");
        if (route.memoId) setSelectedMemoId(route.memoId);
      } else if (route.view === "memo-builder" && route.sessionId) {
        setActiveMemoBuilderSessionId(route.sessionId);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener("hashchange", applyRoute);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("hashchange", applyRoute);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [activeMemoBuilderSessionId, activeView, memoDraftDirty, reviewSection, selectedMemoId]);

  useEffect(() => {
    if (auth.status !== "signed-in") return;
    const controller = new AbortController();
    void Promise.all([
      listTenantMembers(controller.signal),
      listNotifications({ limit: 50, unreadOnly: true }, controller.signal)
    ]).then(([members, notifications]) => {
      setTenantMembers(members.items);
      setUnreadNotifications(notifications.items.length);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [auth.status]);

  const persistWorkspaceSnapshot = async (snapshot: {
    selectedMemoId?: string;
    activeMemoBuilderSessionId?: string;
    sessions: MemoBuilderSession[];
    preferences: WorkspacePreferences;
  }) => {
    const preferenceFingerprint = JSON.stringify({
      selectedMemoId: snapshot.selectedMemoId ?? null,
      activeMemoBuilderSessionId: snapshot.activeMemoBuilderSessionId ?? null,
      ...snapshot.preferences
    });
    let changed = false;

    if (preferenceFingerprint !== preferenceFingerprintRef.current) {
      changed = true;
      let expectedVersion = preferenceVersionRef.current;
      let response;
      try {
        response = await updateWorkspacePreferences(expectedVersion, {
          selectedMemoId: snapshot.selectedMemoId ?? null,
          activeMemoBuilderSessionId: snapshot.activeMemoBuilderSessionId ?? null,
          ...snapshot.preferences
        });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error;
        const latest = await loadWorkspacePreferences();
        expectedVersion = latest.version;
        response = await updateWorkspacePreferences(expectedVersion, {
          selectedMemoId: snapshot.selectedMemoId ?? null,
          activeMemoBuilderSessionId: snapshot.activeMemoBuilderSessionId ?? null,
          ...snapshot.preferences
        });
      }
      preferenceVersionRef.current = response.version;
      preferenceFingerprintRef.current = preferenceFingerprint;
    }

    const currentIds = new Set(snapshot.sessions.map((session) => session.id));
    for (const session of snapshot.sessions) {
      const sanitized = sanitizeMemoBuilderSessionForStorage(session);
      const fingerprint = JSON.stringify(sanitized);
      if (builderFingerprintsRef.current.get(session.id) === fingerprint) continue;
      changed = true;
      let expectedVersion = builderVersionsRef.current.get(session.id) ?? 0;
      let stored;
      try {
        stored = await upsertMemoBuilderSession(sanitized, expectedVersion);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error;
        const latest = await listMemoBuilderSessions({ limit: 50 });
        expectedVersion = latest.items.find((item) => item.session.id === session.id)?.version ?? 0;
        stored = await upsertMemoBuilderSession(sanitized, expectedVersion);
      }
      builderVersionsRef.current.set(session.id, stored.version);
      builderFingerprintsRef.current.set(session.id, JSON.stringify(stored.session));
      persistedBuilderIdsRef.current.add(session.id);
    }

    for (const sessionId of [...persistedBuilderIdsRef.current]) {
      if (currentIds.has(sessionId)) continue;
      changed = true;
      let expectedVersion = builderVersionsRef.current.get(sessionId) ?? 0;
      try {
        await deleteMemoBuilderSession(sessionId, expectedVersion);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error;
        const latest = await listMemoBuilderSessions({ limit: 50 });
        const stored = latest.items.find((item) => item.session.id === sessionId);
        if (stored) {
          expectedVersion = stored.version;
          await deleteMemoBuilderSession(sessionId, expectedVersion);
        }
      }
      builderVersionsRef.current.delete(sessionId);
      builderFingerprintsRef.current.delete(sessionId);
      persistedBuilderIdsRef.current.delete(sessionId);
    }

    if (changed) setSyncNotice("Workspace preferences saved");
  };

  useEffect(() => {
    const controller = new AbortController();
    getCurrentUser(controller.signal)
      .then(async ({ user }) => {
        if (!user) {
          resetWorkspace();
          setAuth({ status: "signed-out" });
          setStateReady(false);
          return;
        }
        const [reviewPage, preferences, builderPage] = await Promise.all([
          listReviews({ limit: 25, state: "active" }, controller.signal),
          loadWorkspacePreferences(controller.signal),
          listMemoBuilderSessions({ limit: 25 }, controller.signal)
        ]);
        hydratePagedWorkspace(reviewPage, preferences, builderPage);
        setAuth({ status: "signed-in", user });
        setStateReady(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          resetWorkspace();
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
            : "Live AI analysis is unavailable. Analysis is disabled until the provider is configured."
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
    const timer = window.setTimeout(() => {
      const snapshot = {
        selectedMemoId,
        activeMemoBuilderSessionId,
        sessions: memoBuilderSessions,
        preferences: workspacePreferences
      };
      workspaceSaveChainRef.current = workspaceSaveChainRef.current
        .catch(() => undefined)
        .then(() => persistWorkspaceSnapshot(snapshot))
        .catch((error) => {
          setSyncNotice(readableApiError(error instanceof Error ? error.message : "Preference save failed"));
        });
    }, 450);

    return () => window.clearTimeout(timer);
  }, [
    auth.status,
    stateReady,
    selectedMemoId,
    memoBuilderSessions,
    activeMemoBuilderSessionId,
    workspacePreferences
  ]);

  useEffect(() => {
    if (activeMemos.length === 0 && selectedMemoId) {
      setSelectedMemoId(undefined);
      return;
    }
    if (
      activeMemos.length > 0
      && selectedMemoId
      && !activeMemos.some((memo) => memo.id === selectedMemoId)
      && restoredSelectionRef.current !== selectedMemoId
    ) {
      setSelectedMemoId(activeMemos[0].id);
    }
    if (activeMemos.length > 0 && !selectedMemoId) {
      setSelectedMemoId(activeMemos[0].id);
    }
  }, [activeMemos, selectedMemoId]);
  useEffect(() => setSelectedFindingId(undefined), [selectedMemo?.id]);

  useEffect(() => {
    if (
      !selectedMemo
      || auth.status !== "signed-in"
      || auth.user.role === "submitter"
      || !backendHealth?.provider.configured
    ) {
      setCouncilApproval(undefined);
      return;
    }
    const controller = new AbortController();
    setCouncilApproval(undefined);
    getCouncilApproval(selectedMemo.id, analysisMode, controller.signal)
      .then(setCouncilApproval)
      .catch(() => {
        if (!controller.signal.aborted) setCouncilApproval(undefined);
      });
    return () => controller.abort();
  }, [
    selectedMemo?.id,
    selectedMemo?.version,
    selectedMemo?.revision,
    selectedMemo?.contentHash,
    analysisMode,
    auth.status,
    currentUser?.role,
    backendHealth?.provider.configured
  ]);

  const loadReviewDetail = (memoId: string, force = false) => {
    if (!force && loadedReviewDetailsRef.current.has(memoId)) return Promise.resolve();
    const inFlight = detailRequestsRef.current.get(memoId);
    if (inFlight) return inFlight;

    const request = (async () => {
      setDetailLoadingId(memoId);
      setDetailFailure((current) => current?.memoId === memoId ? undefined : current);
      const [detail, auditPage, chatPage] = await Promise.all([
        getReviewDetail(memoId),
        listReviewAuditEvents(memoId, { limit: 25 }),
        listReviewChatMessages(memoId, { limit: 25 })
      ]);
      startTransition(() => {
        setMemos((current) => [detail.review, ...current.filter((memo) => memo.id !== memoId)]);
        setAnalysisResults((current) => {
          const next = { ...current };
          if (detail.result?.provider.live) next[memoId] = detail.result;
          else delete next[memoId];
          return next;
        });
        setAnalysisStates((current) => ({
          ...current,
          [memoId]: detail.result?.provider.live
            ? { status: "live", message: "Authoritative AI analysis loaded." }
            : { status: "unanalyzed", message: "This memo has not been analyzed yet." }
        }));
        setDecisions((current) => {
          const next = { ...current };
          if (detail.decision) next[memoId] = detail.decision;
          else delete next[memoId];
          return next;
        });
        setAuditEvents((current) => mergePagedAuditEvents(current, auditPage.items, memoId, true));
        setChatMessages((current) => ({ ...current, [memoId]: mergeChatPage([], chatPage.items) }));
        setAuditCursors((current) => ({ ...current, [memoId]: auditPage.nextCursor }));
        setChatCursors((current) => ({ ...current, [memoId]: chatPage.nextCursor }));
      });
      loadedReviewDetailsRef.current.add(memoId);
      if (restoredSelectionRef.current === memoId) restoredSelectionRef.current = undefined;
    })()
      .catch((error) => {
        const failure = classifyReviewLoadFailure(memoId, error);
        if (!failure.retryable) {
          const nextMemoId = memosRef.current.find((memo) => !memo.archivedAt && memo.id !== memoId)?.id;
          restoredSelectionRef.current = undefined;
          loadedReviewDetailsRef.current.delete(memoId);
          setMemos((current) => current.filter((memo) => memo.id !== memoId));
          setSelectedMemoId((current) => current === memoId ? nextMemoId : current);
          setIntakeWarning(failure.message);
          setDetailFailure(undefined);
        } else {
          setDetailFailure(failure);
        }
        setSyncNotice(failure.message);
        throw error;
      })
      .finally(() => {
        detailRequestsRef.current.delete(memoId);
        setDetailLoadingId((current) => current === memoId ? undefined : current);
      });
    detailRequestsRef.current.set(memoId, request);
    return request;
  };

  useEffect(() => {
    if (!selectedMemoId || auth.status !== "signed-in" || !stateReady) return;
    void loadReviewDetail(selectedMemoId).catch(() => undefined);
    // Detail reads are keyed only by the selected review ID and deduped by ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMemoId, auth.status, stateReady]);

  const loadMoreReviews = async () => {
    if (!reviewCursor || reviewsLoadingMore) return;
    setReviewsLoadingMore(true);
    try {
      const page = await listReviews({ limit: 25, cursor: reviewCursor, state: "active" });
      startTransition(() => {
        setMemos((current) => mergeReviewSummaries(current, page.items));
        setReviewCursor(page.nextCursor);
      });
    } finally {
      setReviewsLoadingMore(false);
    }
  };

  const loadMoreBuilderSessions = async () => {
    if (!builderCursor || builderLoadingMore) return;
    setBuilderLoadingMore(true);
    try {
      const page = await listMemoBuilderSessions({ limit: 25, cursor: builderCursor });
      for (const stored of page.items) {
        builderVersionsRef.current.set(stored.session.id, stored.version);
        builderFingerprintsRef.current.set(
          stored.session.id,
          JSON.stringify(sanitizeMemoBuilderSessionForStorage(stored.session))
        );
        persistedBuilderIdsRef.current.add(stored.session.id);
      }
      startTransition(() => {
        setMemoBuilderSessions((current) => mergeBuilderSessions(current, page.items.map((item) => item.session)));
        setBuilderCursor(page.nextCursor);
      });
    } finally {
      setBuilderLoadingMore(false);
    }
  };

  const loadMoreAuditEvents = async (memoId: string) => {
    const cursor = auditCursors[memoId];
    if (!cursor) return;
    const page = await listReviewAuditEvents(memoId, { limit: 25, cursor });
    setAuditEvents((current) => mergePagedAuditEvents(current, page.items, memoId, false));
    setAuditCursors((current) => ({ ...current, [memoId]: page.nextCursor }));
  };

  const loadMoreChatMessages = async (memoId: string) => {
    const cursor = chatCursors[memoId];
    if (!cursor) return;
    const page = await listReviewChatMessages(memoId, { limit: 25, cursor });
    setChatMessages((current) => ({
      ...current,
      [memoId]: mergeChatPage(current[memoId] ?? [], page.items)
    }));
    setChatCursors((current) => ({ ...current, [memoId]: page.nextCursor }));
  };

  const blockDirtyDraft = (action: string) => {
    if (!memoDraftDirty) return false;
    setSyncNotice(`Save or discard memo edits before ${action}.`);
    return true;
  };

  const selectMemo = (memoId: string) => {
    if (memoId === selectedMemo?.id) {
      navigateApp({ view: "reviews", memoId, section: reviewSection });
      return;
    }
    if (blockDirtyDraft("switching memos")) return;
    setSelectedMemoId(memoId);
    navigateApp({ view: "reviews", memoId, section: "overview" });
  };

  const changeActiveView = (view: AppView) => {
    if (view === activeView) return;
    if (blockDirtyDraft("opening another workspace")) return;
    if (view === "reviews") navigateApp({ view: "reviews" });
    else if (view === "memo-builder") navigateApp({ view: "memo-builder", sessionId: activeMemoBuilderSessionId });
    else navigateApp({ view } as Parameters<typeof navigateApp>[0]);
  };

  const changeReviewSection = (section: ReviewSection) => {
    if (!selectedMemoId) return;
    setReviewSection(section);
    navigateApp({ view: "reviews", memoId: selectedMemoId, section });
  };

  const openNewReview = () => {
    if (blockDirtyDraft("creating a new review")) return;
    setNewReviewOpen(true);
  };

  const openMemoBuilderForNewDraft = () => {
    if (blockDirtyDraft("building a memo with AI")) return;
    const session = createSeededBuilderSession(
      "AI memo draft",
      "Draft a review-ready ECCN classification memo. Ask for only the facts that are truly blocking, and if enough facts are provided, produce a complete memo with missing facts and verification steps clearly labeled."
    );
    setMemoBuilderSessions((current) => [session, ...current]);
    setActiveMemoBuilderSessionId(session.id);
    navigateApp({ view: "memo-builder", sessionId: session.id });
    setSyncNotice("Memo Builder ready with an AI drafting prompt.");
  };

  const openMemoBuilderForSelectedReview = () => {
    if (!selectedMemo) return;
    if (blockDirtyDraft("improving this memo with AI")) return;
    const session = createSeededBuilderSession(
      `Improve ${selectedMemo.title}`.slice(0, 60),
      buildReviewImprovementPrompt(selectedMemo, reviewResult),
      selectedMemo.id,
      selectedMemo.dataClass ?? "proprietary"
    );
    setMemoBuilderSessions((current) => [session, ...current]);
    setActiveMemoBuilderSessionId(session.id);
    navigateApp({ view: "memo-builder", sessionId: session.id });
    setSyncNotice("Memo Builder loaded with review context.");
  };

  const focusSignoff = () => {
    if (blockDirtyDraft("recording a decision")) return;
    if (selectedMemoId) navigateApp({ view: "reviews", memoId: selectedMemoId, section: "analysis" });
    window.setTimeout(() => {
      document.querySelector(".decision-box")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  };

  const completeAuthentication = async (response: { user: UserProfile | null }) => {
    if (!response.user) throw new Error("Sign in failed.");
    const [reviewPage, preferences, builderPage] = await Promise.all([
      listReviews({ limit: 25, state: "active" }),
      loadWorkspacePreferences(),
      listMemoBuilderSessions({ limit: 25 })
    ]);
    hydratePagedWorkspace(reviewPage, preferences, builderPage);
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
    resetWorkspace();
    setStateReady(false);
    setAuth({ status: "signed-out" });
  };

  const refreshReviewState = async (notice: string, memoId: string | null = selectedMemoId ?? null) => {
    if (memoId) {
      loadedReviewDetailsRef.current.delete(memoId);
      await loadReviewDetail(memoId, true);
    } else {
      const page = await listReviews({ limit: 25, state: "active" });
      setMemos((current) => mergeReviewSummaries(current, page.items, true));
      setReviewCursor(page.nextCursor);
    }
    setSyncNotice(notice);
  };

  const acceptReviewCommand = (response: {
    review: MemoRecord;
    auditEvents?: AuditEvent[];
  }) => {
    loadedReviewDetailsRef.current.add(response.review.id);
    setMemos((current) => [
      response.review,
      ...current.filter((memo) => memo.id !== response.review.id)
    ]);
    if (response.auditEvents?.length) mergeAuditEvents(response.auditEvents);
  };

  const persistNewReview = async (input: NewReviewInput, pendingMessage: string) => {
    setSyncNotice(pendingMessage);
    try {
      const response = await createReview({
        ...input,
        title: input.title.trim() || "New ECCN Classification Memo",
        itemFamily: input.itemFamily.trim() || "Research equipment",
        memoText: input.memoText.trim()
      });
      acceptReviewCommand(response);
      setSelectedMemoId(response.review.id);
      setAnalysisStates((current) => ({
        ...current,
        [response.review.id]: {
          status: "unanalyzed",
          message: "This review is waiting for reviewer-initiated AI analysis."
        }
      }));
      navigateApp({ view: "reviews", memoId: response.review.id, section: "overview" });
      setIntakeWarning(undefined);
      setSyncNotice(response.replayed ? "Existing review restored after a safe retry" : "Review created");
      return response.review;
    } catch (error) {
      await refreshReviewState("Review creation failed; authoritative review list reloaded", null).catch(() => undefined);
      throw error;
    }
  };

  const handleFile = async (file: File, dataClass: DataClass) => {
    if (blockDirtyDraft("uploading another memo")) return;
    try {
      setIntakeWarning(`Reading ${file.name}...`);
      const result = await memoFromFile(file, dataClass);
      const reviewedMemo = await persistNewReview({
        title: result.memo.title,
        itemFamily: result.memo.itemFamily,
        manufacturer: result.memo.manufacturer ?? "",
        intendedUse: result.memo.intendedUse ?? "",
        dataClass: result.memo.dataClass ?? dataClass,
        sourcePath: result.memo.sourcePath ?? "unknown",
        attachments: result.memo.attachments,
        memoText: result.memo.memoText
      }, `Creating review from ${file.name}...`);
      setIntakeWarning(result.warning);
      setAnalysisStates((current) => ({
        ...current,
        [reviewedMemo.id]: {
          status: "unanalyzed",
          message: "Uploaded memo is waiting for reviewer-initiated AI analysis."
        }
      }));
      navigateApp({ view: "reviews", memoId: reviewedMemo.id, section: "overview" });
    } catch (error) {
      setIntakeWarning(readableApiError(error instanceof Error ? error.message : "Document extraction failed."));
    }
  };

  const handlePasteMemo = async (title: string, text: string) => {
    if (blockDirtyDraft("pasting another memo")) return;
    const memo = await persistNewReview({
      title: title.trim() || "Pasted ECCN Memo",
      itemFamily: "Pasted memo",
      manufacturer: "",
      intendedUse: "",
      dataClass: "proprietary",
      sourcePath: "self-classification",
      attachments: [],
      memoText: text
    }, "Creating pasted review...");
    setAnalysisStates((current) => ({
      ...current,
      [memo.id]: {
        status: "unanalyzed",
        message: "Pasted memo is waiting for reviewer-initiated AI analysis."
      }
    }));
    setIntakeWarning(undefined);
    navigateApp({ view: "reviews", memoId: memo.id, section: "overview" });
  };

  const handleCreatePublicDraftMemo = async (title: string, memoText: string) => {
    if (blockDirtyDraft("creating a public draft")) return;
    const memo = await persistNewReview({
      title: title.trim() || "Public-source ECCN memo draft",
      itemFamily: "Public-source draft",
      manufacturer: "",
      intendedUse: "",
      dataClass: "public",
      sourcePath: "self-classification",
      attachments: [],
      memoText
    }, "Creating public-source review...");
    setAnalysisStates((current) => ({
      ...current,
      [memo.id]: {
        status: "unanalyzed",
        message: "Public-source draft is waiting for reviewer-initiated AI analysis."
      }
    }));
    navigateApp({ view: "reviews", memoId: memo.id, section: "overview" });
  };

  const prepareBuilderSessionForAi = async (session: MemoBuilderSession) => {
    const sanitized = sanitizeMemoBuilderSessionForStorage(session);
    let expectedVersion = builderVersionsRef.current.get(session.id) ?? 0;
    let stored;
    try {
      stored = await upsertMemoBuilderSession(sanitized, expectedVersion);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      const latest = await listMemoBuilderSessions({ limit: 50 });
      expectedVersion = latest.items.find((item) => item.session.id === session.id)?.version ?? 0;
      stored = await upsertMemoBuilderSession(sanitized, expectedVersion);
    }
    builderVersionsRef.current.set(session.id, stored.version);
    builderFingerprintsRef.current.set(session.id, JSON.stringify(stored.session));
    persistedBuilderIdsRef.current.add(session.id);
    setMemoBuilderSessions((current) => [
      stored.session,
      ...current.filter((item) => item.id !== stored.session.id)
    ]);
    return stored.session;
  };

  const handleCreateBuilderMemo = async (draft: MemoBuildDraft) => {
    if (blockDirtyDraft("creating another memo")) throw new Error("Save or discard memo edits first.");
    const memo = await persistNewReview({
      title: draft.title || "AI-drafted ECCN Memo",
      itemFamily: draft.itemFamily || "AI-drafted item",
      memoText: draft.memoText,
      attachments: draft.attachments ?? [],
      dataClass: draft.dataClass ?? "proprietary",
      sourcePath: "self-classification",
      manufacturer: draft.manufacturer ?? "",
      intendedUse: draft.intendedUse ?? ""
    }, "Creating AI-assisted review...");
    setAnalysisStates((current) => ({
      ...current,
      [memo.id]: {
        status: "unanalyzed",
        message: "AI-drafted memo is waiting for reviewer-initiated AI analysis."
      }
    }));
    navigateApp({ view: "reviews", memoId: memo.id, section: "overview" });
    setIntakeWarning(undefined);
    setSyncNotice("AI draft added to Reviews");
    return memo.id;
  };

  const handleCreateAndAnalyzeBuilderMemo = async (draft: MemoBuildDraft) => {
    if (blockDirtyDraft("creating and analyzing another memo")) {
      throw new Error("Save or discard memo edits first.");
    }
    const memo = await persistNewReview({
      title: draft.title || "AI-drafted ECCN Memo",
      itemFamily: draft.itemFamily || "AI-drafted item",
      memoText: draft.memoText,
      attachments: draft.attachments ?? [],
      dataClass: draft.dataClass ?? "proprietary",
      sourcePath: "self-classification",
      manufacturer: draft.manufacturer ?? "",
      intendedUse: draft.intendedUse ?? ""
    }, "Creating AI-assisted review...");
    await runAnalysisForMemo(memo);
    return memo.id;
  };

  const handleCreateReview = async (input: NewReviewInput) => {
    if (blockDirtyDraft("creating a new review")) return;
    await persistNewReview(input, "Creating review...");
  };

  const updateMemoText = async (memoId: string, memoText: string) => {
    if (analysisStates[memoId]?.status === "running") {
      setSyncNotice("Wait for the running analysis before editing this memo.");
      throw new Error("Wait for the running analysis before editing this memo.");
    }
    const previousMemo = memosRef.current.find((memo) => memo.id === memoId);
    if (!previousMemo || typeof previousMemo.version !== "number") {
      throw new Error("Reload this review before editing it.");
    }
    setSyncNotice("Saving memo changes...");
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
    try {
      const response = await updateReviewMemo(previousMemo, memoText);
      acceptReviewCommand(response);
      setMemoDraftDirty(false);
      setSyncNotice("Memo changes saved");
    } catch (error) {
      await refreshReviewState("Memo update conflicted; authoritative review reloaded", memoId).catch(() => undefined);
      throw error;
    }
  };

  const archiveMemo = async (memoId: string) => {
    if (memoId === selectedMemo?.id && blockDirtyDraft("archiving this memo")) return;
    if (analysisStates[memoId]?.status === "running") {
      setSyncNotice("Wait for the running analysis before archiving this memo.");
      throw new Error("Wait for the running analysis before archiving this memo.");
    }
    const previousMemo = memosRef.current.find((memo) => memo.id === memoId);
    if (!previousMemo || typeof previousMemo.version !== "number") {
      throw new Error("Reload this review before archiving it.");
    }
    const archivedAt = new Date().toISOString();
    setSyncNotice("Archiving review...");
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
    try {
      const response = await setReviewArchived(previousMemo, true);
      acceptReviewCommand(response);
      setSyncNotice("Review archived");
    } catch (error) {
      await refreshReviewState("Archive conflicted; authoritative review reloaded", memoId).catch(() => undefined);
      throw error;
    }
  };

  const handleDecision = async (action: ReviewerDecision["action"], notes: string) => {
    if (blockDirtyDraft("recording a decision")) return;
    if (!selectedMemo || !reviewResult) return;
    setSyncNotice("Recording reviewer decision...");
    try {
      const response = await recordReviewDecision(selectedMemo, reviewResult, action, notes);
      acceptReviewCommand(response);
      setDecisions((current) => ({ ...current, [selectedMemo.id]: response.decision }));
      setSyncNotice("Reviewer decision recorded");
    } catch (error) {
      await refreshReviewState("Decision was not recorded; authoritative review reloaded").catch(() => undefined);
      throw error;
    }
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

  const runAnalysisForMemo = async (memo: MemoRecord) => {
    if (backendHealth && !backendHealth.provider.configured) {
      setAnalysisStates((current) => ({
        ...current,
        [memo.id]: {
          status: "failed",
          message: "Live AI analysis is unavailable. No deterministic analysis was recorded."
        }
      }));
      return;
    }
    setApprovalBusy(true);
    try {
      if (currentUser?.role === "export-control-officer") {
        const approved = await approveCouncilAnalysis(memo, analysisMode);
        setCouncilApproval((current) => current
          ? { ...current, approval: approved.approval, usable: approved.usable }
          : current);
      } else {
        const status = await getCouncilApproval(memo.id, analysisMode);
        setCouncilApproval(status);
        if (!status.usable) {
          await requestCouncilApproval(memo, analysisMode);
          setAnalysisStates((current) => ({
            ...current,
            [memo.id]: {
              status: "unanalyzed",
              message: "Approval requested for this exact revision and analysis depth. An export-control officer can inspect and approve it in Controls."
            }
          }));
          setSyncNotice("AI approval requested");
          return;
        }
      }
    } catch (error) {
      const message = readableApiError(error instanceof Error ? error.message : "AI approval failed.");
      setAnalysisStates((current) => ({
        ...current,
        [memo.id]: { status: "failed", message }
      }));
      return;
    } finally {
      setApprovalBusy(false);
    }
    const controller = new AbortController();
    analysisControllersRef.current.set(memo.id, controller);
    // End the browser wait before the 120-second CloudFront/Lambda deadline so
    // users get a deterministic retry state instead of an edge-generated 504.
    const timeoutId = window.setTimeout(() => controller.abort(), 115000);
    setAnalysisStates((current) => ({
      ...current,
      [memo.id]: {
        status: "running",
        message: backendHealth?.provider.configured
          ? `${ANALYSIS_MODE_CONFIG[analysisMode].label} is analyzing this memo. No deterministic fallback will be recorded.`
          : "Live AI availability is unknown. Rulix will fail closed if the provider is unavailable."
      }
    }));

    try {
      const {
        review,
        result,
        decisionInvalidated,
        auditEvents: serverAuditEvents
      } = await analyzeMemoWithBackend(memo, analysisMode, controller.signal);
      window.clearTimeout(timeoutId);
      const currentMemo = memosRef.current.find((item) => item.id === memo.id);
      if (currentMemo && (
        currentMemo.version !== memo.version
        || currentMemo.contentHash !== memo.contentHash
      )) {
        setAnalysisStates((current) => ({
          ...current,
          [memo.id]: {
            status: "failed",
            message: "Memo changed while analysis was running. The stale result was discarded; run analysis again."
          }
        }));
        return;
      }
      setAnalysisResults((current) => ({ ...current, [memo.id]: result }));
      if (serverAuditEvents?.length) mergeAuditEvents(serverAuditEvents);
      if (decisionInvalidated) {
        setDecisions((current) => {
          const next = { ...current };
          delete next[memo.id];
          return next;
        });
      }
      setAnalysisStates((current) => ({
        ...current,
        [memo.id]: {
          status: "live",
          message: "Live AI analysis completed. Reviewer signoff is still required."
        }
      }));
      setMemos((current) => current.map((item) => (item.id === memo.id ? review : item)));
      setSyncNotice("AI analysis saved");
      void getCouncilApproval(memo.id, analysisMode).then(setCouncilApproval).catch(() => undefined);
    } catch (error) {
      window.clearTimeout(timeoutId);
      if (controller.signal.aborted) {
        setAnalysisStates((current) => ({
          ...current,
          [memo.id]: {
            status: "unanalyzed",
            message: "AI analysis was cancelled. No partial result was recorded."
          }
        }));
        setSyncNotice("AI analysis cancelled");
        return;
      }
      const message = readableApiError(error instanceof Error ? error.message : "AI analysis request failed.");
      setAnalysisStates((current) => ({
        ...current,
        [memo.id]: {
          status: "failed",
          message: `${message} No deterministic analysis was recorded; retry when live AI is available.`
        }
      }));
      await refreshReviewState("Analysis failed; authoritative review state reloaded", memo.id).catch(() => undefined);
    } finally {
      analysisControllersRef.current.delete(memo.id);
    }
  };

  const duplicateSelectedReview = async () => {
    if (!selectedMemo) throw new Error("Open a review before duplicating it.");
    await persistNewReview({
      title: `${selectedMemo.title} (copy)`.slice(0, 240),
      itemFamily: selectedMemo.itemFamily,
      manufacturer: selectedMemo.manufacturer ?? "",
      intendedUse: selectedMemo.intendedUse ?? "",
      dataClass: selectedMemo.dataClass ?? "proprietary",
      sourcePath: selectedMemo.sourcePath ?? "unknown",
      attachments: selectedMemo.attachments,
      memoText: selectedMemo.memoText
    }, "Duplicating review as a new draft…");
  };

  const archiveSelectedReview = async () => {
    if (!selectedMemo) return;
    if (!window.confirm(`Archive “${selectedMemo.title}”? The review remains available in history.`)) return;
    await archiveMemo(selectedMemo.id);
    navigateApp({ view: "reviews" });
  };

  const handleUpdateSelectedMetadata = async (
    patch: Parameters<typeof updateReviewMetadata>[1]
  ) => {
    if (!selectedMemo) throw new Error("Open a review before changing its metadata.");
    try {
      const response = await updateReviewMetadata(selectedMemo, patch);
      acceptReviewCommand(response);
      setSyncNotice("Review metadata saved");
    } catch (error) {
      await refreshReviewState("Metadata conflicted; authoritative review reloaded", selectedMemo.id).catch(() => undefined);
      throw error;
    }
  };

  const handleSaveReviewView = (view: SavedReviewView) => {
    setWorkspacePreferences((current) => ({
      ...current,
      savedReviewViews: [...(current.savedReviewViews ?? []).filter((saved) => saved.id !== view.id), view]
    }));
    setSyncNotice(`Saved view “${view.name}”`);
  };

  const runAnalysis = async () => {
    if (blockDirtyDraft("running analysis")) return;
    if (!selectedMemo) return;
    await runAnalysisForMemo(selectedMemo);
  };

  const cancelAnalysis = () => {
    if (!selectedMemo) return;
    analysisControllersRef.current.get(selectedMemo.id)?.abort();
  };

  const handleRevokeCouncilApproval = async () => {
    const approvalId = councilApproval?.approval?.approval.id;
    if (!approvalId || approvalBusy) return;
    setApprovalBusy(true);
    try {
      const revoked = await revokeAiApproval(
        approvalId,
        "Revoked from the review workspace before provider dispatch."
      );
      setCouncilApproval((current) => current
        ? { ...current, approval: revoked.approval, usable: false }
        : current);
      setSyncNotice("AI approval revoked");
    } finally {
      setApprovalBusy(false);
    }
  };

  const handleSendMemoChat = async (memoId: string, message: string): Promise<"sent" | "queued"> => {
    if (memoId === selectedMemo?.id && blockDirtyDraft("using memo chat")) {
      throw new Error("Save or discard memo edits before using memo chat.");
    }
    if (analysisStates[memoId]?.status === "running") {
      throw new Error("Wait for the running analysis before changing this memo.");
    }
    const memo = memosRef.current.find((item) => item.id === memoId);
    if (!memo) throw new Error("Review not found. Reload the workspace and try again.");
    let response;
    try {
      response = await sendMemoChat(memo, message);
    } catch (error) {
      if (currentUser?.role !== "export-control-officer" &&
          error instanceof ApiError && error.code === "ai_officer_approval_required") {
        await requestMemoChatApproval(memo, message);
        setSyncNotice("Memo chat approval requested");
        return "queued";
      }
      throw error;
    }
    const { review, messages, auditEvents: serverAuditEvents } = response;
    setMemos((current) => current.map((item) => item.id === memoId ? review : item));
    setChatMessages((current) => ({ ...current, [memoId]: messages }));
    if (serverAuditEvents?.length) mergeAuditEvents(serverAuditEvents);
    return "sent";
  };

  const handleApplyChatSuggestion = async (memoId: string, messageId: string) => {
    if (memoId === selectedMemo?.id && blockDirtyDraft("applying a chat edit")) return;
    const memo = memosRef.current.find((item) => item.id === memoId);
    if (!memo) throw new Error("Review not found. Reload the workspace and try again.");
    setSyncNotice("Applying verified chat suggestion...");
    try {
      const response = await applyMemoChatSuggestion(memo, messageId);
      acceptReviewCommand(response);
      setChatMessages((current) => ({ ...current, [memoId]: response.messages }));
      setAnalysisResults((current) => {
        const next = { ...current };
        delete next[memoId];
        return next;
      });
      setDecisions((current) => {
        const next = { ...current };
        delete next[memoId];
        return next;
      });
      setAnalysisStates((current) => ({
        ...current,
        [memoId]: {
          status: "unanalyzed",
          message: "Chat suggestion applied. Run AI Analysis again before recording a decision."
        }
      }));
      setSyncNotice("Chat suggestion applied");
    } catch (error) {
      await refreshReviewState("Suggestion was not applied; authoritative review reloaded", memoId).catch(() => undefined);
      throw error;
    }
  };

  const resetWorkspace = () => {
    analysisControllersRef.current.forEach((controller) => controller.abort());
    analysisControllersRef.current.clear();
    setMemoDraftDirty(false);
    preferenceVersionRef.current = 0;
    preferenceFingerprintRef.current = "";
    loadedReviewDetailsRef.current.clear();
    detailRequestsRef.current.clear();
    restoredSelectionRef.current = undefined;
    builderVersionsRef.current.clear();
    builderFingerprintsRef.current.clear();
    persistedBuilderIdsRef.current.clear();
    setMemos([]);
    setReviewCursor(undefined);
    setSelectedMemoId(undefined);
    setDecisions({});
    setAuditEvents([]);
    setAnalysisResults({});
    setAnalysisStates({});
    setChatMessages({});
    setMemoBuilderSessions([]);
    setActiveMemoBuilderSessionId(undefined);
    setBuilderCursor(undefined);
    setAuditCursors({});
    setChatCursors({});
    setDetailFailure(undefined);
    setWorkspacePreferences({});
    setTenantMembers([]);
    setUnreadNotifications(0);
  };

  const hydratePagedWorkspace = (
    reviewPage: Awaited<ReturnType<typeof listReviews>>,
    preferences: Awaited<ReturnType<typeof loadWorkspacePreferences>>,
    builderPage: Awaited<ReturnType<typeof listMemoBuilderSessions>>
  ) => {
    resetWorkspace();
    const storedSessions = builderPage.items;
    const summaryMemos = mergeReviewSummaries([], reviewPage.items, true);
    const route = parseAppHash(window.location.hash);
    const extraPreferences: WorkspacePreferences = {
      ...(preferences.onboardingCompletedAt ? { onboardingCompletedAt: preferences.onboardingCompletedAt } : {}),
      ...(preferences.dismissedGuidance ? { dismissedGuidance: preferences.dismissedGuidance } : {}),
      ...(preferences.savedReviewViews ? { savedReviewViews: preferences.savedReviewViews } : {}),
      ...(preferences.activeWorkspace ? { activeWorkspace: preferences.activeWorkspace } : {}),
      ...(preferences.lastAppRoute ? { lastAppRoute: preferences.lastAppRoute } : {}),
      ...(preferences.lastDashboardRoute ? { lastDashboardRoute: preferences.lastDashboardRoute } : {})
    };
    setWorkspacePreferences(extraPreferences);
    setMemos(summaryMemos);
    setReviewCursor(reviewPage.nextCursor);
    preferenceVersionRef.current = preferences.version;
    preferenceFingerprintRef.current = JSON.stringify({
      selectedMemoId: preferences.selectedMemoId ?? null,
      activeMemoBuilderSessionId: preferences.activeMemoBuilderSessionId ?? null,
      ...extraPreferences
    });
    const routedMemoId = route.view === "reviews" && isReviewId(route.memoId) ? route.memoId : undefined;
    const restoredMemoId = routedMemoId ?? (isReviewId(preferences.selectedMemoId) ? preferences.selectedMemoId : undefined);
    restoredSelectionRef.current = restoredMemoId
      && !summaryMemos.some((memo) => memo.id === restoredMemoId)
      ? restoredMemoId
      : undefined;
    setSelectedMemoId(restoredMemoId ?? summaryMemos[0]?.id);
    const builderSessions = storedSessions.map((stored) => stored.session);
    builderVersionsRef.current = new Map(
      storedSessions.map((stored) => [stored.session.id, stored.version])
    );
    builderFingerprintsRef.current = new Map(
      storedSessions.map((stored) => [
        stored.session.id,
        JSON.stringify(sanitizeMemoBuilderSessionForStorage(stored.session))
      ])
    );
    persistedBuilderIdsRef.current = new Set(storedSessions.map((stored) => stored.session.id));
    setMemoBuilderSessions(builderSessions);
    setActiveMemoBuilderSessionId(preferences.activeMemoBuilderSessionId ?? builderSessions[0]?.id);
    setBuilderCursor(builderPage.nextCursor);
    setActiveView(route.view);
    if (route.view === "reviews") setReviewSection(route.section ?? "overview");
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
          <ThemeToggle className="auth-theme-toggle" />
          <BrandLogo tone="adaptive" size="auth" />
          <h1>Checking secure session</h1>
          <p>Loading your account-linked review workspace.</p>
        </div>
      </div>
    );
  }

  if (auth.status === "signed-out") {
    return (
      <AuthScreen
        authLink={authLink}
        error={auth.error}
        onSignIn={handleSignIn}
        onAcceptInvite={handleAcceptInvite}
        onRequestPasswordReset={requestPasswordReset}
        onCompletePasswordReset={handleCompletePasswordReset}
      />
    );
  }

  const currentRoute = parseAppHash(window.location.hash);
  const reviewRouteOpen = activeView === "reviews" && currentRoute.view === "reviews" && Boolean(currentRoute.memoId);
  const selectedAuditEvents = selectedMemo
    ? auditEvents.filter((event) => event.memoId === selectedMemo.id)
    : [];
  const memoEditor = selectedMemo ? (
    <MemoWorkspace
      memo={selectedMemo}
      result={reviewResult}
      selectedFindingId={selectedFindingId}
      analysisLocked={analysisState.status === "running"}
      onMemoTextChange={updateMemoText}
      onArchiveMemo={archiveMemo}
      onCreatePublicDraft={handleCreatePublicDraftMemo}
      onImproveWithAi={openMemoBuilderForSelectedReview}
      onDirtyChange={setMemoDraftDirty}
    />
  ) : null;
  const reviewTools = selectedMemo ? (
    <AnalysisPanel
      memo={selectedMemo}
      result={reviewResult}
      analysisState={analysisState}
      analysisMode={analysisMode}
      onAnalysisModeChange={setAnalysisMode}
      backendNotice={backendNotice}
      liveAnalysisAvailable={backendHealth?.provider.configured !== false}
      onRunAnalysis={runAnalysis}
      userRole={auth.user.role}
      councilApproval={councilApproval}
      approvalBusy={approvalBusy}
      onRevokeCouncilApproval={handleRevokeCouncilApproval}
      decision={decision}
      auditEvents={selectedAuditEvents}
      chatMessages={chatMessages[selectedMemo.id] ?? []}
      analysisLocked={analysisState.status === "running"}
      memoDraftDirty={memoDraftDirty}
      onDecision={handleDecision}
      onSendChat={handleSendMemoChat}
      onApplyChatSuggestion={handleApplyChatSuggestion}
      chatHasMore={Boolean(chatCursors[selectedMemo.id])}
      auditHasMore={Boolean(auditCursors[selectedMemo.id])}
      onLoadMoreChat={loadMoreChatMessages}
      onLoadMoreAudit={loadMoreAuditEvents}
      selectedFindingId={selectedFindingId}
      onFindingSelect={setSelectedFindingId}
    />
  ) : null;

  return (
    <div className="px-app-shell">
      <a className="px-skip-link" href="#main-content">Skip to main content</a>
      <TopBar
        tenant={auth.user.organizationName ?? "Research Facility Pilot"}
        user={auth.user}
        systemStatus={backendHealth?.ok ? "Operational" : "Status unavailable"}
        unreadNotifications={unreadNotifications}
        onSearch={() => setCommandOpen(true)}
        onNotifications={() => setNotificationsOpen(true)}
        onHelp={() => setHelpOpen(true)}
        onSettings={() => changeActiveView("settings")}
        onMobileMenu={() => setMobileNavOpen(true)}
        onSignOut={() => void handleSignOut()}
      />
      <CommandPalette
        open={commandOpen}
        reviews={memos}
        onClose={() => setCommandOpen(false)}
        onNavigate={changeActiveView}
        onOpenReview={selectMemo}
        onNewReview={openNewReview}
      />
      <NotificationsDrawer
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
        onUnreadChange={setUnreadNotifications}
        onOpenReview={selectMemo}
      />
      <div className="px-app-body">
        <SidebarRail
          activeView={activeView}
          userRole={auth.user.role}
          mobileOpen={mobileNavOpen}
          serviceReady={Boolean(backendHealth?.ok)}
          onViewChange={changeActiveView}
          onMobileClose={() => setMobileNavOpen(false)}
        />
        <div className="px-app-content">
          {activeView === "home" ? (
            <HomeView
              user={auth.user}
              reviews={memos}
              results={analysisResults}
              decisions={decisions}
              preferences={workspacePreferences}
              onOpenReview={selectMemo}
              onOpenQueue={() => navigateApp({ view: "reviews" })}
              onNewReview={openNewReview}
              onOpenMemoBuilder={openMemoBuilderForNewDraft}
              onCompleteOnboarding={() => setWorkspacePreferences((current) => ({ ...current, onboardingCompletedAt: new Date().toISOString() }))}
            />
          ) : activeView === "reviews" && !reviewRouteOpen ? (
            <ReviewQueueView
              user={auth.user}
              savedViews={workspacePreferences.savedReviewViews ?? []}
              onOpenReview={selectMemo}
              onNewReview={openNewReview}
              onSaveView={handleSaveReviewView}
            />
          ) : activeView === "reviews" && selectedMemo ? (
            <ReviewWorkbench
              memo={selectedMemo}
              result={reviewResult}
              decision={decision}
              auditEvents={selectedAuditEvents}
              user={auth.user}
              members={tenantMembers}
              section={reviewSection}
              analysisStatus={analysisState.status}
              analysisMessage={analysisState.message}
              councilApproval={councilApproval}
              approvalBusy={approvalBusy}
              memoEditor={memoEditor}
              reviewTools={reviewTools}
              onSectionChange={changeReviewSection}
              onBack={() => navigateApp({ view: "reviews" })}
              onRunAnalysis={() => void runAnalysis()}
              onCancelAnalysis={cancelAnalysis}
              onExport={exportReport}
              onOpenMemoBuilder={openMemoBuilderForSelectedReview}
              onDuplicate={duplicateSelectedReview}
              onArchive={archiveSelectedReview}
              onUpdateMetadata={handleUpdateSelectedMetadata}
              onDecision={handleDecision}
            />
          ) : activeView === "reviews" ? (
            <main className="px-page px-loading-page" id="main-content">
              <div className="px-empty-state">
                <span className="px-loader" />
                <h1>{detailLoadingId === selectedMemoId ? "Loading review details" : "Review details unavailable"}</h1>
                <p>{detailFailure?.memoId === selectedMemoId ? detailFailure?.message : "Fetching the memo, analysis, collaboration, and audit history."}</p>
                {selectedMemoId && detailLoadingId !== selectedMemoId ? <button type="button" className="button" onClick={() => void loadReviewDetail(selectedMemoId, true)}>Retry loading review</button> : null}
                <button type="button" className="px-text-button" onClick={() => navigateApp({ view: "reviews" })}>Back to Review Queue</button>
              </div>
            </main>
          ) : activeView === "memo-builder" ? (
            <main className="px-builder-page" id="main-content">
              <MemoDraftChatPanel
                sessions={memoBuilderSessions}
                activeSessionId={activeMemoBuilderSessionId}
                onSessionsChange={setMemoBuilderSessions}
                onActiveSessionChange={(sessionId) => {
                  setActiveMemoBuilderSessionId(sessionId);
                  navigateApp({ view: "memo-builder", sessionId });
                }}
                onCreateMemo={handleCreateBuilderMemo}
                onCreateAndAnalyze={handleCreateAndAnalyzeBuilderMemo}
                onPrepareSessionForAi={prepareBuilderSessionForAi}
                userRole={auth.user.role}
                hasMoreSessions={Boolean(builderCursor)}
                loadingMoreSessions={builderLoadingMore}
                onLoadMoreSessions={loadMoreBuilderSessions}
              />
            </main>
          ) : activeView === "evidence" ? (
            <EvidenceLibraryView corpus={officialCorpus} reviews={memos} onOpenReview={selectMemo} />
          ) : (
            <AdminConsole
              view={activeView}
              memos={memos}
              decisions={decisions}
              auditEvents={auditEvents}
              reviewResults={reviewResults}
              corpus={officialCorpus}
              userRole={auth.user.role}
              onSelectMemo={selectMemo}
            />
          )}
        </div>
      </div>
      {(exportNotice || intakeWarning) ? <div className="px-toast" role="status">{exportNotice || intakeWarning}</div> : null}
      <NewReviewModal
        open={newReviewOpen}
        onClose={() => setNewReviewOpen(false)}
        onCreate={handleCreateReview}
      />
      <HelpCenter
        open={helpOpen}
        userRole={auth.user.role}
        onClose={() => setHelpOpen(false)}
        onNewReview={openNewReview}
        onMemoBuilder={openMemoBuilderForNewDraft}
      />
    </div>
  );
}

function createSeededBuilderSession(
  title: string,
  starterPrompt: string,
  contextMemoId?: string,
  dataClass: DataClass = "proprietary"
): MemoBuilderSession {
  const now = new Date().toISOString();
  return {
    id: `builder-${crypto.randomUUID()}`,
    title,
    dataClass,
    messages: [],
    starterPrompt,
    contextMemoId,
    updatedAt: now
  };
}

function mergeReviewSummaries(
  current: MemoRecord[],
  summaries: ReviewSummary[],
  replace = false
) {
  const currentById = new Map(current.map((memo) => [memo.id, memo]));
  const incoming = summaries.map((summary) => ({
    ...(currentById.get(summary.id) ?? {
      memoText: "",
      attachments: []
    }),
    ...summary
  } as MemoRecord));
  if (replace) return incoming;
  const incomingIds = new Set(incoming.map((memo) => memo.id));
  return [...current.filter((memo) => !incomingIds.has(memo.id)), ...incoming];
}

function mergeBuilderSessions(current: MemoBuilderSession[], incoming: MemoBuilderSession[]) {
  const incomingIds = new Set(incoming.map((session) => session.id));
  return [...current.filter((session) => !incomingIds.has(session.id)), ...incoming];
}

function mergePagedAuditEvents(
  current: AuditEvent[],
  incoming: AuditEvent[],
  memoId: string,
  replace: boolean
) {
  const otherMemos = current.filter((event) => event.memoId !== memoId);
  const currentMemo = replace ? [] : current.filter((event) => event.memoId === memoId);
  const seen = new Set<string>();
  const mergedMemo = [...currentMemo, ...incoming].filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
  return [...mergedMemo, ...otherMemos];
}

function buildReviewImprovementPrompt(memo: MemoRecord, result: ReviewResult | undefined) {
  const findings = result?.findings
    .slice(0, 8)
    .map((finding, index) => `${index + 1}. ${finding.status.toUpperCase()}: ${finding.title} - ${finding.claim}`)
    .join("\n") || "No AI analysis findings are available yet. Improve structure, clarity, and missing-fact handling from the memo text.";
  const infoRequests = result?.infoRequests.length
    ? result.infoRequests.slice(0, 8).map((request, index) => `${index + 1}. ${request}`).join("\n")
    : "No explicit information requests are available yet.";

  return [
    "Improve this existing ECCN memo into a cleaner review-ready draft.",
    "Preserve useful facts, do not invent specifications, and make unknowns explicit in Information still needed.",
    "Return a complete memo draft with the normal Rulix sections and reviewer-verification checklist.",
    "",
    `Title: ${memo.title}`,
    `Item family: ${memo.itemFamily}`,
    `Manufacturer: ${memo.manufacturer ?? "unknown"}`,
    `Intended use: ${memo.intendedUse ?? "unknown"}`,
    `Data class: ${memo.dataClass ?? "proprietary"}`,
    "",
    "Current review findings:",
    findings,
    "",
    "Information requests:",
    infoRequests,
    "",
    "Current memo text:",
    clipForBuilderPrompt(memo.memoText, 14000)
  ].join("\n");
}

function builderAuditDetail(draft: MemoBuildDraft, suffix: string) {
  const sourceLabel =
    draft.source === "attachments"
      ? "from attached source documents"
      : draft.source === "sample"
        ? "from sample data"
        : draft.source === "review-improvement"
          ? "from existing review context"
          : "from Memo Builder chat";
  const quality = draft.qualityChecks?.length
    ? ` Quality checks: ${draft.qualityChecks.slice(0, 3).join("; ")}.`
    : "";
  const missing = draft.missingFacts?.length
    ? ` Missing facts flagged: ${draft.missingFacts.slice(0, 3).join("; ")}.`
    : "";
  return `Memo drafted via Memo Builder ${sourceLabel}. ${suffix}${quality}${missing}`.trim();
}

function clipForBuilderPrompt(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n\n[Memo text truncated for builder context]` : value;
}

type AuthMode = "signin" | "invite" | "reset-request" | "reset-complete";

interface AuthFormValues {
  email: string;
  password: string;
  token: string;
}

function AuthScreen({
  authLink,
  error,
  onSignIn,
  onAcceptInvite,
  onRequestPasswordReset,
  onCompletePasswordReset
}: {
  authLink: AuthLinkBootstrap;
  error?: string;
  onSignIn: (email: string, password: string) => Promise<void>;
  onAcceptInvite: (token: string, password: string, name?: string) => Promise<void>;
  onRequestPasswordReset: (email: string) => Promise<void>;
  onCompletePasswordReset: (token: string, password: string) => Promise<void>;
}) {
  const initialInviteToken = authLink.mode === "invite" ? authLink.token : "";
  const initialResetToken = authLink.mode === "reset-complete" ? authLink.token : "";
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
        <ThemeToggle className="auth-theme-toggle" />
        <BrandLogo tone="adaptive" size="auth" />
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

function deriveAnalysisStates(results: Record<string, ReviewResult>) {
  return Object.fromEntries(
    Object.entries(results).map(([memoId]) => [
      memoId,
      {
        status: "live",
        message: "Live AI analysis completed. Reviewer signoff is still required."
      }
    ])
  ) as Record<string, AnalysisRunState>;
}

function liveOnlyAnalysisResults(results: Record<string, ReviewResult>) {
  return Object.fromEntries(
    Object.entries(results).filter(([, result]) => result.provider.live && result.provider.source === "bedrock")
  ) as Record<string, ReviewResult>;
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

export function classifyReviewLoadFailure(memoId: string, error: unknown): ReviewLoadFailure {
  if (error instanceof ApiError && (error.status === 404 || error.code === "invalid_review_id")) {
    return {
      memoId,
      retryable: false,
      message: error.status === 404
        ? "That review no longer exists. It was removed from this queue and your next available review was selected."
        : "That saved review reference is no longer supported. It was removed from this queue and your next available review was selected."
    };
  }
  if (error instanceof ApiError && error.status === 403) {
    return {
      memoId,
      retryable: false,
      message: "You no longer have access to that review. Your next available review was selected."
    };
  }
  return {
    memoId,
    retryable: true,
    message: error instanceof ApiError && error.status >= 500
      ? "Rulix could not load this review because the service is temporarily unavailable. Retry when ready."
      : "Rulix could not finish loading this review. Check your connection and retry."
  };

}
