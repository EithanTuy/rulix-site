# Rulix operator dashboard runbook

The operator dashboard has two deliberately separate workspaces so export-control operations and growth outreach cannot be confused.

## Routes and navigation

- **Operations:** `#operations/overview`, `usage`, `accounts`, `invitations`, and `settings`.
- **Growth:** `#growth/overview`, `leads`, `lead-review`, `jobs`, and `writer`.

The workspace switcher is the first navigation control. The last valid workspace route is persisted per account. Breadcrumbs and hash routes are safe to bookmark. Only export-control officers can open the dashboard.

## Operations workflow

1. Start at **Overview** and confirm the service, provider telemetry, access protection, freshness timestamp, and reporting window.
2. Use **Usage** for exact calls, tokens, spend, latency, failures, model/workflow breakdowns, and unavailable facets. Never infer a value from an empty chart.
3. Use **Accounts** for account and online-state review, **Invitations** for controlled access, and **Settings** for provider configuration and deployment-owned controls.
4. Drill into a metric before acting on it. Each metric must retain its definition, time window, comparison context, and `generatedAt`/range metadata.

## Growth workflow

The supported pipeline is **lead ingestion → research → draft → human lead review → signature → mark sent**.

- **Leads** is the bounded, paged lead collection.
- **Lead Review** is the human approval queue. It is intentionally not called “Review Queue.”
- **Background Jobs** exposes progress, retry/cancel state, job logs, model, and estimated cost.
- **Bedrock Writer** creates drafts; it never sends outreach.

Rulix must never transmit outreach automatically. “Sent” is a human-recorded lifecycle state after an operator sends through an approved external channel. Keep owner, review status, lifecycle status, follow-up time, reply status, and notes current so the audit trail remains trustworthy.

## Failure handling

- A metric marked unavailable stays unavailable; do not substitute a partial total.
- Retry failed background work only after inspecting its error and current lead state. Cancel work whose underlying lead or draft is no longer current.
- A `409` means another operator updated the record first. Reload and reapply the intended change.
- A `401` requires sign-in. A `403` means the account lacks the officer role; do not work around it.
- If health, dashboard access, or bounded aggregate integrity regresses after release, follow the rollback procedure in `frontend-release-runbook.md`.

See `admin-metrics-operations.md` for aggregate integrity and migration details and `outreach-operations.md` for bounded outreach storage behavior.
