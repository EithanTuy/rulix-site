import type { CorpusSnapshot, MemoRecord, ReviewResult } from "../types";

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

export async function analyzeMemoWithBackend(memo: MemoRecord, signal?: AbortSignal) {
  const response = await fetchJson<{ result: ReviewResult }>("/api/ai/review", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ memo })
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
