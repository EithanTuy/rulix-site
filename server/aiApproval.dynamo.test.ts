// @vitest-environment node

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiApprovalPolicyBinding, AiApprovalSubjectBinding, MemoRecord } from "../src/types";
import { hashAiApprovalChatHistory, hashAiApprovalPayload } from "./domain/aiApproval";
import { hashMemoContent } from "./domain/hashes";
import {
  DynamoAccountStore,
  emptyAccountState,
  type CreateAiApprovalRequestCommand
} from "./store";

const AUTH_TABLE = "auth";
const ACCOUNT_TABLE = "accounts";
const ACCOUNT = "dynamo-requester";
const REQUESTER = { id: ACCOUNT, role: "reviewer" as const };
const OFFICER = { id: "dynamo-officer", role: "export-control-officer" as const };
const POLICY: AiApprovalPolicyBinding = {
  version: "policy-v1",
  mode: "approved",
  provider: "amazon-bedrock",
  clientRegion: "us-east-1",
  model: "anthropic.claude-approved"
};

describe("Dynamo AI approval queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    process.env.RULIX_AI_APPROVAL_PREVIEW_ACTIVE_KEY_ID = "ddb-v1";
    process.env.RULIX_AI_APPROVAL_PREVIEW_KEYS_JSON = JSON.stringify({
      "ddb-v1": Buffer.alloc(32, 11).toString("base64url")
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.RULIX_AI_APPROVAL_PREVIEW_ACTIVE_KEY_ID;
    delete process.env.RULIX_AI_APPROVAL_PREVIEW_KEYS_JSON;
  });

  it("atomically persists encrypted preview, indexes, quotas, and the complete approval decision", async () => {
    const { client, store, subject } = dynamoStore();
    const pending = "Officer must inspect this exact prospective message.";
    const command = chatRequest(subject, "ddb-chat", pending);
    const created = await store.createAiApprovalRequest(ACCOUNT, command);
    const createTransaction = client.transactions[client.transactions.length - 1]!;

    expect(createTransaction.filter((item) => item.ConditionCheck?.TableName === ACCOUNT_TABLE)).toHaveLength(1);
    expect(putKeys(createTransaction)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^AI_APPROVAL_REQUEST#air-/),
      expect.stringMatching(/^AI_APPROVAL_REQUEST_ACCOUNT#/),
      expect.stringMatching(/^AI_APPROVAL_REQUEST_TENANT#/),
      expect.stringMatching(/^AI_APPROVAL_REQUEST_PREVIEW#air-/)
    ]));
    expect(updateKeys(createTransaction)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^AI_APPROVAL_REQUEST_QUOTA_ACCOUNT#/),
      expect.stringMatching(/^AI_APPROVAL_REQUEST_QUOTA_TENANT#/)
    ]));
    const previewItem = createTransaction.find((item) =>
      String(item.Put?.Item?.sk).startsWith("AI_APPROVAL_REQUEST_PREVIEW#"))?.Put?.Item;
    expect(JSON.stringify(previewItem)).not.toContain(pending);

    const officerDetail = await store.getTenantAiApprovalRequest(OFFICER, created.request.id);
    expect(officerDetail?.pendingContent?.text).toBe(pending);
    const approved = await store.approveAiApprovalRequest(created.request.id, {
      requestId: "ddb-approve",
      decidedBy: OFFICER
    });
    expect(approved.status).toBe("approved");
    expect(approved.approval?.current).toBe(true);
    expect(approved.approval?.approval.accountId).toBe(ACCOUNT);

    const approvalTransaction = client.transactions[client.transactions.length - 1]!;
    expect(approvalTransaction.filter((item) => item.ConditionCheck?.TableName === ACCOUNT_TABLE)).toHaveLength(1);
    expect(approvalTransaction.some((item) =>
      String(item.ConditionCheck?.Key?.sk).startsWith("AI_APPROVAL_REQUEST#") &&
      String(item.ConditionCheck?.ConditionExpression).includes("validUntilEpoch"))).toBe(true);
    expect(deleteKeys(approvalTransaction)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^AI_APPROVAL_REQUEST_PENDING#/),
      expect.stringMatching(/^AI_APPROVAL_REQUEST_PREVIEW#air-/)
    ]));
    expect(putKeys(approvalTransaction)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^AI_APPROVAL_REQUEST_DECISION#air-/),
      expect.stringMatching(/^AI_APPROVAL#.+#aia-/),
      expect.stringMatching(/^AI_APPROVAL_COUNTER#/),
      expect.stringMatching(/^AI_APPROVAL_CURRENT#/),
      expect.stringMatching(/^AI_APPROVAL_REQUEST_ACCOUNT#/),
      expect.stringMatching(/^AI_APPROVAL_REQUEST_TENANT#/)
    ]));
    expect(client.authKeys("AI_APPROVAL_REQUEST_PREVIEW#")).toHaveLength(0);

    const delayed = await store.approveAiApprovalRequest(created.request.id, {
      requestId: "ddb-approve",
      decidedBy: OFFICER
    });
    expect(delayed.approval?.approval.id).toBe(approved.approval?.approval.id);
    await expect(store.approveAiApprovalRequest(created.request.id, {
      requestId: "ddb-different-approve",
      decidedBy: OFFICER
    })).rejects.toMatchObject({ code: "ai_approval_request_decided" });

    await store.revokeAiApprovalRequestApproval(created.request.id, {
      requestId: "ddb-revoke",
      revokedBy: OFFICER,
      reason: "Officer revoked the exact queued authorization."
    });
    const revoked = await store.getTenantAiApprovalRequest(OFFICER, created.request.id);
    expect(revoked?.approvalRequest.approval?.current).toBe(false);
    expect(revoked?.approvalRequest.approval?.revocation?.reason).toContain("revoked");
  });

  it("enforces per-account quota atomically under concurrent unique request IDs", async () => {
    const { store, subject } = dynamoStore();
    const results = await Promise.allSettled(Array.from({ length: 26 }, (_, index) =>
      store.createAiApprovalRequest(
        ACCOUNT,
        councilRequest(subject, `ddb-quota-${index}`, `unique-${index}`)
      )));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(25);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 429,
      code: "ai_approval_request_capacity"
    });
  });

  it("deduplicates 26 concurrent identical requests before quota or index growth", async () => {
    const { client, store, subject } = dynamoStore();
    const results = await Promise.all(Array.from({ length: 26 }, (_, index) =>
      store.createAiApprovalRequest(ACCOUNT, councilRequest(subject, `ddb-same-${index}`))));
    expect(new Set(results.map((result) => result.request.id)).size).toBe(1);
    expect(client.authKeys("AI_APPROVAL_REQUEST#")).toHaveLength(1);
    expect(client.authKeys("AI_APPROVAL_REQUEST_ACCOUNT#")).toHaveLength(1);
    expect(client.authKeys("AI_APPROVAL_REQUEST_TENANT#")).toHaveLength(1);
    expect(client.quotaCount("AI_APPROVAL_REQUEST_QUOTA_ACCOUNT#")).toBe(1);
  });

  it("serializes cancellation and rejection so exactly one durable decision wins", async () => {
    const { store, subject } = dynamoStore();
    const created = await store.createAiApprovalRequest(ACCOUNT, councilRequest(subject, "ddb-race"));
    const results = await Promise.allSettled([
      store.cancelAiApprovalRequest(ACCOUNT, created.request.id, {
        requestId: "ddb-cancel",
        actor: REQUESTER,
        reason: "Requester withdrew the request."
      }),
      store.rejectAiApprovalRequest(created.request.id, {
        requestId: "ddb-reject",
        decidedBy: OFFICER,
        reason: "Officer rejected the request."
      })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const current = await store.getAiApprovalRequest(ACCOUNT, created.request.id);
    expect(["cancelled", "rejected"]).toContain(current?.status);
    expect(current?.decision?.decision).toBe(current?.status);
  });

  it("revalidates the target workspace in the approval transaction and rejects a stale subject", async () => {
    const { client, store, subject, memo } = dynamoStore();
    const created = await store.createAiApprovalRequest(ACCOUNT, councilRequest(subject, "ddb-stale"));
    client.replaceMemo({
      ...memo,
      memoText: `${memo.memoText}\nChanged after request.`,
      revision: 2,
      version: 2,
      contentHash: undefined
    });
    await expect(store.approveAiApprovalRequest(created.request.id, {
      requestId: "ddb-stale-decision",
      decidedBy: OFFICER
    })).rejects.toMatchObject({ code: "ai_approval_stale_subject" });
  });
});

function dynamoStore() {
  const client = new ApprovalDynamoClient();
  const memo = memoFixture();
  client.seedAccount(memo);
  const store = new DynamoAccountStore(AUTH_TABLE, ACCOUNT_TABLE, {
    client: client as unknown as DynamoDBDocumentClient,
    workspaceMode: "legacy"
  });
  const subject: AiApprovalSubjectBinding = {
    kind: "review",
    id: memo.id,
    revision: memo.revision as number,
    version: memo.version as number,
    contentHash: memo.contentHash as string
  };
  return { client, store, subject, memo };
}

function memoFixture(): MemoRecord {
  const memo: MemoRecord = {
    id: "memo-ddb",
    title: "Dynamo approval",
    itemFamily: "Signal equipment",
    owner: "Reviewer",
    updatedAt: "2026-07-15T12:00:00.000Z",
    documentCode: "DDB-1",
    status: "ready",
    memoText: "Exact Dynamo workspace content.",
    attachments: [],
    dataClass: "proprietary",
    sourcePath: "self-classification",
    intendedUse: "Testing",
    revision: 1,
    version: 1
  };
  memo.contentHash = hashMemoContent(memo);
  return memo;
}

function chatRequest(
  subject: AiApprovalSubjectBinding,
  requestId: string,
  pending: string
): CreateAiApprovalRequestCommand {
  return {
    ...councilRequest(subject, requestId),
    purpose: "memo-chat",
    payloadHash: hashAiApprovalPayload({ subject, pending }),
    providerRequestHashes: [hashAiApprovalPayload({ model: POLICY.model, pending })],
    context: {
      kind: "memo-chat",
      pendingMessageHash: hashAiApprovalPayload(pending),
      historyHash: hashAiApprovalChatHistory([])
    },
    pendingContent: { kind: "memo-chat", text: pending }
  };
}

function councilRequest(
  subject: AiApprovalSubjectBinding,
  requestId: string,
  semanticSalt?: string
): CreateAiApprovalRequestCommand {
  return {
    requestId,
    requestedBy: REQUESTER,
    purpose: "council",
    subject,
    payloadHash: hashAiApprovalPayload({ subject, depth: "standard", semanticSalt }),
    providerRequestHashes: [hashAiApprovalPayload({ model: POLICY.model, subject, semanticSalt })],
    dataClass: "proprietary",
    policy: POLICY,
    context: { kind: "council", depth: "standard" }
  };
}

function putKeys(items: any[]) {
  return items.flatMap((item) => item.Put?.Item?.sk ? [String(item.Put.Item.sk)] : []);
}

function updateKeys(items: any[]) {
  return items.flatMap((item) => item.Update?.Key?.sk ? [String(item.Update.Key.sk)] : []);
}

function deleteKeys(items: any[]) {
  return items.flatMap((item) => item.Delete?.Key?.sk ? [String(item.Delete.Key.sk)] : []);
}

type Item = Record<string, any>;

class ApprovalDynamoClient {
  private items = new Map<string, Item>();
  readonly transactions: any[][] = [];

  seedAccount(memo: MemoRecord) {
    const state = { ...emptyAccountState(), version: 1, memos: [structuredClone(memo)] };
    this.set(ACCOUNT_TABLE, { pk: `TENANT#prod#USER#${ACCOUNT}`, state });
  }

  replaceMemo(memo: MemoRecord) {
    const key = itemKey(ACCOUNT_TABLE, { pk: `TENANT#prod#USER#${ACCOUNT}` });
    const item = this.items.get(key) as Item;
    const secured = structuredClone(memo);
    secured.contentHash = hashMemoContent(secured);
    item.state = { ...item.state, version: item.state.version + 1, memos: [secured] };
  }

  authKeys(prefix: string) {
    return [...this.items.values()]
      .filter((item) => item.__table === AUTH_TABLE && String(item.sk).startsWith(prefix))
      .map((item) => item.sk);
  }

  quotaCount(prefix: string) {
    return [...this.items.values()]
      .filter((item) => item.__table === AUTH_TABLE && String(item.sk).startsWith(prefix))
      .reduce((total, item) => total + Number(item.count ?? 0), 0);
  }

  async send(command: { constructor: { name: string }; input: Item }) {
    const input = command.input;
    if (command.constructor.name === "GetCommand") {
      return { Item: clone(this.items.get(itemKey(input.TableName, input.Key))) };
    }
    if (command.constructor.name === "QueryCommand") {
      const prefix = input.ExpressionAttributeValues[":prefix"];
      const values = [...this.items.values()]
        .filter((item) => item.__table === input.TableName && item.pk === input.ExpressionAttributeValues[":pk"] &&
          String(item.sk).startsWith(prefix))
        .sort((left, right) => String(left.sk).localeCompare(String(right.sk)));
      return { Items: clone(values.slice(0, input.Limit)) };
    }
    if (command.constructor.name === "TransactWriteCommand") {
      this.transact(input.TransactItems);
      return {};
    }
    throw new Error(`Unsupported command ${command.constructor.name}`);
  }

  private transact(operations: any[]) {
    const draft = new Map([...this.items.entries()].map(([key, value]) => [key, clone(value)]));
    try {
      for (const operation of operations) {
        if (operation.ConditionCheck) this.check(draft, operation.ConditionCheck);
        else if (operation.Put) this.put(draft, operation.Put);
        else if (operation.Update) this.update(draft, operation.Update);
        else if (operation.Delete) this.remove(draft, operation.Delete);
      }
    } catch (error) {
      (error as Error).name = "TransactionCanceledException";
      throw error;
    }
    this.items = draft;
    this.transactions.push(clone(operations));
  }

  private check(target: Map<string, Item>, operation: Item) {
    const current = target.get(itemKey(operation.TableName, operation.Key));
    const expression = String(operation.ConditionExpression);
    const values = operation.ExpressionAttributeValues ?? {};
    if (expression.includes("attribute_not_exists(#pk)")) {
      if (current) throw new Error("conditional");
      return;
    }
    if (expression.includes("#state.#version")) {
      if (current?.state?.version !== values[":expectedVersion"]) throw new Error("conditional");
      return;
    }
    if (expression.includes("#record.#commandHash") &&
        (current?.record?.commandHash !== values[":commandHash"] ||
         current?.record?.validUntilEpoch <= values[":nowEpoch"])) throw new Error("conditional");
    if (expression.includes("#record.#bindingHash") &&
        (current?.record?.bindingHash !== values[":bindingHash"] ||
         current?.record?.expiresAtEpoch <= values[":nowEpoch"])) throw new Error("conditional");
  }

  private put(target: Map<string, Item>, operation: Item) {
    const key = itemKey(operation.TableName, operation.Item);
    const current = target.get(key);
    const expression = String(operation.ConditionExpression ?? "");
    const values = operation.ExpressionAttributeValues ?? {};
    if (expression.includes("attribute_not_exists(#pk)") && current) throw new Error("conditional");
    if (expression.includes("#record.#status") &&
        (current?.record?.status !== values[":pending"] || current?.record?.requestKey !== values[":requestKey"])) {
      throw new Error("conditional");
    }
    if (expression.includes(":expectedApprovalId") &&
        current?.record?.approvalId !== values[":expectedApprovalId"]) throw new Error("conditional");
    target.set(key, { ...clone(operation.Item), __table: operation.TableName });
  }

  private update(target: Map<string, Item>, operation: Item) {
    const key = itemKey(operation.TableName, operation.Key);
    const current = target.get(key);
    const count = current?.count ?? 0;
    if (count >= operation.ExpressionAttributeValues[":limit"]) throw new Error("conditional");
    target.set(key, {
      ...clone(operation.Key),
      count: count + 1,
      expiresAtEpoch: operation.ExpressionAttributeValues[":expiresAtEpoch"],
      __table: operation.TableName
    });
  }

  private remove(target: Map<string, Item>, operation: Item) {
    const key = itemKey(operation.TableName, operation.Key);
    const current = target.get(key);
    const expression = String(operation.ConditionExpression ?? "");
    const values = operation.ExpressionAttributeValues ?? {};
    if (expression.includes("#record.#bindingHash") && current?.record?.bindingHash !== values[":bindingHash"]) {
      throw new Error("conditional");
    }
    if (expression.includes("#record.#approvalId") && current?.record?.approvalId !== values[":approvalId"]) {
      throw new Error("conditional");
    }
    if (expression.includes("#record.#approvalRequestId") &&
        (current?.record?.approvalRequestId !== values[":approvalRequestId"] ||
         current?.record?.dedupeHash !== values[":dedupeHash"])) {
      throw new Error("conditional");
    }
    target.delete(key);
  }

  private set(table: string, item: Item) {
    this.items.set(itemKey(table, item), { ...clone(item), __table: table });
  }
}

function itemKey(table: string, value: Item) {
  return `${table}\u0000${value.pk}\u0000${value.sk ?? ""}`;
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
