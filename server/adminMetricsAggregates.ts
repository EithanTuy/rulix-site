import type {
  AdminMetrics,
  MetricBucket,
  MetricTotals,
  UsageCallType,
  UsageEvent
} from "../src/types";
import { priceFamily, readBedrockPrices, usageCostUsd } from "./bedrockPricing";

export const ADMIN_METRICS_SCHEMA_VERSION = 1 as const;
export const ADMIN_METRICS_SUPPORTED_RANGE_DAYS = [7, 30, 90] as const;
export type AdminMetricsRangeDays = (typeof ADMIN_METRICS_SUPPORTED_RANGE_DAYS)[number];

interface StoredMetricBucket extends MetricBucket {
  latencyMsTotal: number;
  latencySamples: number;
}

export interface AdminDailyUsageAggregate {
  schemaVersion: typeof ADMIN_METRICS_SCHEMA_VERSION;
  version: number;
  day: string;
  updatedAt: string;
  expiresAtEpoch: number;
  totals: StoredMetricBucket;
  byModel: Record<string, StoredMetricBucket>;
  byCallType: Record<string, StoredMetricBucket>;
}

export class AdminMetricsIntegrityError extends Error {}

export function isAdminMetricsRangeDays(value: number): value is AdminMetricsRangeDays {
  return ADMIN_METRICS_SUPPORTED_RANGE_DAYS.includes(value as AdminMetricsRangeDays);
}

export function utcDay(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new AdminMetricsIntegrityError("Usage telemetry has an invalid timestamp.");
  }
  return date.toISOString().slice(0, 10);
}

export function adminMetricsWindow(rangeDays: AdminMetricsRangeDays, nowMs = Date.now()) {
  const end = new Date(nowMs);
  const start = new Date(Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate() - rangeDays + 1
  ));
  return { start: utcDay(start), end: utcDay(end) };
}

export function emptyAdminDailyUsageAggregate(day: string): AdminDailyUsageAggregate {
  assertUtcDay(day);
  return {
    schemaVersion: ADMIN_METRICS_SCHEMA_VERSION,
    version: 0,
    day,
    updatedAt: `${day}T00:00:00.000Z`,
    expiresAtEpoch: Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 1_000) + 120 * 24 * 60 * 60,
    totals: emptyStoredBucket("total", "Total"),
    byModel: {},
    byCallType: {}
  };
}

export function addUsageToAdminDailyAggregate(
  current: AdminDailyUsageAggregate | undefined,
  event: UsageEvent
): AdminDailyUsageAggregate {
  assertUsageEvent(event);
  const day = utcDay(event.at);
  const aggregate = current ?? emptyAdminDailyUsageAggregate(day);
  assertAdminDailyUsageAggregate(aggregate, day);
  const cost = usageCostUsd(event);
  if (!Number.isFinite(cost) || cost < 0) {
    throw new AdminMetricsIntegrityError("Usage telemetry produced an invalid cost estimate.");
  }
  const family = priceFamily(event.model);
  const modelBucket = aggregate.byModel[family]
    ?? emptyStoredBucket(family, modelLabel(family));
  const callTypeBucket = aggregate.byCallType[event.callType]
    ?? emptyStoredBucket(event.callType, callTypeLabel(event.callType));
  return {
    ...aggregate,
    version: aggregate.version + 1,
    updatedAt: maxIso(aggregate.updatedAt, event.at),
    totals: addEvent(aggregate.totals, event, cost),
    byModel: {
      ...aggregate.byModel,
      [family]: addEvent(modelBucket, event, cost)
    },
    byCallType: {
      ...aggregate.byCallType,
      [event.callType]: addEvent(callTypeBucket, event, cost)
    }
  };
}

export function assertAdminDailyUsageAggregate(
  value: AdminDailyUsageAggregate | undefined,
  expectedDay?: string
): asserts value is AdminDailyUsageAggregate | undefined {
  if (value === undefined) return;
  if (
    value.schemaVersion !== ADMIN_METRICS_SCHEMA_VERSION
    || !Number.isSafeInteger(value.version)
    || value.version < 0
    || !isUtcDay(value.day)
    || (expectedDay !== undefined && value.day !== expectedDay)
    || !Number.isFinite(Date.parse(value.updatedAt))
    || !Number.isSafeInteger(value.expiresAtEpoch)
    || value.expiresAtEpoch <= 0
    || !isStoredBucket(value.totals)
    || !isBucketRecord(value.byModel, new Set(["haiku", "sonnet", "opus", "default"]))
    || !isBucketRecord(value.byCallType)
  ) {
    throw new AdminMetricsIntegrityError("A materialized admin usage bucket is malformed.");
  }
}

export function buildMaterializedAdminMetrics(input: {
  daily: AdminDailyUsageAggregate[];
  rangeDays: AdminMetricsRangeDays;
  usersTotal: number;
  aggregateCompletedAt: string;
  accountTotalAsOf?: string;
  usageAsOf?: string;
  nowMs?: number;
}): AdminMetrics {
  const nowMs = input.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const window = adminMetricsWindow(input.rangeDays, nowMs);
  if (!Number.isSafeInteger(input.usersTotal) || input.usersTotal < 0) {
    throw new AdminMetricsIntegrityError("The materialized account total is malformed.");
  }
  if (!Number.isFinite(Date.parse(input.aggregateCompletedAt))) {
    throw new AdminMetricsIntegrityError("The admin aggregate completion timestamp is malformed.");
  }
  const accountTotalAsOf = input.accountTotalAsOf ?? generatedAt;
  const usageAsOf = input.usageAsOf ?? generatedAt;
  if (!Number.isFinite(Date.parse(accountTotalAsOf)) || !Number.isFinite(Date.parse(usageAsOf))) {
    throw new AdminMetricsIntegrityError("An admin metrics freshness timestamp is malformed.");
  }

  const days = new Map<string, AdminDailyUsageAggregate>();
  for (const aggregate of input.daily) {
    assertAdminDailyUsageAggregate(aggregate);
    if (aggregate.day < window.start || aggregate.day > window.end || days.has(aggregate.day)) {
      throw new AdminMetricsIntegrityError("The materialized admin usage range is inconsistent.");
    }
    days.set(aggregate.day, aggregate);
  }

  const total = emptyStoredBucket("total", "Total");
  const byModel = new Map<string, StoredMetricBucket>();
  const byCallType = new Map<string, StoredMetricBucket>();
  const daily: MetricBucket[] = [];

  for (const day of calendarDays(window.start, window.end)) {
    const aggregate = days.get(day);
    if (!aggregate) {
      daily.push(publicBucket(emptyStoredBucket(day, day)));
      continue;
    }
    mergeStoredBucket(total, aggregate.totals);
    mergeBucketRecord(byModel, aggregate.byModel);
    mergeBucketRecord(byCallType, aggregate.byCallType);
    daily.push(publicBucket({ ...aggregate.totals, key: day, label: day }));
  }

  const modelBuckets = Array.from(byModel.values()).sort(descendingCost).map(publicBucket);
  const callTypeBuckets = Array.from(byCallType.values()).sort(descendingCost).map(publicBucket);
  const monthlyByModel = timeline(input.daily, "byModel");
  const monthlyByCallType = timeline(input.daily, "byCallType");
  const prices = readBedrockPrices();
  return {
    generatedAt,
    rangeDays: input.rangeDays,
    rangeStart: window.start,
    rangeEnd: window.end,
    availability: {
      status: "partial",
      usage: { status: "available", exact: true, asOf: usageAsOf },
      accountTotal: { status: "available", exact: true, asOf: accountTotalAsOf },
      onlineUsers: {
        status: "unavailable",
        exact: false,
        reason: "Online presence is not exposed when it would require an unbounded session scan."
      },
      topUsers: {
        status: "unavailable",
        exact: false,
        reason: "Range-ranked users are not exposed without an exact bounded ranking index."
      }
    },
    totals: publicTotals(total),
    byModel: modelBuckets,
    byCallType: callTypeBuckets,
    daily,
    monthlyByModel,
    monthlyByCallType,
    pricing: modelBuckets.map((bucket) => {
      const price = prices[bucket.key] ?? prices.default;
      return {
        key: bucket.key,
        label: bucket.label,
        inputPer1M: price.inputPer1M,
        outputPer1M: price.outputPer1M,
        cacheReadPer1M: price.cacheReadPer1M,
        cacheWritePer1M: price.cacheWritePer1M
      };
    }),
    topUsers: [],
    users: { total: input.usersTotal, online: null }
  };
}

function assertUsageEvent(event: UsageEvent) {
  if (
    !event
    || typeof event.id !== "string"
    || !event.id
    || typeof event.userId !== "string"
    || !event.userId
    || typeof event.model !== "string"
    || !event.model
    || typeof event.callType !== "string"
    || !event.callType
    || ![event.inputTokens, event.outputTokens, event.cacheReadTokens, event.cacheWriteTokens]
      .every((value) => Number.isSafeInteger(value) && value >= 0)
    || (event.latencyMs !== undefined && (!Number.isFinite(event.latencyMs) || event.latencyMs < 0))
  ) {
    throw new AdminMetricsIntegrityError("Usage telemetry is malformed.");
  }
  utcDay(event.at);
}

function emptyStoredBucket(key: string, label: string): StoredMetricBucket {
  return {
    key,
    label,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    calls: 0,
    latencyMsTotal: 0,
    latencySamples: 0
  };
}

function addEvent(bucket: StoredMetricBucket, event: UsageEvent, costUsd: number): StoredMetricBucket {
  const next = {
    ...bucket,
    costUsd: bucket.costUsd + costUsd,
    inputTokens: bucket.inputTokens + event.inputTokens,
    outputTokens: bucket.outputTokens + event.outputTokens,
    cacheReadTokens: bucket.cacheReadTokens + event.cacheReadTokens,
    cacheWriteTokens: bucket.cacheWriteTokens + event.cacheWriteTokens,
    calls: bucket.calls + 1,
    latencyMsTotal: bucket.latencyMsTotal + (event.latencyMs ?? 0),
    latencySamples: bucket.latencySamples + (event.latencyMs === undefined ? 0 : 1)
  };
  assertExactCounters(next);
  return next;
}

function mergeStoredBucket(target: StoredMetricBucket, source: StoredMetricBucket) {
  target.costUsd += source.costUsd;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.calls += source.calls;
  target.latencyMsTotal += source.latencyMsTotal;
  target.latencySamples += source.latencySamples;
  assertExactCounters(target);
}

function assertExactCounters(bucket: StoredMetricBucket) {
  if (![bucket.inputTokens, bucket.outputTokens, bucket.cacheReadTokens, bucket.cacheWriteTokens, bucket.calls]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new AdminMetricsIntegrityError("Admin metric counters exceed exact numeric bounds.");
  }
  if (!Number.isFinite(bucket.costUsd) || bucket.costUsd < 0) {
    throw new AdminMetricsIntegrityError("Admin metric cost exceeds exact numeric bounds.");
  }
}

function mergeBucketRecord(
  target: Map<string, StoredMetricBucket>,
  source: Record<string, StoredMetricBucket>
) {
  for (const [key, bucket] of Object.entries(source)) {
    const merged = target.get(key) ?? emptyStoredBucket(key, bucket.label);
    mergeStoredBucket(merged, bucket);
    target.set(key, merged);
  }
}

function publicTotals(bucket: StoredMetricBucket): MetricTotals {
  return {
    costUsd: bucket.costUsd,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    cacheWriteTokens: bucket.cacheWriteTokens,
    calls: bucket.calls,
    avgLatencyMs: bucket.latencySamples
      ? Math.round(bucket.latencyMsTotal / bucket.latencySamples)
      : 0
  };
}

function publicBucket(bucket: StoredMetricBucket): MetricBucket {
  const { latencyMsTotal: _latencyMsTotal, latencySamples: _latencySamples, ...value } = bucket;
  return value;
}

function timeline(
  aggregates: AdminDailyUsageAggregate[],
  field: "byModel" | "byCallType"
) {
  const periods = new Map<string, Map<string, { label: string; costUsd: number }>>();
  for (const aggregate of aggregates) {
    const period = aggregate.day.slice(0, 7);
    const segments = periods.get(period) ?? new Map();
    for (const [key, bucket] of Object.entries(aggregate[field])) {
      const current = segments.get(key) ?? { label: bucket.label, costUsd: 0 };
      current.costUsd += bucket.costUsd;
      segments.set(key, current);
    }
    periods.set(period, segments);
  }
  return Array.from(periods.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([period, segments]) => ({
      period,
      label: new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" })
        .format(new Date(`${period}-01T00:00:00.000Z`)),
      segments: Array.from(segments.entries()).map(([key, segment]) => ({ key, ...segment }))
    }));
}

function calendarDays(start: string, end: string) {
  const days: string[] = [];
  for (let cursor = new Date(`${start}T00:00:00.000Z`); utcDay(cursor) <= end;) {
    days.push(utcDay(cursor));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return days;
}

function isBucketRecord(
  value: unknown,
  allowedKeys?: ReadonlySet<string>
): value is Record<string, StoredMetricBucket> {
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).every(([key, bucket]) => (
    (!allowedKeys || allowedKeys.has(key))
    && isStoredBucket(bucket)
    && bucket.key === key
  ));
}

function isStoredBucket(value: unknown): value is StoredMetricBucket {
  if (!isPlainRecord(value)) return false;
  return typeof value.key === "string"
    && typeof value.label === "string"
    && [
      value.costUsd,
      value.inputTokens,
      value.outputTokens,
      value.cacheReadTokens,
      value.cacheWriteTokens,
      value.calls,
      value.latencyMsTotal,
      value.latencySamples
    ].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)
    && Number.isSafeInteger(value.calls)
    && Number.isSafeInteger(value.latencySamples);
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUtcDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && utcDay(`${value}T00:00:00.000Z`) === value;
}

function assertUtcDay(value: string) {
  if (!isUtcDay(value)) throw new AdminMetricsIntegrityError("Admin metrics day is invalid.");
}

function maxIso(left: string, right: string) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function descendingCost(left: StoredMetricBucket, right: StoredMetricBucket) {
  return right.costUsd - left.costUsd || left.key.localeCompare(right.key);
}

function modelLabel(family: string) {
  if (family === "haiku") return "Claude Haiku";
  if (family === "sonnet") return "Claude Sonnet";
  if (family === "opus") return "Claude Opus";
  return "Other model";
}

function callTypeLabel(type: UsageCallType) {
  if (type === "council") return "Council review";
  if (type === "memo-chat") return "Memo chat";
  if (type === "outreach-writer") return "Outreach writer";
  if (type === "outreach-personalization") return "Outreach personalization";
  if (type === "lead-search") return "Lead search";
  if (type === "memo-builder") return "Memo Builder";
  if (type === "document-extraction") return "Document extraction";
  return "Public draft";
}
