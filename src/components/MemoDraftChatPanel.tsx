import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, FileText, MessageSquare, Paperclip, Plus, Send, Wand2, X } from "lucide-react";
import { sendMemoBuildChat, type MemoBuildDraft, type MemoBuildMessage } from "../lib/apiClient";
import { extractFileText, formatExtractedAttachment } from "../lib/documentIntake";
import type { MemoBuilderSession } from "../types";

interface MemoDraftChatPanelProps {
  sessions: MemoBuilderSession[];
  activeSessionId?: string;
  onSessionsChange: (sessions: MemoBuilderSession[]) => void;
  onActiveSessionChange: (sessionId: string) => void;
  onCreateMemo: (draft: MemoBuildDraft) => void;
  onCreateAndAnalyze: (draft: MemoBuildDraft) => void;
}

interface BuilderAttachment {
  id: string;
  name: string;
  content: string;
  status: "reading" | "ready" | "warning" | "failed";
  detail: string;
}

const INITIAL_GREETING =
  "I'll help you draft a review-ready ECCN classification memo. Attach a datasheet, quote, screenshot, or manual, then tell me what you want drafted.";
const ATTACHMENT_CONTEXT_MARKER = "\n\n---\nAttached source documents for Sonnet:\n";
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export function MemoDraftChatPanel({
  sessions,
  activeSessionId,
  onSessionsChange,
  onActiveSessionChange,
  onCreateMemo,
  onCreateAndAnalyze
}: MemoDraftChatPanelProps) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attachments, setAttachments] = useState<BuilderAttachment[]>([]);
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions]
  );
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  const messages = activeSession?.messages ?? [];
  const draft = activeSession?.draft;

  useEffect(() => {
    if (!activeSession && sessions.length === 0) {
      const session = createBlankSession();
      onSessionsChange([session]);
      onActiveSessionChange(session.id);
    }
  }, [activeSession, onActiveSessionChange, onSessionsChange, sessions.length]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeSession?.id, messages, draft, busy]);

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
    setAttachments([]);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const send = async () => {
    const text = input.trim();
    const readyAttachments = attachments.filter((attachment) => attachment.content.trim());
    const unsentAttachments = attachments;
    if ((!text && readyAttachments.length === 0) || busy) return;
    if (attachments.some((attachment) => attachment.status === "reading")) {
      setError("Wait for the attachment text extraction to finish before sending to Sonnet.");
      return;
    }

    const visibleText = text || "Draft an ECCN memo from the attached source documents.";
    const userMsg: MemoBuildMessage = {
      role: "user",
      content: buildUserContentForSonnet(visibleText, readyAttachments)
    };
    const nextMessages = [...messages, userMsg];
    updateActiveSession({
      title: activeSessionTitle(activeSession, visibleText),
      messages: nextMessages
    });
    setInput("");
    setAttachments([]);
    setBusy(true);
    setError("");

    try {
      const result = await sendMemoBuildChat(nextMessages);
      const assistantMsg: MemoBuildMessage = { role: "assistant", content: result.reply };
      const returnedDraft = result.draft
        ? normalizeDraft(result.draft, readyAttachments, draft, nextMessages)
        : undefined;
      if (result.draft && !returnedDraft) {
        setError("Sonnet returned a draft that is too thin for review. Ask it to produce the full sectioned memo.");
      }
      updateActiveSession({
        messages: [...nextMessages, assistantMsg],
        draft: returnedDraft ?? draft
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
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
        const extraction = await extractFileText(file);
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

  const handleWrite = (analyze: boolean) => {
    if (!draft) return;
    if (!isUsableMemo(draft.memoText)) {
      setError("The draft is not review-ready yet. Ask Sonnet to produce the full sectioned memo before adding it to Reviews.");
      return;
    }
    if (analyze) {
      onCreateAndAnalyze(draft);
    } else {
      onCreateMemo(draft);
    }
    updateActiveSession({ draft: undefined });
    setInput("");
    setError("");
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="memo-builder-shell">
      <aside className="memo-builder-sessions" aria-label="Saved Memo Builder chats">
        <div className="memo-builder-sessions-head">
          <div>
            <strong>Saved chats</strong>
            <span>{sessions.length} memo thread{sessions.length === 1 ? "" : "s"}</span>
          </div>
          <button type="button" className="button primary compact" onClick={startNewChat}>
            <Plus size={14} />
            New
          </button>
        </div>
        <div className="memo-builder-session-list">
          {sortedSessions.map((session) => (
            <button
              type="button"
              key={session.id}
              className={`memo-builder-session ${session.id === activeSession?.id ? "active" : ""}`}
              onClick={() => onActiveSessionChange(session.id)}
            >
              <MessageSquare size={14} />
              <span>
                <strong>{session.title}</strong>
                <small>{session.draft ? "Draft ready" : session.messages.length ? "In progress" : "Empty chat"}</small>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <div className="memo-builder-panel">
        <div className="memo-builder-header">
          <Wand2 size={20} />
          <div>
            <strong>Memo Builder</strong>
            <span>Chat with Sonnet to draft a review-ready ECCN memo from your notes and attachments</span>
          </div>
        </div>

        <div className="memo-builder-thread" ref={threadRef}>
          <div className="mb-msg mb-msg--assistant">
            <div className="mb-bubble">{INITIAL_GREETING}</div>
          </div>

          {messages.map((msg, i) => (
            <div key={`${activeSession?.id ?? "session"}-${i}`} className={`mb-msg mb-msg--${msg.role}`}>
              <div className="mb-bubble">{displayMessageContent(msg.content)}</div>
            </div>
          ))}

          {busy && (
            <div className="mb-msg mb-msg--assistant">
              <div className="mb-bubble mb-typing">
                <span /><span /><span />
              </div>
            </div>
          )}

          {draft && !busy && (
            <div className="mb-draft-card">
              <div className="mb-draft-head">
                <FileText size={15} />
                <strong>{draft.title}</strong>
                {draft.manufacturer && <span className="mb-draft-meta">{draft.manufacturer}</span>}
              </div>
              <pre className="mb-draft-preview">{draft.memoText}</pre>
              <p className="mb-draft-queue-note">
                ECCN draft ready. Add it to the review queue to review, edit, and run council analysis.
              </p>
              <div className="mb-draft-actions">
                <button type="button" className="button primary" onClick={() => handleWrite(false)}>
                  <Plus size={14} />
                  Add ECCN draft to review queue
                </button>
                <button type="button" className="button ghost" onClick={() => handleWrite(true)}>
                  <CheckCircle2 size={14} />
                  Add to queue &amp; analyze
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="memo-builder-compose">
          {error && <p className="memo-chat-error">{error}</p>}
          <div className="memo-builder-compose-actions">
            <button
              type="button"
              className="button ghost memo-builder-attach-wide"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              <Paperclip size={16} />
              Attach document
            </button>
            <span>PDF, image, text, or small datasheet under 4 MB</span>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".txt,.md,.csv,.json,.pdf,.docx,.png,.jpg,.jpeg,.webp"
              onChange={handleAttachmentChange}
              hidden
            />
          </div>
          {attachments.length > 0 && (
            <div className="memo-builder-attachments" aria-label="Memo Builder attachments">
              {attachments.map((attachment) => (
                <div className={`memo-builder-attachment ${attachment.status}`} key={attachment.id}>
                  <Paperclip size={14} />
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
          <div className="memo-builder-input">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={draft ? "Continue refining the draft..." : "Attach a datasheet or describe the item to classify..."}
              rows={3}
              disabled={busy}
            />
            <button
              type="button"
              className="button primary memo-builder-send"
              onClick={() => void send()}
              disabled={busy || (!input.trim() && !attachments.some((attachment) => attachment.content.trim()))}
              aria-label="Send"
            >
              <Send size={16} />
            </button>
          </div>
          <p className="memo-chat-note">Ctrl+Enter to send · attached documents go to Sonnet as extracted source text · reviewer signoff required</p>
        </div>
      </div>
    </div>
  );
}

function createBlankSession(): MemoBuilderSession {
  const now = new Date().toISOString();
  return {
    id: `builder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "New memo chat",
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
  messages: MemoBuildMessage[]
) {
  const memoText = result.memoText.trim();
  if (!isUsableMemo(memoText)) return undefined;
  return {
    ...result,
    memoText,
    attachments: readyAttachments.length
      ? readyAttachments.map((attachment) => attachment.name)
      : currentDraft?.attachments ?? attachmentNamesFromMessages(messages)
  };
}

function isUsableMemo(memoText: string) {
  const trimmed = memoText.trim();
  const sectionCount = (trimmed.match(/^#{1,3}\s+/gm) ?? []).length;
  return trimmed.length >= 500 && sectionCount >= 4;
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
