# Rulix ECCN Reviewer Guide

Rulix is a review aid for ECCN classification memos. It helps an export-control reviewer find weak reasoning, missing technical facts, conflicts, and source citations. It does not make a final legal determination.

The same workflow guide is available inside the app from **Help** on desktop and mobile. **Home / My Work** keeps a dismissible, role-aware checklist until the user has completed the core workflow.

## Finding your way around

- **Home / My Work** prioritizes assigned reviews, urgent work, information requests, decisions, and recent activity.
- **Reviews** is the searchable queue. Filters, sorting, paging, saved views, and the current queue state remain in the URL so the view can be bookmarked or shared.
- **Memo Builder** keeps AI drafting conversations and artifacts together. A generated artifact never silently overwrites an approved review.
- **Evidence Library** searches source material and exposes review/citation associations.
- **Controls** contains exact-content AI approvals. **Administration** and the operator dashboard are role-gated.
- Press **Ctrl/Command+K** to open command search. Right-click a review or memo artifact for open, copy-link, duplicate, download, audit, and archive actions. The menu is keyboard navigable and uses the platform's native shortcut label.

On mobile, open the main navigation from the top-left menu. Review sections become a horizontal tab row and the workbench stacks in the order case context, evidence/analysis, then artifacts/collaboration.

## Core workflow

1. Start from **Home / My Work** or the **Review Queue**, then select **New review**, paste text, upload a supported file, or begin in **Memo Builder**.
2. Confirm the exact memo text, source/manufacturer, data class, classification path, and any file bytes before analysis.
3. Start AI analysis:
   - Export-control officers select **Approve & Analyze**. This approves only the exact current revision, depth, server-loaded context, and allowed provider lane.
   - Reviewers and counsel select **Request Approval**. An officer inspects the exact request in **Controls > AI approval queue**, then selects **Approve one dispatch**. The requester can then select **Run Approved Analysis** without editing the memo.
4. Follow the persistent workbench path: **Intake → Evidence → AI approval/run → Resolve findings → Human decision → Export**. Read the memo and inspect evidence and AI findings:
   - Check jurisdiction before relying on an EAR/ECCN path.
   - Treat blocking evidence as unresolved until the underlying fact or citation is fixed.
   - Treat the recommendation as decision support, never as the final determination.
5. Use **AI summary**, **Key findings**, **Full evidence**, and **Citations** to inspect the rationale, exact memo claim, source provenance, and official-source citation.
6. Use **Information to Request** when technical parameters or source support are missing.
7. Record exactly one human decision with notes:
   - **Accept Recommendation** only when the memo support is sufficient.
   - **Request More Info** when missing facts prevent signoff.
   - **Override / Change ECCN** when the reviewer disagrees with the recommendation or jurisdiction path.
8. Export the report after the current revision has a valid decision.

The right-hand artifact pane holds review notes, collaboration, and the active memo artifact beside the evidence being evaluated. Comments and information requests are tenant-visible and audited. Use `@Name` to mention a tenant member; assignment, mention, due-date, request-information, decision, and system events appear in the notification inbox.

## Queue and review recovery

- A missing or deleted restored selection is cleared once, then Rulix opens the next usable review instead of repeating a failed preference save.
- A retryable network failure keeps the selection and offers retry. It is not treated as a deletion.
- A stale version (`409`) keeps the authoritative server record, explains the conflict, and requires the intended edit to be reapplied.
- Malformed review data is isolated from the queue with an actionable error instead of crashing the workspace.
- Filters and saved views never change access control. Bulk assignment and tagging appear only for authorized roles.

## Exact AI approval behavior

An approval is not a reusable permission. It authorizes one provider dispatch for one immutable snapshot. Editing the memo, chat history, Memo Builder conversation, classification, analysis depth, server-loaded context, or provider policy makes the approval stale. Expired, rejected, revoked, already-consumed, or concurrently claimed approvals fail closed.

For reviewer and counsel accounts:

- **Request Approval** creates a queued request; it does not call a provider.
- The officer sees the server-derived subject, preview, classification, policy, provider body hash, and current/stale status.
- **Approve one dispatch** creates a short-lived one-use authorization.
- **Run Approved Analysis** claims that exact authorization atomically. A second tab or retry cannot reuse it.

Memo chat and Memo Builder follow the same rule. Save the exact conversation, request approval, and do not edit it before the approved send. Officers can approve and send their own exact current request directly.

## Adding a memo

Minimum useful intake data:

- Memo title
- Manufacturer or source
- Data class
- Classification path, if known
- Memo text

The memo should include item description, technical parameters, software/firmware/technology scope, source classification support, jurisdiction reasoning, and end-use context.

Choose the file data class before uploading. Text stays local. PDF, DOCX, or image extraction may require AI, so **Upload / Approve** binds the exact validated bytes and classification before extraction. A reviewer who cannot approve controlled extraction must ask an officer to select the same file and class.

Newly uploaded, pasted, or created memos are intentionally **Unanalyzed**. No result is recorded merely because content was added.

## Analysis status

- **Unanalyzed**: no review result has been produced for the current revision.
- **Approval required**: the exact request must be inspected by an export-control officer.
- **Approved for one exact dispatch**: an unexpired one-use approval matches the current request.
- **AI working**: the approved live analysis is running.
- **Live AI analysis**: the configured provider returned a structured review that passed server validation.
- **AI analysis unavailable**: the provider was unavailable, failed, or timed out; no reviewer-facing result was recorded.

If live AI does not finish within three minutes, Rulix fails closed and asks the reviewer to retry. Deterministic rules are an internal validation baseline for live output, not a reviewer-visible substitute.

## Analysis depth

- **Full AI Council** uses the server-configured standard model for routine triage, missing-information checks, citation validation, and evidence mapping.
- **Deep Council Pass** uses the server-configured deep model and a stricter prompt to look for ambiguous next steps, unsupported confidence, overblocking, or underblocking.

The browser never chooses a provider or model ID. Deployment policy owns the exact provider, Region, classification floor, controlled-data mode, and allowed models.

## Evidence and decision rules

- **Strong Evidence** supports the classification analysis.
- **Weak Reasoning** is relevant but not tied clearly to a control parameter or source.
- **Missing Info** identifies a required fact that is absent.
- **Conflicting Claim** identifies reasoning that may be wrong or legally insufficient.

Do not accept a recommendation just because AI produced it. Confirm jurisdiction, relevant citations, technical thresholds, and the distinction between end-use statements and classification analysis. Resolve blockers or explicitly choose **Request More Info**. A new memo revision or analysis invalidates the older human decision; Rulix rechecks blocker policy inside the authoritative signoff transaction.

## If something changed in another tab

A `409` conflict means a newer authoritative revision won. Reload the review, inspect the current content, and reapply the intended change. Never assume a failed save overwrote the newer state. Re-request AI approval after any conflict because the old snapshot is no longer current.
