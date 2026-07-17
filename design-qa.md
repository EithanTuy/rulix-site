# Rulix product experience design QA

## Comparison target

- Source visual truth: `C:\Users\prana\.codex\generated_images\019f68cb-0342-7b40-955e-6cc22ca92430\exec-c2da2145-072b-4ee3-8350-9847f92a9b03.png`
- Browser-rendered implementation: `C:\Users\prana\.codex\visualizations\2026\07\16\019f68cb-0342-7b40-955e-6cc22ca92430\rulix-workbench-final-1487x1058.png`
- Source frame: 1487 × 1058.
- Browser viewport override: 1487 × 1103; the in-app browser captured a 1487 × 979 effective page viewport after application chrome.
- Route: `/app#/reviews/review-8aadbba6-80e2-4729-aafb-760b04cf8e49/overview`.
- State: signed-in export-control officer, proprietary review awaiting exact-content AI approval, artifact context menu open.

The source and implementation were opened together in the same comparison input at native width. The 79-pixel effective-height difference was treated as a capture-surface constraint; the shared above-the-fold product region was compared directly.

## Full-view comparison evidence

- Layout and hierarchy: the implementation preserves the deep-navy global shell, white task header, horizontal review progress, approval-scope banner, and high-contrast three-pane workbench. Panel proportions, active navigation, and the right-side artifact/menu relationship remain faithful.
- Typography: both use a compact sans-serif product hierarchy with clear weight changes. The implementation uses the repository's Inter files, preserves readable small labels, and avoids accidental marketing/display typography in the product shell.
- Spacing and rhythm: 24-pixel page gutters, restrained card padding, thin separators, compact tabs, and dense metadata match the reference intent. The implementation removes ornamental space and keeps the main task above the fold.
- Colors and tokens: navy, white/cool-gray surfaces, blue-gray borders, and restrained teal active/status treatment match the selected direction with WCAG-oriented contrast. Destructive menu content remains red and separated.
- Assets and icons: the existing Rulix brand asset and Lucide icon family are used throughout. No source asset was replaced with CSS art, emoji, handcrafted SVG, or placeholder imagery.
- Copy/content: dynamic review content intentionally differs from the concept fixture. Product copy preserves the same meaning while making exact approval scope, source provenance, human signoff, and empty AI state explicit.

## Focused region evidence

A separate crop was not required because the native-width combined comparison keeps the header, progress path, artifact card, and complete context menu readable. The browser DOM snapshot independently verified accessible names and Windows-native shortcut labels (`Ctrl K`, `Ctrl L`, `Ctrl ↵`).

## Primary interactions tested

- Home → stable review route and browser-restored selection.
- Command search open/close.
- Help drawer open/close.
- Artifact right-click menu, Arrow/Escape behavior, duplicate action availability, outside-click cleanup, and resize cleanup.
- Reviewer progress/section navigation and AI action affordance.
- Dashboard Operations → Usage → Accounts → Growth → Lead Review routing.
- 390, 768, and 1440 responsive journeys for submitter, reviewer, counsel, and export-control officer.

Browser console warnings/errors: none. Same-origin failed requests: none in the passing journeys. Critical Axe violations: none.

## Comparison history

### Iteration 1

- [P1] Responsive Help lost its accessible name when the visible label was hidden at tablet width.
  - Fix: added a stable `aria-label="Help"` to the header control.
  - Post-fix evidence: the tablet reviewer journey locates and operates Help; all four tablet roles pass.
- [P2] The context menu displayed Command shortcuts on Windows.
  - Fix: introduced platform-aware shortcut formatting shared by the header and context menu, with unit coverage for Apple, Windows, and Linux.
  - Post-fix evidence: the final browser snapshot exposes `Ctrl K`, `Ctrl L`, and `Ctrl ↵`.
- [P2] An open context menu could persist offscreen after a responsive resize or hash-route transition.
  - Fix: close on resize, user wheel/touch scroll, and hash change, in addition to outside click, blur, and Escape. Programmatic scroll-to-target remains safe so right-click can reveal and open an offscreen artifact in one action.
  - Post-fix evidence: menu count changes from one to zero immediately after viewport resize; unit coverage exercises resize, wheel, touch movement, and hash change.

### Final comparison

No actionable P0, P1, or P2 mismatch remains. The implementation intentionally adds Home / My Work, collaboration, notification, Evidence Library, and role-gated administration destinations because those are product requirements beyond the selected static concept. The awaiting-AI empty state is also intentional and preferable to fabricated analysis data.

## Findings

No actionable P0/P1/P2 findings.

## Open questions

None.

## Implementation checklist

- [x] Match the selected navy/teal high-contrast shell and three-pane workbench.
- [x] Preserve readable hierarchy and responsive task order.
- [x] Implement the complete right-click interaction with keyboard and viewport behavior.
- [x] Verify reviewer and dashboard core routes across 390, 768, and 1440 pixels.
- [x] Verify console, network, accessibility, unit, integration, build, Lambda, and bundle gates.

## Follow-up polish

No P3 item is being deferred as part of this handoff.

final result: passed
