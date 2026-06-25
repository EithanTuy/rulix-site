import { useEffect, useRef, useState } from "react";
import { CheckCircle2, FileText, Plus, Send, Wand2 } from "lucide-react";
import { sendMemoBuildChat, type MemoBuildDraft, type MemoBuildMessage } from "../lib/apiClient";

interface MemoDraftChatPanelProps {
  onCreateMemo: (draft: MemoBuildDraft) => void;
  onCreateAndAnalyze: (draft: MemoBuildDraft) => void;
}

const INITIAL_GREETING =
  "I'll help you draft an ECCN classification memo. Tell me about the item — its name, model number, and manufacturer is a good starting point.";

export function MemoDraftChatPanel({ onCreateMemo, onCreateAndAnalyze }: MemoDraftChatPanelProps) {
  const [messages, setMessages] = useState<MemoBuildMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<MemoBuildDraft | undefined>();
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, draft, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;

    const userMsg: MemoBuildMessage = { role: "user", content: text };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput("");
    setBusy(true);
    setError("");

    try {
      const result = await sendMemoBuildChat(nextMessages);
      const assistantMsg: MemoBuildMessage = { role: "assistant", content: result.reply };
      setMessages([...nextMessages, assistantMsg]);
      if (result.draft) setDraft(result.draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  };

  const handleWrite = (analyze: boolean) => {
    if (!draft) return;
    if (analyze) {
      onCreateAndAnalyze(draft);
    } else {
      onCreateMemo(draft);
    }
  };

  return (
    <div className="memo-builder-panel">
      <div className="memo-builder-header">
        <Wand2 size={20} />
        <div>
          <strong>Memo Builder</strong>
          <span>Chat with Sonnet to draft a new ECCN classification memo</span>
        </div>
      </div>

      <div className="memo-builder-thread" ref={threadRef}>
        <div className="mb-msg mb-msg--assistant">
          <div className="mb-bubble">{INITIAL_GREETING}</div>
        </div>

        {messages.map((msg, i) => (
          <div key={i} className={`mb-msg mb-msg--${msg.role}`}>
            <div className="mb-bubble">{msg.content}</div>
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
            <div className="mb-draft-actions">
              <button type="button" className="button ghost" onClick={() => handleWrite(false)}>
                <Plus size={14} />
                Write Memo
              </button>
              <button type="button" className="button primary" onClick={() => handleWrite(true)}>
                <CheckCircle2 size={14} />
                Write &amp; Analyze
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="memo-builder-compose">
        {error && <p className="memo-chat-error">{error}</p>}
        <div className="memo-builder-input">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={draft ? "Continue refining the draft…" : "Describe the item to classify…"}
            rows={3}
            disabled={busy}
          />
          <button
            type="button"
            className="button primary memo-builder-send"
            onClick={() => void send()}
            disabled={busy || !input.trim()}
            aria-label="Send"
          >
            <Send size={16} />
          </button>
        </div>
        <p className="memo-chat-note">Ctrl+Enter to send · Sonnet · All drafts require reviewer signoff before use</p>
      </div>
    </div>
  );
}
