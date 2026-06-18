import type {
  AccountReviewState,
  AuditEvent,
  CorpusSnapshot,
  MemoChatMessage,
  MemoRecord,
  ReviewResult,
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
    cost: "Haiku deeper pass",
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
  };
}

export interface AuthResponse {
  user: UserProfile | null;
  csrfToken: string | null;
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

export async function createAccount(name: string, email: string, password: string) {
  const response = await fetchJson<AuthResponse>("/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name, email, password })
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
