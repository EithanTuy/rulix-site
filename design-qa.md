# Rulix Cloud Editorial Redesign QA

Date: 2026-07-15

Local preview: http://127.0.0.1:4173/

Source visual truth: `design/marketing/rulix-cloud-editorial-interactive-final.png`

## Rendered evidence

- Desktop, native 1440 x 1024, page top: `design-audits/rulix-cloud-editorial-2026-07-15/01-desktop-top.png`
- Desktop, reviewer loop with `Map the reasoning` selected: `design-audits/rulix-cloud-editorial-2026-07-15/02-review-loop-map.png`
- Desktop, trust accordion with `Source-linked findings` expanded: `design-audits/rulix-cloud-editorial-2026-07-15/03-trust-source-linked.png`
- Mobile, native 390 x 844, page top: `design-audits/rulix-cloud-editorial-2026-07-15/04-mobile-top.png`
- Mobile, product demo with `Resolve with evidence` selected: `design-audits/rulix-cloud-editorial-2026-07-15/05-mobile-product-resolve.png`
- Mobile, conversion section with FAQ expanded: `design-audits/rulix-cloud-editorial-2026-07-15/06-mobile-conversion.png`

The approved concept and latest implementation screenshots were opened together with `view_image` for the final comparison. The implementation was rendered from the production build through the in-app Browser preview; no standalone browser or Playwright CLI was used.

## Fidelity comparison

- Copy: passed. Automated above-the-fold diff found no missing or unexpected approved strings across navigation, headline, supporting paragraph, CTAs, and Claim -> Evidence gap -> Reviewer decision -> Record labels.
- Layout and spacing: passed. The desktop hero preserves the concept's editorial copy/product split, full-width evidence rail, white-to-graphite transition, and generous section rhythm. Focused reviewer-loop and trust captures preserve the intended left-story/right-interaction hierarchy.
- Typography: passed. Instrument Serif is loaded for editorial headlines with the intended body/display contrast. The desktop hero is locked to `Find the weak link` / `in every export-control` / `memo.` and remains readable on mobile.
- Color and surfaces: passed. White, graphite, muted gray, and Rulix teal map to the approved palette. Borders and active states stay restrained; there are no decorative blobs, fake illustrations, or generic floating-card drift.
- Imagery and assets: passed. Existing Rulix product demo media is used throughout instead of placeholder or CSS-drawn product art. Crops remain sharp and contained at desktop and mobile widths.
- Behavior and accessibility: passed. Tabs, list-step buttons, comparison rows, accordions, use-case tabs, menu, labels, focus states, reduced-motion behavior, and semantic expanded/selected/pressed states are implemented.
- Responsiveness: passed at 1440 x 1024 and 390 x 844. Browser measurements found no page-level horizontal overflow (`scrollWidth` <= `innerWidth`) in the hero, selected product demo, or conversion states.

## Comparison history

1. Pass 1 - P1 typography: the desktop hero could wrap `export-control` at the hyphen. Fixed by protecting the compound term and defining the approved three editorial lines.
2. Pass 2 - P2 layout: the hero copy column was slightly narrow relative to the concept. Fixed by rebalancing the desktop grid while preserving product-media prominence.
3. Pass 3 - passed: side-by-side review found the approved hierarchy, palette, asset treatment, spacing, and interaction emphasis intact. No P0 or P1 findings remain.

## Interaction and runtime checks

- Product demo tabs: changed to `Resolve with evidence`; selected state and media changed.
- Reviewer loop: selected `Map the reasoning`; pressed state, copy, and product image changed.
- Comparison inspector: selected `Evidence`; pressed row and explanation changed.
- Trust accordion: expanded `Source-linked findings`; preview heading and body changed.
- Use cases: selected `Manufacturers and labs`; tab and panel content changed.
- Conversion: expanded `What data can we use?`, filled the email and organization fields, and intentionally did not submit the external mail flow.
- Mobile navigation: opened and closed successfully at 390 x 844.
- Console: no warnings or errors.
- Automated verification: `npm test` (65 tests) and `npm run build` passed.

## Intentional deviations

- The approved concept uses a static illustrative workspace. The implementation uses the existing real Rulix demo recordings and screenshots, preserving the same placement and narrative while providing authentic product evidence.
- The source concept is a compressed full-page image representing a 1440-wide layout. Fidelity was judged at its intended native 1440 x 1024 desktop viewport, plus a separate 390 x 844 mobile pass.

final result: passed
