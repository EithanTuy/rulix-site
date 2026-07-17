# Admin metrics operations

Production `GET /api/admin/metrics` is intentionally a bounded read. It never
loads raw `USAGE#`, `USER#`, or `SESSION#` collections. The only supported
windows are 7, 30, and 90 inclusive UTC calendar days. A request performs one
strongly consistent marker read and one strongly consistent range query with a
hard limit equal to the requested number of days.

Each accepted usage event updates four records in one DynamoDB transaction:
the immutable event, its idempotency receipt, the cumulative per-account
summary, and one `ADMIN_METRICS_DAY#YYYY-MM-DD` aggregate. A version condition
serializes same-day writers. The event record carries the metrics schema
version, so a retry cannot add the same event twice and an older event can be
migrated exactly once. Daily records expire 120 days after their day, leaving a
30-day safety margin beyond the largest API window.

The aggregate marker contains the exact account total. Invite acceptance and
the counter increment share one transaction after migration. While a backfill
owns the marker lease, account creation returns a retryable `503`; this prevents
an account from landing between the user scan and marker publication. Two
backfills cannot publish concurrently: acquisition is version-conditioned,
the one-hour lease is recoverable, and completion is fenced by its random
build ID.

## Availability contract

Successful responses include `generatedAt`, `availability`, and the exact
`rangeStart` and `rangeEnd` reporting window:

- usage totals, daily/model/workflow buckets, and the account total are exact;
- Dynamo mode reports online presence as `null` and marks it unavailable,
  because an exact answer would otherwise scan every active session;
- Dynamo mode returns no range-ranked users and marks that facet unavailable,
  because a capped or approximate ranking would be misleading;
- the local store retains exact online and top-user behavior and reports every
  facet available.

## Dashboard metric definitions

| Metric | Definition | Drill-down |
|---|---|---|
| Spend | Settled provider cost for the selected UTC window | Usage by model and workflow |
| AI calls | Settled provider dispatches in the selected UTC window | Daily/model/workflow buckets |
| Tokens processed | Settled input plus output tokens | Usage breakdown |
| Average latency | Mean settled provider latency for calls with timing data | Daily usage detail |
| Failures | Settled failed provider dispatches | Workflow and daily detail |
| Accounts | Exact tenant account counter as of the availability timestamp | Accounts |
| Online now | Exact local-session count; unavailable in Dynamo mode | Accounts when available |

The dashboard must display the reporting window and freshness beside these metrics. A missing or unavailable facet renders an honest unavailable state, never zero or an inferred aggregate.

If the marker is missing, old, building, or malformed, the endpoint returns
`503 admin_metrics_backfill_required` or `admin_metrics_integrity_failed`.
It never caps a raw query and presents the partial result as a total.

## Deployment and migration

Deploy the application code before exposing the new dashboard contract, then
run the one-time migration from an operator environment with normal DynamoDB
credentials:

```powershell
$env:RULIX_AUTH_TABLE = "<auth-table>"
$env:RULIX_ACCOUNT_TABLE = "<account-table>"
$env:RULIX_TENANT_ID = "prod"
npm run migrate:admin-aggregates -- --confirm-table "<auth-table>"
```

The command scans legacy data only in the explicit maintenance path. It is
idempotent. A completed current-schema marker returns immediately. If another
operator owns an unexpired lease, wait for that run; if it died, rerun after
the one-hour lease expires. Never delete the marker or daily records to force a
retry.

After migration, verify all three bounded windows:

```powershell
# Use an authenticated export-control-officer session.
Invoke-WebRequest https://app.rulix.cloud/api/admin/metrics?rangeDays=7
Invoke-WebRequest https://app.rulix.cloud/api/admin/metrics?rangeDays=30
Invoke-WebRequest https://app.rulix.cloud/api/admin/metrics?rangeDays=90
```

Confirm `availability.usage.exact` and
`availability.accountTotal.exact` are `true`, and compare the marker's account
total with the paginated account console. CloudWatch should show no
`admin_metrics_integrity_failed` or `admin_aggregate_backfill_fenced` errors.

## Regression proof

`server/store.auth-concurrency.test.ts` covers duplicate usage, concurrent
same-day writes, post-migration account creation, and a mocked tenant with
10,000 users plus 10,000 sessions. The large fixture proves a metrics request
uses exactly one marker read and one daily query and issues zero user, session,
or raw-usage queries. `server/adminMetricsAggregates.test.ts` covers exact
bucket arithmetic, empty calendar days, supported windows, and malformed
aggregate rejection.
