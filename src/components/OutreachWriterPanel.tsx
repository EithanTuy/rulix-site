import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Copy, ExternalLink, Mail, RefreshCw, Save, Send, Sparkles } from "lucide-react";
import {
  generateOutreachEmail,
  createOutreachJob,
  getOutreachWorkspace,
  markOutreachSent,
  personalizeOutreachEmail,
  saveOutreachDraft
} from "../lib/apiClient";
import type { OutreachDraft, OutreachLead } from "../types";

export function OutreachWriterPanel() {
  const [leads, setLeads] = useState<OutreachLead[]>([]);
  const [drafts, setDrafts] = useState<Record<string, OutreachDraft>>({});
  const [selectedId, setSelectedId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [direction, setDirection] = useState("");
  const [model, setModel] = useState("us.anthropic.claude-opus-4-6-v1");
  const [personalizationModel, setPersonalizationModel] = useState("global.anthropic.claude-sonnet-4-6");
  const [region, setRegion] = useState("us-east-1");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const lead = useMemo(
    () => leads.find((item) => item.leadId === selectedId) ?? leads[0],
    [leads, selectedId]
  );

  const load = useCallback(async () => {
    setError("");
    try {
      const workspace = await getOutreachWorkspace();
      setLeads(workspace.leads);
      setDrafts(workspace.drafts);
      setModel(workspace.bedrock.model);
      setPersonalizationModel(workspace.bedrock.personalizationModel);
      setRegion(workspace.bedrock.region);
      setReady(workspace.bedrock.ready);
      setSelectedId((current) => current || workspace.leads[0]?.leadId || "");
    } catch (loadError) {
      setError(message(loadError, "Could not load the outreach workspace."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!lead) return;
    const draft = drafts[lead.leadId];
    setSubject(draft?.subject ?? "");
    setBody(draft?.body ?? "");
    setNotice(draft ? "Saved in the secure account draft store." : "");
  }, [drafts, lead]);

  const generate = async () => {
    if (!lead) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await generateOutreachEmail(lead.leadId, direction);
      setDrafts((current) => ({ ...current, [lead.leadId]: result.draft }));
      setSubject(result.draft.subject);
      setBody(result.draft.body);
      setNotice("Generated with Bedrock and saved automatically.");
    } catch (generateError) {
      setError(message(generateError, "Bedrock generation failed."));
    } finally {
      setBusy(false);
    }
  };

  const save = async (quiet = false) => {
    if (!lead) return undefined;
    setBusy(true);
    setError("");
    try {
      const result = await saveOutreachDraft(lead.leadId, subject, body);
      setDrafts((current) => ({ ...current, [lead.leadId]: result.draft }));
      if (!quiet) setNotice("Draft saved.");
      return result.draft;
    } catch (saveError) {
      setError(message(saveError, "Draft save failed."));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const markSent = async () => {
    if (!lead) return;
    const saved = await save(true);
    if (!saved) return;
    if (!window.confirm(`Mark ${lead.email} as sent manually?`)) return;
    setBusy(true);
    try {
      const result = await markOutreachSent(lead.leadId);
      setDrafts((current) => ({ ...current, [lead.leadId]: result.draft }));
      setNotice("Marked sent manually. No email was sent by Rulix.");
    } catch (sentError) {
      setError(message(sentError, "Could not mark this draft sent."));
    } finally {
      setBusy(false);
    }
  };

  const draftAllMissing = async () => {
    const missing = leads.filter((item) => !hasDraft(drafts[item.leadId]));
    if (!missing.length) {
      setNotice("Every lead already has a draft.");
      return;
    }

    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await createOutreachJob({
        type: "draft-missing",
        maxCostUsd: 10,
        maxRetries: 2,
        direction
      });
      setNotice(`Background job queued for ${result.job.itemIds.length} missing drafts. Track it in Background Jobs.`);
    } catch (bulkError) {
      setError(message(bulkError, "Could not queue bulk drafting."));
    } finally {
      setBulkProgress("");
      setBusy(false);
    }
  };

  const personalize = async () => {
    if (!lead || !currentDraft) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await personalizeOutreachEmail(lead.leadId);
      setDrafts((current) => ({ ...current, [lead.leadId]: result.draft }));
      setSubject(result.draft.subject);
      setBody(result.draft.body);
      setNotice(
        result.draft.personalizationStatus === "personalized"
          ? "Personalized from a verified public source."
          : "The available public sources were not strong enough. The generic draft was preserved."
      );
    } catch (personalizationError) {
      setError(message(personalizationError, "Personalization failed."));
    } finally {
      setBusy(false);
    }
  };

  const personalizeAll = async () => {
    const candidates = leads.filter((item) => {
      const draft = drafts[item.leadId];
      return hasDraft(draft) && !draft?.sentAt && draft?.personalizationStatus !== "personalized";
    });
    if (!candidates.length) {
      setNotice("Every eligible draft is already personalized.");
      return;
    }

    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await createOutreachJob({
        type: "personalize-all",
        maxCostUsd: 10,
        maxRetries: 2
      });
      setNotice(`Background job queued for ${result.job.itemIds.length} eligible drafts. Track it in Background Jobs.`);
    } catch (bulkError) {
      setError(message(bulkError, "Could not queue bulk personalization."));
    } finally {
      setBulkProgress("");
      setBusy(false);
    }
  };

  const copy = async (value: string, label: string) => {
    if (!value.trim()) return;
    await navigator.clipboard.writeText(value);
    setNotice(`${label} copied.`);
  };

  const currentDraft = lead ? drafts[lead.leadId] : undefined;
  const fullDraft = `To: ${lead?.email ?? ""}\nSubject: ${subject}\n\n${body}`;
  const missingDraftCount = leads.filter((item) => !hasDraft(drafts[item.leadId])).length;
  const personalizationCount = leads.filter((item) => {
    const draft = drafts[item.leadId];
    return hasDraft(draft) && !draft?.sentAt && draft?.personalizationStatus !== "personalized";
  }).length;

  return (
    <section className="outreach-panel" id="writer">
      <div className="outreach-head">
        <div>
          <span className="dash-eyebrow">AWS Bedrock</span>
          <h2>Bedrock Writer</h2>
          <p>Project-first outreach drafts. Rulix never sends email automatically.</p>
        </div>
        <div className="outreach-status">
          <span className={`dash-badge ${ready ? "used" : "expired"}`}>
            {ready ? <CheckCircle2 size={14} /> : <RefreshCw size={14} />} {ready ? "Ready" : "Unavailable"}
          </span>
          <strong>{friendlyModel(model)}</strong>
          <span>Personalization: {friendlyModel(personalizationModel)}</span>
          <span>{region}</span>
        </div>
      </div>

      {error && <div className="dash-error dash-banner">{error}</div>}
      {notice && <div className="dash-notice">{notice}</div>}
      {bulkProgress && <div className="dash-notice">{bulkProgress}</div>}

      <div className="outreach-grid">
        <div className="outreach-lead-card">
          <label>
            <span>Priority lead</span>
            <select value={lead?.leadId ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
              {leads.map((item) => (
                <option value={item.leadId} key={item.leadId}>
                  {item.organization} · {item.email}
                </option>
              ))}
            </select>
          </label>
          {lead && (
            <div className="outreach-lead-detail">
              <strong>{lead.organization}</strong>
              <span>{lead.email}</span>
              <span>{lead.persona}</span>
              <p>{lead.outreachAngle}</p>
            </div>
          )}
          <label>
            <span>Founder direction (optional)</span>
            <textarea
              rows={6}
              value={direction}
              onChange={(event) => setDirection(event.target.value)}
              placeholder="Keep this very direct. Focus on pilot users and explain the project plainly."
            />
          </label>
          <button type="button" className="dash-primary" onClick={() => void generate()} disabled={busy || !ready}>
            <Mail size={16} /> {busy ? "Writing…" : "Generate with Opus"}
          </button>
        </div>

        <div className="outreach-compose">
          <div className="outreach-meta">
            <span><small>Recipient</small><strong>{lead?.email ?? "Select a lead"}</strong></span>
            <span><small>Model used</small><strong>{friendlyModel(currentDraft?.model ?? model)}</strong></span>
            <span><small>Status</small><strong>{currentDraft?.sentAt ? "Sent manually" : currentDraft ? "Saved draft" : "Not generated"}</strong></span>
          </div>
          <label>
            <span>Subject</span>
            <input value={subject} onChange={(event) => setSubject(event.target.value)} />
          </label>
          <div className="outreach-actions">
            <button type="button" onClick={() => void copy(lead?.email ?? "", "Email")}><Copy size={14} /> Email</button>
            <button type="button" onClick={() => void copy(subject, "Subject")}><Copy size={14} /> Subject</button>
            <button type="button" onClick={() => void copy(body, "Body")}><Copy size={14} /> Body</button>
            <button type="button" onClick={() => void copy(fullDraft, "Draft")}><Copy size={14} /> Copy all</button>
            <button type="button" onClick={() => void save()} disabled={busy}><Save size={14} /> Save</button>
            <button type="button" onClick={() => void personalize()} disabled={busy || !currentDraft}>
              <Sparkles size={14} /> Personalize this draft
            </button>
            <button type="button" onClick={() => void markSent()} disabled={busy || !subject || !body}><Send size={14} /> Mark sent</button>
          </div>
          <label>
            <span>Body</span>
            <textarea rows={16} value={body} onChange={(event) => setBody(event.target.value)} />
          </label>
          {currentDraft && (
            <PersonalizationEvidence draft={currentDraft} />
          )}
        </div>
      </div>

      <div className="outreach-ledger">
        <div className="outreach-ledger-head">
          <div>
            <span className="dash-eyebrow">Outreach status</span>
            <h3>Email queue</h3>
            <p>Draft and manual-send status for every configured lead.</p>
          </div>
          <div className="outreach-ledger-actions">
            <button
              type="button"
              className="dash-secondary"
              onClick={() => void personalizeAll()}
              disabled={busy || !ready || personalizationCount === 0}
            >
              <Sparkles size={16} />
              {personalizationCount ? `Personalize all drafts (${personalizationCount})` : "All eligible drafts personalized"}
            </button>
            <button
              type="button"
              className="dash-primary"
              onClick={() => void draftAllMissing()}
              disabled={busy || !ready || missingDraftCount === 0}
            >
              <Mail size={16} />
              {busy && bulkProgress
                ? "Working..."
                : missingDraftCount
                  ? `Draft all missing (${missingDraftCount})`
                  : "All emails drafted"}
            </button>
          </div>
        </div>
        <div className="outreach-ledger-table">
          <div className="outreach-ledger-row outreach-ledger-labels">
            <span>Email</span>
            <span>Drafted</span>
            <span>Personalized</span>
            <span>Sent</span>
          </div>
          {leads.map((item) => {
            const draft = drafts[item.leadId];
            const drafted = hasDraft(draft);
            const sent = Boolean(draft?.sentAt);
            return (
              <button
                type="button"
                className={item.leadId === lead?.leadId ? "outreach-ledger-row selected" : "outreach-ledger-row"}
                onClick={() => setSelectedId(item.leadId)}
                key={item.leadId}
              >
                <span title={item.organization}><strong>{item.email}</strong></span>
                <span className={`outreach-state ${drafted ? "complete" : "missing"}`}>
                  {drafted ? <CheckCircle2 size={14} /> : <RefreshCw size={14} />}
                  {drafted ? "Drafted" : "Missing"}
                </span>
                <span className={`outreach-state ${personalizationTone(draft)}`}>
                  {draft?.personalizationStatus === "personalized"
                    ? <CheckCircle2 size={14} />
                    : <Sparkles size={14} />}
                  {personalizationLabel(draft)}
                </span>
                <span className={`outreach-state ${sent ? "complete" : "pending"}`}>
                  {sent ? <CheckCircle2 size={14} /> : <Send size={14} />}
                  {sent ? "Sent" : "Not sent"}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function PersonalizationEvidence({ draft }: { draft: OutreachDraft }) {
  const status = draft.personalizationStatus ?? "generic";
  return (
    <div className={`personalization-evidence ${status}`}>
      <div className="personalization-evidence-head">
        <span><Sparkles size={15} /> {personalizationLabel(draft)}</span>
        {draft.personalizationConfidence !== undefined && (
          <strong>{Math.round(draft.personalizationConfidence * 100)}% confidence</strong>
        )}
      </div>
      {draft.personalizationDetail && <p><strong>Public detail:</strong> {draft.personalizationDetail}</p>}
      {draft.personalizationRelevance && <p><strong>Why it matters:</strong> {draft.personalizationRelevance}</p>}
      {draft.personalizationSourceUrl && (
        <a href={draft.personalizationSourceUrl} target="_blank" rel="noreferrer">
          {draft.personalizationSourceTitle || "Open personalization source"} <ExternalLink size={13} />
        </a>
      )}
      {status === "generic" && <p>Run personalization to research one organization-level public detail.</p>}
    </div>
  );
}

function hasDraft(draft: OutreachDraft | undefined) {
  return Boolean(draft?.subject.trim() || draft?.body.trim());
}

function personalizationLabel(draft: OutreachDraft | undefined) {
  if (!draft) return "No draft";
  if (draft.personalizationStatus === "personalized") return "Personalized";
  if (draft.personalizationStatus === "needs-research") return "Needs research";
  return "Generic";
}

function personalizationTone(draft: OutreachDraft | undefined) {
  if (draft?.personalizationStatus === "personalized") return "complete";
  if (draft?.personalizationStatus === "needs-research") return "missing";
  return "pending";
}

function friendlyModel(model: string) {
  if (model.includes("opus-4-6")) return "Claude Opus 4.6";
  if (model.includes("sonnet-4-6")) return "Claude Sonnet 4.6";
  return model;
}

function message(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  try {
    const parsed = JSON.parse(error.message) as { error?: string };
    return parsed.error ?? error.message;
  } catch {
    return error.message || fallback;
  }
}
