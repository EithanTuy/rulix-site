// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { LeadSearchRun, OutreachJob, OutreachLead } from "../src/types";
import { LocalAccountStore, emptyAccountState, type CursorPage } from "./store";

describe("outreach collection storage pagination", () => {
  it("returns every record across large lead, run, and job collections", async () => {
    const store = new LocalAccountStore({ persist: false });
    const userId = "large-outreach-account";
    const discoveredLeads = Array.from({ length: 1_025 }, (_, index) => lead(index));
    const leadSearchRuns = Array.from({ length: 550 }, (_, index) => run(index));
    const outreachJobs = Array.from({ length: 550 }, (_, index) => job(index));
    await store.replaceAccountState(userId, {
      ...emptyAccountState(),
      discoveredLeads,
      leadSearchRuns,
      outreachJobs
    });

    const leads = await collect((query) => store.listOutreachLeadsPage(userId, query));
    const runs = await collect((query) => store.listLeadSearchRunsPage(userId, query));
    const jobs = await collect((query) => store.listOutreachJobsPage(userId, query));
    expect(leads.length).toBeGreaterThan(1_025); // includes the bundled catalog
    expect(leads.filter((item) => item.leadId.startsWith("STRESS-"))).toHaveLength(1_025);
    expect(runs).toHaveLength(550);
    expect(jobs).toHaveLength(550);
    expect(new Set(leads.map((item) => item.leadId)).size).toBe(leads.length);
    expect(new Set(runs.map((item) => item.id)).size).toBe(runs.length);
    expect(new Set(jobs.map((item) => item.id)).size).toBe(jobs.length);
  });

  it("binds signed cursors to the account, collection, and page size", async () => {
    const store = new LocalAccountStore({ persist: false });
    const userId = "cursor-account";
    await store.replaceAccountState(userId, {
      ...emptyAccountState(),
      discoveredLeads: Array.from({ length: 80 }, (_, index) => lead(index)),
      outreachJobs: Array.from({ length: 80 }, (_, index) => job(index))
    });
    const first = await store.listOutreachLeadsPage(userId, { limit: 25 });
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    await expect(store.listOutreachDraftsPage(userId, { limit: 25, cursor: first.nextCursor }))
      .rejects.toMatchObject({ status: 400, code: "invalid_outreach_cursor" });
    await expect(store.listOutreachLeadsPage(userId, { limit: 10, cursor: first.nextCursor }))
      .rejects.toMatchObject({ status: 400, code: "invalid_outreach_cursor" });
    await expect(store.listOutreachLeadsPage("another-account", { limit: 25, cursor: first.nextCursor }))
      .rejects.toMatchObject({ status: 400, code: "invalid_outreach_cursor" });

    const firstJobs = await store.listOutreachJobsPage(userId, { limit: 25 });
    const inserted = { ...job(999), id: "job-9999" };
    await store.upsertOutreachJob(userId, inserted);
    const nextJobs = await store.listOutreachJobsPage(userId, { limit: 25, cursor: firstJobs.nextCursor });
    expect(firstJobs.items[firstJobs.items.length - 1]?.id).toBe("job-0055");
    expect(nextJobs.items[0]?.id).toBe("job-0054");
    expect(nextJobs.items.some((item) => item.id === inserted.id)).toBe(false);
  });
});

async function collect<T>(read: (query: { limit: number; cursor?: string }) => Promise<CursorPage<T>>) {
  const values: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await read({ limit: 50, ...(cursor ? { cursor } : {}) });
    values.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return values;
}

function lead(index: number): OutreachLead {
  const suffix = index.toString().padStart(5, "0");
  return {
    leadId: `STRESS-${suffix}`,
    organization: `Stress Organization ${suffix}`,
    organizationType: "manufacturer",
    segment: "industrial",
    website: `https://stress-${suffix}.example.com`,
    domain: `stress-${suffix}.example.com`,
    city: "Boston",
    state: "MA",
    source: "test",
    sourceUrl: `https://stress-${suffix}.example.com/source`,
    fitScore: 80,
    priority: "B",
    email: `export-${suffix}@stress-${suffix}.example.com`,
    status: "new",
    outreachAngle: "Export classification workflow",
    owner: "",
    notes: "",
    persona: "export-control"
  };
}

function run(index: number): LeadSearchRun {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    id: `run-${index.toString().padStart(4, "0")}`,
    startedAt: at,
    completedAt: at,
    durationSeconds: 15,
    model: "test-model",
    status: "completed",
    addedLeadIds: [],
    activity: []
  };
}

function job(index: number): OutreachJob {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    id: `job-${index.toString().padStart(4, "0")}`,
    type: "draft-missing",
    status: "completed",
    itemIds: [],
    cursor: 0,
    completedCount: 0,
    failedCount: 0,
    retryCount: 0,
    maxRetries: 2,
    maxCostUsd: 1,
    estimatedCostUsd: 0,
    createdAt: at,
    updatedAt: at,
    completedAt: at,
    logs: []
  };
}
