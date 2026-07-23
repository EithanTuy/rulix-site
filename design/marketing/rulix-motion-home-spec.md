# Rulix Motion Homepage Spec

## Accepted Concepts

- First viewport: `design/marketing/rulix-motion-home-hero-concept.png`
- Review-loop section: `design/marketing/rulix-motion-review-loop-concept.png`
- Motion source: `design/rulix-motion-reel-2026-07-23/`

## Allowed Above-the-Fold Copy

- Product
- Use Cases
- Trust
- Contact
- Sign in
- Review the reasoning.
- Keep the decision human.
- Rulix finds missing support in export-classification memos, ties every question to the source, and keeps signoff with a qualified reviewer.
- Request access
- Watch the review loop
- Reviewer workspace
- Human decision

No eyebrow, badge, metric, customer logo, certification, or additional visible hero claim is allowed.

## Section Order

1. Floating Rulix navigation.
2. Motion-led homepage hero.
3. Dark interactive review-loop section.
4. Existing outcome band, tightened to continue the review narrative.
5. Existing footer.

## Design Tokens

- Canvas: `#EFF7F6`
- Canvas highlight: `#FFFFFF`
- Heading: `#101719`
- Body: `#334448`
- Muted: `#516166`
- Reviewer surface: `#071014`
- Reviewer frame: `#050B12`
- Action: `#057F82`
- Active motion accent: `#74EEEF`
- Focus accent: `#0AAEB1`
- Dark-body text: `#CBD7D6`
- Hero radius: 30px media shell; 18–20px controls
- Media shadow: localized teal bloom plus one deep neutral shadow
- Motion timing: 160ms controls; 420–700ms section reveals; 22.2s product reel

## Typography

- Navigation, controls, body: Inter, 400–700.
- Hero display: Inter 800 for “Review the reasoning.”
- Human-judgment line: Instrument Serif 400 italic.
- Hero desktop: 76–92px, line-height 0.92–0.98.
- Hero mobile: 48–58px, line-height 0.94–1.
- Section heading: 54–64px desktop, 38–46px mobile.
- UI controls: 14–16px, explicit 650–700 weight.

## Media Treatment

- Hero media uses the short HyperFrames render inside the existing reviewer-cinema frame.
- The hero video receives no color wash; only edge light and an outer background bloom are allowed.
- Reduced-motion uses a generated HyperFrames poster frame and does not autoplay.
- The dark review-loop section uses the full narrated render with custom play/pause and sound controls.
- The interactive rail seeks the real video to the matching beat; it is not decorative.

## Component Inventory

- `MotionHomeHero`: asymmetric copy/media grid with two CTAs.
- `MotionProductFrame`: Rulix chrome, video/poster, focused media treatment.
- `ReviewLoopSection`: section copy, full reel, media controls, and three-stage seek rail.
- `ReviewLoopStageButton`: selected/hover/focus states; no pill treatment.
- Existing `SiteHeader`, `OutcomeBand`, and `SiteFooter` remain in the established visual system.

## Icon Inventory

- Primary CTA: Lucide `ArrowRight`, 18px, 2px stroke.
- Watch CTA: Lucide `Play`, 18px, 2px stroke.
- Media play/pause: Lucide `Play` / `Pause`, 17px, 2px stroke.
- Sound: Lucide `Volume2` / `VolumeX`, 17px, 2px stroke.
- No decorative icon row.

## Responsive Rules

- At 980px and below, hero becomes a single column with copy before media.
- At 720px and below, CTAs stack or wrap without shrinking text below 15px.
- Hero video remains 16:9 and never crops controls or product text.
- Review-loop copy stacks above media; the stage rail becomes a vertical list.
- Mobile motion defaults to muted playback and respects `prefers-reduced-motion`.
- No horizontal overflow at 390px.

## Core Interactions

- “Request access” opens the existing contact route.
- “Watch the review loop” scrolls to `#review-loop`.
- Stage buttons seek to 4.429s, 8.342s, and 16.128s.
- Play/pause and sound buttons update real video state and accessible labels.
- Video-end state returns to the first review stage.
