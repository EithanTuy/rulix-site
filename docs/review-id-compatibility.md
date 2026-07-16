# Review ID compatibility decision

Status: Accepted
Date: 2026-07-15

## Decision

Rulix treats review IDs as durable identities. All review-bound APIs accept the bounded forms below:

- `review-*` for every newly created review.
- `paste-*`, `upload-*`, and `ai-draft-*` for records created by earlier intake paths and preserved by workspace-v2 migration.

Every ID is at most 128 characters and must match:

```text
^(?:review|paste|upload|ai-draft)-[A-Za-z0-9_][A-Za-z0-9_-]*$
```

The shared implementation is `src/shared/reviewIds.ts`. Server routes, workspace preferences, AI approval requests, and Memo Builder context must use it instead of defining their own prefix rule.

## Why identities are not rewritten

Review IDs bind memo content, revisions, analysis, decisions, chat, comments, notifications, and audit events. Rewriting migrated IDs would require a coordinated graph migration and would create unnecessary integrity and rollback risk. Supporting the historical intake prefixes preserves those relationships and lets current and migrated workspaces use the same command API.

## Compatibility rules

- New review creation continues to issue `review-<uuid>`.
- Unknown prefixes and unsafe characters are rejected with `invalid_review_id`.
- A restored selection is loaded before Rulix writes a replacement preference.
- A confirmed missing, invalid, or unauthorized review is removed from the visible queue and the next usable review is selected.
- Network and service failures keep the review selected and expose a retry action.

## Required regression coverage

- Shared validator tests for every accepted prefix and unsafe input.
- Command API tests covering detail, audit, chat, preferences, Memo Builder context, AI approval validation, and memo edits.
- Migration fixtures using a real legacy prefix.
- Rendered tests for off-page restored selections, deleted-review fallback, one-time preference repair, and retryable failures.
