import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Edit3,
  MessageSquare,
  Send
} from "lucide-react";
import type { MemoChatMessage, MemoRecord } from "../types";
import type { ReactNode } from "react";

interface MemoChatPanelProps {
  memo?: MemoRecord;
  chatMessages: MemoChatMessage[];
  analysisLocked: boolean;
  onSendChat: (memoId: string, message: string) => Promise<void>;
  onApplyChatSuggestion: (memoId: string, messageId: string, proposedMemoText: string) => void;
}

export function MemoChatPanel({
  memo,
  chatMessages,
  analysisLocked,
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
    if (!memo || !chatDraft.trim()) return;
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
                  <SuggestedEditDiff
                    currentMemoText={memo.memoText}
                    proposedMemoText={message.proposedMemoText}
                  />
                  <button
                    type="button"
                    className={message.applied ? "button small applied" : "button primary small"}
                    disabled={message.applied || analysisLocked}
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
          disabled={!memo || analysisLocked}
        />
        <button
          className="button primary small"
          type="button"
          onClick={submitChat}
          disabled={!memo || analysisLocked || chatBusy || !chatDraft.trim()}
        >
          <Send size={16} />
          Send
        </button>
      </div>
      {analysisLocked && <p className="memo-chat-note">Memo edits are locked until analysis finishes.</p>}
      {chatError && <p className="memo-chat-error">{chatError}</p>}
    </section>
  );
}

function SuggestedEditDiff({
  currentMemoText,
  proposedMemoText
}: {
  currentMemoText: string;
  proposedMemoText: string;
}) {
  const changes = diffWords(currentMemoText, proposedMemoText);
  const visibleChanges = trimUnchangedContext(changes, 28);

  return (
    <div className="suggested-edit" aria-label="Suggested memo changes">
      {visibleChanges.map((change, index) => {
        if (change.type === "gap") {
          return (
            <span className="diff-gap" key={`gap-${index}`}>
              ...
            </span>
          );
        }
        return (
          <span className={`diff-token ${change.type}`} key={`${change.type}-${index}-${change.text}`}>
            {change.text}
          </span>
        );
      })}
    </div>
  );
}

type DiffChange =
  | { type: "same" | "added" | "removed"; text: string }
  | { type: "gap"; text?: string };

function diffWords(currentMemoText: string, proposedMemoText: string): DiffChange[] {
  const oldTokens = tokenizeForDiff(currentMemoText);
  const newTokens = tokenizeForDiff(proposedMemoText);
  if (oldTokens.length * newTokens.length > 1_500_000) {
    return buildLargeDiffPreview(currentMemoText, proposedMemoText);
  }
  const rows = oldTokens.length + 1;
  const cols = newTokens.length + 1;
  const table = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let i = oldTokens.length - 1; i >= 0; i -= 1) {
    for (let j = newTokens.length - 1; j >= 0; j -= 1) {
      table[i][j] = oldTokens[i] === newTokens[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const changes: DiffChange[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldTokens.length && newIndex < newTokens.length) {
    if (oldTokens[oldIndex] === newTokens[newIndex]) {
      pushDiffChange(changes, "same", oldTokens[oldIndex]);
      oldIndex += 1;
      newIndex += 1;
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      pushDiffChange(changes, "removed", oldTokens[oldIndex]);
      oldIndex += 1;
    } else {
      pushDiffChange(changes, "added", newTokens[newIndex]);
      newIndex += 1;
    }
  }

  while (oldIndex < oldTokens.length) {
    pushDiffChange(changes, "removed", oldTokens[oldIndex]);
    oldIndex += 1;
  }
  while (newIndex < newTokens.length) {
    pushDiffChange(changes, "added", newTokens[newIndex]);
    newIndex += 1;
  }

  return changes;
}

function buildLargeDiffPreview(currentMemoText: string, proposedMemoText: string): DiffChange[] {
  const currentTrimmed = currentMemoText.trim();
  const proposedTrimmed = proposedMemoText.trim();
  if (proposedTrimmed.startsWith(currentTrimmed)) {
    return [
      { type: "gap" },
      { type: "same", text: currentTrimmed.slice(-500) },
      { type: "added", text: proposedTrimmed.slice(currentTrimmed.length) }
    ];
  }

  return [
    { type: "removed", text: currentTrimmed.slice(0, 900) },
    { type: "gap" },
    { type: "added", text: proposedTrimmed.slice(0, 900) }
  ];
}

function tokenizeForDiff(value: string) {
  return value.match(/\s+|[^\s]+/g) ?? [];
}

function pushDiffChange(
  changes: DiffChange[],
  type: "same" | "added" | "removed",
  text: string
) {
  const previous = changes[changes.length - 1];
  if (previous?.type === type) {
    previous.text += text;
    return;
  }
  changes.push({ type, text });
}

function trimUnchangedContext(changes: DiffChange[], contextTokens: number): DiffChange[] {
  const importantIndexes = new Set<number>();
  changes.forEach((change, index) => {
    if (change.type === "added" || change.type === "removed") {
      for (let offset = -contextTokens; offset <= contextTokens; offset += 1) {
        const contextIndex = index + offset;
        if (contextIndex >= 0 && contextIndex < changes.length) {
          importantIndexes.add(contextIndex);
        }
      }
    }
  });

  if (importantIndexes.size === 0) {
    return changes.slice(-8);
  }

  const trimmed: DiffChange[] = [];
  changes.forEach((change, index) => {
    if (importantIndexes.has(index)) {
      trimmed.push(change);
      return;
    }
    if (trimmed[trimmed.length - 1]?.type !== "gap") {
      trimmed.push({ type: "gap" });
    }
  });
  return trimmed;
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
  const lines = text.split(/\n/);
  const blocks: ReactNode[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (!listItems.length) return;
    blocks.push(
      <ul className="chat-list" key={`list-${blocks.length}`}>
        {listItems.map((item, index) => (
          <li key={`${item}-${index}`}>{formatInline(item)}</li>
        ))}
      </ul>
    );
    listItems = [];
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      return;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      listItems.push(bullet[1]);
      return;
    }

    flushList();
    if (/^#{1,3}\s+/.test(trimmed)) {
      blocks.push(
        <strong className="chat-heading" key={`heading-${index}`}>
          {formatInline(trimmed.replace(/^#{1,3}\s+/, ""))}
        </strong>
      );
      return;
    }

    blocks.push(<p key={`p-${index}`}>{formatInline(trimmed)}</p>);
  });

  flushList();

  return (
    <>
      {blocks}
      {showCursor && <span className="typing-cursor" aria-hidden="true" />}
    </>
  );
}

function formatInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    return <span key={index}>{part}</span>;
  });
}
