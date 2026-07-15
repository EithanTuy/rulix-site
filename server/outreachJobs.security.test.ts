// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchAuthorizedAiRequest,
  setAiDispatchAdmissionHook,
  setAiDispatchAuthorizationHook,
  type AiProviderClient
} from "./aiEgressGateway";
import {
  appendOutreachJobLog,
  createOutreachJob,
  MAX_OUTREACH_JOB_LOGS,
  trustedJobEgress,
  type OutreachWorkerEvent
} from "./outreachJobs";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.RULIX_AI_DATA_CLASS = "proprietary";
  process.env.RULIX_CONTROLLED_DATA_MODE = "approved";
  process.env.RULIX_APPROVED_REGION = "us-east-1";
  process.env.RULIX_APPROVED_MODEL_IDS = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
});

afterEach(() => {
  setAiDispatchAdmissionHook(undefined);
  setAiDispatchAuthorizationHook(undefined);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe("trusted outreach worker dispatch identity", () => {
  it("bounds persisted job history while retaining the newest operator evidence", () => {
    const job = createOutreachJob({ type: "draft-missing", itemIds: [], maxCostUsd: 1 });
    for (let index = 0; index < 100; index += 1) {
      appendOutreachJobLog(job, {
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        message: `event-${index}`,
        level: "info"
      });
    }
    expect(job.logs).toHaveLength(MAX_OUTREACH_JOB_LOGS);
    expect(job.logs[0]?.message).toBe("event-99");
    expect(job.logs[job.logs.length - 1]?.message).toBe("event-50");
  });

  it("hashes maximum-length job and lead identifiers into a stable bounded base", () => {
    const event: OutreachWorkerEvent = {
      source: "rulix.outreach-worker",
      userId: `user-${"u".repeat(500)}`,
      jobId: "event-job"
    };
    const job = createOutreachJob({
      type: "personalize-all",
      itemIds: [],
      maxCostUsd: 1
    });
    job.id = `outreach-job-${"j".repeat(500)}`;
    const subject = `lead-${"s".repeat(500)}`;

    const first = trustedJobEgress(event, job, "outreach-personalization", subject);
    const second = trustedJobEgress(event, job, "outreach-personalization", subject);

    expect(first.dispatchId).toBe(second.dispatchId);
    expect(`${first.dispatchId}:candidate:review`.length).toBeLessThanOrEqual(160);
    expect(first.dispatchId).not.toContain(job.id);
    expect(first.dispatchId).not.toContain(subject);
  });

  it("reuses one receipt across a lost-response retry and never calls the provider twice", async () => {
    const receipts = new Set<string>();
    setAiDispatchAdmissionHook(async () => ({ settle: async () => undefined }));
    setAiDispatchAuthorizationHook(async (metadata) => ({
      replayed: receipts.has(metadata.dispatchId),
      markProviderStarted: async () => { receipts.add(metadata.dispatchId); },
      settle: async () => undefined
    }));
    const create = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 }
    }));
    const provider: AiProviderClient = { messages: { create } };
    const event: OutreachWorkerEvent = {
      source: "rulix.outreach-worker",
      userId: "user-1",
      jobId: "job-1"
    };
    const job = createOutreachJob({ type: "personalize-all", itemIds: ["lead-1"], maxCostUsd: 1 });
    const base = trustedJobEgress(event, job, "outreach-personalization", "lead-1");
    const context = {
      ...base,
      dispatchId: `${base.dispatchId}:candidate`,
      purpose: "outreach-personalization" as const,
      payload: { leadId: "lead-1" }
    };
    const lane = {
      provider: "amazon-bedrock" as const,
      region: "us-east-1",
      model: "global.anthropic.claude-haiku-4-5-20251001-v1:0"
    };
    const body = { model: lane.model, max_tokens: 10, messages: [] };

    await dispatchAuthorizedAiRequest(context, lane, body, undefined, provider);
    await expect(dispatchAuthorizedAiRequest(context, lane, body, undefined, provider))
      .rejects.toMatchObject({ code: "ai_dispatch_replayed" });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
