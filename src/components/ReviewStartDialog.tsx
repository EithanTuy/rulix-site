import { useEffect, useRef, useState } from "react";
import { FileText, Sparkles, Upload, X } from "lucide-react";
import type { DataClass, NewReviewInput, UserProfile } from "../types";

type StartMethod = "paste" | "upload" | "ai";

interface ReviewStartDialogProps {
  open: boolean;
  userRole: UserProfile["role"];
  onClose: () => void;
  onPaste: (input: NewReviewInput) => Promise<void>;
  onUpload: (file: File, dataClass: DataClass) => Promise<void>;
  onDraftWithAi: () => void;
}

const methods: Array<{ id: StartMethod; label: string; description: string; icon: typeof FileText }> = [
  { id: "paste", label: "Paste or type memo", description: "Start with the content you already have.", icon: FileText },
  { id: "upload", label: "Upload file", description: "Extract a review from an approved document.", icon: Upload },
  { id: "ai", label: "Draft with AI", description: "Open Memo Builder and approve exact content before dispatch.", icon: Sparkles }
];

export function ReviewStartDialog({
  open,
  userRole,
  onClose,
  onPaste,
  onUpload,
  onDraftWithAi
}: ReviewStartDialogProps) {
  const [method, setMethod] = useState<StartMethod>("paste");
  const [title, setTitle] = useState("");
  const [memoText, setMemoText] = useState("");
  const [itemFamily, setItemFamily] = useState("Research equipment");
  const [manufacturer, setManufacturer] = useState("");
  const [intendedUse, setIntendedUse] = useState("");
  const [dataClass, setDataClass] = useState<DataClass>("proprietary");
  const [uploadDataClass, setUploadDataClass] = useState<DataClass | "">("");
  const [sourcePath, setSourcePath] = useState<NewReviewInput["sourcePath"]>("self-classification");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setMethod("paste");
    setError("");
    window.setTimeout(() => titleRef.current?.focus(), 0);
  }, [open]);

  if (!open) return null;

  const submitPaste = async () => {
    if (!memoText.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await onPaste({
        title: title.trim() || "Pasted ECCN memo",
        itemFamily: itemFamily.trim() || "Research equipment",
        manufacturer: manufacturer.trim(),
        intendedUse: intendedUse.trim(),
        dataClass,
        sourcePath,
        memoText: memoText.trim(),
        attachments: []
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The review could not be created. Your draft was kept.");
    } finally {
      setBusy(false);
    }
  };

  const submitFile = async (file?: File) => {
    if (!file || !uploadDataClass || busy) return;
    setBusy(true);
    setError("");
    try {
      await onUpload(file, uploadDataClass);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The file could not be added. Choose a supported document and try again.");
    } finally {
      setBusy(false);
    }
  };

  const insertTemplate = () => {
    setMemoText((current) => current.trim() ? current : memoTemplate);
  };

  return (
    <div className="review-start-backdrop" role="presentation">
      <section className="review-start-dialog" role="dialog" aria-modal="true" aria-labelledby="review-start-title">
        <header>
          <div>
            <h2 id="review-start-title">Start review</h2>
            <p>Choose the shortest path for the material you have now.</p>
          </div>
          <button type="button" className="px-icon-button" onClick={onClose} aria-label="Close start review"><X size={19} /></button>
        </header>

        <div className="review-start-methods" role="tablist" aria-label="Review start method">
          {methods.map((item) => {
            const Icon = item.icon;
            return (
              <button
                type="button"
                role="tab"
                aria-selected={method === item.id}
                className={method === item.id ? "active" : ""}
                id={`${item.id}-review-start`}
                key={item.id}
                onClick={() => { setMethod(item.id); setError(""); }}
              >
                <Icon size={20} />
                <span><strong>{item.label}</strong><small>{item.description}</small></span>
              </button>
            );
          })}
        </div>

        {method === "paste" ? (
          <div className="review-start-content">
            <label>
              Review title
              <input ref={titleRef} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What is being classified?" />
            </label>
            <label>
              Memo content
              <textarea value={memoText} onChange={(event) => setMemoText(event.target.value)} rows={12} placeholder="Paste or type the current memo…" />
            </label>
            <button type="button" className="review-template-action" onClick={insertTemplate}>Insert memo template</button>
            <details className="review-details">
              <summary>Review details</summary>
              <div>
                <label>Data class
                  <select value={dataClass} onChange={(event) => setDataClass(event.target.value as DataClass)}>
                    <DataClassOptions />
                  </select>
                </label>
                <label>Manufacturer or source
                  <input value={manufacturer} onChange={(event) => setManufacturer(event.target.value)} />
                </label>
                <label>Item family
                  <input value={itemFamily} onChange={(event) => setItemFamily(event.target.value)} />
                </label>
                <label>Intended use
                  <input value={intendedUse} onChange={(event) => setIntendedUse(event.target.value)} />
                </label>
                <label>Classification path
                  <select value={sourcePath} onChange={(event) => setSourcePath(event.target.value as NewReviewInput["sourcePath"])}>
                    <option value="self-classification">Self-classification</option>
                    <option value="manufacturer">Manufacturer/source classification</option>
                    <option value="ccats">BIS CCATS</option>
                    <option value="cj">DDTC CJ</option>
                    <option value="unknown">Unknown</option>
                  </select>
                </label>
              </div>
            </details>
          </div>
        ) : null}

        {method === "upload" ? (
          <div className="review-start-content upload">
            <label>
              Data class
              <select value={uploadDataClass} onChange={(event) => setUploadDataClass(event.target.value as DataClass | "")}>
                <option value="">Choose before selecting a file</option>
                <DataClassOptions />
              </select>
            </label>
            <label className={`review-upload-drop${uploadDataClass ? "" : " disabled"}`}>
              <Upload size={24} />
              <strong>{uploadDataClass ? "Choose a file" : "Choose the data class first"}</strong>
              <span>Markdown, text, DOCX, and PDF intake rules remain enforced.</span>
              <input
                id="upload-review-file"
                type="file"
                disabled={!uploadDataClass || busy}
                accept=".md,.txt,.docx,.pdf"
                onChange={(event) => void submitFile(event.target.files?.[0])}
              />
            </label>
            {["export-controlled", "itar-risk", "cui"].includes(uploadDataClass) ? (
              <p className="review-controlled-note" role="status">
                Controlled-file policy and officer approval remain required for this data class.
              </p>
            ) : null}
          </div>
        ) : null}

        {method === "ai" ? (
          <div className="review-start-content ai">
            <Sparkles size={28} />
            <h3>Draft in Memo Builder</h3>
            <p>
              Rulix will ask for blocking facts, prepare a review-ready draft, and keep exact-content approval visible before any AI dispatch.
            </p>
            {userRole === "submitter" ? <small>An officer must approve the exact AI request before it can run.</small> : null}
            <button
              type="button"
              id="ai-draft-review-start"
              className="button primary"
              onClick={() => { onClose(); onDraftWithAi(); }}
            >
              Open Memo Builder
            </button>
          </div>
        ) : null}

        <footer>
          {error ? <p role="alert">{error}</p> : <span />}
          <div>
            <button type="button" className="button" onClick={onClose}>Cancel</button>
            {method === "paste" ? (
              <button type="button" id="paste-review-submit" className="button primary" disabled={!memoText.trim() || busy} onClick={() => void submitPaste()}>
                {busy ? "Creating…" : "Create review"}
              </button>
            ) : null}
          </div>
        </footer>
      </section>
    </div>
  );
}

function DataClassOptions() {
  return (
    <>
      <option value="public">Public/sample</option>
      <option value="proprietary">Proprietary</option>
      <option value="export-controlled">Export-controlled</option>
      <option value="itar-risk">ITAR risk</option>
      <option value="cui">CUI</option>
    </>
  );
}

const memoTemplate = `# Classification memo

## Item and scope
Describe the item, software, or technology being reviewed.

## Classification candidates
List the ECCN or USML entries considered and why.

## Evidence
Quote or cite the source material used for each conclusion.

## Analysis
Explain which criteria are met, not met, or still need verification.

## Open questions
List facts a human reviewer must confirm before signoff.`;
