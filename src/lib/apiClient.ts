import type {
  AccountReviewState,
  AdminMetrics,
  AuditEvent,
  CorpusSnapshot,
  MemoChatMessage,
  MemoRecord,
  OutreachDraft,
  OutreachLead,
  LeadSearchRun,
  LeadWorkflow,
  OutreachJob,
  ReviewResult,
  UserAdminSummary,
  UserProfile
} from "../types";

export type AnalysisMode = "standard" | "deep";

export const ANALYSIS_MODE_CONFIG = {
  standard: {
    label: "Full AI Council",
    depth: "standard",
    cost: "Haiku live review",
    description: "Use for routine seven-agent triage, citation checks, and missing-information mapping."
  },
  deep: {
    label: "Deep Council Pass",
    depth: "deep",
    cost: "Sonnet deep review",
    description: "Use when blockers, user friction, or signoff risk need a stricter second look."
  }
} as const satisfies Record<AnalysisMode, {
  label: string;
  depth: "standard" | "deep";
  cost: string;
  description: string;
}>;

export interface BackendHealth {
  ok: boolean;
  service: string;
  phase: string;
  time: string;
  provider: {
    configured: boolean;
    model: string;
    deepModel: string;
  };
}

export interface AuthResponse {
  user: UserProfile | null;
  csrfToken: string | null;
}

export type InviteStatus = "pending" | "used" | "expired";

export interface InviteSummary {
  id: string;
  email: string;
  name: string;
  role: UserProfile["role"];
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  invitedBy?: string;
  usedAt?: string;
}

export interface InvitePublicInfo {
  email: string;
  name: string;
  role: UserProfile["role"];
  expiresAt: string;
  status: InviteStatus;
}

export interface PasswordResetPublicInfo {
  email: string;
  expiresAt: string;
  status: InviteStatus;
}

export interface EmailDeliveryResult {
  sent: boolean;
  reason?: string;
}

export interface InviteCreationResponse {
  invite: InviteSummary;
  inviteLink: string;
  delivery: EmailDeliveryResult;
}

let csrfToken: string | undefined;

export function setCsrfToken(token: string | undefined) {
  csrfToken = token;
}

export async function getBackendHealth(signal?: AbortSignal) {
  return fetchJson<BackendHealth>("/api/health", { signal });
}

export async function getBackendCorpus(signal?: AbortSignal) {
  return fetchJson<CorpusSnapshot>("/api/corpus", { signal });
}

export async function analyzeMemoWithBackend(
  memo: MemoRecord,
  mode: AnalysisMode,
  signal?: AbortSignal
) {
  const response = await fetchJson<{
    review: MemoRecord;
    result: ReviewResult;
    auditEvents?: AuditEvent[];
  }>(
    `/api/reviews/${encodeURIComponent(memo.id)}/analyze`,
    {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ depth: ANALYSIS_MODE_CONFIG[mode].depth })
    }
  );
  return response;
}

export async function getCurrentUser(signal?: AbortSignal) {
  const response = await fetchJson<AuthResponse>("/api/auth/me", { signal });
  setCsrfToken(response.csrfToken ?? undefined);
  return response;
}

export async function signIn(email: string, password: string) {
  const response = await fetchJson<AuthResponse>("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, password })
  });
  setCsrfToken(response.csrfToken ?? undefined);
  return response;
}

export async function listInvites(signal?: AbortSignal) {
  const response = await fetchJson<{ invites: InviteSummary[] }>("/api/auth/invites", { signal });
  return response.invites;
}

export async function createInvite(email: string, name: string, role: UserProfile["role"]) {
  return fetchJson<InviteCreationResponse>("/api/auth/invites", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, name, role })
  });
}

export async function getAdminMetrics(rangeDays = 30, signal?: AbortSignal) {
  const response = await fetchJson<{ metrics: AdminMetrics }>(
    `/api/admin/metrics?rangeDays=${encodeURIComponent(String(rangeDays))}`,
    { signal }
  );
  return response.metrics;
}

export async function listAdminUsers(signal?: AbortSignal) {
  const response = await fetchJson<{ users: UserAdminSummary[] }>("/api/admin/users", { signal });
  return response.users;
}

export async function validateInvite(token: string, signal?: AbortSignal) {
  const response = await fetchJson<{ invite: InvitePublicInfo }>(
    `/api/auth/invites/${encodeURIComponent(token)}`,
    { signal }
  );
  return response.invite;
}

export async function acceptInvite(token: string, password: string, name?: string) {
  const response = await fetchJson<AuthResponse>("/api/auth/invite/accept", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ token, password, name })
  });
  setCsrfToken(response.csrfToken ?? undefined);
  return response;
}

export async function requestPasswordReset(email: string) {
  await fetchJson<{ ok: true }>("/api/auth/password-reset/request", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email })
  });
}

export async function validatePasswordReset(token: string, signal?: AbortSignal) {
  const response = await fetchJson<{ reset: PasswordResetPublicInfo }>(
    `/api/auth/password-reset/${encodeURIComponent(token)}`,
    { signal }
  );
  return response.reset;
}

export async function completePasswordReset(token: string, password: string) {
  const response = await fetchJson<AuthResponse>("/api/auth/password-reset/complete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ token, password })
  });
  setCsrfToken(response.csrfToken ?? undefined);
  return response;
}

export async function signOut() {
  await fetchJson<void>("/api/auth/logout", { method: "POST" });
  setCsrfToken(undefined);
}

export async function loadAccountState(signal?: AbortSignal) {
  const response = await fetchJson<{ state: AccountReviewState }>("/api/account/state", { signal });
  return response.state;
}

export async function saveAccountState(state: AccountReviewState, signal?: AbortSignal) {
  const response = await fetchJson<{ state: AccountReviewState }>("/api/account/state", {
    method: "PUT",
    signal,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ state })
  });
  return response.state;
}

export async function sendMemoChat(memoId: string, message: string, signal?: AbortSignal) {
  const response = await fetchJson<{ messages: MemoChatMessage[]; auditEvents?: AuditEvent[] }>(
    `/api/reviews/${encodeURIComponent(memoId)}/chat`,
    {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ message })
    }
  );
  return response;
}

export async function draftPublicMemo(item: string, signal?: AbortSignal) {
  return fetchJson<{
    title: string;
    memoText: string;
    sources: Array<{ title: string; url: string }>;
    provider: { configured: boolean; model: string; live: boolean; message: string };
  }>("/api/public-memo-draft", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ item })
  });
}

export interface OutreachProviderConfig {
  provider: "bedrock" | "anthropic";
  anthropicKeyMasked?: string;
}

export async function getOutreachProviderConfig(signal?: AbortSignal) {
  return fetchJson<OutreachProviderConfig>("/api/admin/outreach-config", { signal });
}

export async function setOutreachProviderConfig(config: {
  provider: "bedrock" | "anthropic";
  anthropicApiKey?: string;
}) {
  return fetchJson<OutreachProviderConfig>("/api/admin/outreach-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config)
  });
}

export interface OutreachWorkspace {
  leads: OutreachLead[];
  drafts: Record<string, OutreachDraft>;
  leadSearchRuns: LeadSearchRun[];
  leadWorkflows: Record<string, LeadWorkflow>;
  outreachJobs: OutreachJob[];
  bedrock: {
    ready: boolean;
    provider: "bedrock" | "anthropic";
    model: string;
    personalizationModel: string;
    leadSearchModel: string;
    region: string;
  };
}

export async function getOutreachWorkspace(signal?: AbortSignal) {
  return fetchJson<OutreachWorkspace>("/api/admin/outreach", { signal });
}

export async function generateOutreachEmail(leadId: string, direction: string) {
  return fetchJson<{ lead: OutreachLead; draft: OutreachDraft }>("/api/admin/outreach/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leadId, direction })
  });
}

export async function saveOutreachDraft(leadId: string, subject: string, body: string) {
  return fetchJson<{ lead: OutreachLead; draft: OutreachDraft }>(
    `/api/admin/outreach/drafts/${encodeURIComponent(leadId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject, body })
    }
  );
}

export async function markOutreachSent(leadId: string) {
  return fetchJson<{ draft: OutreachDraft }>(
    `/api/admin/outreach/drafts/${encodeURIComponent(leadId)}/mark-sent`,
    { method: "POST" }
  );
}

export async function personalizeOutreachEmail(leadId: string) {
  return fetchJson<{ lead: OutreachLead; draft: OutreachDraft }>(
    `/api/admin/outreach/drafts/${encodeURIComponent(leadId)}/personalize`,
    { method: "POST" }
  );
}

export async function searchForLeads(durationSeconds: number, signal?: AbortSignal) {
  return fetchJson<{ leads: OutreachLead[]; run: LeadSearchRun }>("/api/admin/leads/search", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ durationSeconds })
  });
}

export async function createOutreachJob(input: {
  type: OutreachJob["type"];
  maxCostUsd: number;
  maxRetries?: number;
  direction?: string;
  searchDurationSeconds?: number;
}) {
  return fetchJson<{ job: OutreachJob }>("/api/admin/outreach/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export async function updateOutreachJob(jobId: string, action: "pause" | "resume" | "retry") {
  return fetchJson<{ job: OutreachJob }>(
    `/api/admin/outreach/jobs/${encodeURIComponent(jobId)}/${action}`,
    { method: "POST" }
  );
}

export async function updateLeadWorkflow(
  leadId: string,
  workflow: Omit<LeadWorkflow, "leadId" | "updatedAt">
) {
  return fetchJson<{ lead: OutreachLead; workflow: LeadWorkflow }>(
    `/api/admin/leads/${encodeURIComponent(leadId)}/workflow`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(workflow)
    }
  );
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const method = init?.method?.toUpperCase() ?? "GET";
  if (csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("x-rulix-csrf", csrfToken);
  }

  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
