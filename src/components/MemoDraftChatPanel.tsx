import { ChangeEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  Database,
  Download,
  FileText,
  FileUp,
  ListChecks,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import {
  ApiError,
  requestMemoBuilderApproval,
  sendMemoBuildChat,
  type MemoBuildDraft,
  type MemoBuildMessage
} from "../lib/apiClient";
import { extractFileText, formatExtractedAttachment } from "../lib/documentIntake";
import { renderMarkdown } from "../lib/markdown";
import type { MemoBuilderDraftSource, MemoBuilderSession, UserProfile } from "../types";

interface MemoDraftChatPanelProps {
  sessions: MemoBuilderSession[];
  activeSessionId?: string;
  onSessionsChange: (sessions: MemoBuilderSession[]) => void;
  onActiveSessionChange: (sessionId: string) => void;
  onCreateMemo: (draft: MemoBuildDraft) => Promise<string | void>;
  onCreateAndAnalyze: (draft: MemoBuildDraft) => Promise<string | void>;
  onPrepareSessionForAi: (session: MemoBuilderSession) => Promise<MemoBuilderSession>;
  userRole: UserProfile["role"];
  hasMoreSessions?: boolean;
  loadingMoreSessions?: boolean;
  onLoadMoreSessions?: () => Promise<void>;
}

interface BuilderAttachment {
  id: string;
  name: string;
  content: string;
  status: "reading" | "ready" | "warning" | "failed";
  detail: string;
}

interface DraftSection {
  title: string;
  body: string;
}

type SessionJobStatus = "thinking" | "approval" | "error";

interface SessionJob {
  status: SessionJobStatus;
  detail: string;
}

interface OptimisticMessage {
  content: string;
  visibleText: string;
  attachments: BuilderAttachment[];
}

const ATTACHMENT_CONTEXT_MARKER = "\n\n---\nAttached source documents for Sonnet:\n";
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const ITEM_STARTER =
  "I need an ECCN memo for this item:";
const ATTACHMENT_STARTER =
  "Build an ECCN memo from these source documents. Ask me only for anything that truly blocks a useful draft.";

export function MemoDraftChatPanel({
  sessions,
  activeSessionId,
  onSessionsChange,
  onActiveSessionChange,
  onCreateMemo,
  onCreateAndAnalyze,
  onPrepareSessionForAi,
  userRole,
  hasMoreSessions = false,
  loadingMoreSessions = false,
  onLoadMoreSessions = async () => undefined
}: MemoDraftChatPanelProps) {
  const [input, setInput] = useState("");
  const [writeBusy, setWriteBusy] = useState(false);
  const [sessionJobs, setSessionJobs] = useState<Record<string, SessionJob>>({});
  const [sessionErrors, setSessionErrors] = useState<Record<string, string>>({});
  const [optimisticMessages, setOptimisticMessages] = useState<Record<string, OptimisticMessage>>({});
  const [attachments, setAttachments] = useState<BuilderAttachment[]>([]);
  const [copyNotice, setCopyNotice] = useState("");
  const [writeNotice, setWriteNotice] = useState("");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= 760
  );
  const sessionsRef = useRef(sessions);
  const activeSessionIdRef = useRef(activeSessionId);
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const draftCardRef = useRef<HTMLDivElement>(null);
  const draftDocumentRef = useRef<HTMLElement>(null);
  sessionsRef.current = sessions;

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions]
  );
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  activeSessionIdRef.current = activeSession?.id;
  const messages = activeSession?.messages ?? [];
  const draft = activeSession?.draft;
  const draftSections = useMemo(() => (draft ? parseDraftSections(draft.memoText) : []), [draft]);
  const activeContextPrompt = activeSession?.starterPrompt;
  const activeJob = activeSession ? sessionJobs[activeSession.id] : undefined;
  const busy = activeJob?.status === "thinking";
  const composerLocked = busy || activeJob?.status === "approval";
  const error = activeSession ? sessionErrors[activeSession.id] ?? "" : "";
  const optimisticMessage = activeSession ? optimisticMessages[activeSession.id] : undefined;
  const conversationStarted = messages.length > 0 || Boolean(optimisticMessage) || Boolean(activeJob) || Boolean(draft);
  const thinkingCount = Object.values(sessionJobs).filter((job) => job.status === "thinking").length;
  const latestAssistantMessage = [...messages].reverse().find((message) => message.role === "assistant");
  const suggestedReplies = !busy && !draft ? replySuggestions(latestAssistantMessage?.content) : [];
  const dataRecommendation = recommendDataClass(
    [input, ...messages.slice(-4).map((message) => message.content)].join(" ")
  );

  useEffect(() => {
    if (!activeSession && sessions.length === 0) {
      const session = createBlankSession();
      onSessionsChange([session]);
      onActiveSessionChange(session.id);
    }
  }, [activeSession, onActiveSessionChange, onSessionsChange, sessions.length]);

  useEffect(() => {
    const el = threadRef.current;
    if (el && (busy || optimisticMessage || !draft)) el.scrollTop = el.scrollHeight;
  }, [activeSession?.id, messages, busy, optimisticMessage, draft]);

  useEffect(() => {
    if (draft) {
      window.requestAnimationFrame(() => draftCardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }));
    }
  }, [draft?.memoText]);

  // Restore pending input and attachments when switching sessions
  useEffect(() => {
    const pendingWasSent = activeSession ? Boolean(optimisticMessages[activeSession.id]) : false;
    setInput(pendingWasSent ? "" : activeSession?.pendingInput ?? "");
    setAttachments(pendingWasSent
      ? []
      : (activeSession?.pendingAttachments ?? []).map((a) => ({ ...a })));
    setToolsOpen(false);
  // Only run when the session ID changes, not on every session update
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.id]);

  useEffect(() => {
    if (!toolsOpen) return;
    const closeTools = (event: PointerEvent) => {
      if (!toolsMenuRef.current?.contains(event.target as Node)) setToolsOpen(false);
    };
    document.addEventListener("pointerdown", closeTools);
    return () => document.removeEventListener("pointerdown", closeTools);
  }, [toolsOpen]);

  // Debounced save of draft input text to the session
  useEffect(() => {
    if (!activeSession) return;
    if (optimisticMessages[activeSession.id] || sessionJobs[activeSession.id]) return;
    if (input === (activeSession.pendingInput ?? "")) return;
    const t = setTimeout(() => updateActiveSession({ pendingInput: input }), 600);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  // Save ready/warning attachments to the session whenever they change
  useEffect(() => {
    if (!activeSession) return;
    if (optimisticMessages[activeSession.id] || sessionJobs[activeSession.id]) return;
    const persistable = attachments
      .filter((a): a is BuilderAttachment & { status: "ready" | "warning" } =>
        a.status === "ready" || a.status === "warning"
      );
    const saved = activeSession.pendingAttachments ?? [];
    const sameIds = persistable.length === saved.length && persistable.every((a, i) => a.id === saved[i]?.id);
    if (sameIds) return;
    updateActiveSession({ pendingAttachments: persistable });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachments]);

  const updateSession = (
    sessionId: string,
    patch: Partial<MemoBuilderSession>,
    baseSession?: MemoBuilderSession,
    activate = false
  ) => {
    const current = sessionsRef.current;
    const session = current.find((item) => item.id === sessionId) ?? baseSession;
    if (!session) return;
    const nextSession: MemoBuilderSession = {
      ...session,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    const seen = new Set<string>();
    const nextSessions = [nextSession, ...current.filter((item) => item.id !== nextSession.id)]
      .filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
    sessionsRef.current = nextSessions;
    onSessionsChange(nextSessions);
    if (activate) onActiveSessionChange(nextSession.id);
  };

  const updateActiveSession = (patch: Partial<MemoBuilderSession>) => {
    const session = activeSession ?? createBlankSession();
    if (!sessionsRef.current.some((item) => item.id === session.id)) {
      sessionsRef.current = [session, ...sessionsRef.current];
    }
    updateSession(session.id, patch, session, true);
  };

  const startNewChat = () => {
    const session = createBlankSession();
    const nextSessions = [session, ...sessionsRef.current];
    sessionsRef.current = nextSessions;
    onSessionsChange(nextSessions);
    onActiveSessionChange(session.id);
    setInput("");
    setCopyNotice("");
    setWriteNotice("");
    setAttachments([]);
    setToolsOpen(false);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const clearSessionError = (sessionId: string) => {
    setSessionErrors((current) => {
      if (!(sessionId in current)) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  };

  const useQuickStart = (kind: "item" | "attachments" | "sample" | "review" | "other") => {
    if (activeSession) clearSessionError(activeSession.id);
    setCopyNotice("");
    setWriteNotice("");
    if (kind === "item") {
      setInput(ITEM_STARTER);
      window.setTimeout(() => textareaRef.current?.focus(), 0);
      return;
    }

    if (kind === "other") {
      setInput("");
      window.setTimeout(() => textareaRef.current?.focus(), 0);
      return;
    }

    if (kind === "attachments") {
      const hasReadyAttachment = attachments.some((attachment) => attachment.content.trim());
      if (hasReadyAttachment) {
        void send(ATTACHMENT_STARTER, "attachments");
        return;
      }
      setInput(ATTACHMENT_STARTER);
      fileInputRef.current?.click();
      return;
    }

    if (kind === "review") {
      setInput(activeContextPrompt ?? "Improve the current memo into a review-ready ECCN memo. Preserve useful facts and make missing facts explicit.");
      window.setTimeout(() => textareaRef.current?.focus(), 0);
      return;
    }

    const sampleDraft = buildSampleDraft();
    updateActiveSession({
      title: "Sample RF amplifier memo",
      messages: [
        ...messages,
        { role: "assistant", content: "Sample memo created. Review it below, then copy it or add it to Reviews." }
      ],
      draft: sampleDraft
    });
  };

  const send = async (
    overrideText?: string,
    explicitSource?: MemoBuilderDraftSource,
    overrideAttachments?: BuilderAttachment[]
  ) => {
    const targetSession = activeSession ?? createBlankSession();
    const targetSessionId = targetSession.id;
    const text = (overrideText ?? input).trim();
    const attachmentSource = overrideAttachments ?? attachments;
    const readyAttachments = attachmentSource.filter((attachment) => attachment.content.trim());
    const unsentAttachments = attachmentSource;
    if (
      (!text && readyAttachments.length === 0)
      || sessionJobs[targetSessionId]?.status === "thinking"
    ) return;
    if (attachmentSource.some((attachment) => attachment.status === "reading")) {
      setSessionErrors((current) => ({
        ...current,
        [targetSessionId]: "Wait for the attachment text extraction to finish before sending."
      }));
      return;
    }

    const visibleText = text || "Draft an ECCN memo from the attached source documents.";
    const draftSource = explicitSource ?? (readyAttachments.length ? "attachments" : activeSession?.contextMemoId ? "review-improvement" : "chat");
    const userMsg: MemoBuildMessage = {
      role: "user",
      content: buildUserContentForSonnet(visibleText, readyAttachments)
    };
    const targetMessages = [...targetSession.messages];
    const targetDraft = targetSession.draft;
    const nextMessages = [...targetMessages, userMsg];
    setInput("");
    setAttachments([]);
    setToolsOpen(false);
    clearSessionError(targetSessionId);
    setOptimisticMessages((current) => ({
      ...current,
      [targetSessionId]: { content: userMsg.content, visibleText, attachments: unsentAttachments }
    }));
    setSessionJobs((current) => ({
      ...current,
      [targetSessionId]: {
        status: "thinking",
        detail: thinkingLabel(visibleText, readyAttachments.length)
      }
    }));
    setCopyNotice("");
    setWriteNotice("");

    try {
      const preparedSession = await onPrepareSessionForAi({
        ...targetSession,
        title: conversationTitle(targetSession, visibleText, readyAttachments),
        pendingInput: userMsg.content
      });
      const fingerprint = JSON.stringify({
        id: preparedSession.id,
        dataClass: preparedSession.dataClass,
        messages: preparedSession.messages,
        pendingInput: preparedSession.pendingInput,
        updatedAt: preparedSession.updatedAt
      });
      let result;
      try {
        result = await sendMemoBuildChat(
          preparedSession.id,
          userMsg.content,
          fingerprint
        );
      } catch (error) {
        if (userRole !== "export-control-officer" &&
            error instanceof ApiError && error.code === "ai_officer_approval_required") {
          await requestMemoBuilderApproval(preparedSession.id, fingerprint);
          setSessionJobs((current) => ({
            ...current,
            [targetSessionId]: {
              status: "approval",
              detail: "Waiting for an export-control officer to approve this exact message."
            }
          }));
          return;
        }
        throw error;
      }
      const assistantMsg: MemoBuildMessage = { role: "assistant", content: result.reply };
      const returnedDraft = result.draft
        ? normalizeDraft(
            result.draft,
            readyAttachments,
            targetDraft,
            nextMessages,
            draftSource,
            targetSession.contextMemoId
          )
        : undefined;
      if (result.draft && !returnedDraft) {
        setSessionErrors((current) => ({
          ...current,
          [targetSessionId]: "The draft needs more detail. Ask Rulix to produce the full sectioned memo."
        }));
      }
      updateSession(targetSessionId, {
        title: finishedConversationTitle(preparedSession.title, returnedDraft),
        messages: [...nextMessages, assistantMsg],
        draft: returnedDraft ?? targetDraft,
        pendingInput: undefined,
        pendingAttachments: undefined
      }, preparedSession);
      if (activeSessionIdRef.current === targetSessionId) {
        setInput("");
        setAttachments([]);
      }
      setOptimisticMessages((current) => omitRecordKey(current, targetSessionId));
      setSessionJobs((current) => omitRecordKey(current, targetSessionId));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong. Try again.";
      setSessionErrors((current) => ({ ...current, [targetSessionId]: message }));
      setSessionJobs((current) => ({
        ...current,
        [targetSessionId]: { status: "error", detail: message }
      }));
      updateSession(targetSessionId, {
        pendingInput: text,
        pendingAttachments: unsentAttachments.filter(
          (attachment): attachment is BuilderAttachment & { status: "ready" | "warning" } =>
            attachment.status === "ready" || attachment.status === "warning"
        )
      }, targetSession);
    } finally {
      if (activeSessionIdRef.current === targetSessionId) textareaRef.current?.focus();
    }
  };

  const retryActiveMessage = () => {
    if (!activeSession) return;
    const pending = optimisticMessages[activeSession.id];
    if (!pending) return;
    void send(pending.visibleText, undefined, pending.attachments);
  };

  const handleAttachmentChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    for (const file of files) {
      const id = crypto.randomUUID();
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachments((current) => [
          ...current,
          {
            id,
            name: file.name,
            content: "",
            status: "failed",
            detail: "File is too large for inline extraction. Use a PDF under 4 MB or split the datasheet."
          }
        ]);
        continue;
      }
      setAttachments((current) => [
        ...current,
        { id, name: file.name, content: "", status: "reading", detail: "Reading attachment. PDFs can take a bit..." }
      ]);
      try {
        const extraction = await extractFileText(file, activeSession?.dataClass ?? "proprietary");
        const content = extraction.text.trim() ? formatExtractedAttachment(file.name, extraction) : "";
        setAttachments((current) =>
          current.map((attachment) =>
            attachment.id === id
              ? {
                  id,
                  name: file.name,
                  content,
                  status: content ? (extraction.warning ? "warning" : "ready") : "warning",
                  detail: content
                    ? extraction.warning ?? `${attachmentMethodLabel(extraction.method)} Ready to send.`
                    : extraction.warning ?? "No meaningful text was extracted."
                }
              : attachment
          )
        );
      } catch (err) {
        setAttachments((current) =>
          current.map((attachment) =>
            attachment.id === id
              ? {
                  ...attachment,
                  status: "failed",
                  detail: err instanceof Error ? err.message : "Attachment extraction failed."
                }
              : attachment
          )
        );
      }
    }
  };

  const handleWrite = async (analyze: boolean) => {
    if (!draft || !draft.memoText.trim() || writeBusy) return;
    setWriteBusy(true);
    if (activeSession) clearSessionError(activeSession.id);
    setWriteNotice(analyze ? "Adding review before analysis..." : "Adding review...");
    try {
      const reviewId = await (analyze ? onCreateAndAnalyze(draft) : onCreateMemo(draft));
      updateActiveSession({
        draft: undefined,
        starterPrompt: undefined,
        contextMemoId: undefined
      });
      setInput("");
      setWriteNotice(reviewId ? `Added to Reviews as ${reviewId}.` : "Added to Reviews.");
    } catch (err) {
      if (activeSession) {
        setSessionErrors((current) => ({
          ...current,
          [activeSession.id]: err instanceof Error ? err.message : "The review could not be created. Try again."
        }));
      }
      setWriteNotice("");
    } finally {
      setWriteBusy(false);
    }
  };

  const clearDraft = () => {
    updateActiveSession({ draft: undefined });
    setWriteNotice("");
    setCopyNotice("");
  };

  const copyDraft = async () => {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft.memoText);
      setCopyNotice("Memo copied.");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = draft.memoText;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
        setCopyNotice("Memo copied.");
      } catch {
        setCopyNotice("Copy failed. Select the memo text manually.");
      } finally {
        textarea.remove();
      }
    }
  };

  const downloadDraft = () => {
    if (!draft) return;
    const blob = new Blob([draft.memoText], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFileName(draft.title)}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 250);
    setCopyNotice("Markdown downloaded.");
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter"
      && !event.shiftKey
      && !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void send();
    }
  };

  const scrollToDraftSection = (index: number) => {
    const target = draftDocumentRef.current?.querySelector<HTMLElement>(`[data-section-index="${index}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const composer = (
    <div className="memo-builder-compose">
      {error && (
        <div className="memo-chat-error" role="alert">
          <span>{error}</span>
          {activeJob?.status === "error" && optimisticMessage && (
            <button type="button" onClick={retryActiveMessage}>Try again</button>
          )}
        </div>
      )}
      <div className={`memo-builder-composer-box ${busy ? "is-thinking" : ""}`}>
        {attachments.length > 0 && (
          <div className="memo-builder-attachments" aria-label="Memo Builder attachments">
            {attachments.map((attachment) => (
              <div className={`memo-builder-attachment ${attachment.status}`} key={attachment.id}>
                <FileText size={14} />
                <span>
                  <strong>{attachment.name}</strong>
                  <small>{attachment.detail}</small>
                </span>
                <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => removeAttachment(attachment.id)}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        {dataRecommendation && dataRecommendation.value !== activeSession?.dataClass && (
          <div className="memo-builder-data-nudge">
            <Sparkles size={15} />
            <span>
              <strong>{dataRecommendation.label} data may fit this chat</strong>
              <small>{dataRecommendation.reason}</small>
            </span>
            <button
              type="button"
              onClick={() => updateActiveSession({ dataClass: dataRecommendation.value })}
              disabled={composerLocked}
            >
              Use {dataRecommendation.label}
            </button>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={draft ? "Ask Rulix to refine this draft..." : "Message Rulix about the item..."}
          aria-label="Message Rulix AI"
          rows={conversationStarted ? 2 : 3}
          disabled={composerLocked}
        />
        <div className="memo-builder-composer-actions">
          <div className="memo-builder-tools" ref={toolsMenuRef}>
            <button
              type="button"
              className="memo-builder-plus"
              onClick={() => setToolsOpen((open) => !open)}
              disabled={composerLocked}
              aria-label="Add files or set data handling"
              aria-haspopup="dialog"
              aria-expanded={toolsOpen}
            >
              <Plus size={19} />
            </button>
            {toolsOpen && (
              <div className="memo-builder-tools-menu" role="dialog" aria-label="Memo tools">
                <button
                  type="button"
                  className="memo-builder-tool-row"
                  onClick={() => {
                    setToolsOpen(false);
                    fileInputRef.current?.click();
                  }}
                >
                  <FileUp size={17} />
                  <span><strong>Add source files</strong><small>Datasheets, manuals, images, or notes</small></span>
                </button>

                <div className="memo-builder-data-picker">
                  <div className="memo-builder-tools-heading">
                    <Database size={15} />
                    <span><strong>Data handling</strong><small>Choose what this conversation contains</small></span>
                  </div>
                  <div className="memo-builder-data-options" aria-label="Memo Builder classification">
                    {(["public", "proprietary", "export-controlled", "itar-risk", "cui"] as const).map((value) => (
                      <button
                        type="button"
                        key={value}
                        className={value === (activeSession?.dataClass ?? "proprietary") ? "active" : ""}
                        aria-pressed={value === (activeSession?.dataClass ?? "proprietary")}
                        onClick={() => updateActiveSession({ dataClass: value })}
                      >
                        {dataClassLabel(value)}
                      </button>
                    ))}
                  </div>
                  {dataRecommendation && dataRecommendation.value !== activeSession?.dataClass && (
                    <div className="memo-builder-data-recommendation">
                      <Sparkles size={14} />
                      <span>
                        <strong>Rulix suggests {dataRecommendation.label}</strong>
                        <small>{dataRecommendation.reason}</small>
                      </span>
                      <button
                        type="button"
                        onClick={() => updateActiveSession({ dataClass: dataRecommendation.value })}
                      >
                        Use
                      </button>
                    </div>
                  )}
                </div>

                <div className="memo-builder-tools-note">
                  Rulix uses this boundary for AI routing. Final classifications still require reviewer signoff.
                </div>
              </div>
            )}
          </div>
          <span className="memo-builder-enter-hint">Enter to send · Shift+Enter for a new line</span>
          <button
            type="button"
            className="memo-builder-send"
            onClick={() => void send()}
            disabled={composerLocked || (!input.trim() && !attachments.some((attachment) => attachment.content.trim()))}
            aria-label="Send message"
            title="Send message"
          >
            <ArrowUp size={18} strokeWidth={2.4} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.md,.csv,.json,.pdf,.docx,.png,.jpg,.jpeg,.webp"
            onChange={handleAttachmentChange}
            hidden
          />
        </div>
      </div>
    </div>
  );

  const contextBanner = activeContextPrompt ? (
    <div className="memo-builder-context-banner">
      <ListChecks size={16} />
      <span>Review context is ready. Use it to improve the current memo without losing its source trail.</span>
      <button type="button" className="button small" onClick={() => useQuickStart("review")} disabled={busy}>
        Use context
      </button>
    </div>
  ) : null;

  const quickStarts = (
    <section className="memo-builder-quickstarts" aria-label="Choose how to begin">
      <button type="button" onClick={() => useQuickStart("item")} disabled={busy}>
        <Sparkles size={16} />
        <span><strong>I have an item</strong><small>Describe it in your own words</small></span>
      </button>
      <button type="button" onClick={() => useQuickStart("attachments")} disabled={busy}>
        <Paperclip size={16} />
        <span><strong>I have source files</strong><small>Add a datasheet or manual</small></span>
      </button>
      <button type="button" onClick={() => useQuickStart("sample")} disabled={busy}>
        <FileText size={16} />
        <span><strong>Show me an example</strong><small>Explore a complete memo</small></span>
      </button>
      {activeContextPrompt && (
        <button type="button" onClick={() => useQuickStart("review")} disabled={busy}>
          <RotateCcw size={16} />
          <span><strong>Improve this review</strong><small>Use the loaded findings</small></span>
        </button>
      )}
      <button type="button" onClick={() => useQuickStart("other")} disabled={busy}>
        <MessageSquare size={16} />
        <span><strong>Something else</strong><small>Tell Rulix what you need</small></span>
      </button>
    </section>
  );

  return (
    <div className={`memo-builder-shell ${sessionsCollapsed ? "sessions-collapsed" : ""}`}>
      <aside
        className="memo-builder-sessions"
        aria-label="Saved Memo Builder chats"
        aria-hidden={sessionsCollapsed}
        inert={sessionsCollapsed}
      >
        <div className="memo-builder-sessions-head">
          <button type="button" className="memo-builder-new-chat" onClick={startNewChat}>
            <Plus size={16} />
            New memo
          </button>
          <button
            type="button"
            className="memo-builder-sidebar-toggle"
            onClick={() => setSessionsCollapsed(true)}
            aria-label="Collapse memo chat history"
            title="Collapse memo chat history"
          >
            <PanelLeftClose size={17} />
          </button>
        </div>
        <div className="memo-builder-session-label">
          <span>Recent</span>
          <small>{sessions.length}</small>
        </div>
        <div className="memo-builder-session-list">
          {sortedSessions.map((session) => {
            const job = sessionJobs[session.id];
            const optimistic = optimisticMessages[session.id];
            return (
            <button
              type="button"
              key={session.id}
              className={`memo-builder-session ${session.id === activeSession?.id ? "active" : ""} ${job ? `is-${job.status}` : ""}`}
              onClick={() => {
                onActiveSessionChange(session.id);
                if (window.innerWidth <= 760) setSessionsCollapsed(true);
              }}
            >
              <span className="memo-builder-session-icon" aria-hidden="true">
                {job?.status === "thinking" ? <Sparkles size={14} /> : <MessageSquare size={14} />}
              </span>
              <span>
                <strong>{optimistic ? conversationTitle(session, optimistic.visibleText, optimistic.attachments) : session.title}</strong>
                <small>{sessionStatus(session, job)}</small>
              </span>
            </button>
            );
          })}
          {hasMoreSessions && (
            <button
              type="button"
              className="button small full"
              onClick={() => void onLoadMoreSessions()}
              disabled={loadingMoreSessions}
            >
              {loadingMoreSessions ? "Loading more chats..." : "Load more chats"}
            </button>
          )}
        </div>
      </aside>

      <main className={`memo-builder-panel ${conversationStarted ? "has-conversation" : "is-empty"}`}>
        <div className="memo-builder-header">
          <button
            type="button"
            className="memo-builder-sidebar-toggle"
            onClick={() => setSessionsCollapsed((value) => !value)}
            aria-label={sessionsCollapsed ? "Open memo chat history" : "Collapse memo chat history"}
            title={sessionsCollapsed ? "Open memo chat history" : "Collapse memo chat history"}
          >
            {sessionsCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
          <div>
            <strong>
              {activeSession
                ? optimisticMessage
                  ? conversationTitle(activeSession, optimisticMessage.visibleText, optimisticMessage.attachments)
                  : activeSession.title
                : "Memo Builder"}
            </strong>
            <span>
              {busy
                ? activeJob?.detail
                : draft
                  ? "Draft ready for reviewer action"
                  : activeJob?.status === "approval"
                    ? activeJob.detail
                    : activeContextPrompt
                      ? "Existing review context loaded"
                      : thinkingCount > 0
                        ? `${thinkingCount} other memo${thinkingCount === 1 ? " is" : "s are"} drafting in the background`
                        : "AI memo workspace"}
            </span>
          </div>
          <button type="button" className="memo-builder-header-new" onClick={startNewChat}>
            <Plus size={15} />
            New chat
          </button>
        </div>

        {!conversationStarted ? (
          <section className="memo-builder-empty-state">
            <div className="memo-builder-empty-copy">
              <span className="memo-builder-empty-mark" aria-hidden="true"><Sparkles size={24} /></span>
              <h1>What are we classifying today?</h1>
            </div>
            {contextBanner}
            {composer}
            {quickStarts}
          </section>
        ) : (
          <>
            <div className="memo-builder-thread" ref={threadRef}>
              {contextBanner}

              {messages.map((msg, i) => (
                <div key={`${activeSession?.id ?? "session"}-${i}`} className={`mb-msg mb-msg--${msg.role}`}>
                  <div
                    className="mb-bubble"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(displayMessageContent(msg.content)) }}
                  />
                </div>
              ))}

              {optimisticMessage && (
                <div className="mb-msg mb-msg--user mb-msg--optimistic">
                  <div
                    className="mb-bubble"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(displayMessageContent(optimisticMessage.content)) }}
                  />
                </div>
              )}

              {busy && (
                <div className="mb-msg mb-msg--assistant">
                  <div className="mb-thinking" aria-label="Rulix is drafting">
                    <span className="mb-thinking-orb" aria-hidden="true"><Sparkles size={16} /></span>
                    <span className="mb-thinking-copy">
                      <strong>{activeJob?.detail ?? "Building your memo"}</strong>
                      <small>Reading context, checking facts, and shaping the draft</small>
                    </span>
                    <span className="mb-thinking-wave" aria-hidden="true"><i /><i /><i /><i /></span>
                  </div>
                </div>
              )}

              {activeJob?.status === "approval" && (
                <div className="mb-msg mb-msg--assistant">
                  <div className="mb-status-card">
                    <span className="mb-status-icon"><ListChecks size={16} /></span>
                    <span><strong>Approval requested</strong><small>{activeJob.detail}</small></span>
                    <button type="button" onClick={retryActiveMessage}>Check approval</button>
                  </div>
                </div>
              )}

              {suggestedReplies.length > 0 && (
                <section className="mb-reply-choices" aria-label="Suggested replies">
                  <span>Suggested replies</span>
                  <div>
                    {suggestedReplies.map((reply) => (
                      <button type="button" key={reply} onClick={() => void send(reply)}>{reply}</button>
                    ))}
                    <button type="button" onClick={() => useQuickStart("other")}>Other</button>
                  </div>
                </section>
              )}

              {draft && (
                <div className="mb-draft-card" ref={draftCardRef}>
                  <div className="mb-draft-actionbar">
                    <div>
                      <FileText size={16} />
                      <span>
                        <strong>{draft.title}</strong>
                        <small>{draft.manufacturer || draft.itemFamily}</small>
                      </span>
                    </div>
                    <div className="mb-draft-action-buttons">
                      <button type="button" className="button small" onClick={() => void copyDraft()}>
                        <Clipboard size={14} />
                        Copy
                      </button>
                      <button type="button" className="button small" onClick={downloadDraft}>
                        <Download size={14} />
                        Download .md
                      </button>
                      <button
                        type="button"
                        className="button primary small"
                        onClick={() => void handleWrite(false)}
                        disabled={writeBusy}
                      >
                        <Plus size={14} />
                        Add to Reviews
                      </button>
                      <button
                        type="button"
                        className="button small"
                        onClick={() => void handleWrite(true)}
                        disabled={writeBusy}
                      >
                        <CheckCircle2 size={14} />
                        Add &amp; Analyze
                      </button>
                      <button type="button" className="tool danger" aria-label="Clear draft" title="Clear draft" onClick={clearDraft}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>

                  {(copyNotice || writeNotice) && (
                    <div className="mb-draft-notice" aria-live="polite">
                      {copyNotice || writeNotice}
                    </div>
                  )}

                  <DraftQualitySummary draft={draft} />

                  {draftSections.length > 1 && (
                    <nav className="mb-draft-sections" aria-label="Memo sections">
                      {draftSections.map((section, index) => (
                        <button type="button" key={`${section.title}-${index}`} onClick={() => scrollToDraftSection(index)}>
                          {section.title}
                        </button>
                      ))}
                    </nav>
                  )}

                  <article className="mb-draft-document" ref={draftDocumentRef} aria-label="Generated memo draft">
                    {draftSections.map((section, index) => (
                      <section key={`${section.title}-${index}`} data-section-index={index}>
                        {section.title !== "Memo draft" && <h3>{section.title}</h3>}
                        <div dangerouslySetInnerHTML={{ __html: renderMarkdown(section.body) }} />
                      </section>
                    ))}
                  </article>
                </div>
              )}
            </div>
            {composer}
          </>
        )}
      </main>
    </div>
  );
}

function DraftQualitySummary({ draft }: { draft: MemoBuildDraft }) {
  const qualityChecks = draft.qualityChecks?.length ? draft.qualityChecks : derivedQualityChecks(draft.memoText);
  const missingFacts = draft.missingFacts?.length ? draft.missingFacts : derivedMissingFacts(draft.memoText);
  const sourceNotes = draft.sourceNotes?.length ? draft.sourceNotes : derivedSourceNotes(draft);

  return (
    <details className="mb-draft-quality" aria-label="Draft quality notes">
      <summary>
        <span>
          <strong>Review notes</strong>
          <small>{qualityChecks.length} ready · {missingFacts.length} need review · {sourceNotes.length} source note{sourceNotes.length === 1 ? "" : "s"}</small>
        </span>
        <ChevronDown size={16} />
      </summary>
      <div className="mb-draft-quality-grid">
        <div>
          <strong>Ready checks</strong>
          {qualityChecks.map((item) => (
            <span key={item}><CheckCircle2 size={13} /> {item}</span>
          ))}
        </div>
        <div>
          <strong>Still needs review</strong>
          {missingFacts.map((item) => (
            <span key={item}><ListChecks size={13} /> {item}</span>
          ))}
        </div>
        <div>
          <strong>Source basis</strong>
          {sourceNotes.map((item) => (
            <span key={item}><FileText size={13} /> {item}</span>
          ))}
        </div>
      </div>
    </details>
  );
}

function createBlankSession(): MemoBuilderSession {
  const now = new Date().toISOString();
  return {
    id: `builder-${crypto.randomUUID()}`,
    title: "New memo chat",
    dataClass: "proprietary",
    messages: [],
    updatedAt: now
  };
}

function conversationTitle(
  session: MemoBuilderSession,
  firstUserText: string,
  attachments: BuilderAttachment[] = []
) {
  if (session.messages.length || (session.title && session.title !== "New memo chat")) return session.title;
  if (attachments.length > 0) {
    const firstFile = attachments[0].name
      .replace(/\.[a-z0-9]{1,8}$/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (firstFile) {
      const suffix = attachments.length > 1 ? ` + ${attachments.length - 1} sources` : " source memo";
      return `${sentenceCase(firstFile).slice(0, 42)}${suffix}`.slice(0, 56);
    }
  }
  const cleaned = firstUserText
    .replace(ATTACHMENT_CONTEXT_MARKER, " ")
    .replace(/\[[^\]]*attached source document[^\]]*\]/gi, " ")
    .replace(/^(please\s+)?(help me\s+)?(build|create|draft|write|make)\s+(an?\s+)?/i, "")
    .replace(/^(from|about|for)\s+(the\s+)?/i, "")
    .replace(/^i (need|want|have)\s+(an?\s+)?/i, "")
    .replace(/\b(review-ready|classification|classify|eccn|memo|for this item|from these source documents)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:.,-]+|[\s:.,-]+$/g, "")
    .trim();
  if (!cleaned) return "New ECCN memo";
  const words = cleaned.split(" ").slice(0, 7).join(" ");
  return sentenceCase(words).slice(0, 56);
}

function finishedConversationTitle(currentTitle: string, draft?: MemoBuildDraft) {
  if (!draft?.title) return currentTitle;
  const cleaned = draft.title
    .replace(/\b(test memo|eccn|classification|draft memo|memo draft|memo)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:.,-]+|[\s:.,-]+$/g, "")
    .trim();
  if (!cleaned || /^(ai drafted|new draft|untitled)$/i.test(cleaned)) return currentTitle;
  return sentenceCase(cleaned).slice(0, 56);
}

function sentenceCase(value: string) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function sessionStatus(session: MemoBuilderSession, job?: SessionJob) {
  if (job?.status === "thinking") return "Drafting now";
  if (job?.status === "approval") return "Waiting for approval";
  if (job?.status === "error") return "Needs attention";
  if (session.draft) return "Draft ready";
  if (session.starterPrompt) return "Review context ready";
  if (session.messages.length) return "Continue conversation";
  return "New conversation";
}

function thinkingLabel(message: string, attachmentCount: number) {
  if (attachmentCount > 0) {
    return `Reading ${attachmentCount} source${attachmentCount === 1 ? "" : "s"}`;
  }
  if (/\b(refine|revise|improve|update|change)\b/i.test(message)) return "Refining your memo";
  if (/\b(compare|screen|check|analy[sz]e)\b/i.test(message)) return "Checking the details";
  return "Building your memo";
}

function replySuggestions(content?: string) {
  if (!content || !/[?]|\b(confirm|provide|tell me|need to know|which|what is)\b/i.test(content)) return [];
  if (/\bmanufacturer|made by\b/i.test(content)) {
    return ["I know the manufacturer", "The manufacturer is unknown"];
  }
  if (/\bmodel|part number|sku\b/i.test(content)) {
    return ["I have the model number", "There is no model number"];
  }
  if (/\bend use|intended use|used for\b/i.test(content)) {
    return ["Commercial use", "Research or testing", "Military or defense use"];
  }
  if (/\bpublic|proprietary|controlled data|cui|itar\b/i.test(content)) {
    return ["Public information", "Proprietary information", "Export-controlled information"];
  }
  if (/\bdatasheet|manual|source document|technical specification\b/i.test(content)) {
    return ["I can attach a source", "Use the facts I provided", "I do not have a source yet"];
  }
  if (/\bcountry|origin\b/i.test(content)) {
    return ["United States", "Another country", "I do not know yet"];
  }
  return ["I can answer that", "I’m not sure yet"];
}

function recommendDataClass(content: string): {
  value: MemoBuilderSession["dataClass"];
  label: string;
  reason: string;
} | undefined {
  if (/\b(itar|usml|defen[cs]e article|military technical data)\b/i.test(content)) {
    return { value: "itar-risk", label: "ITAR risk", reason: "The conversation mentions defense or ITAR-sensitive material." };
  }
  if (/\b(cui|controlled unclassified information)\b/i.test(content)) {
    return { value: "cui", label: "CUI", reason: "The conversation explicitly references CUI." };
  }
  if (/\b(export-controlled|controlled technical data|ear-controlled)\b/i.test(content)) {
    return { value: "export-controlled", label: "Export-controlled", reason: "The content may include controlled technical information." };
  }
  if (/\b(public datasheet|public website|published brochure|public information)\b/i.test(content)) {
    return { value: "public", label: "Public", reason: "The source appears to be publicly available." };
  }
  return undefined;
}

function dataClassLabel(value: MemoBuilderSession["dataClass"]) {
  if (value === "export-controlled") return "Export-controlled";
  if (value === "itar-risk") return "ITAR risk";
  if (value === "cui") return "CUI";
  return sentenceCase(value);
}

function omitRecordKey<T>(record: Record<string, T>, key: string) {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function buildUserContentForSonnet(text: string, attachments: BuilderAttachment[]) {
  if (attachments.length === 0) return text;
  return `${text}${ATTACHMENT_CONTEXT_MARKER}${attachments
    .map((attachment, index) => `## Attachment ${index + 1}: ${attachment.name}\n${attachment.content}`)
    .join("\n\n")}`;
}

function displayMessageContent(content: string) {
  const markerIndex = content.indexOf(ATTACHMENT_CONTEXT_MARKER);
  if (markerIndex === -1) return content;
  const visible = content.slice(0, markerIndex).trim();
  const attachmentCount = (content.slice(markerIndex).match(/## Attachment /g) ?? []).length;
  return `${visible}\n\n[${attachmentCount} attached source document${attachmentCount === 1 ? "" : "s"} sent to Sonnet]`;
}

function normalizeDraft(
  result: MemoBuildDraft,
  readyAttachments: BuilderAttachment[],
  currentDraft: MemoBuildDraft | undefined,
  messages: MemoBuildMessage[],
  source: MemoBuilderDraftSource,
  reviewContextMemoId?: string
) {
  const memoText = result.memoText.trim();
  if (!memoText) return undefined;
  return {
    ...result,
    source,
    reviewContextMemoId: reviewContextMemoId ?? currentDraft?.reviewContextMemoId,
    memoText,
    attachments: readyAttachments.length
      ? readyAttachments.map((attachment) => attachment.name)
      : currentDraft?.attachments ?? attachmentNamesFromMessages(messages)
  };
}

function attachmentNamesFromMessages(messages: MemoBuildMessage[]) {
  const names = new Set<string>();
  for (const message of messages) {
    const markerIndex = message.content.indexOf(ATTACHMENT_CONTEXT_MARKER);
    if (markerIndex === -1) continue;
    const matches = message.content.slice(markerIndex).matchAll(/## Attachment \d+: ([^\n]+)/g);
    for (const match of matches) names.add(match[1].trim());
  }
  return Array.from(names);
}

function attachmentMethodLabel(method: string) {
  if (method === "pdf-image-fallback") return "PDF text was empty, so Rulix used the image-style fallback.";
  if (method === "bedrock-image") return "Image text extracted.";
  if (method === "bedrock-document") return "Document text extracted.";
  return "Text extracted.";
}


function parseDraftSections(memoText: string): DraftSection[] {
  const lines = memoText.split(/\r?\n/);
  const sections: DraftSection[] = [];
  let title = "Memo draft";
  let body: string[] = [];

  for (const line of lines) {
    const match = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (match) {
      if (body.join("\n").trim() || sections.length === 0) {
        sections.push({ title, body: body.join("\n").trim() });
      }
      title = match[2].replace(/\*\*/g, "").trim();
      body = [];
    } else {
      body.push(line);
    }
  }

  sections.push({ title, body: body.join("\n").trim() });
  return sections.filter((section) => section.body || section.title !== "Memo draft");
}

function derivedQualityChecks(memoText: string) {
  const checks = [];
  if (/executive summary/i.test(memoText)) checks.push("Includes executive summary");
  if (/technical specifications|specifications relevant/i.test(memoText)) checks.push("Calls out technical specifications");
  if (/classification|review path|ccl/i.test(memoText)) checks.push("States proposed review path");
  if (/verification checklist/i.test(memoText)) checks.push("Includes verification checklist");
  return checks.length ? checks.slice(0, 4) : ["Sectioned memo draft is ready to review"];
}

function derivedMissingFacts(memoText: string) {
  const missing = [];
  if (/information still needed/i.test(memoText)) missing.push("Review the Information still needed section");
  if (!/manufacturer/i.test(memoText)) missing.push("Manufacturer should be confirmed");
  if (!/model|part number/i.test(memoText)) missing.push("Model or part number should be confirmed");
  if (!missing.length) missing.push("Independent reviewer verification still required");
  return missing.slice(0, 4);
}

function derivedSourceNotes(draft: MemoBuildDraft) {
  if (draft.sourceNotes?.length) return draft.sourceNotes;
  if (draft.attachments?.length) return [`Draft used ${draft.attachments.length} attached source document${draft.attachments.length === 1 ? "" : "s"}`];
  if (draft.source === "sample") return ["Sample data only; not suitable for final signoff"];
  if (draft.source === "review-improvement") return ["Draft used existing review context and still requires reviewer verification"];
  return ["Drafted from chat context and requires source verification"];
}

function buildSampleDraft(): MemoBuildDraft {
  return {
    title: "TEST MEMO - RF Signal Amplifier Model XA-2400",
    itemFamily: "RF signal amplifier",
    manufacturer: "Acme RF Technologies (USA)",
    intendedUse: "Research facility bench testing and instrument calibration",
    dataClass: "public",
    source: "sample",
    qualityChecks: [
      "Sectioned memo with review path",
      "Explicit technical parameters",
      "Missing facts isolated for reviewer follow-up"
    ],
    missingFacts: [
      "Confirm final frequency range and gain from manufacturer datasheet",
      "Confirm whether firmware or encryption features are included",
      "Confirm country of origin and any existing manufacturer classification"
    ],
    sourceNotes: ["Synthetic sample memo for workflow testing only"],
    memoText: [
      "# ECCN Self-Classification Draft Memo",
      "",
      "## Executive summary",
      "This draft memo evaluates the Acme RF Technologies XA-2400 signal amplifier as a bench-test radio frequency amplifier for research facility use. The draft is prepared for review purposes only and does not constitute a final legal classification or government determination.",
      "",
      "## Item and source documents reviewed",
      "The working record identifies the item as the RF Signal Amplifier Model XA-2400 manufactured by Acme RF Technologies in the United States. This test memo uses placeholder source facts for product-flow validation. A reviewer must replace the placeholders with the final datasheet, purchase documentation, manufacturer statement, or other approved source evidence before signoff.",
      "",
      "## Item description",
      "The XA-2400 is described as a laboratory RF signal amplifier intended to amplify low-power RF signals in research, calibration, and bench-test environments. The item is not described as a complete transmitter, radar system, electronic warfare system, or specially designed military end item in the current working facts.",
      "",
      "## Technical specifications relevant to ECCN screening",
      "- Frequency range: placeholder 10 MHz to 6 GHz; reviewer must confirm.",
      "- Small-signal gain: placeholder 24 dB nominal; reviewer must confirm gain flatness and maximum output power.",
      "- Output power: placeholder +20 dBm maximum; reviewer must confirm whether higher-power options exist.",
      "- Software or firmware: no controlled encryption, waveform generation, or adaptive signal processing identified in the placeholder facts.",
      "- Accessories: no technical data package, production software, or military-rated module identified.",
      "",
      "## Intended use and end-user assumptions",
      "The stated use is research facility bench testing and instrument calibration. Classification should be based on item characteristics, not transaction-specific end use. End-use, end-user, sanctions, and license-screening questions should remain separate from the ECCN technical classification memo.",
      "",
      "## Proposed classification/review path",
      "Begin with EAR Category 3 and Category 5 review for electronic components, RF equipment, signal processing functionality, and any telecommunications or information-security functions. Based on the placeholder facts alone, the item may be a candidate for EAR99 or a low-risk electronics review path, but that conclusion cannot be finalized until the reviewer confirms the technical thresholds and source evidence.",
      "",
      "## Rationale and CCL screening notes",
      "The placeholder facts do not identify military design intent, controlled cryptographic functionality, radar-specific functionality, or high-power RF transmission characteristics. The memo should document why nearby CCL entries do or do not apply after the reviewer confirms final frequency, gain, output power, modulation, firmware, and options.",
      "",
      "## Information still needed",
      "- Final manufacturer datasheet or specification sheet.",
      "- Country of origin and part-number variants.",
      "- Maximum output power, gain, frequency range, and optional firmware features.",
      "- Manufacturer classification statement, if available.",
      "",
      "## Verification checklist",
      "- Confirm all technical parameters against the final datasheet.",
      "- Confirm whether software, firmware, or technical data is included.",
      "- Confirm no options change the classification-relevant thresholds.",
      "- Run Rulix AI analysis and require human reviewer signoff before export or reliance."
    ].join("\n")
  };
}

function safeFileName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "eccn-memo-draft";
}
