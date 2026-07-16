# Rulix product experience audit baseline

Date: 2026-07-15 EDT
Surfaces: `app.rulix.cloud`, `dashboard.rulix.cloud`

## Production source lock

- Deployed source during the audit: commit `93d1611` (`Fix Netlify access request delivery`).
- GitHub `main` after reconciliation: commit `0c70ca4`, patch-identical to `93d1611`.
- Lambda: `rulix-prod-app`, Node.js 24, 1,024 MB, 120-second timeout.
- Pre-release Lambda code SHA-256: `edu8O0m8fhsgTJ1eOF2cwLhuWcaQob6DGhfpufhaBcc=`.
- Pre-release Lambda modification time: `2026-07-16T02:26:22.000+0000`.
- Health check: service healthy; phase `phase-2-mvp`; live provider configured.

### Pre-release served assets

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `/assets/index-BkG479uO.js` | 453,906 | `018aae8e05de0df96a3d714c50d68c6b07c7e941053299be52b2d83e59ebfb07` |
| `/assets/index-CyFlrlTu.css` | 178,503 | `06bfca8656ce3f767a9b817ee251cea74b4e93baf365b18cc5cd10781c899785` |

Representative production screenshots are retained outside the repository under the local Codex visualization artifact `rulix-ui-plan-audit`. They include the reviewer error state, Help Center, Memo Builder, dashboard overview/settings/writer, and mobile dashboard behavior. They are intentionally not committed because authenticated captures can contain account information.

## Role journey baseline

| Role | Expected product journey |
| --- | --- |
| Submitter | Sign in, create/import a review, provide evidence and requested information, inspect status; no AI approval or final decision authority. |
| Reviewer | Triage assigned reviews, verify evidence, request approved AI assistance, edit the memo, resolve findings, and record a human decision. |
| Counsel | Perform the reviewer journey with legal-policy review and decision participation. |
| Export-control officer | Perform the full reviewer journey, approve AI egress where required, administer accounts/invitations, and use the operations dashboard. |

## Blocking findings and permanent corrections

1. Workspace-v2 migration preserved legacy `paste-*`, `upload-*`, and `ai-draft-*` IDs, while newer API validators accepted only `review-*`. This blocked production detail, audit, chat, AI approval, and preference requests for migrated reviews. The accepted compatibility contract is documented in `review-id-compatibility.md`.
2. Restored selections were replaced before the server validated them, and failures could trigger repeated preference writes. Rulix now validates off-page restored reviews, repairs confirmed missing selections once, and preserves retryable failures.
3. The shared bundle loaded Google Fonts that the production content-security policy blocked. Fonts are now packaged locally, removing external font requests and layout inconsistency.
4. Submitters and deployments without an enabled AI provider still requested approval status, producing expected-but-noisy 403/503 console errors. Approval polling is now role- and provider-aware.

## Automated browser baseline

Playwright runs the production bundle against a disposable local account store. The matrix covers:

- Four reviewer roles.
- Desktop `1440x1024`, tablet `768x1024`, and mobile `390x844`.
- Invite acceptance, authenticated review loading, review-detail rendering, Help Center open/close behavior, dashboard navigation, browser console/page errors, same-origin request failures, and critical WCAG violations.

The Chunk 1 acceptance run completed with 15 of 15 scenarios passing.
