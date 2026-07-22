import { useState } from "react";
import { X } from "lucide-react";
import type { DataClass, NewReviewInput } from "../types";

interface NewReviewModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (input: NewReviewInput) => Promise<void>;
}

function buildDefaultMemo(title: string) {
  const today = new Date().toISOString().slice(0, 10);
  return `# Export control analysis for "${title}"
**Date issued:** ${today}
**Scope analyzed:** "${title}"

## ECCNs/ITAR considered
- [List every ECCN/ITAR entry evaluated, e.g. EAR99, ECCN 3A001, USML Category XI]

## Description from ECCN/ITAR
For each entry, include the exact verbatim text from the regulation and the version date.

> "[Exact quoted description from the ECCN/ITAR entry]"
— *[Regulation name, e.g. EAR 15 CFR Part 774, Supplement No. 1], as of [date]*

## Analysis

### [ECCN/ITAR entry]
**Is the scope subject to [entry]?**

Not subject — [Subcategory X.X]: [Explain why the item does not meet this criterion]

---

### [ECCN/ITAR entry if subject]
**Scope is subject to ECCN/ITAR: "[entry]"**
[Explanation grounded in the item's specifications]

## Revision History
| Date | Change |
|------|--------|
| ${today} | Initial draft |

## Reference Documents
- [Datasheet or document name — manufacturer, date]`;
}

export function NewReviewModal({ open, onClose, onCreate }: NewReviewModalProps) {
  const [title, setTitle] = useState("New ECCN Classification Memo");
  const [itemFamily, setItemFamily] = useState("Research equipment");
  const [manufacturer, setManufacturer] = useState("");
  const [intendedUse, setIntendedUse] = useState("Research facility evaluation");
  const [dataClass, setDataClass] = useState<DataClass>("proprietary");
  const [sourcePath, setSourcePath] = useState<NewReviewInput["sourcePath"]>("self-classification");
  const [memoText, setMemoText] = useState(() => buildDefaultMemo("New ECCN Classification Memo"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleTitleChange = (next: string) => {
    setTitle(next);
    setMemoText(buildDefaultMemo(next));
  };
  if (!open) return null;

  const close = () => {
    onClose();
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreate({
        title,
        itemFamily,
        manufacturer,
        intendedUse,
        dataClass,
        sourcePath,
        memoText,
        attachments: []
      });
      close();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Review creation failed. Your draft was kept.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="new-review-title">
        <div className="modal-header">
          <div>
            <h2 id="new-review-title">New Review</h2>
            <p>Add the memo text and the minimum metadata needed for review tracking.</p>
          </div>
          <button className="icon-button" type="button" onClick={close} aria-label="Close new review">
            <X size={18} />
          </button>
        </div>

        <div className="modal-grid">
          <label htmlFor="new-review-title-input">
            Memo title
            <input
              id="new-review-title-input"
              name="title"
              value={title}
              onChange={(event) => handleTitleChange(event.target.value)}
            />
          </label>
          <label htmlFor="new-review-manufacturer">
            Manufacturer or source
            <input
              id="new-review-manufacturer"
              name="manufacturer"
              value={manufacturer}
              onChange={(event) => setManufacturer(event.target.value)}
            />
          </label>
          <label htmlFor="new-review-data-class">
            Data class
            <select
              id="new-review-data-class"
              name="dataClass"
              value={dataClass}
              onChange={(event) => setDataClass(event.target.value as DataClass)}
            >
              <option value="public">Public/sample</option>
              <option value="proprietary">Proprietary</option>
              <option value="export-controlled">Export-controlled</option>
              <option value="itar-risk">ITAR risk</option>
              <option value="cui">CUI</option>
            </select>
          </label>
          <label htmlFor="new-review-source-path">
            Classification path
            <select
              id="new-review-source-path"
              name="sourcePath"
              value={sourcePath}
              onChange={(event) => setSourcePath(event.target.value as NewReviewInput["sourcePath"])}
            >
              <option value="self-classification">Self-classification</option>
              <option value="manufacturer">Manufacturer/source classification</option>
              <option value="ccats">BIS CCATS</option>
              <option value="cj">DDTC CJ</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
        </div>

        <label className="modal-memo" htmlFor="new-review-memo-text">
          Memo text
          <textarea
            id="new-review-memo-text"
            name="memoText"
            value={memoText}
            onChange={(event) => setMemoText(event.target.value)}
            rows={12}
          />
        </label>
        <div className="modal-footer">
          {error && <p className="memo-chat-error">{error}</p>}
          <button className="button" type="button" onClick={close}>
            Cancel
          </button>
          <button
            className="button primary"
            type="button"
            onClick={() => void submit()}
            disabled={!memoText.trim() || busy}
          >
            {busy ? "Creating..." : "Create Review"}
          </button>
        </div>
      </section>
    </div>
  );
}
