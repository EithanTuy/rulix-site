import { randomUUID } from "node:crypto";
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
import { sha256Canonical } from "./domain/hashes";
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
import {
  AiEgressPolicyError,
  deploymentDataClass,
  issueTrustedAiWorkflowGrant,
  type AiTrustedWorkflow
} from "./aiEgressGateway";
import {
  collectOutreachPages,
  OUTREACH_LEAD_SEARCH_INPUT_CAP
} from "./outreachPagination";

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
export const MAX_OUTREACH_JOB_LOGS = 50;

export function appendOutreachJobLog(job: OutreachJob, log: OutreachJobLog) {
  job.logs = [log, ...job.logs].slice(0, MAX_OUTREACH_JOB_LOGS);
}

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
    id: `outreach-job-${sortableTimestamp(now)}-${randomUUID()}`,
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

export async function scheduleOutreachJob(
  event: OutreachWorkerEvent,
  delayMs = 0,
  store: AccountStore = createAccountStore()
) {
  if (delayMs > 0) await sleep(delayMs);
  if (process.env.NODE_ENV === "test") return;
  setTimeout(() => void processOutreachJob(event, store), 0);
}

export async function processOutreachJob(
  event: OutreachWorkerEvent,
  store: AccountStore = createAccountStore()
) {
  const job = await store.getOutreachJob(event.userId, event.jobId);
  if (!job || job.status === "paused" || job.status === "completed" || job.status === "terminated") return;

  const projectedCost = projectedJobCost(job);
  if (projectedCost > job.maxCostUsd) {
    const expectedUpdatedAt = job.updatedAt;
    job.status = "paused";
    job.error = `Projected cost $${projectedCost.toFixed(2)} exceeds the $${job.maxCostUsd.toFixed(2)} cap.`;
    appendOutreachJobLog(job, jobLog(job.error, "warning"));
    job.updatedAt = new Date().toISOString();
    await store.upsertOutreachJob(event.userId, job, expectedUpdatedAt);
    return;
  }

  const config = await store.getOutreachConfig();

  const expectedRunningUpdatedAt = job.updatedAt;
  job.status = "running";
  job.startedAt ??= new Date().toISOString();
  job.updatedAt = new Date().toISOString();
  appendOutreachJobLog(job, jobLog(`Processing ${job.type} step ${job.cursor + 1}.`));
  await store.upsertOutreachJob(event.userId, job, expectedRunningUpdatedAt);

  let retryDelayMs = 0;

  try {
    if (job.type === "lead-search") {
      await processLeadSearchJob(store, job, event, config);
      completeJob(job, `Lead search completed with ${job.completedCount} accepted candidates.`);
    } else {
      const leadId = job.itemIds[job.cursor];
      if (!leadId) {
        completeJob(job, "All queued items have been processed.");
      } else {
        await processLeadItem(store, job, event, leadId, config);
        job.cursor += 1;
        job.completedCount += 1;
        job.retryCount = 0;
        appendOutreachJobLog(job, jobLog(`Completed ${leadId}.`, "success"));
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
    appendOutreachJobLog(job, jobLog(message, "error"));
    if (job.retryCount <= job.maxRetries) {
      job.status = "queued";
      if (rateLimit) {
        retryDelayMs = Math.min(120_000, 15_000 * Math.pow(2, job.retryCount - 1));
        appendOutreachJobLog(job, jobLog(`Retry ${job.retryCount} of ${job.maxRetries} queued after ${retryDelayMs / 1000}s backoff.`, "warning"));
      } else {
        appendOutreachJobLog(job, jobLog(`Retry ${job.retryCount} of ${job.maxRetries} queued.`, "warning"));
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
        appendOutreachJobLog(job, jobLog("Retry limit reached; skipping to the next item.", "warning"));
      }
    }
  }

  const latestJob = await store.getOutreachJob(event.userId, event.jobId);
  if (
    !latestJob
    || latestJob.status === "terminated"
    || latestJob.status === "paused"
    || latestJob.updatedAt !== job.updatedAt
  ) return;

  job.updatedAt = new Date().toISOString();
  await store.upsertOutreachJob(event.userId, job, latestJob.updatedAt);
  if (job.status === "queued" && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
    await scheduleOutreachJob(event, retryDelayMs, store);
  }
}

async function processLeadItem(
  store: AccountStore,
  job: OutreachJob,
  event: OutreachWorkerEvent,
  leadId: string,
  config: StoredOutreachConfig
) {
  const lead = await store.getOutreachLead(event.userId, leadId);
  if (!lead) throw new Error(`Lead ${leadId} no longer exists.`);
  const onUsage = usageRecorder(store, event);

  if (job.type === "draft-missing") {
    const existingDraft = await store.getOutreachDraft(event.userId, leadId);
    if (existingDraft) return;
    const draft = await generateOutreachDraft(
      lead,
      job.direction ?? "",
      onUsage,
      config,
      trustedJobEgress(event, job, "outreach-writer", leadId)
    );
    const workflow = await store.getLeadWorkflow(event.userId, leadId);
    await Promise.all([
      store.upsertOutreachDraft(event.userId, draft),
      store.upsertLeadWorkflow(
        event.userId,
        buildWorkflow(workflow, leadId, { reviewStatus: "pending-review", lifecycleStatus: "drafted" }),
        workflow?.updatedAt
      )
    ]);
    return;
  }

  const draft = await store.getOutreachDraft(event.userId, leadId);
  if (!draft) throw new Error(`Lead ${leadId} has no draft to personalize.`);
  if (draft.sentAt) return;
  const personalized = await personalizeOutreachDraft(
    lead,
    draft,
    onUsage,
    config,
    trustedJobEgress(event, job, "outreach-personalization", leadId)
  );
  const workflow = await store.getLeadWorkflow(event.userId, leadId);
  await Promise.all([
    store.upsertOutreachDraft(event.userId, personalized, draft.updatedAt),
    store.upsertLeadWorkflow(
      event.userId,
      buildWorkflow(workflow, leadId, {
        reviewStatus: personalized.personalizationStatus === "personalized" ? "pending-review" : "needs-research",
        lifecycleStatus: personalized.personalizationStatus === "personalized" ? "personalized" : "drafted"
      }),
      workflow?.updatedAt
    )
  ]);
}

async function processLeadSearchJob(
  store: AccountStore,
  job: OutreachJob,
  event: OutreachWorkerEvent,
  config: StoredOutreachConfig
) {
  const storedLeads = await collectOutreachPages({
    readPage: (query) => store.listOutreachLeadsPage(event.userId, query),
    maximum: OUTREACH_LEAD_SEARCH_INPUT_CAP,
    collection: "lead-search exclusion list"
  });
  const result = await discoverLeads({
    existingLeads: mergeOutreachLeads(storedLeads),
    durationSeconds: job.searchDurationSeconds ?? 30,
    onUsage: usageRecorder(store, event),
    egress: trustedJobEgress(event, job, "lead-search", job.id),
    config
  });
  const run: LeadSearchRun = {
    id: `lead-search-${sortableTimestamp(new Date().toISOString())}-${randomUUID()}`,
    startedAt: job.startedAt ?? job.createdAt,
    completedAt: new Date().toISOString(),
    durationSeconds: job.searchDurationSeconds ?? 30,
    model: result.model,
    status: "completed",
    addedLeadIds: result.leads.map((lead) => lead.leadId),
    activity: result.activity
  };
  await Promise.all([
    store.upsertOutreachLeads(event.userId, result.leads),
    store.appendLeadSearchRun(event.userId, run),
    ...result.leads.map(async (lead) => {
      const workflow = await store.getLeadWorkflow(event.userId, lead.leadId);
      return store.upsertLeadWorkflow(
        event.userId,
        buildWorkflow(workflow, lead.leadId, { reviewStatus: "new", lifecycleStatus: "not-contacted" }),
        workflow?.updatedAt
      );
    })
  ]);
  job.completedCount = result.leads.length;
}

export function trustedJobEgress(
  event: OutreachWorkerEvent,
  job: OutreachJob,
  workflow: AiTrustedWorkflow,
  subjectId: string
) {
  const trustedSubjectId = `job:${sha256Canonical({
    workflow,
    jobId: job.id,
    subjectId
  })}`;
  return {
    accountId: event.userId,
    dataClass: deploymentDataClass(),
    // Intentionally stable across worker retries. A retry must recover or
    // observe the original receipt, never create a second billable request.
    dispatchId: `${workflow}:${trustedSubjectId}`,
    trustedWorkflowGrant: issueTrustedAiWorkflowGrant(workflow, trustedSubjectId)
  };
}

function usageRecorder(store: AccountStore, event: OutreachWorkerEvent) {
  return (sample: UsageSample) => {
    const usage: UsageEvent = {
      id: `usage-${randomUUID()}`,
      userId: event.userId,
      userEmail: event.userEmail,
      at: new Date().toISOString(),
      ...sample
    };
    void store.recordUsage(usage);
  };
}

function buildWorkflow(
  previous: LeadWorkflow | undefined,
  leadId: string,
  patch: Partial<LeadWorkflow>
) {
  return {
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
  appendOutreachJobLog(job, jobLog(message, "success"));
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
  if (error instanceof AiEgressPolicyError && (error.status === 429 || error.status === 503)) {
    return true;
  }
  if (!(error instanceof Error)) return false;
  return /429|too many requests|throttl|rate.?limit/i.test(error.message);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function sortableTimestamp(value: string) {
  return value.replace(/[^0-9]/g, "");
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
