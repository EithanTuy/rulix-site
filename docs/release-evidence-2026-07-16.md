# Rulix product experience release evidence — 2026-07-16

## Source and destination

- Verified product source commit: `d3db640e27e23909e7bfea9e270625afed483f9a`
- Feature commit: `1e00995611c195516a8656382b1686e41ec4d6c6`
- Destination: `EithanTuy/rulix-site`, branch `main`
- Destination history preserved from: `b84c7ce52c09a4e1fe781543076be189d0d9b1a2`
- Merge method: non-destructive two-parent merge; no force-push.

## Required gates

| Gate | Result |
|---|---|
| TypeScript client/server typecheck | passed |
| Unit/integration | 68 files, 583 tests passed |
| Production Vite build | passed |
| Lambda and audit Lambda build | passed |
| Responsive Playwright | 15/15 passed: four roles at 390, 768, and 1440 plus dashboard journeys |
| Axe/runtime/network checks | no critical Axe violations, uncaught page errors, console errors, or same-origin request failures in passing journeys |
| Design QA | `design-qa.md`: passed |
| Git whitespace check | passed |

## Bundle budgets

| Chunk | Gzip | Budget |
|---|---:|---:|
| Shared initial shell | 60.4 KiB | 150 KiB |
| Reviewer app | 51.5 KiB | 120 KiB |
| Operator dashboard | 15.6 KiB | 120 KiB |
| Marketing site | 8.7 KiB | 120 KiB |

## Build hashes

| Artifact | SHA-256 |
|---|---|
| `dist/index.html` | `fd24ff126fda0b77e2f6ecbde00142d818365435e9965b3681f7c21250fda475` |
| `dist/assets/index-gj5fL761.js` | `b159c8402c4ccd9e27fce4b120fe93e25abac691020b853a8379ac42a77d6530` |
| `dist/assets/index-CpPEGR8-.css` | `0172859247cb25834adf781cfea9f03f85e4db329359742d75c6e2b6b9978886` |
| `dist/assets/App-Cxl-TmL6.js` | `ea4a9aadb918dc4a20d933403f2fd93fdb676895c3986ef5b4481710b8e88989` |
| `dist/assets/DashboardApp-jW-7MB9y.js` | `45f937bb699ae67e33b554206a269ee836dc41b43dc6f4b1dd02738edd28586d` |
| `dist/assets/MarketingSite-SuFCg3U4.js` | `676afe0ee3f135117aed80ee491980a4f28efb1e4262abc886a9154109651ede` |
| `lambda-build/handler.cjs` | `e9c7f4fa47f209ee1215c28b81fc603e4642ea92847ccdb532cf5fb84d78e895` |
| `audit-lambda-build/handler.cjs` | `280812d633a93b8a1c4b2edb6a393a4a0ea81752afcbe5e4edd3358865f09b43` |

## Health and visual evidence

Local production-bundle health response:

```json
{"ok":true,"service":"rulix-eccn-api","phase":"phase-2-mvp","provider":{"configured":false}}
```

The local QA server intentionally disabled Bedrock; provider availability was exercised through fail-closed UI states. Visual evidence is stored outside the repository:

- Reviewer desktop/right-click: `C:\Users\prana\.codex\visualizations\2026\07\16\019f68cb-0342-7b40-955e-6cc22ca92430\rulix-workbench-final-1487x1058.png`
- Reviewer tablet/mobile: `rulix-workbench-tablet.png`, `rulix-workbench-mobile.png`
- Dashboard desktop/mobile: `rulix-dashboard-desktop.png`, `rulix-dashboard-mobile.png`

## Rollback

The immediate destination rollback reference is `b84c7ce52c09a4e1fe781543076be189d0d9b1a2`. Preserve the build hashes above until live CI/deployment status and role-based smoke checks are complete. Follow `frontend-release-runbook.md` for rollback criteria and verification.
