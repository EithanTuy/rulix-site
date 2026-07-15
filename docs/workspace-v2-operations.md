# Workspace v2 migration and content-GC runbook

This runbook is for the normalized DynamoDB workspace table and its versioned,
KMS-encrypted S3 content bucket. The safety invariant is strict: an S3
`VersionId` may be deleted only when no committed normalized item references it,
and no writer can commit that version while deletion is possible.

## Storage modes and rollout order

`RULIX_WORKSPACE_MODE` has three supported values:

1. `legacy`: reads and writes use the legacy whole-account item.
2. `dual-read`: an account with a verified `META` item reads and writes through
   normalized storage; an unmigrated account reads legacy storage. There is no
   dual-write path.
3. `normalized`: every account must have a complete normalized `META` item;
   legacy aggregate APIs are unavailable.

Use `legacy -> dual-read -> normalized`. Do not switch directly to normalized
until every account has a successful signed verification receipt. Rollback to
legacy is safe only before normalized-only writes have been accepted. After
that point, restoring the old mode would discard newer authoritative data;
restore from DynamoDB point-in-time recovery and pinned S3 versions instead.

## Required environment

Export these values from Terraform outputs or the approved deployment record:

```powershell
$env:AWS_REGION = "us-east-1"
$env:RULIX_TENANT_ID = "prod"
$env:RULIX_ACCOUNT_TABLE = "<legacy-table>"
$env:RULIX_WORKSPACE_TABLE = "<normalized-table>"
$env:RULIX_WORKSPACE_CONTENT_BUCKET = "<versioned-content-bucket>"
$env:RULIX_WORKSPACE_KMS_KEY_ARN = "<workspace-kms-key-arn>"
$env:RULIX_WORKSPACE_MIGRATION_ROLE_ARN = "<migration-role-arn>"
$env:RULIX_MIGRATION_RECEIPT_SECRET_ARN = "<receipt-secret-arn>"
$env:RULIX_WORKSPACE_CONTENT_GC_ROLE_ARN = "<gc-role-arn>"
```

Before apply work, confirm DynamoDB point-in-time recovery and deletion
protection are enabled, S3 versioning is `Enabled`, and the destination names
match the change ticket. Never use application credentials for migration or GC;
both commands assume their isolated roles.

## Migration: plan, apply, verify

Plan is read-only and does not write content, checkpoints, or receipts:

```powershell
npm run migrate:workspace-v2 -- --tenant prod --mode plan --all --concurrency 1
```

Inspect entity counts and content bytes. Resolve validation errors in the
legacy source; the migration never truncates malformed or oversized records.
Apply one account first, using the exact table name as the confirmation token:

```powershell
npm run migrate:workspace-v2 -- `
  --tenant prod --mode apply --account <user-id> `
  --checkpoint .rulix-workspace-v2-checkpoint.json `
  --confirm-destination <normalized-table> `
  --change-ticket CHG-1234
```

Then apply the remaining accounts with conservative concurrency:

```powershell
npm run migrate:workspace-v2 -- `
  --tenant prod --mode apply --all --concurrency 2 `
  --checkpoint .rulix-workspace-v2-checkpoint.json `
  --confirm-destination <normalized-table> `
  --change-ticket CHG-1234
```

Apply is idempotent. It writes `META` last, after semantic verification, and
atomically updates the checkpoint. Preserve both the checkpoint and its signed
`.receipt.json` projection with the change record. Verify independently before
cutover:

```powershell
npm run migrate:workspace-v2 -- `
  --tenant prod --mode verify --all --concurrency 2 `
  --checkpoint .rulix-workspace-v2-checkpoint.json
```

Migration content-bearing transactions honor the tenant GC fence. If GC is
active they fail without committing a pointer. Wait for the GC cooldown, then
rerun the complete migration command; do not replay a captured DynamoDB
transaction or hand-edit a content reference.

### Migration abort and recovery

- Abort with `Ctrl+C`. An in-progress account never receives a complete `META`
  item. Its per-account migration lease expires, and a later run safely resumes
  matching materialized entities by migration digest.
- Keep the checkpoint. Do not delete partially materialized normalized items or
  S3 versions manually.
- Rerun `plan`, then rerun the same `apply` command and confirmation values.
- Exit code `2` is an input/validation problem, `3` is a lease or concurrent
  state conflict, and `4` is an infrastructure/credential failure. Investigate
  before retrying `4`; never weaken IAM or KMS policies to bypass it.

## Reference-aware content GC

GC is plan-only unless `--apply` and the exact bucket confirmation are both
present. The default 24-hour grace excludes fresh transaction orphans:

```powershell
npm run gc:workspace-content -- --tenant prod --grace-hours 24
```

Review `committedReferences`, `orphanVersions`, and `orphanBytes`. Apply during a
quiet operational window:

```powershell
npm run gc:workspace-content -- `
  --tenant prod --grace-hours 24 --apply `
  --confirm-bucket <versioned-content-bucket>
```

The defaults are deliberately conservative:

- a 120-second writer drain, matching the maximum app Lambda execution window;
- a 180-second renewable lease;
- a 15-second bounded S3 delete request;
- owner and monotonically increasing fence checks before every delete batch;
- clock-skew and stale-request cooldown before writers or a new owner proceed.

Only transactions that carry a `WorkspaceContentRef` are fenced. Reads and
unrelated metadata/outreach writes continue, so a crashed GC process does not
create a tenant-wide outage. A fenced API request returns retryable
`WORKSPACE_CONTENT_GC_ACTIVE` (`503`) without committing. Retry the complete HTTP
operation after cooldown so `putImmutable` resolves a current S3 version; never
retry only the old DynamoDB transaction.

Use `--writer-drain-seconds`, `--lease-seconds`, or
`--delete-timeout-seconds` only for an approved incident change. The CLI will
not allow a drain below 120 seconds or a delete timeout above 30 seconds.

### GC abort and recovery

- `Ctrl+C` or `SIGTERM` stops at the next bounded checkpoint. The command
  conditionally releases only its own owner/fence and leaves a cooldown record.
- If the process crashes, do not delete or overwrite the lease item. Content
  writers and another GC owner recover automatically after `drainUntilMs`.
- The lease key is `pk=TENANT#<tenant>#SYSTEM`,
  `sk=GC#WORKSPACE_CONTENT#LEASE`. Inspect it with a strongly consistent read
  when diagnosing a stuck run. Record `owner`, `fence`, `status`,
  `leaseUntilMs`, and `drainUntilMs` in the incident timeline.
- A stale owner is never authorized to resume. After `drainUntilMs`, start a new
  command, which acquires a higher fence. Rerun plan before apply.
- Manual lease deletion is not a recovery procedure and the GC role cannot do
  it. If timestamps are corrupt or implausibly far in the future, stop app
  content writes through the approved maintenance control and restore the lease
  item/table from the audited DynamoDB recovery path.

After any apply, rerun plan. Expected result is zero aged orphan versions. Check
the workspace KMS-denial, DynamoDB throttle, audit iterator-age/error, and audit
DLQ alarms before closing the change.
