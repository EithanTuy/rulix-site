# AI approval and human signoff

Rulix is human-review-first. AI is decision support, never the final legal determination.

## Exact-content approval

An approval binds one immutable request snapshot: review/revision, content hash, data class, analysis depth, server-loaded context, provider lane, model policy, and canonical provider-body hash. It is short-lived and authorizes one atomic provider dispatch.

The following invalidate approval and require a new request:

- memo, attachment, chat, or Memo Builder edits;
- data-class, classification-path, or analysis-depth changes;
- provider/model policy or server-loaded context changes;
- expiration, rejection, revocation, consumption, or a competing successful claim.

Reviewer and counsel accounts request approval. An export-control officer inspects and approves the exact dispatch. Submitters cannot approve AI or sign off. Provider failures fail closed and do not create a reviewer-facing result.

## Result and decision lifecycle

Rulix exposes elapsed progress, cancellation, retry, stale-result warnings, partial-result handling, source provenance, and the exact approval scope. A later memo revision or analysis makes the older decision stale. Final export requires a current human decision and the existing role authorization.

AI-generated Memo Builder output is always a draft artifact. It must be explicitly created as or applied to a review; it never silently overwrites approved work. All approvals, claims, analysis results, decisions, signoffs, and exports produce audit provenance.
