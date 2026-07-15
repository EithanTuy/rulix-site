# Rulix ECCN Reviewer Guide

Rulix is a review aid for ECCN classification memos. It helps an export-control reviewer find weak reasoning, missing technical facts, conflicts, and source citations. It does not make a final legal determination.

The same four-step guide is available inside the app from **Help** on desktop and mobile. On an empty account it is also available through **Learn the workflow**.

## Core workflow

1. Select **New Review**, **Paste Text**, **Upload / Approve**, or **Build with AI**.
2. Confirm the exact memo text, source/manufacturer, data class, classification path, and any file bytes before analysis.
3. Start AI analysis:
   - Export-control officers select **Approve & Analyze**. This approves only the exact current revision, depth, server-loaded context, and allowed provider lane.
   - Reviewers and counsel select **Request Approval**. An officer inspects the exact request in **Controls > AI approval queue**, then selects **Approve one dispatch**. The requester can then select **Run Approved Analysis** without editing the memo.
4. Read the memo in the center panel and inspect **Decision Support**:
   - Check jurisdiction before relying on an EAR/ECCN path.
   - Treat blocking evidence as unresolved until the underlying fact or citation is fixed.
   - Treat the recommendation as decision support, never as the final determination.
5. Select Evidence Map rows to inspect the rationale, memo claim, and official-source citation.
6. Use **Information to Request** when technical parameters or source support are missing.
7. Record exactly one human decision with notes:
   - **Accept Recommendation** only when the memo support is sufficient.
   - **Request More Info** when missing facts prevent signoff.
   - **Override / Change ECCN** when the reviewer disagrees with the recommendation or jurisdiction path.
8. Export the report after the current revision has a valid decision.

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
