import { ChangeEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  Download,
  FileText,
  ListChecks,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Plus,
  RotateCcw,
  ShieldCheck,
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

const ATTACHMENT_CONTEXT_MARKER = "\n\n---\nAttached source documents for Sonnet:\n";
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const ITEM_STARTER =
  "Draft a review-ready ECCN classification memo for this item. Ask only for truly blocking missing facts, and otherwise produce a complete draft with explicit verification items:\n\nItem:";
const ATTACHMENT_STARTER =
  "Draft a review-ready ECCN classification memo from the attached source documents. Preserve model numbers, manufacturer names, technical limits, units, and source caveats. Put unknown facts in Information still needed.";

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
  const [busy, setBusy] = useState(false);
  const [writeBusy, setWriteBusy] = useState(false);
  const [error, setError] = useState("");
  const [attachments, setAttachments] = useState<BuilderAttachment[]>([]);
  const [copyNotice, setCopyNotice] = useState("");
  const [writeNotice, setWriteNotice] = useState("");
  const [sessionsCollapsed, setSessionsCollapsed] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= 760
  );
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftCardRef = useRef<HTMLDivElement>(null);
  const draftDocumentRef = useRef<HTMLElement>(null);

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions]
  );
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  const messages = activeSession?.messages ?? [];
  const draft = activeSession?.draft;
  const draftSections = useMemo(() => (draft ? parseDraftSections(draft.memoText) : []), [draft]);
  const activeContextPrompt = activeSession?.starterPrompt;
  const conversationStarted = messages.length > 0 || busy || Boolean(draft);

  useEffect(() => {
    if (!activeSession && sessions.length === 0) {
      const session = createBlankSession();
      onSessionsChange([session]);
      onActiveSessionChange(session.id);
    }
  }, [activeSession, onActiveSessionChange, onSessionsChange, sessions.length]);

  useEffect(() => {
    const el = threadRef.current;
    if (el && (busy || !draft)) el.scrollTop = el.scrollHeight;
  }, [activeSession?.id, messages, busy, draft]);

  useEffect(() => {
    if (draft) {
      window.requestAnimationFrame(() => draftCardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }));
    }
  }, [draft?.memoText]);

  // Restore pending input and attachments when switching sessions
  useEffect(() => {
    setInput(activeSession?.pendingInput ?? "");
    setAttachments(
      (activeSession?.pendingAttachments ?? []).map((a) => ({ ...a }))
    );
  // Only run when the session ID changes, not on every session update
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.id]);

  // Debounced save of draft input text to the session
  useEffect(() => {
    if (!activeSession) return;
    if (input === (activeSession.pendingInput ?? "")) return;
    const t = setTimeout(() => updateActiveSession({ pendingInput: input }), 600);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  // Save ready/warning attachments to the session whenever they change
  useEffect(() => {
    if (!activeSession) return;
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

  const updateActiveSession = (patch: Partial<MemoBuilderSession>) => {
    const session = activeSession ?? createBlankSession();
    const nextSession: MemoBuilderSession = {
      ...session,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    const seen = new Set<string>();
    const nextSessions = [nextSession, ...sessions.filter((item) => item.id !== nextSession.id)]
      .filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
    onSessionsChange(nextSessions);
    onActiveSessionChange(nextSession.id);
  };

  const startNewChat = () => {
    const session = createBlankSession();
    onSessionsChange([session, ...sessions]);
    onActiveSessionChange(session.id);
    setInput("");
    setError("");
    setCopyNotice("");
    setWriteNotice("");
    setAttachments([]);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const useQuickStart = (kind: "item" | "attachments" | "sample" | "review") => {
    setError("");
    setCopyNotice("");
    setWriteNotice("");
    if (kind === "item") {
      setInput(ITEM_STARTER);
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
    explicitSource?: MemoBuilderDraftSource
  ) => {
    const text = (overrideText ?? input).trim();
    const readyAttachments = attachments.filter((attachment) => attachment.content.trim());
    const unsentAttachments = attachments;
    if ((!text && readyAttachments.length === 0) || busy) return;
    if (attachments.some((attachment) => attachment.status === "reading")) {
      setError("Wait for the attachment text extraction to finish before sending to Sonnet.");
      return;
    }

    const visibleText = text || "Draft an ECCN memo from the attached source documents.";
    const draftSource = explicitSource ?? (readyAttachments.length ? "attachments" : activeSession?.contextMemoId ? "review-improvement" : "chat");
    const userMsg: MemoBuildMessage = {
      role: "user",
      content: buildUserContentForSonnet(visibleText, readyAttachments)
    };
    const nextMessages = [...messages, userMsg];
    setInput("");
    setAttachments([]);
    setBusy(true);
    setError("");
    setCopyNotice("");
    setWriteNotice("");

    try {
      const session = activeSession ?? createBlankSession();
      const preparedSession = await onPrepareSessionForAi({
        ...session,
        title: activeSessionTitle(activeSession, visibleText),
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
          setInput(text);
          setAttachments(unsentAttachments);
          setWriteNotice("Approval requested. This exact saved message is ready for an export-control officer to inspect.");
          return;
        }
        throw error;
      }
      const assistantMsg: MemoBuildMessage = { role: "assistant", content: result.reply };
      const returnedDraft = result.draft
        ? normalizeDraft(result.draft, readyAttachments, draft, nextMessages, draftSource, activeSession?.contextMemoId)
        : undefined;
      if (result.draft && !returnedDraft) {
        setError("Sonnet returned a draft that is too thin for review. Ask it to produce the full sectioned memo.");
      }
      updateActiveSession({
        messages: [...nextMessages, assistantMsg],
        draft: returnedDraft ?? draft,
        pendingInput: ""
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
      setInput(text);
      setAttachments(unsentAttachments);
    } finally {
      setBusy(false);
      textareaRef.current?.focus();
    }
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
    setError("");
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
      setError(err instanceof Error ? err.message : "The review could not be created. Try again.");
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
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
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
      {error && <p className="memo-chat-error">{error}</p>}
      <div className="memo-builder-composer-box">
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
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={draft ? "Ask Rulix to refine this draft..." : "Describe the item, paste the key facts, or attach source documents..."}
          aria-label="Message Rulix AI"
          rows={conversationStarted ? 2 : 3}
          disabled={busy}
        />
        <div className="memo-builder-composer-actions">
          <button
            type="button"
            className="memo-builder-attach"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            aria-label="Attach source documents"
            title="Attach source documents"
          >
            <Paperclip size={18} />
          </button>
          <div className="memo-builder-model" aria-label="Active assistant">
            <Sparkles size={14} />
            <span>Rulix AI</span>
          </div>
          <label className="memo-builder-classification memo-builder-classification-inline">
            <span>Data</span>
            <select
              aria-label="Memo Builder classification"
              value={activeSession?.dataClass ?? "proprietary"}
              disabled={busy}
              onChange={(event) => updateActiveSession({
                dataClass: event.target.value as MemoBuilderSession["dataClass"]
              })}
            >
              <option value="public">Public</option>
              <option value="proprietary">Proprietary</option>
              <option value="export-controlled">Export-controlled</option>
              <option value="itar-risk">ITAR risk</option>
              <option value="cui">CUI</option>
            </select>
          </label>
          <span className="memo-builder-source-boundary">Approved data only</span>
          <button
            type="button"
            className="memo-builder-send"
            onClick={() => void send()}
            disabled={busy || (!input.trim() && !attachments.some((attachment) => attachment.content.trim()))}
            aria-label={userRole === "export-control-officer" ? "Approve and send" : "Request officer approval"}
            title={userRole === "export-control-officer"
              ? "Approve this exact saved conversation and send one provider request"
              : "Submit this exact saved conversation for officer approval"}
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
      <div className="memo-builder-compose-foot">
        <span>
          {userRole === "export-control-officer"
            ? "Ctrl+Enter approves this exact saved message and sends it"
            : "Ctrl+Enter requests officer approval for this exact saved message"}
        </span>
        <span><ShieldCheck size={13} /> AI-assisted draft · human review required</span>
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
    <section className="memo-builder-quickstarts" aria-label="Memo Builder quick starts">
      <button type="button" onClick={() => useQuickStart("item")} disabled={busy}>
        <Sparkles size={16} />
        <span><strong>Draft from an item</strong><small>Start with a description</small></span>
      </button>
      <button type="button" onClick={() => useQuickStart("attachments")} disabled={busy}>
        <Paperclip size={16} />
        <span><strong>Use source documents</strong><small>Add a datasheet or manual</small></span>
      </button>
      <button type="button" onClick={() => useQuickStart("sample")} disabled={busy}>
        <FileText size={16} />
        <span><strong>Open an example</strong><small>Explore a complete memo</small></span>
      </button>
      {activeContextPrompt && (
        <button type="button" onClick={() => useQuickStart("review")} disabled={busy}>
          <RotateCcw size={16} />
          <span><strong>Improve this review</strong><small>Use the loaded findings</small></span>
        </button>
      )}
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
          {sortedSessions.map((session) => (
            <button
              type="button"
              key={session.id}
              className={`memo-builder-session ${session.id === activeSession?.id ? "active" : ""}`}
              onClick={() => {
                onActiveSessionChange(session.id);
                if (window.innerWidth <= 760) setSessionsCollapsed(true);
              }}
            >
              <MessageSquare size={14} />
              <span>
                <strong>{session.title}</strong>
                <small>{session.draft ? "Draft ready" : session.starterPrompt ? "Review context ready" : session.messages.length ? "In progress" : "New conversation"}</small>
              </span>
            </button>
          ))}
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
            <strong>{activeSession?.title || "Memo Builder"}</strong>
            <span>{draft ? "Draft ready for reviewer action" : activeContextPrompt ? "Existing review context loaded" : "AI memo workspace"}</span>
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
              <p>Describe the item in plain language or attach the source material. Rulix will ask only for facts that truly block a useful memo draft.</p>
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

              {busy && (
                <div className="mb-msg mb-msg--assistant">
                  <div className="mb-bubble mb-typing" aria-label="Rulix is drafting">
                    <span /><span /><span />
                  </div>
                </div>
              )}

              {draft && !busy && (
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

function activeSessionTitle(session: MemoBuilderSession | undefined, firstUserText: string) {
  if (session?.messages.length || (session?.title && session.title !== "New memo chat")) return session.title;
  return firstUserText.replace(/\s+/g, " ").slice(0, 46) || "Memo draft";
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
