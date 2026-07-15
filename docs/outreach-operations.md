# Outreach pagination and bulk operations

The outreach console is designed for accounts larger than a single DynamoDB query page. Interactive routes and screens never load an entire tenant collection implicitly.

## Interactive pagination

`GET /api/admin/outreach` returns the first bounded page of leads, drafts, runs, workflows, and jobs plus collection-specific continuation metadata. Continue one collection through:

```text
GET /api/admin/outreach/pages/{collection}?pageSize=25&cursor=...
```

Supported collections are `leads`, `lead-rows`, `drafts`, `runs`, `workflows`, and `jobs`. `lead-rows` is the preferred UI projection when a lead must be joined with its targeted draft and workflow without loading unrelated records.

Cursors are signed, account-bound, collection-bound, and page-size-bound. They carry the last stable item identity rather than a numeric offset, so inserting a newer item between requests does not duplicate or skip the next page. A cursor from another account, collection, or page size is rejected. Clients merge pages by entity ID and display **loaded** counts; they do not call a partial client page “all.”

## Deliberate bulk work

Bulk job creation and lead-search exclusions use the server-only page collector. Its limits are explicit:

- page size: 50
- maximum records scanned by one operation: 5,000
- maximum items queued in one bulk job: 1,000
- maximum existing leads considered for one synchronous/background search: 1,000
- persisted job log entries: newest 50

The collector detects a stalled/repeated cursor and throws. If a scan or item cap would be exceeded, the API rejects the operation with an actionable error; it never queues a partial job while claiming the whole selection was processed. Narrow the pipeline or split the work deliberately, then retry.

Per-lead mutations use direct key reads for the target lead, draft, and workflow. They do not enumerate the tenant collection. Run and job IDs include sortable timestamps, and their pages are newest-first in local and DynamoDB storage.

## Operator verification

After deployment, use a non-production test account with more than 1,025 records and verify:

1. Repeated **Load more** reaches every lead/job exactly once.
2. Inserting a newer record between page requests does not change the continuation sequence.
3. Reusing a cursor with another collection, page size, or account fails.
4. A bulk request over 1,000 eligible items is rejected before a job is created.
5. Worker logs retain the newest 50 entries and the DynamoDB job item remains bounded.
6. Browser polling refreshes runs/jobs while preserving previously loaded pages.

Regression coverage lives in `server/outreachPagination.test.ts`, `server/outreachPagination.store.test.ts`, `server/app.test.ts`, `server/outreachJobs.security.test.ts`, and `src/lib/apiClient.outreach-pagination.test.ts`.
