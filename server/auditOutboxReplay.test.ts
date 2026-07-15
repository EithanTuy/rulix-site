// @vitest-environment node

import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it } from "vitest";
import { buildAuditReplayRecord, assertAuditReplayResponse } from "../scripts/replay-audit-outbox";

describe("audit outbox replay guardrails", () => {
  it("builds a deterministic INSERT image without rewriting the stored item", () => {
    const item = marshall({
      pk: "TENANT#prod#USER#user-1",
      sk: "AU#memo-1#2026-07-15T00:00:00.000Z#audit-1",
      entityType: "AU",
      createdAt: "2026-07-15T00:00:00.000Z"
    });
    const record = buildAuditReplayRecord(item, "arn:aws:dynamodb:us-east-1:1:table/t/stream/s", "us-east-1", 0);

    expect(record).toMatchObject({
      eventName: "INSERT",
      eventSource: "aws:dynamodb",
      awsRegion: "us-east-1",
      dynamodb: {
        Keys: { pk: item.pk, sk: item.sk },
        NewImage: item,
        SequenceNumber: "0000000000000000000000000000000000000001",
        StreamViewType: "NEW_IMAGE"
      }
    });
  });

  it("requires a successful Lambda batch response before a replay is counted", () => {
    const success = new TextEncoder().encode(JSON.stringify({ batchItemFailures: [] }));
    expect(() => assertAuditReplayResponse({ StatusCode: 200, Payload: success })).not.toThrow();
    expect(() => assertAuditReplayResponse({ StatusCode: 200, Payload: new TextEncoder().encode(
      JSON.stringify({ batchItemFailures: [{ itemIdentifier: "1" }] })
    ) })).toThrow(/rejected 1/);
    expect(() => assertAuditReplayResponse({ StatusCode: 200, FunctionError: "Unhandled", Payload: success }))
      .toThrow(/invocation failed/);
  });
});
