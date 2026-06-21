import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { outreachLeads } from "../src/outreachLeads";
import type {
  LeadSearchRun,
  LeadWorkflow,
  OutreachJob,
  OutreachJobLog,
  OutreachLead,
  UsageEvent
} from "../src/types";
import { usageCostUsd } from "./bedrockPricing";
import { discoverLeads, leadSearchModel } from "./leadSearch";
import {
  generateOutreachDraft,
  outreachModel,
  personalizeOutreachDraft,
  personalizationModel
} from "./outreachWriter";
import { createAccountStore, type AccountStore } from "./store";
import type { UsageSample } from "./bedrockCouncil";
import type { StoredOutreachConfig } from "./aiClient";

export interface OutreachWorkerEvent {
  source: "rulix.outreach-worker";
  userId: string;
  userEmail?: string;
  jobId: string;
}

const JOB_COST_ESTIMATES: Record<OutreachJob["type"], number> = {
  "draft-missing": 0.035,
  "personalize-all": 0.025,
  "lead-search": 0.08
};

export function createOutreachJob(input: {
  type: OutreachJob["type"];
  itemIds: string[];
  maxCostUsd: number;
  maxRetries?: number;
  direction?: string;
  searchDurationSeconds?: number;
}): OutreachJob {
  const now = new Date().toISOString();
  const unitCost = JOB_COST_ESTIMATES[input.type];
  return {
    id: `outreach-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: input.type,
    status: "queued",
    itemIds: input.itemIds,
    cursor: 0,
    completedCount: 0,
    failedCount: 0,
    retryCount: 0,
    maxRetries: Math.min(5, Math.max(0, input.maxRetries ?? 2)),
    maxCostUsd: Math.max(0.01, input.maxCostUsd),
    estimatedCostUsd: input.type === "lead-search" ? unitCost : input.itemIds.length * unitCost,
    createdAt: now,
    updatedAt: now,
    direction: input.direction,
    searchDurationSeconds: input.searchDurationSeconds,
    logs: [
      jobLog(
        `Queued ${input.type} job with ${input.type === "lead-search" ? "one research run" : `${input.itemIds.length} items`} and a $${input.maxCostUsd.toFixed(2)} cost cap.`
      )
    ]
  };
}

export async function scheduleOutreachJob(event: OutreachWorkerEvent, delayMs = 0) {
  if (delayMs > 0) await sleep(delayMs);
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!functionName) {
    if (process.env.NODE_ENV !== "test") {
      setTimeout(() => void processOutreachJob(event), 0);
    }
    return;
  }
  const client = new LambdaClient({});
  await client.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: "Event",
    Payload: Buffer.from(JSON.stringify(event))
  }));
}

export async function processOutreachJob(
  event: OutreachWorkerEvent,
  store: AccountStore = createAccountStore()
) {
  const state = await store.getAccountState(event.userId);
  const job = state.outreachJobs?.find((candidate) => candidate.id === event.jobId);
  if (!job || job.status === "paused" || job.status === "completed") return;

  const projectedCost = projectedJobCost(job);
  if (projectedCost > job.maxCostUsd) {
    job.status = "paused";
    job.error = `Projected cost $${projectedCost.toFixed(2)} exceeds the $${job.maxCostUsd.toFixed(2)} cap.`;
    job.logs.unshift(jobLog(job.error, "warning"));
    job.updatedAt = new Date().toISOString();
    await store.replaceAccountState(event.userId, state);
    return;
  }

  const config = await store.getOutreachConfig();

  job.status = "running";
  job.startedAt ??= new Date().toISOString();
  job.updatedAt = new Date().toISOString();
  job.logs.unshift(jobLog(`Processing ${job.type} step ${job.cursor + 1}.`));
  await store.replaceAccountState(event.userId, state);

  let retryDelayMs = 0;

  try {
    if (job.type === "lead-search") {
      await processLeadSearchJob(store, state, job, event, config);
      completeJob(job, `Lead search completed with ${job.completedCount} accepted candidates.`);
    } else {
      const leadId = job.itemIds[job.cursor];
      if (!leadId) {
        completeJob(job, "All queued items have been processed.");
      } else {
        await processLeadItem(store, state, job, event, leadId, config);
        job.cursor += 1;
        job.completedCount += 1;
        job.retryCount = 0;
        job.logs.unshift(jobLog(`Completed ${leadId}.`, "success"));
        if (job.cursor >= job.itemIds.length) {
          completeJob(job, `Completed ${job.completedCount} items with ${job.failedCount} failures.`);
        } else {
          job.status = "queued";
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Background job step failed.";
    const rateLimit = isRateLimitError(error);
    job.retryCount += 1;
    job.logs.unshift(jobLog(message, "error"));
    if (job.retryCount <= job.maxRetries) {
      job.status = "queued";
      if (rateLimit) {
        retryDelayMs = Math.min(120_000, 15_000 * Math.pow(2, job.retryCount - 1));
        job.logs.unshift(jobLog(`Retry ${job.retryCount} of ${job.maxRetries} queued after ${retryDelayMs / 1000}s backoff.`, "warning"));
      } else {
        job.logs.unshift(jobLog(`Retry ${job.retryCount} of ${job.maxRetries} queued.`, "warning"));
      }
    } else {
      job.failedCount += 1;
      job.cursor += 1;
      job.retryCount = 0;
      if (job.cursor >= job.itemIds.length || job.type === "lead-search") {
        job.status = "failed";
        job.error = message;
        job.completedAt = new Date().toISOString();
      } else {
        job.status = "queued";
        job.logs.unshift(jobLog("Retry limit reached; skipping to the next item.", "warning"));
      }
    }
  }

  job.updatedAt = new Date().toISOString();
  await store.replaceAccountState(event.userId, state);
  if (job.status === "queued") {
    await scheduleOutreachJob(event, retryDelayMs);
  }
}

async function processLeadItem(
  store: AccountStore,
  state: Awaited<ReturnType<AccountStore["getAccountState"]>>,
  job: OutreachJob,
  event: OutreachWorkerEvent,
  leadId: string,
  config: StoredOutreachConfig
) {
  const lead = mergeOutreachLeads(state.discoveredLeads ?? [])
    .find((candidate) => candidate.leadId === leadId);
  if (!lead) throw new Error(`Lead ${leadId} no longer exists.`);
  const onUsage = usageRecorder(store, event);

  if (job.type === "draft-missing") {
    if (state.outreachDrafts?.[leadId]) return;
    const draft = await generateOutreachDraft(lead, job.direction ?? "", onUsage, config);
    (state.outreachDrafts ??= {})[leadId] = draft;
    updateWorkflow(state, leadId, { reviewStatus: "pending-review", lifecycleStatus: "drafted" });
    return;
  }

  const draft = state.outreachDrafts?.[leadId];
  if (!draft) throw new Error(`Lead ${leadId} has no draft to personalize.`);
  if (draft.sentAt || draft.personalizationStatus === "personalized") return;
  const personalized = await personalizeOutreachDraft(lead, draft, onUsage, config);
  state.outreachDrafts![leadId] = personalized;
  updateWorkflow(state, leadId, {
    reviewStatus: personalized.personalizationStatus === "personalized" ? "pending-review" : "needs-research",
    lifecycleStatus: personalized.personalizationStatus === "personalized" ? "personalized" : "drafted"
  });
}

async function processLeadSearchJob(
  store: AccountStore,
  state: Awaited<ReturnType<AccountStore["getAccountState"]>>,
  job: OutreachJob,
  event: OutreachWorkerEvent,
  config: StoredOutreachConfig
) {
  const result = await discoverLeads({
    existingLeads: mergeOutreachLeads(state.discoveredLeads ?? []),
    durationSeconds: job.searchDurationSeconds ?? 30,
    onUsage: usageRecorder(store, event),
    config
  });
  state.discoveredLeads = mergeOutreachLeads([...(state.discoveredLeads ?? []), ...result.leads])
    .filter((lead) => lead.leadId.startsWith("AI-"));
  for (const lead of result.leads) {
    updateWorkflow(state, lead.leadId, { reviewStatus: "new", lifecycleStatus: "not-contacted" });
  }
  const run: LeadSearchRun = {
    id: `lead-search-${Date.now()}`,
    startedAt: job.startedAt ?? job.createdAt,
    completedAt: new Date().toISOString(),
    durationSeconds: job.searchDurationSeconds ?? 30,
    model: result.model,
    status: "completed",
    addedLeadIds: result.leads.map((lead) => lead.leadId),
    activity: result.activity
  };
  state.leadSearchRuns = [run, ...(state.leadSearchRuns ?? [])].slice(0, 20);
  job.completedCount = result.leads.length;
}

function usageRecorder(store: AccountStore, event: OutreachWorkerEvent) {
  return (sample: UsageSample) => {
    const usage: UsageEvent = {
      id: `usage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId: event.userId,
      userEmail: event.userEmail,
      at: new Date().toISOString(),
      ...sample
    };
    void store.recordUsage(usage);
  };
}

function updateWorkflow(
  state: Awaited<ReturnType<AccountStore["getAccountState"]>>,
  leadId: string,
  patch: Partial<LeadWorkflow>
) {
  const previous = state.leadWorkflows?.[leadId];
  (state.leadWorkflows ??= {})[leadId] = {
    leadId,
    reviewStatus: previous?.reviewStatus ?? "new",
    lifecycleStatus: previous?.lifecycleStatus ?? "not-contacted",
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString()
  };
}

function completeJob(job: OutreachJob, message: string) {
  job.status = "completed";
  job.completedAt = new Date().toISOString();
  job.error = undefined;
  job.logs.unshift(jobLog(message, "success"));
}

function projectedJobCost(job: OutreachJob) {
  if (job.type === "lead-search") return JOB_COST_ESTIMATES["lead-search"];
  return job.itemIds.length * JOB_COST_ESTIMATES[job.type];
}

function jobLog(message: string, level: OutreachJobLog["level"] = "info"): OutreachJobLog {
  return { at: new Date().toISOString(), message, level };
}

export function mergeOutreachLeads(discovered: OutreachLead[]) {
  const seenEmails = new Set<string>();
  const seenOrganizations = new Set<string>();
  return [...outreachLeads, ...discovered].filter((lead) => {
    const email = lead.email.trim().toLowerCase();
    const organization = lead.organization.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!email || seenEmails.has(email) || seenOrganizations.has(organization)) return false;
    seenEmails.add(email);
    seenOrganizations.add(organization);
    return true;
  });
}

export function jobModel(job: OutreachJob) {
  if (job.type === "draft-missing") return outreachModel();
  if (job.type === "personalize-all") return personalizationModel();
  return leadSearchModel();
}

function isRateLimitError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /429|too many requests|throttl|rate.?limit/i.test(error.message);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function estimateJobCost(job: OutreachJob) {
  const model = jobModel(job);
  const synthetic: UsageEvent = {
    id: "",
    userId: "",
    at: "",
    model,
    callType: job.type === "lead-search" ? "lead-search" : job.type === "draft-missing" ? "outreach-writer" : "outreach-personalization",
    inputTokens: job.type === "lead-search" ? 10_000 : 4_000,
    outputTokens: job.type === "lead-search" ? 3_000 : 900,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  };
  return usageCostUsd(synthetic) * (job.type === "lead-search" ? 1 : job.itemIds.length);
}
