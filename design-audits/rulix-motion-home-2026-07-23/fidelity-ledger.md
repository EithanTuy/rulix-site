# Rulix motion homepage fidelity ledger

QA date: 2026-07-23

Reference concepts:

- `design/marketing/rulix-motion-home-hero-concept.png`
- `design/marketing/rulix-motion-review-loop-concept.png`

Verified implementation:

- `design-audits/rulix-motion-home-2026-07-23/desktop-full.png`
- `design-audits/rulix-motion-home-2026-07-23/mobile-full.png`
- `design-audits/rulix-motion-home-2026-07-23/review-loop.png`

## Fidelity points

1. The above-fold headline and supporting copy match the selected hero concept verbatim: “Review the reasoning. Keep the decision human.” and the reviewer-signoff paragraph.
2. The desktop hero preserves the concept’s left editorial copy/right product-media split, including the sans/Instrument Serif type contrast, teal primary action, outlined playback action, and glass navigation shell.
3. The hero uses the rendered product sequence instead of a static mockup, retaining the concept’s evidence zoom, cyan focus framing, dark product chrome, and human-decision label.
4. The review-loop section preserves the dark stage, oversized stacked headline, reviewer-safety statement, three-step chapter rail, and visible playback/sound/time controls.
5. The outcome section keeps the light editorial reset and three-part draft-to-decision progression, giving the motion section a clear visual boundary instead of repeating another dark panel.
6. At 390 × 844, the hierarchy reflows to one column, both calls to action remain reachable, the product renders retain a 16:9 frame, stages stack without horizontal overflow, and the mobile menu remains functional.

## Copy diff

No unintended above-fold copy differences remain between the selected hero concept and the implementation. Product chrome labels are implementation-only accessibility/context additions.

## Intentional deviations

- The generated concepts showed one frozen application state. The shipped media uses the final HyperFrames sequence, so the visible product state changes over time.
- The public 22.2-second reel is a web-optimized 1280 × 720 encode; the retained HyperFrames source can regenerate the 1920 × 1080 master.

## QA result

No blocking visual mismatch remains. Desktop and mobile DOM checks found no horizontal overflow or runtime console errors in a clean browser session.
