import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Database,
  ExternalLink,
  FileText,
  Filter,
  LockKeyhole,
  Mail,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  XCircle,
  UsersRound
} from "lucide-react";
import { SafeExternalLink } from "./SafeExternalLink";
import type {
  AppView,
  AuditEvent,
  AiApprovalRequestListItem,
  AiApprovalRequestStatus,
  AiApprovalRequestStatusKind,
  CorpusSnapshot,
  EvidenceStatus,
  MemoRecord,
  ReviewerDecision,
  ReviewResult,
  UserProfile
} from "../types";
import {
  cancelAiApprovalRequest,
  createInvite,
  decideAiApprovalRequest,
  getAiApprovalRequest,
  listAiApprovalRequests,
  listInvites,
  revokeQueuedAiApproval,
  type AiApprovalRequestOfficerView,
  type InviteSummary
} from "../lib/apiClient";
import { summarizeReadiness } from "../lib/reviewLifecycle";

interface AdminConsoleProps {
  view: AppView;
  memos: MemoRecord[];
  decisions: Record<string, ReviewerDecision>;
  auditEvents: AuditEvent[];
  reviewResults: Record<string, ReviewResult | undefined>;
  corpus: CorpusSnapshot;
  userRole: UserProfile["role"];
  onSelectMemo: (memoId: string) => void;
}

export function AdminConsole({
  view,
  memos,
  decisions,
  auditEvents,
  reviewResults,
  corpus,
  userRole,
  onSelectMemo
}: AdminConsoleProps) {
  const title = viewTitle(view);
  const signed = memos.filter((memo) => memo.status === "signed-off").length;
  const blocked = memos.filter((memo) => memo.status === "conflict" || memo.status === "needs-info").length;
  const evidenceCounts = memos.reduce(
    (acc, memo) => {
      const result = reviewResults[memo.id];
      result?.findings.forEach((finding) => {
        acc[finding.status] += 1;
      });
      return acc;
    },
    { strong: 0, weak: 0, missing: 0, conflict: 0 }
  );

  return (
    <main className="admin-console">
      <header className="console-header">
        <div>
          <h1>{title.heading}</h1>
          <p>{title.description}</p>
        </div>
        <div className="console-kpis">
          <Kpi label="Reviews" value={memos.length} />
          <Kpi label="Blocked" value={blocked} tone={blocked ? "amber" : "green"} />
          <Kpi label="Signed" value={signed} tone="green" />
        </div>
      </header>

      {view === "corpus" && <CorpusPanel corpus={corpus} />}
      {view === "evidence" && (
        <EvidencePanel memos={memos} reviewResults={reviewResults} counts={evidenceCounts} onSelectMemo={onSelectMemo} />
      )}
      {view === "controls" && <ControlsPanel userRole={userRole} />}
      {view === "users" && <UsersPanel />}
      {view === "settings" && <SettingsPanel />}
      {view !== "corpus" && (
        <AuditPanel memos={memos} auditEvents={auditEvents} decisions={decisions} reviewResults={reviewResults} onSelectMemo={onSelectMemo} />
      )}
    </main>
  );
}

function Kpi({ label, value, tone = "default" }: { label: string; value: number; tone?: "default" | "green" | "amber" }) {
  return (
    <div className={`console-kpi ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CorpusPanel({ corpus }: { corpus: CorpusSnapshot }) {
  const [query, setQuery] = useState("");
  const [authority, setAuthority] = useState<"all" | "EAR" | "ITAR" | "BIS" | "ITA">("all");
  const authorityCounts = useMemo(
    () =>
      corpus.documents.reduce(
        (acc, doc) => {
          acc[doc.authority] += 1;
          return acc;
        },
        { EAR: 0, ITAR: 0, BIS: 0, ITA: 0 }
      ),
    [corpus.documents]
  );
  const chunkCounts = useMemo(
    () =>
      corpus.chunks.reduce(
        (acc, chunk) => {
          const doc = corpus.documents.find((item) => item.id === chunk.documentId);
          if (doc) acc[doc.authority] += 1;
          return acc;
        },
        { EAR: 0, ITAR: 0, BIS: 0, ITA: 0 }
      ),
    [corpus.chunks, corpus.documents]
  );
  const filteredDocuments = corpus.documents.filter((doc) => {
    const matchesAuthority = authority === "all" || doc.authority === authority;
    const matchesQuery = `${doc.title} ${doc.authority}`.toLowerCase().includes(query.toLowerCase());
    return matchesAuthority && matchesQuery;
  });
  const filteredChunks = corpus.chunks.filter((chunk) => {
    const doc = corpus.documents.find((item) => item.id === chunk.documentId);
    const matchesAuthority = authority === "all" || doc?.authority === authority;
    const matchesQuery = `${chunk.title} ${chunk.locator} ${chunk.tags.join(" ")} ${chunk.text}`
      .toLowerCase()
      .includes(query.toLowerCase());
    return matchesAuthority && matchesQuery;
  });

  return (
    <section className="console-section">
      <div className="console-section-title">
        <BookOpen size={20} />
        <h2>{corpus.label}</h2>
        <span>{corpus.documents.length} sources | {corpus.chunks.length} chunks</span>
      </div>

      <div className="corpus-overview">
        {(["EAR", "ITAR", "BIS", "ITA"] as const).map((item) => (
          <button
            className={authority === item ? "corpus-metric selected" : "corpus-metric"}
            type="button"
            onClick={() => setAuthority(authority === item ? "all" : item)}
            key={item}
          >
            <strong>{item}</strong>
            <span>{authorityCounts[item]} sources</span>
            <small>{chunkCounts[item]} cited chunks</small>
          </button>
        ))}
      </div>

      <div className="console-filter-row">
        <label className="search-box compact">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search source, locator, tag..."
          />
        </label>
        <button className={authority === "all" ? "filter-chip active" : "filter-chip"} type="button" onClick={() => setAuthority("all")}>
          All sources
        </button>
      </div>

      <div className="corpus-grid">
        {filteredDocuments.map((doc) => (
          <SafeExternalLink className="corpus-source" href={doc.url} key={doc.id}>
            <strong>{doc.title}</strong>
            <span>{doc.authority} | Snapshot {doc.snapshotDate}</span>
            <ExternalLink size={15} />
          </SafeExternalLink>
        ))}
        {filteredDocuments.length === 0 && <div className="empty-list">No sources match this filter.</div>}
      </div>
      <div className="chunk-table">
        {filteredChunks.map((chunk) => (
          <div className="chunk-row" key={chunk.id}>
            <FileText size={17} />
            <strong>{chunk.locator}</strong>
            <span>{chunk.tags.slice(0, 4).join(", ")}</span>
            <small>{chunk.text}</small>
          </div>
        ))}
        {filteredChunks.length === 0 && <div className="empty-list">No chunks match this filter.</div>}
      </div>
    </section>
  );
}

function EvidencePanel({
  memos,
  reviewResults,
  counts,
  onSelectMemo
}: {
  memos: MemoRecord[];
  reviewResults: Record<string, ReviewResult | undefined>;
  counts: Record<"strong" | "weak" | "missing" | "conflict", number>;
  onSelectMemo: (memoId: string) => void;
}) {
  const [status, setStatus] = useState<"all" | EvidenceStatus>("all");
  const [query, setQuery] = useState("");
  const rows = memos.flatMap((memo) =>
    (reviewResults[memo.id]?.findings ?? []).map((finding) => ({ memo, finding }))
  );
  const visibleRows = rows.filter(({ memo, finding }) => {
    const matchesStatus = status === "all" || finding.status === status;
    const matchesQuery = `${finding.title} ${finding.rationale} ${memo.title}`
      .toLowerCase()
      .includes(query.toLowerCase());
    return matchesStatus && matchesQuery;
  });
  const attentionCount = counts.weak + counts.missing + counts.conflict;

  return (
    <section className="console-section">
      <div className="evidence-brief">
        <div>
          <strong>{attentionCount} finding{attentionCount === 1 ? "" : "s"} need reviewer attention</strong>
          <span>Filter by status, then open the memo to see the highlighted claim in context.</span>
        </div>
        <div className="evidence-filter-icon">
          <Filter size={19} />
        </div>
      </div>
      <div className="evidence-summary">
        {(["strong", "weak", "missing", "conflict"] as const).map((item) => (
          <button
            className={status === item ? `evidence-status-tile ${item} selected` : `evidence-status-tile ${item}`}
            type="button"
            onClick={() => setStatus(status === item ? "all" : item)}
            key={item}
          >
            <span>{statusLabel(item)}</span>
            <strong>{counts[item]}</strong>
          </button>
        ))}
      </div>
      <div className="console-filter-row">
        <label className="search-box compact">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search finding or memo..."
          />
        </label>
        <button className={status === "all" ? "filter-chip active" : "filter-chip"} type="button" onClick={() => setStatus("all")}>
          All findings
        </button>
      </div>
      <div className="evidence-table">
        {visibleRows.slice(0, 24).map(({ memo, finding }) => (
          <button className="evidence-table-row" type="button" onClick={() => onSelectMemo(memo.id)} key={`${memo.id}-${finding.id}`}>
            <span className={`finding-badge ${finding.status}`}>{finding.status[0].toUpperCase()}</span>
            <span className="evidence-row-main">
              <strong>{finding.title}</strong>
              <span>{memo.title}</span>
            </span>
            <small>{finding.rationale}</small>
          </button>
        ))}
        {visibleRows.length === 0 && <div className="empty-list">No evidence findings match this view.</div>}
      </div>
    </section>
  );
}

function ControlsPanel({ userRole }: { userRole: UserProfile["role"] }) {
  const controls = [
    ["Jurisdiction first", "USML/ITAR risk is reviewed before EAR/CCL reliance.", true],
    ["Human signoff gate", "AI recommendation cannot become final without reviewer action.", true],
    ["Citation verifier", "Findings cite only official corpus chunk IDs.", true],
    ["GovCloud migration", "IaC starter is partition-aware; service validation remains deployment work.", false],
    ["Controlled data boundary", "Commercial AWS should stay sample/redacted unless compliance approves.", false]
  ] as const;

  return (
    <>
      <AiApprovalQueuePanel isOfficer={userRole === "export-control-officer"} />
      <section className="console-section control-grid">
        {controls.map(([label, detail, complete]) => (
          <div className="control-card" key={label}>
            {complete ? <CheckCircle2 size={21} /> : <AlertTriangle size={21} />}
            <strong>{label}</strong>
            <p>{detail}</p>
            <span className={complete ? "control-pass" : "control-review"}>{complete ? "Implemented" : "Requires deployment validation"}</span>
          </div>
        ))}
      </section>
    </>
  );
}

function AiApprovalQueuePanel({ isOfficer }: { isOfficer: boolean }) {
  const [items, setItems] = useState<AiApprovalRequestListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<AiApprovalRequestStatus | AiApprovalRequestOfficerView>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | AiApprovalRequestStatusKind>("pending");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const loadQueue = async (signal?: AbortSignal, append = false) => {
    setLoading(true);
    setError("");
    try {
      const page = await listAiApprovalRequests({
        limit: 50,
        admin: isOfficer,
        ...(append && nextCursor ? { cursor: nextCursor } : {}),
        ...(statusFilter === "all" ? {} : { status: statusFilter })
      }, signal);
      setItems((current) => append
        ? [...new Map([...current, ...page.items].map((item) => [item.id, item])).values()]
        : page.items);
      setNextCursor(page.nextCursor);
      if (!append) {
        setSelectedId((current) => current && page.items.some((item) => item.id === current)
          ? current
          : page.items[0]?.id);
      }
    } catch (loadError) {
      if (!(loadError instanceof DOMException && loadError.name === "AbortError")) {
        setError(readableApiError(loadError instanceof Error ? loadError.message : "Approval queue unavailable."));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    setNextCursor(undefined);
    void loadQueue(controller.signal, false);
    return () => controller.abort();
  }, [isOfficer, statusFilter]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(undefined);
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setDetail(undefined);
    setDetailLoading(true);
    setReason("");
    setError("");
    const request = isOfficer
      ? getAiApprovalRequest(selectedId, { admin: true }, controller.signal)
      : getAiApprovalRequest(selectedId, { admin: false }, controller.signal);
    void request.then((loaded) => {
      if (active) setDetail(loaded);
    }).catch((loadError) => {
      if (!(loadError instanceof DOMException && loadError.name === "AbortError")) {
        setError(readableApiError(loadError instanceof Error ? loadError.message : "Approval request unavailable."));
      }
    }).finally(() => {
      if (active) setDetailLoading(false);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [isOfficer, selectedId]);

  const loadedStatus = detail && "approvalRequest" in detail ? detail.approvalRequest : detail;
  const detailMatchesSelection = Boolean(
    loadedStatus && selectedId && loadedStatus.request.id === selectedId && !detailLoading
  );
  const currentStatus = detailMatchesSelection ? loadedStatus : undefined;
  const officerDetail = detailMatchesSelection && detail && "approvalRequest" in detail ? detail : undefined;

  const selectRequest = (requestId: string) => {
    if (requestId === selectedId) return;
    setDetail(undefined);
    setDetailLoading(true);
    setReason("");
    setSelectedId(requestId);
  };

  const refreshSelected = async () => {
    await loadQueue(undefined, false);
    if (!selectedId) return;
    const refreshed = isOfficer
      ? await getAiApprovalRequest(selectedId, { admin: true })
      : await getAiApprovalRequest(selectedId, { admin: false });
    setDetail(refreshed);
  };

  const decide = async (action: "approve" | "reject" | "revoke" | "cancel") => {
    const loadedRequestId = currentStatus?.request.id;
    if (!loadedRequestId || loadedRequestId !== selectedId || detailLoading || busy) return;
    if ((action === "reject" || action === "revoke" || action === "cancel") && !reason.trim()) {
      setError("Add a concise reason before rejecting, revoking, or cancelling.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (action === "approve") {
        await decideAiApprovalRequest(loadedRequestId, "approve");
        setNotice("Exact AI request approved for one dispatch.");
      } else if (action === "reject") {
        await decideAiApprovalRequest(loadedRequestId, "reject", reason);
        setNotice("AI request rejected.");
      } else if (action === "revoke") {
        await revokeQueuedAiApproval(loadedRequestId, reason);
        setNotice("Queued AI approval revoked before further dispatch.");
      } else {
        await cancelAiApprovalRequest(loadedRequestId, reason);
        setNotice("AI approval request cancelled.");
      }
      setReason("");
      await refreshSelected();
    } catch (decisionError) {
      setError(readableApiError(decisionError instanceof Error ? decisionError.message : "Approval action failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="console-section ai-approval-queue">
      <div className="console-section-title">
        <ShieldCheck size={20} />
        <h2>{isOfficer ? "AI approval queue" : "My AI approval requests"}</h2>
        <span>{items.length} shown</span>
        <button className="icon-action" type="button" aria-label="Refresh AI approval queue" onClick={() => void loadQueue(undefined, false)}>
          <RefreshCw size={16} />
        </button>
      </div>
      <p className="ai-approval-queue-intro">
        {isOfficer
          ? "Inspect the exact server-owned content and policy below. Approve is disabled if the target changed or the short-lived preview expired."
          : "Requests bind one exact revision, conversation, classification, provider, region, and model. Editing the content requires a new request."}
      </p>
      <div className="console-filter-row">
        <label>
          Status
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as "all" | AiApprovalRequestStatusKind)}
          >
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="cancelled">Cancelled</option>
            <option value="expired">Expired</option>
            <option value="all">All</option>
          </select>
        </label>
      </div>
      <div className="ai-approval-queue-layout">
        <div className="ai-approval-request-list" aria-label="AI approval requests">
          {items.map((item) => (
            <button
              type="button"
              className={item.id === selectedId ? "ai-approval-request-row selected" : "ai-approval-request-row"}
              onClick={() => selectRequest(item.id)}
              key={item.id}
            >
              <span>
                <strong>{approvalPurposeLabel(item.purpose)}</strong>
                <small>{item.dataClass} · {item.policy.provider} · {item.policy.clientRegion}</small>
              </span>
              <span className={`invite-status ${item.status}`}>{item.status}</span>
              <small>Expires {formatDateTime(item.expiresAt)}</small>
            </button>
          ))}
          {!loading && items.length === 0 && <div className="empty-list">No requests match this status.</div>}
          {loading && <div className="empty-list">Loading approval requests…</div>}
          {!loading && nextCursor && (
            <button className="button small full" type="button" onClick={() => void loadQueue(undefined, true)}>
              Load more requests
            </button>
          )}
        </div>

        <div className="ai-approval-request-detail">
          {!currentStatus && (
            <div className="empty-list">{detailLoading ? "Loading exact request content…" : "Select a request to inspect it."}</div>
          )}
          {currentStatus && (
            <>
              <div className="ai-approval-binding-summary">
                <strong>{approvalPurposeLabel(currentStatus.request.purpose)}</strong>
                <span>{currentStatus.request.dataClass} · {currentStatus.request.policy.provider}</span>
                <small>
                  Model {currentStatus.request.policy.model} · Region {currentStatus.request.policy.clientRegion}
                </small>
                <small>Requested {formatDateTime(currentStatus.request.createdAt)} · expires {formatDateTime(currentStatus.request.expiresAt)}</small>
                <code>Payload {currentStatus.request.payloadHash.slice(0, 16)}…</code>
              </div>
              {officerDetail && <ApprovalInspection detail={officerDetail} />}
              {isOfficer && currentStatus.status === "pending" && (
                <>
                  <label className="ai-approval-reason">
                    Rejection reason
                    <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={2} />
                  </label>
                  <div className="ai-approval-actions">
                    <button
                      className="button primary small"
                      type="button"
                      disabled={busy || !officerDetail?.inspection.current}
                      onClick={() => void decide("approve")}
                    >
                      <CheckCircle2 size={16} /> Approve one dispatch
                    </button>
                    <button className="button small" type="button" disabled={busy} onClick={() => void decide("reject")}>
                      <XCircle size={16} /> Reject
                    </button>
                  </div>
                </>
              )}
              {isOfficer && currentStatus.status === "approved" && !currentStatus.approval?.revocation && (
                <>
                  <label className="ai-approval-reason">
                    Revocation reason
                    <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={2} />
                  </label>
                  <button className="button small" type="button" disabled={busy} onClick={() => void decide("revoke")}>
                    Revoke queued approval
                  </button>
                </>
              )}
              {!isOfficer && currentStatus.status === "pending" && (
                <>
                  <label className="ai-approval-reason">
                    Cancellation reason
                    <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={2} />
                  </label>
                  <button className="button small" type="button" disabled={busy} onClick={() => void decide("cancel")}>
                    Cancel request
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {notice && <div className="admin-notice success">{notice}</div>}
      {error && <div className="admin-notice error">{error}</div>}
    </section>
  );
}

function ApprovalInspection({ detail }: { detail: AiApprovalRequestOfficerView }) {
  const inspection = detail.inspection;
  return (
    <div className={inspection.current ? "ai-approval-inspection current" : "ai-approval-inspection stale"}>
      <div className="ai-approval-inspection-state">
        {inspection.current ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
        <strong>{inspection.current ? "Exact bindings revalidated" : "Do not approve: content or policy changed"}</strong>
      </div>
      {inspection.unavailableReason && <p>{inspection.unavailableReason}</p>}
      {inspection.kind === "council" && (
        <>
          <h3>{inspection.memo.title}</h3>
          <small>Depth: {inspection.depth} · revision {inspection.memo.revision}</small>
          <pre>{inspection.memo.memoText}</pre>
        </>
      )}
      {inspection.kind === "memo-chat" && (
        <>
          <h3>{inspection.memo.title}</h3>
          <strong className="ai-approval-pending-label">Exact pending message</strong>
          <pre>{inspection.pendingMessage ?? "Preview unavailable"}</pre>
          <details>
            <summary>Current memo and {inspection.history.length} history messages</summary>
            <pre>{inspection.memo.memoText}</pre>
            {inspection.history.map((message) => (
              <div className={`chat-message ${message.role}`} key={message.id}>
                <strong>{message.role}</strong>
                <p>{message.text}</p>
              </div>
            ))}
          </details>
        </>
      )}
      {inspection.kind === "memo-builder" && (
        <>
          <h3>{inspection.session?.title ?? "Memo Builder session"}</h3>
          <strong className="ai-approval-pending-label">Exact saved pending message</strong>
          <pre>{inspection.pendingMessage ?? "Pending input unavailable"}</pre>
          <details>
            <summary>{inspection.messages?.length ?? 0} exact provider conversation messages</summary>
            {inspection.messages?.map((message, index) => (
              <div className={`chat-message ${message.role}`} key={`${message.role}-${index}`}>
                <strong>{message.role}</strong>
                <p>{message.content}</p>
              </div>
            ))}
          </details>
        </>
      )}
      {inspection.providerRequest !== undefined && (
        <details className="ai-approval-provider-request">
          <summary>Exact provider request · hash {inspection.providerRequestHash ?? "unavailable"}</summary>
          <p>Canonical provider body only; credentials, SDK transport headers, and runtime secrets are excluded.</p>
          <pre>{JSON.stringify(inspection.providerRequest, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

function approvalPurposeLabel(purpose: AiApprovalRequestListItem["purpose"]) {
  if (purpose === "council") return "Council analysis";
  if (purpose === "memo-chat") return "Memo chat";
  return "Memo Builder";
}

function statusLabel(status: EvidenceStatus) {
  if (status === "strong") return "Strong";
  if (status === "weak") return "Weak";
  if (status === "missing") return "Missing";
  return "Conflict";
}

function UsersPanel() {
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [values, setValues] = useState({
    email: "",
    name: "",
    role: "reviewer" as InviteSummary["role"]
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const loadInvites = async () => {
    setError(undefined);
    try {
      setInvites(await listInvites());
    } catch (loadError) {
      setError(readableApiError(loadError instanceof Error ? loadError.message : "Invite list unavailable."));
    }
  };

  useEffect(() => {
    void loadInvites();
  }, []);

  const submitInvite = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    try {
      const created = await createInvite(values.email, values.name, values.role);
      setValues({ email: "", name: "", role: "reviewer" });
      setInvites((current) => [created.invite, ...current.filter((invite) => invite.id !== created.invite.id)]);
      setNotice(
        created.delivery.sent
          ? `Invite sent to ${created.invite.email}.`
          : `Invite created. Email delivery is not configured: ${created.delivery.reason ?? "no delivery result"}. Link: ${created.inviteLink}`
      );
    } catch (inviteError) {
      setError(readableApiError(inviteError instanceof Error ? inviteError.message : "Invite failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="console-section users-admin-panel">
      <div className="console-section-title">
        <UsersRound size={20} />
        <h2>Invite-only access</h2>
        <span>{invites.length} invite{invites.length === 1 ? "" : "s"}</span>
      </div>

      <form className="invite-form" onSubmit={submitInvite}>
        <label>
          Name
          <input
            value={values.name}
            onChange={(event) => setValues((current) => ({ ...current, name: event.target.value }))}
            placeholder="Garry Reviewer"
          />
        </label>
        <label>
          Email
          <input
            value={values.email}
            onChange={(event) => setValues((current) => ({ ...current, email: event.target.value }))}
            placeholder="reviewer@example.com"
            type="email"
            required
          />
        </label>
        <label>
          Role
          <select
            value={values.role}
            onChange={(event) => setValues((current) => ({ ...current, role: event.target.value as InviteSummary["role"] }))}
          >
            <option value="reviewer">Reviewer</option>
            <option value="export-control-officer">Export Control Officer</option>
            <option value="submitter">Submitter</option>
            <option value="counsel">Counsel</option>
          </select>
        </label>
        <button className="button primary" type="submit" disabled={busy}>
          <Send size={16} />
          {busy ? "Sending" : "Create invite"}
        </button>
      </form>

      {notice && <div className="admin-notice success">{notice}</div>}
      {error && <div className="admin-notice error">{error}</div>}

      <div className="invite-list-header">
        <strong>Invite status</strong>
        <button className="icon-action" type="button" aria-label="Refresh invites" title="Refresh invites" onClick={() => void loadInvites()}>
          <RefreshCw size={16} />
        </button>
      </div>
      <div className="invite-list">
        {invites.map((invite) => (
          <div className="invite-row" key={invite.id}>
            <Mail size={18} />
            <span>
              <strong>{invite.name}</strong>
              <small>{invite.email}</small>
            </span>
            <span>{roleLabel(invite.role)}</span>
            <span className={`invite-status ${invite.status}`}>{invite.status}</span>
            <small>{invite.status === "used" && invite.usedAt ? `Used ${formatDateTime(invite.usedAt)}` : `Expires ${formatDateTime(invite.expiresAt)}`}</small>
          </div>
        ))}
        {invites.length === 0 && <div className="empty-list">No invites have been created yet.</div>}
      </div>
    </section>
  );
}

function SettingsPanel() {
  return (
    <section className="console-section settings-grid">
      <div className="setting-card">
        <LockKeyhole size={22} />
        <strong>Single-tenant data boundary</strong>
        <p>S3, KMS, audit, and corpus resources are modeled per tenant in the Terraform starter.</p>
      </div>
      <div className="setting-card">
        <Database size={22} />
        <strong>Account-linked storage</strong>
        <p>Reviews, decisions, chat edits, and audit records are saved under the signed-in account.</p>
      </div>
      <div className="setting-card">
        <ShieldCheck size={22} />
        <strong>Model policy</strong>
        <p>Reviewer-facing analysis requires live AI; local rules remain an internal validation baseline and never replace human signoff.</p>
      </div>
    </section>
  );
}

function AuditPanel({
  memos,
  auditEvents,
  decisions,
  reviewResults,
  onSelectMemo
}: {
  memos: MemoRecord[];
  auditEvents: AuditEvent[];
  decisions: Record<string, ReviewerDecision>;
  reviewResults: Record<string, ReviewResult | undefined>;
  onSelectMemo: (memoId: string) => void;
}) {
  return (
    <section className="console-section">
      <div className="console-section-title">
        <ShieldCheck size={20} />
        <h2>Review Readiness and Audit</h2>
      </div>
      <div className="readiness-list">
        <div className="readiness-row readiness-row-head" aria-hidden="true">
          <span>Memo</span>
          <span>Status</span>
          <span>Readiness</span>
          <span>Decision</span>
        </div>
        {memos.map((memo) => {
          const result = reviewResults[memo.id];
          const readiness = result ? summarizeReadiness(result) : undefined;
          return (
            <button className="readiness-row" type="button" onClick={() => onSelectMemo(memo.id)} key={memo.id}>
              <strong>{memo.title}</strong>
              <span className={`review-status-pill ${memo.status}`}>{reviewStatusLabel(memo.status)}</span>
              <span className={readiness ? readinessClassName(readiness.label) : "readiness-pill unanalyzed"}>
                {readiness?.label ?? "Unanalyzed"}
              </span>
              <small>{decisions[memo.id]?.action ?? "No reviewer decision"}</small>
            </button>
          );
        })}
      </div>
      <div className="audit-table">
        {auditEvents.length > 0 && (
          <div className="audit-row audit-row-head" aria-hidden="true">
            <span />
            <span>Event</span>
            <span>Actor</span>
            <span>Time</span>
            <span>Detail</span>
          </div>
        )}
        {auditEvents.slice(0, 16).map((event) => (
          <div className="audit-row" key={event.id}>
            <span className={`status-dot ${event.severity === "info" ? "green" : "amber"}`} />
            <strong>{event.action}</strong>
            <span>{event.actor}</span>
            <span>{formatDateTime(event.at)}</span>
            <p>{event.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function reviewStatusLabel(status: MemoRecord["status"]) {
  if (status === "needs-info") return "Needs info";
  if (status === "signed-off") return "Signed off";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function readinessClassName(label: string) {
  if (label === "Blocked") return "readiness-pill blocked";
  if (label === "Ready for signoff") return "readiness-pill ready";
  return "readiness-pill review";
}

function viewTitle(view: AppView) {
  const titles = {
    home: ["Home", "Your assigned, urgent, and recently active review work."],
    reviews: ["Reviews", "AI-assisted memo review workspace."],
    controls: ["Controls", "Safety gates and compliance controls for AI classification review."],
    evidence: ["Evidence", "Cross-memo finding queue and evidence quality map."],
    corpus: ["Corpus", "Official source snapshots and retrieved source chunks."],
    users: ["Users", "Invite operators, review invite status, and keep access roles visible."],
    settings: ["Settings", "Tenant deployment, persistence, and model policy settings."],
    "memo-builder": ["Memo Builder", "Chat with Sonnet to draft a new ECCN classification memo."]
  } satisfies Record<AppView, [string, string]>;

  return {
    heading: titles[view][0],
    description: titles[view][1]
  };
}

function roleLabel(role: InviteSummary["role"]) {
  if (role === "export-control-officer") return "Export Control Officer";
  if (role === "submitter") return "Submitter";
  if (role === "counsel") return "Counsel";
  return "Reviewer";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function readableApiError(message: string) {
  try {
    const parsed = JSON.parse(message) as { error?: string };
    return parsed.error ?? message;
  } catch {
    return message;
  }
}
