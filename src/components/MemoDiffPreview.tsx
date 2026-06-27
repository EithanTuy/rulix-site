import { diffWords, trimUnchangedContext } from "../lib/memoDiff";

interface MemoDiffPreviewProps {
  currentMemoText: string;
  proposedMemoText: string;
  label?: string;
  contextTokens?: number;
}

export function MemoDiffPreview({
  currentMemoText,
  proposedMemoText,
  label = "Suggested memo changes",
  contextTokens = 28
}: MemoDiffPreviewProps) {
  const changes = trimUnchangedContext(diffWords(currentMemoText, proposedMemoText), contextTokens);

  return (
    <div className="suggested-edit" aria-label={label}>
      {changes.map((change, index) => {
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
