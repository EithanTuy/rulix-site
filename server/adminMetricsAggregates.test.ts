// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { UsageEvent } from "../src/types";
import {
  AdminMetricsIntegrityError,
  addUsageToAdminDailyAggregate,
  adminMetricsWindow,
  buildMaterializedAdminMetrics,
  emptyAdminDailyUsageAggregate,
  isAdminMetricsRangeDays
} from "./adminMetricsAggregates";

describe("materialized admin metrics", () => {
  it("builds exact bounded UTC-day totals, dimensions, timelines, and latency", () => {
    const first = usage("one", "2026-07-14T23:59:00.000Z", "council", 100);
    const second = usage("two", "2026-07-15T00:01:00.000Z", "memo-chat", 300);
    const dayOne = addUsageToAdminDailyAggregate(undefined, first);
    const dayTwo = addUsageToAdminDailyAggregate(undefined, second);

    const metrics = buildMaterializedAdminMetrics({
      daily: [dayOne, dayTwo],
      rangeDays: 7,
      usersTotal: 42,
      aggregateCompletedAt: "2026-07-15T00:00:00.000Z",
      nowMs: Date.parse("2026-07-15T12:00:00.000Z")
    });

    expect(metrics).toMatchObject({
      rangeStart: "2026-07-09",
      rangeEnd: "2026-07-15",
      totals: {
        calls: 2,
        inputTokens: 200,
        outputTokens: 40,
        avgLatencyMs: 200
      },
      users: { total: 42, online: null },
      availability: {
        status: "partial",
        usage: { status: "available", exact: true },
        accountTotal: { status: "available", exact: true },
        onlineUsers: { status: "unavailable", exact: false },
        topUsers: { status: "unavailable", exact: false }
      }
    });
    expect(metrics.daily).toHaveLength(7);
    expect(metrics.daily.slice(-2).map((bucket) => [bucket.key, bucket.calls])).toEqual([
      ["2026-07-14", 1],
      ["2026-07-15", 1]
    ]);
    expect(metrics.byModel).toHaveLength(1);
    expect(metrics.byModel[0]).toMatchObject({ key: "haiku", calls: 2 });
    expect(metrics.byCallType.map((bucket) => [bucket.key, bucket.calls])).toEqual([
      ["council", 1],
      ["memo-chat", 1]
    ]);
    expect(metrics.monthlyByModel).toEqual([expect.objectContaining({ period: "2026-07" })]);
    expect(metrics.topUsers).toEqual([]);
  });

  it("rejects malformed, duplicate, or out-of-window materialized records", () => {
    const day = addUsageToAdminDailyAggregate(undefined, usage(
      "one",
      "2026-07-15T00:00:00.000Z",
      "council",
      10
    ));
    expect(() => buildMaterializedAdminMetrics({
      daily: [day, day],
      rangeDays: 7,
      usersTotal: 1,
      aggregateCompletedAt: "2026-07-15T00:00:00.000Z",
      nowMs: Date.parse("2026-07-15T12:00:00.000Z")
    })).toThrow(AdminMetricsIntegrityError);
    expect(() => buildMaterializedAdminMetrics({
      daily: [day],
      rangeDays: 7,
      usersTotal: -1,
      aggregateCompletedAt: "2026-07-15T00:00:00.000Z",
      nowMs: Date.parse("2026-07-15T12:00:00.000Z")
    })).toThrow(AdminMetricsIntegrityError);
    expect(() => addUsageToAdminDailyAggregate(
      emptyAdminDailyUsageAggregate("2026-07-14"),
      usage("wrong-day", "2026-07-15T00:00:00.000Z", "council", 10)
    )).toThrow(AdminMetricsIntegrityError);
  });

  it("accepts only the three documented bounded windows", () => {
    expect([7, 30, 90].every(isAdminMetricsRangeDays)).toBe(true);
    expect([1, 14, 365].some(isAdminMetricsRangeDays)).toBe(false);
    expect(adminMetricsWindow(90, Date.parse("2026-01-01T00:00:00.000Z"))).toEqual({
      start: "2025-10-04",
      end: "2026-01-01"
    });
  });
});

function usage(
  id: string,
  at: string,
  callType: UsageEvent["callType"],
  latencyMs: number
): UsageEvent {
  return {
    id,
    userId: "user-1",
    userEmail: "user@example.com",
    at,
    model: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    callType,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheWriteTokens: 3,
    latencyMs
  };
}
