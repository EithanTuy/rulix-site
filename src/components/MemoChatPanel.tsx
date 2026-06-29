import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Edit3,
  MessageSquare,
  Send
} from "lucide-react";
import type { MemoChatMessage, MemoRecord } from "../types";
import type { ReactNode } from "react";
import { renderMarkdown } from "../lib/markdown";
import { MemoDiffPreview } from "./MemoDiffPreview";

interface MemoChatPanelProps {
  memo?: MemoRecord;
  chatMessages: MemoChatMessage[];
  analysisLocked: boolean;
  memoDraftDirty: boolean;
  onSendChat: (memoId: string, message: string) => Promise<void>;
  onApplyChatSuggestion: (memoId: string, messageId: string, proposedMemoText: string) => void;
}

export function MemoChatPanel({
  memo,
  chatMessages,
  analysisLocked,
  memoDraftDirty,
  onSendChat,
  onApplyChatSuggestion
}: MemoChatPanelProps) {
  const [chatDraft, setChatDraft] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState("");
  const [animatedMessageId, setAnimatedMessageId] = useState<string | undefined>();
  const previousMessageCount = useRef(chatMessages.length);

  useEffect(() => {
    if (chatMessages.length > previousMessageCount.current) {
      const newestAssistant = [...chatMessages].reverse().find((message) => message.role === "assistant");
      setAnimatedMessageId(newestAssistant?.id);
    }
    previousMessageCount.current = chatMessages.length;
  }, [chatMessages]);

  const submitChat = async () => {
    if (!memo || !chatDraft.trim() || memoDraftDirty) return;
    const message = chatDraft.trim();
    setChatDraft("");
    setChatBusy(true);
    setChatError("");
    try {
      await onSendChat(memo.id, message);
    } catch (error) {
      setChatDraft(message);
      setChatError(error instanceof Error ? error.message : "Chat failed. Your draft was kept.");
    } finally {
      setChatBusy(false);
    }
  };

  return (
    <section className="memo-chat support-chat" aria-label="Memo chat">
      <div className="memo-chat-title">
        <MessageSquare size={18} />
        <div>
          <strong>Chat About This Memo</strong>
          <span>{memo ? memo.title : "Select a memo to chat."}</span>
        </div>
      </div>
      <div className="memo-chat-thread">
        {!memo && <div className="memo-chat-empty">Select a memo first.</div>}
        {memo && chatMessages.length === 0 && (
          <div className="memo-chat-empty">No memo chat yet.</div>
        )}
        {memo &&
          chatMessages.map((message) => (
            <div className={`chat-message ${message.role}`} key={message.id}>
              <ChatMessageText message={message} animate={message.id === animatedMessageId} />
              {message.proposedMemoText && (
                <div className="chat-proposal">
                  <div className="suggestion-title">
                    <strong>Suggested edit</strong>
                    <span>Review changes before applying</span>
                  </div>
                  <MemoDiffPreview
                    currentMemoText={memo.memoText}
                    proposedMemoText={message.proposedMemoText}
                  />
                  <button
                    type="button"
                    className={message.applied ? "button small applied" : "button primary small"}
                    disabled={message.applied || analysisLocked || memoDraftDirty}
                    title={memoDraftDirty ? "Save or discard memo edits before applying chat suggestions." : undefined}
                    onClick={() => onApplyChatSuggestion(memo.id, message.id, message.proposedMemoText!)}
                  >
                    {message.applied ? <CheckCircle2 size={16} /> : <Edit3 size={16} />}
                    {message.applied ? "Applied" : "Apply"}
                  </button>
                </div>
              )}
            </div>
          ))}
        {chatBusy && (
          <div className="chat-message assistant thinking">
            <span className="thinking-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <p>Haiku is thinking</p>
          </div>
        )}
      </div>
      <div className="memo-chat-input">
        <textarea
          value={chatDraft}
          onChange={(event) => setChatDraft(event.target.value)}
          placeholder="Ask about or revise this memo..."
          rows={3}
          disabled={!memo || analysisLocked || memoDraftDirty}
        />
        <button
          className="button primary small"
          type="button"
          onClick={submitChat}
          disabled={!memo || analysisLocked || memoDraftDirty || chatBusy || !chatDraft.trim()}
          title={memoDraftDirty ? "Save or discard memo edits before using memo chat." : undefined}
        >
          <Send size={16} />
          Send
        </button>
      </div>
      {analysisLocked && <p className="memo-chat-note">Memo edits are locked until analysis finishes.</p>}
      {memoDraftDirty && <p className="memo-chat-note">Save or discard memo edits before using chat.</p>}
      {chatError && <p className="memo-chat-error">{chatError}</p>}
    </section>
  );
}

function ChatMessageText({ message, animate }: { message: MemoChatMessage; animate: boolean }) {
  const [visibleText, setVisibleText] = useState(
    animate ? "" : message.text
  );

  useEffect(() => {
    if (!animate) {
      setVisibleText(message.text);
      return;
    }

    setVisibleText("");
    const text = message.text;
    const words = Math.max(1, text.trim().split(/\s+/).filter(Boolean).length);
    const durationMs = Math.max(500, (words / 300) * 60_000);
    const stepMs = 35;
    const charsPerStep = Math.max(1, Math.ceil(text.length / (durationMs / stepMs)));
    let visibleCount = 0;

    const timer = window.setInterval(() => {
      visibleCount = Math.min(text.length, visibleCount + charsPerStep);
      setVisibleText(text.slice(0, visibleCount));
      if (visibleCount >= text.length) {
        window.clearInterval(timer);
      }
    }, stepMs);

    return () => window.clearInterval(timer);
  }, [animate, message.id, message.text]);

  return <FormattedChatText text={visibleText} showCursor={animate && visibleText.length < message.text.length} />;
}

function FormattedChatText({ text, showCursor }: { text: string; showCursor: boolean }) {
  return (
    <>
      <span dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
      {showCursor && <span className="typing-cursor" aria-hidden="true" />}
    </>
  );
}
