export type DiffChange =
  | { type: "same" | "added" | "removed"; text: string }
  | { type: "gap"; text?: string };

export function diffWords(currentMemoText: string, proposedMemoText: string): DiffChange[] {
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

export function trimUnchangedContext(changes: DiffChange[], contextTokens: number): DiffChange[] {
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
