import type {
  AdminMetrics,
  MetricBucket,
  UsageEvent,
  UserAdminSummary,
  UserProfile,
  UserUsageSummary
} from "../src/types";
import { priceFamily, usageCostUsd } from "./bedrockPricing";

export interface SessionSummary {
  userId: string;
  lastSeenAt: string;
}

export const DEFAULT_RANGE_DAYS = 30;

export function onlineWindowMs(): number {
  const minutes = Number(process.env.RULIX_ONLINE_WINDOW_MIN);
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : 5;
  return safe * 60 * 1000;
}

export function buildAdminMetrics(input: {
  usage: UsageEvent[];
  users: UserProfile[];
  sessions: SessionSummary[];
  rangeDays?: number;
}): AdminMetrics {
  const rangeDays = input.rangeDays && input.rangeDays > 0 ? input.rangeDays : DEFAULT_RANGE_DAYS;
  const cutoff = Date.now() - rangeDays * 24 * 60 * 60 * 1000;
  const events = input.usage.filter((event) => Date.parse(event.at) >= cutoff);

  const totals = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    calls: 0,
    avgLatencyMs: 0
  };
  let latencySum = 0;
  let latencyCount = 0;

  const byModel = new Map<string, MetricBucket>();
  const byCallType = new Map<string, MetricBucket>();
  const daily = new Map<string, MetricBucket>();
  const perUser = new Map<string, UserUsageSummary>();
  const profiles = new Map(input.users.map((user) => [user.id, user]));

  for (const event of events) {
    const cost = usageCostUsd(event);
    totals.costUsd += cost;
    totals.inputTokens += event.inputTokens;
    totals.outputTokens += event.outputTokens;
    totals.cacheReadTokens += event.cacheReadTokens;
    totals.cacheWriteTokens += event.cacheWriteTokens;
    totals.calls += 1;
    if (typeof event.latencyMs === "number") {
      latencySum += event.latencyMs;
      latencyCount += 1;
    }

    addBucket(byModel, priceFamily(event.model), modelLabel(event.model), event, cost);
    addBucket(byCallType, event.callType, callTypeLabel(event.callType), event, cost);
    addBucket(daily, event.at.slice(0, 10), event.at.slice(0, 10), event, cost);

    const profile = profiles.get(event.userId);
    const summary = perUser.get(event.userId) ?? {
      userId: event.userId,
      email: profile?.email ?? event.userEmail ?? "unknown",
      name: profile?.name ?? "Unknown",
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      calls: 0
    };
    summary.costUsd += cost;
    summary.inputTokens += event.inputTokens;
    summary.outputTokens += event.outputTokens;
    summary.calls += 1;
    perUser.set(event.userId, summary);
  }

  totals.avgLatencyMs = latencyCount ? Math.round(latencySum / latencyCount) : 0;

  return {
    generatedAt: new Date().toISOString(),
    rangeDays,
    totals,
    byModel: sortByCost(byModel),
    byCallType: sortByCost(byCallType),
    daily: Array.from(daily.values()).sort((a, b) => a.key.localeCompare(b.key)),
    topUsers: Array.from(perUser.values()).sort((a, b) => b.costUsd - a.costUsd).slice(0, 10),
    users: { total: input.users.length, online: countOnline(input.sessions) }
  };
}

export function summarizeUsers(input: {
  users: UserProfile[];
  usage: UsageEvent[];
  sessions: SessionSummary[];
}): UserAdminSummary[] {
  const windowMs = onlineWindowMs();
  const now = Date.now();

  const lastSeen = new Map<string, string>();
  for (const session of input.sessions) {
    const current = lastSeen.get(session.userId);
    if (!current || Date.parse(session.lastSeenAt) > Date.parse(current)) {
      lastSeen.set(session.userId, session.lastSeenAt);
    }
  }

  const usageByUser = new Map<string, UserAdminSummary["usage"]>();
  for (const event of input.usage) {
    const usage = usageByUser.get(event.userId) ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0 };
    usage.costUsd += usageCostUsd(event);
    usage.inputTokens += event.inputTokens;
    usage.outputTokens += event.outputTokens;
    usage.calls += 1;
    usageByUser.set(event.userId, usage);
  }

  return input.users
    .map((user) => {
      const seen = lastSeen.get(user.id);
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        createdAt: user.createdAt,
        lastSeenAt: seen,
        online: seen ? now - Date.parse(seen) <= windowMs : false,
        usage: usageByUser.get(user.id) ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0 }
      };
    })
    .sort((a, b) => b.usage.costUsd - a.usage.costUsd || a.email.localeCompare(b.email));
}

function countOnline(sessions: SessionSummary[]): number {
  const windowMs = onlineWindowMs();
  const now = Date.now();
  const online = new Set<string>();
  for (const session of sessions) {
    if (now - Date.parse(session.lastSeenAt) <= windowMs) online.add(session.userId);
  }
  return online.size;
}

function addBucket(
  map: Map<string, MetricBucket>,
  key: string,
  label: string,
  event: UsageEvent,
  cost: number
) {
  const bucket = map.get(key) ?? { key, label, costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0 };
  bucket.costUsd += cost;
  bucket.inputTokens += event.inputTokens;
  bucket.outputTokens += event.outputTokens;
  bucket.calls += 1;
  map.set(key, bucket);
}

function sortByCost(map: Map<string, MetricBucket>) {
  return Array.from(map.values()).sort((a, b) => b.costUsd - a.costUsd);
}

function modelLabel(model: string) {
  const family = priceFamily(model);
  if (family === "haiku") return "Claude Haiku";
  if (family === "sonnet") return "Claude Sonnet";
  if (family === "opus") return "Claude Opus";
  return model;
}

function callTypeLabel(type: UsageEvent["callType"]) {
  if (type === "council") return "Council review";
  if (type === "memo-chat") return "Memo chat";
  if (type === "outreach-writer") return "Outreach writer";
  return "Public draft";
}
