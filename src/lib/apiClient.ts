import type { CorpusSnapshot, MemoRecord, ReviewResult } from "../types";

export type AnalysisMode = "standard" | "escalated";

export const ANALYSIS_MODE_CONFIG = {
  standard: {
    label: "Standard Review",
    model: "claude-haiku-4-5",
    cost: "Lower cost",
    description: "Use for routine first-pass triage and missing-information checks."
  },
  escalated: {
    label: "Escalated Review",
    model: "claude-sonnet-4-6",
    cost: "More expensive",
    description: "Use for higher-risk jurisdiction, ITAR, conflict, or override reviews."
  }
} as const satisfies Record<AnalysisMode, {
  label: string;
  model: string;
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
  const response = await fetchJson<{ result: ReviewResult }>("/api/ai/review", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ memo, model: ANALYSIS_MODE_CONFIG[mode].model })
  });
  return response.result;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}
