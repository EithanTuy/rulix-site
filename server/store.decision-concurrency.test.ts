// @vitest-environment node

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { analyzeMemo } from "../src/lib/eccnReview";
import type { AuditEvent, MemoRecord, ReviewerDecision } from "../src/types";
import { hashMemoContent } from "./domain/hashes";
import { DynamoAccountStore, type DecisionBindingError } from "./store";

describe("Dynamo authoritative decision transition", () => {
  it("retries a lost CAS and revalidates policy instead of restoring a concurrently edited memo", async () => {
    const client = new AccountStateDynamoClient();
    const store = new DynamoAccountStore("auth", "accounts", {
      client: client as unknown as DynamoDBDocumentClient
    });
    const userId = "decision-race-account";
    const memo = reviewMemo();
    await store.upsertReview(userId, memo);
    await store.setAnalysisResult(userId, { ...memo, status: "ready" }, liveResult(memo));
    const prepared = await store.getAccountState(userId);
    const preparedMemo = prepared.memos.find((item) => item.id === memo.id)!;
    const preparedAnalysis = prepared.analysisResults[memo.id];

    const pause = client.pauseBefore((event) =>
      event.name === "PutCommand" && Boolean(event.input.Item?.state?.decisions?.[memo.id])
    );
    const decisionPromise = store.setDecision(
      userId,
      memo.id,
      proposedDecision(),
      proposedAudit(memo.id),
      {
        expectedVersion: preparedMemo.version!,
        expectedRevision: preparedMemo.revision!,
        expectedHash: preparedMemo.contentHash!,
        expectedAnalysisId: preparedAnalysis.id!,
        expectedAnalysisHash: preparedAnalysis.resultHash!
      }
    );
    await pause.reached;

    const edited = {
      ...memo,
      memoText: `${memo.memoText}\n\nConcurrent material edit.`,
      status: "draft" as const,
      lifecycleStage: "draft" as const,
      revision: 2,
      version: 2
    };
    edited.contentHash = hashMemoContent(edited);
    await store.updateReview(userId, edited);
    pause.release();

    await expect(decisionPromise).rejects.toMatchObject({
      code: "stale_revision",
      status: 409,
      current: {
        version: 2,
        revision: 2,
        hash: edited.contentHash
      }
    } satisfies Partial<DecisionBindingError>);
    expect(client.conditionalConflicts).toBe(1);
    const state = await store.getAccountState(userId);
    expect(state.memos.find((item) => item.id === memo.id)).toMatchObject({
      memoText: edited.memoText,
      revision: 2,
      lifecycleStage: "draft"
    });
    expect(state.analysisResults[memo.id]).toBeUndefined();
    expect(state.decisions[memo.id]).toBeUndefined();
    expect(state.auditEvents.filter((event) => event.action === "Analysis completed")).toHaveLength(1);
    expect(state.auditEvents.some((event) => event.action.startsWith("Reviewer decision:"))).toBe(false);
  });

  it("retries analysis CAS without duplicating its atomic completion audit", async () => {
    const client = new AccountStateDynamoClient();
    const store = new DynamoAccountStore("auth", "accounts", {
      client: client as unknown as DynamoDBDocumentClient
    });
    const userId = "analysis-cas-account";
    const memo = reviewMemo();
    await store.upsertReview(userId, memo);

    const pause = client.pauseBefore((event) =>
      event.name === "PutCommand" && Boolean(event.input.Item?.state?.analysisResults?.[memo.id])
    );
    const analysisPromise = store.setAnalysisResult(userId, memo, liveResult(memo));
    await pause.reached;
    await store.appendAuditEvent(userId, {
      id: "audit-unrelated",
      memoId: memo.id,
      at: "2026-07-14T11:59:00.000Z",
      actor: "Concurrent Reviewer",
      action: "Concurrent note",
      detail: "Forces the analysis transition to retry its account-state CAS.",
      severity: "review"
    });
    pause.release();

    const transition = await analysisPromise;
    expect(transition.decisionInvalidated).toBe(false);
    expect(client.conditionalConflicts).toBe(1);
    const state = await store.getAccountState(userId);
    expect(state.analysisResults[memo.id].id).toBe("analysis-decision-race");
    expect(state.auditEvents.filter((event) => event.action === "Analysis completed")).toHaveLength(1);
    expect(state.auditEvents.filter((event) => event.id === "audit-unrelated")).toHaveLength(1);
  });
});

function reviewMemo(): MemoRecord {
  const memo: MemoRecord = {
    id: "memo-decision-race",
    title: "RLX-200 controller review",
    itemFamily: "Cryogenic controller",
    owner: "Security Reviewer",
    updatedAt: "2026-07-14",
    documentCode: "RACE-001",
    status: "draft",
    lifecycleStage: "draft",
    memoText: "The controller regulates cryogenic laboratory equipment.",
    attachments: [],
    dataClass: "proprietary",
    sourcePath: "self-classification",
    manufacturer: "Rulix Test Instruments",
    intendedUse: "University research laboratory",
    revision: 1,
    version: 1
  };
  memo.contentHash = hashMemoContent(memo);
  return memo;
}

function liveResult(memo: MemoRecord) {
  const result = analyzeMemo(memo);
  return {
    ...result,
    id: "analysis-decision-race",
    provider: {
      ...result.provider,
      source: "bedrock" as const,
      label: "Amazon Bedrock",
      model: "test-live-model",
      live: true,
      message: "Live provider result used by the CAS regression."
    },
    findings: result.findings.map((finding) => ({ ...finding, status: "strong" as const }))
  };
}

function proposedDecision(): ReviewerDecision {
  return {
    id: "decision-race",
    action: "accept",
    notes: "Accept the analyzed revision.",
    signerId: "reviewer-1",
    signedBy: "Security Reviewer",
    signedAt: "2026-07-14T12:00:00.000Z",
    createdAt: "2026-07-14T12:00:00.000Z"
  };
}

function proposedAudit(memoId: string): AuditEvent {
  return {
    id: "audit-decision-race",
    memoId,
    at: "2026-07-14T12:00:00.000Z",
    actor: "Security Reviewer",
    action: "Reviewer decision: accept",
    detail: "Accept the analyzed revision.",
    severity: "info"
  };
}

type CommandInput = Record<string, any>;
type CommandEvent = { name: string; input: CommandInput };

class AccountStateDynamoClient {
  private item?: CommandInput;
  private beforeHooks: Array<(event: CommandEvent) => Promise<void>> = [];
  conditionalConflicts = 0;

  pauseBefore(predicate: (event: CommandEvent) => boolean) {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    let active = true;
    this.beforeHooks.push(async (event) => {
      if (!active || !predicate(event)) return;
      active = false;
      reached();
      await releasePromise;
    });
    return { reached: reachedPromise, release };
  }

  async send(command: { constructor: { name: string }; input: CommandInput }) {
    const event = { name: command.constructor.name, input: command.input };
    for (const hook of this.beforeHooks) await hook(event);
    if (event.name === "GetCommand") {
      return { Item: clone(this.item) };
    }
    if (event.name !== "PutCommand") {
      throw new Error(`Unsupported account-state command: ${event.name}`);
    }
    if (!this.conditionHolds(event.input)) {
      this.conditionalConflicts += 1;
      const error = new Error("ConditionalCheckFailedException");
      error.name = "ConditionalCheckFailedException";
      throw error;
    }
    this.item = clone(event.input.Item);
    return {};
  }

  private conditionHolds(input: CommandInput) {
    const expression = String(input.ConditionExpression ?? "");
    if (!expression) return true;
    if (expression.includes("attribute_not_exists(#pk)")) return !this.item;
    if (expression.includes("attribute_exists(#pk)") && !this.item) return false;
    if (expression.includes("attribute_not_exists(#state.#version)")) {
      return this.item?.state?.version === undefined;
    }
    if (":expectedVersion" in (input.ExpressionAttributeValues ?? {})) {
      return this.item?.state?.version === input.ExpressionAttributeValues[":expectedVersion"];
    }
    return true;
  }
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
