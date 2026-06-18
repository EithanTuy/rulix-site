import { useState } from "react";
import { Globe2, Plus, Search } from "lucide-react";
import { draftPublicMemo } from "../lib/apiClient";

interface PublicDraftPanelProps {
  onCreateMemo: (title: string, memoText: string) => void;
}

export function PublicDraftPanel({ onCreateMemo }: PublicDraftPanelProps) {
  const [item, setItem] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Awaited<ReturnType<typeof draftPublicMemo>> | undefined>();

  const generateDraft = async () => {
    if (!item.trim()) return;
    setBusy(true);
    setError("");
    try {
      setDraft(await draftPublicMemo(item.trim()));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Draft failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="public-draft-panel" aria-label="Public source memo draft">
      <div className="public-draft-header">
        <Globe2 size={19} />
        <div>
          <strong>Public-Source Draft</strong>
          <span>Draft a starting memo and verify public-source facts.</span>
        </div>
      </div>

      <label className="public-draft-input">
        Item to classify
        <textarea
          value={item}
          onChange={(event) => setItem(event.target.value)}
          placeholder="Example: Keysight N9042B UXA signal analyzer with 110 GHz frequency option"
          rows={4}
        />
      </label>
      <button
        type="button"
        className="button primary full"
        onClick={generateDraft}
        disabled={busy || !item.trim()}
      >
        <Search size={16} />
        {busy ? "Drafting..." : "Draft Memo"}
      </button>
      {error && <p className="memo-chat-error">{error}</p>}

      {draft && (
        <div className="public-draft-result">
          <div className={draft.provider.live ? "provider-box bedrock compact" : "provider-box fallback compact"}>
            <Globe2 size={16} />
            <p>{draft.provider.message}</p>
          </div>
          <div className="public-draft-preview">
            <strong>{draft.title}</strong>
            <pre>{draft.memoText}</pre>
          </div>
          {draft.sources.length > 0 && (
            <div className="public-source-list">
              <strong>Public sources</strong>
              {draft.sources.map((source) => (
                <a href={source.url} target="_blank" rel="noreferrer" key={source.url}>
                  {source.title}
                </a>
              ))}
            </div>
          )}
          <button
            type="button"
            className="button primary full"
            onClick={() => onCreateMemo(draft.title, draft.memoText)}
          >
            <Plus size={16} />
            Add Draft to Queue
          </button>
        </div>
      )}
    </section>
  );
}
