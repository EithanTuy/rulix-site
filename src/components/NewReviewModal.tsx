import { useState } from "react";
import { X } from "lucide-react";
import type { DataClass, NewReviewInput } from "../types";

interface NewReviewModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (input: NewReviewInput) => void;
}

const defaultMemo = `1.0 Item
Describe the item, model, manufacturer, and relevant hardware/software/technology.

2.0 Technical Characteristics
List performance values, thresholds, materials, firmware/software, dimensions, and attachments.

3.0 Jurisdiction and Classification
Explain USML/ITAR screening first, then CCL/ECCN or EAR99 reasoning.

4.0 End Use
Separate classification facts from transaction/license/end-use review.`;

export function NewReviewModal({ open, onClose, onCreate }: NewReviewModalProps) {
  const [title, setTitle] = useState("New ECCN Classification Memo");
  const [itemFamily, setItemFamily] = useState("Research equipment");
  const [manufacturer, setManufacturer] = useState("");
  const [intendedUse, setIntendedUse] = useState("Research facility evaluation");
  const [dataClass, setDataClass] = useState<DataClass>("proprietary");
  const [sourcePath, setSourcePath] = useState<NewReviewInput["sourcePath"]>("self-classification");
  const [memoText, setMemoText] = useState(defaultMemo);
  if (!open) return null;

  const close = () => {
    onClose();
  };

  const submit = () => {
    onCreate({
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
          <label>
            Memo title
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            Manufacturer or source
            <input value={manufacturer} onChange={(event) => setManufacturer(event.target.value)} />
          </label>
          <label>
            Data class
            <select value={dataClass} onChange={(event) => setDataClass(event.target.value as DataClass)}>
              <option value="public">Public/sample</option>
              <option value="proprietary">Proprietary</option>
              <option value="export-controlled">Export-controlled</option>
              <option value="itar-risk">ITAR risk</option>
              <option value="cui">CUI</option>
            </select>
          </label>
          <label>
            Classification path
            <select
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

        <label className="modal-memo">
          Memo text
          <textarea value={memoText} onChange={(event) => setMemoText(event.target.value)} rows={12} />
        </label>
        <div className="modal-footer">
          <button className="button" type="button" onClick={close}>
            Cancel
          </button>
          <button
            className="button primary"
            type="button"
            onClick={submit}
            disabled={!memoText.trim()}
          >
            Create Review
          </button>
        </div>
      </section>
    </div>
  );
}
