# Rulix ECCN Reviewer Guide

Rulix is a review aid for ECCN classification memos. It helps an export-control reviewer find weak reasoning, missing technical facts, conflicts, and source citations. It does not make a final legal determination.

## Core Workflow

1. Open the Review Queue.
2. Select the memo that needs action.
3. If the memo is marked Unanalyzed, select Run AI Analysis.
4. Read the memo text in the center panel.
5. Review the Decision Support panel:
   - Jurisdiction should be checked before relying on an EAR/ECCN path.
   - Blocking evidence shows missing or conflicting support.
   - Recommendation shows the AI-supported ECCN candidate or review path.
6. Click Evidence Map rows to see the rationale, memo claim, and official-source citations.
7. Use Information to Request when the memo lacks technical parameters or source support.
8. Record one reviewer decision with notes:
   - Accept Recommendation: use only when the memo support is sufficient.
   - Request More Info: use when missing facts prevent signoff.
   - Override / Change ECCN: use when the reviewer disagrees with the recommendation or jurisdiction path.
9. Export the report after the decision is recorded.

## Adding a Memo

Use New Review or Add a Memo in the queue.

Minimum useful intake data:

- Memo title
- Manufacturer or source
- Data class
- Classification path, if known
- Memo text

The memo text should include item description, technical parameters, software/firmware/technology scope, source classification support, jurisdiction reasoning, and end-use context.

Newly uploaded, pasted, or created memos are intentionally Unanalyzed. The reviewer starts analysis manually so it is clear when AI is working and which result is being used.

## Analysis Status

- Unanalyzed: no review result has been produced yet.
- AI working: live AI analysis is currently running.
- Live AI analysis: the AI provider returned a structured review.
- Deterministic analysis: local rules produced the review because no live AI provider was used.
- AI failed - deterministic result: live AI failed or timed out, and deterministic rules were used instead.

If live AI does not finish within 3 minutes, Rulix records a deterministic result and clearly marks it as AI failed - deterministic result.

## Analysis Modes

- Full AI Council uses the server-configured Claude Haiku model. It runs the seven-agent council for routine first-pass triage, missing-information checks, citation validation, and evidence mapping.
- Deep Council Pass uses the same server-configured Claude Haiku model with a stricter prompt. It asks the council to look for user-facing blockers: ambiguous next steps, unsupported confidence, overblocking a ready memo, or underblocking a risky memo.

The browser never chooses the provider model directly. Model selection stays on the backend through `BEDROCK_MODEL`, with `global.anthropic.claude-haiku-4-5-20251001-v1:0` as the supported default.

## Evidence Labels

- Strong Evidence: supports the classification analysis.
- Weak Reasoning: relevant, but not tied clearly to a control parameter or source.
- Missing Info: required facts are absent.
- Conflicting Claim: the memo relies on reasoning that may be wrong or legally insufficient.

Clicking an evidence row selects the matching memo highlight when the claim appears in the memo text.

## Decision Rules

Always write decision notes before recording a decision. Notes should explain what was accepted, what was requested, or why the reviewer overrode the recommendation.

Do not accept a recommendation just because the AI produced one. Accept only after checking:

- Jurisdiction path is reasonable.
- Source citations are relevant.
- Technical parameters are present.
- End-use statements are not being used as a substitute for classification analysis.
- Any missing or conflicting evidence has been resolved or explicitly justified.

## What Was Removed From The Main Workflow

The app intentionally keeps the reviewer screen focused. It avoids extra admin screens, decorative document controls, agent-run details, and fake actions that do not help with ECCN memo review. The main reviewer task is to decide whether the memo is supported, not to operate a general document-management dashboard.
