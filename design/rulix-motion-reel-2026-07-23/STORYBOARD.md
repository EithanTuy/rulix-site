# Rulix Review Loop Storyboard

**Format:** 1920×1080, 30fps, 22.20 seconds
**Audio:** Local neural voiceover; no music bed so the website can use the reel muted without losing the story
**VO direction:** Calm, precise, mid-register delivery; trusted reviewer rather than announcer; short pauses carry authority
**Style basis:** `DESIGN.md` and the captured Rulix marketing/product system

## Global Direction

- Start in motion. The viewer is already moving toward a real review workspace before the first line finishes.
- The product capture is the hero asset in every beat. Text explains the consequence; it never replaces the product.
- Camera movement must end on a specific review artifact: the memo, a highlighted evidence gap, a reviewer question, or the audit record.
- Use `#74EEEF` focus light as the visual thread connecting all four beats.
- Preserve the product’s human-review boundary. AI help is shown as orientation and gap-finding, never autonomous signoff.
- Use three techniques per beat: screenshot compositing with controlled camera scale, SVG focus/connector drawing, and kinetic typography or mono annotation motion.
- Use cinematic zoom/focus-pull transitions for three related handoffs. The final handoff resolves to stillness.

## Asset Audit

| Asset | Type | Assign to Beat | Role |
| --- | --- | --- | --- |
| `capture/assets/product/01-review-queue-and-memo.png` | Product capture | Beat 1 | Full reviewer workspace; establishes the memo and human-controlled review |
| `capture/assets/product/03-analysis-evidence-map.png` | Product capture | Beat 2 | Evidence-map state and first precise camera zoom |
| `capture/assets/product/05-decision-review-gap.png` | Product capture | Beat 3 | Reviewer question/evidence checklist and second camera zoom |
| `capture/assets/product/07-export-ready.png` | Product capture | Beat 4 | Audit trail and preserved reviewer decision |
| `capture/assets/svgs/logo-b2ef4711.svg` | Brand logo | Beats 1 and 4 | Brand anchor at opening and close |
| `capture/assets/svgs/svg-7da9c459.svg` | Direction glyph | Beats 2 and 3 | Small directional accent only |

All four product captures are used. The Rulix mark appears in the opening and closing beat. No captured product screenshot is left static: every one receives a parent entrance plus child camera movement.

## BEAT 1 — THE REVIEW CAN STILL FAIL (0.00–4.429s)

**VO:** “Your memo can reach the right answer and still fail review.”

### Concept

We begin halfway through an approach toward a dark reviewer workspace suspended over the pale Rulix canvas. The memo is already visible, but the camera has not settled; the line creates tension between having an answer and being able to defend it. The scene should feel like entering a review room moments before a decision.

### Visual

- Pale `#EFF7F6` canvas with two restrained cyan contour arcs at the edges.
- Small Rulix mark top-left with a mono `REVIEW / 00:00` label.
- Large split headline on the left: “The answer isn’t the record.” The serif word “record” arrives last.
- The full reviewer workspace fills the right 62% of frame inside a dark cinema shell.
- A cyan focus reticle draws around the memo area while a thin connector travels toward a small annotation: “Draft state · reviewer controlled.”
- A second depth plane, cropped from the same capture, sits slightly closer and shows the memo title.

### Mood

Editorial opening credits crossed with a secure review room. Controlled, not ominous.

### Assets

- `capture/assets/product/01-review-queue-and-memo.png` — full product plane, camera scale 1.00→1.045.
- `capture/assets/svgs/logo-b2ef4711.svg` — top-left brand anchor.

### Animation Choreography

- Background contour rules DRAW from opposite edges.
- Logo and mono label SNAP into alignment with different eases.
- Headline words CASCADE from left with decaying travel distance.
- Product shell APPROACHES from slight scale/rotation, then settles.
- Focus reticle DRAWS, connector line TRACES, annotation locks in.
- Inner screenshot PUSHES slowly toward the memo title through the hold.

### Transition

Primary cinematic zoom at 3.979s: the focus reticle becomes the aperture. The outgoing product plane remains visible while the next evidence view scales up through it over 0.45s using `power3.inOut`.

### Depth Layers

BG: mist canvas + contour arcs.
MG: full product cinema shell.
FG: cropped memo plane, reticle, connector, annotation.

### SFX

No added SFX. The pause after “answer” should be allowed to read.

## BEAT 2 — FIND THE MISSING SUPPORT (3.979–8.342s; VO begins 4.429s)

**VO:** “Rulix finds the missing support inside the source.”

### Concept

The previous reticle lands directly on a real highlighted memo passage. The viewer moves from the broad workspace into the exact evidence, then pulls back just enough to see the evidence map explain why it matters. This is the product’s core proof moment.

### Visual

- Ink-dark `#071014` canvas with the product capture nearly full frame.
- The left third of the capture is clipped away; the memo and analysis panel dominate.
- An oversized “inside the source” statement anchors the lower-left edge.
- The evidence highlight receives a cyan outline, then a numbered point illuminates.
- A compact side annotation states: “Missing support, tied to this passage.”
- A mono data rail shows `SOURCE → GAP → REVIEW`.
- A faint cyan scan travels once across the selected passage.

### Mood

Forensic clarity. Think a film editor’s precision, not a cybersecurity dashboard.

### Assets

- `capture/assets/product/03-analysis-evidence-map.png` — fill the frame; start zoomed into the memo evidence, settle to show the analysis panel.
- `capture/assets/svgs/svg-7da9c459.svg` — directional accent within the mono rail.

### Animation Choreography

- Product capture ARRIVES through the previous reticle.
- The camera PUSHES from 1.13→1.02, changing object position from the highlighted memo to the evidence map.
- Headline words STAMP in one at a time along the lower edge.
- Evidence outline DRAWS; numbered point PULSES once.
- Connector line TRACES to the annotation.
- Mono rail TYPES on in three decisive steps.
- Scanner SWEEPS once and stops; no looping.

### Transition

Cinematic pan/zoom at 7.892s. The evidence connector continues moving right and pulls the next scene into view over 0.45s. No independent element exits before the transition.

### Depth Layers

BG: near-black surface + restrained teal bloom.
MG: full product capture.
FG: evidence outline, connector, annotation, mono rail.

### SFX

None. Let the voice line and visible highlight carry the beat.

## BEAT 3 — TURN THE GAP INTO REVIEW WORK (7.892–16.128s; VO begins 8.342s)

**VO:** “It turns each gap into a reviewer question, keeps every response tied to the evidence, and preserves the final call.”

### Concept

The scene widens into the review checklist. Evidence points become an ordered rail of decisions rather than a cloud of AI commentary. The camera visits one question, follows its connector back to the memo, then glides forward to the reviewer-owned action.

### Visual

- Full dark canvas with the product capture occupying the right 70%.
- Large left headline: “A gap becomes a decision path.”
- Three stacked stages sit below it: `01 Question`, `02 Evidence`, `03 Reviewer action`.
- The real evidence map is readable in the capture; one selected item is enlarged in a floating crop.
- A cyan connector bridges the floating crop back to the memo passage.
- Amber is present only on the real “needs support” state.
- A narrow human-review line remains visible throughout: “Reviewer chooses the path.”

### Mood

Operational calm. The choreography is sequential and deliberate, like a complex decision becoming tractable.

### Assets

- `capture/assets/product/05-decision-review-gap.png` — main product plane and evidence checklist.
- `capture/assets/svgs/svg-7da9c459.svg` — stage-rail direction marker.

### Animation Choreography

- Scene plane GLIDES in from the right with a slower, heavier entrance than Beat 2.
- Headline BUILDS in two typographic registers.
- Stage labels CASCADE vertically with a 110ms rhythm.
- Active stage bar FILLS from left to right.
- Floating selected-question crop LIFTS off the product plane in shallow 3D.
- Connector line DRAWS back to the memo.
- Camera PANS from the checklist to the selected passage while the crop remains foregrounded.
- Human-review line FADES in last, establishing hierarchy by time.

### Transition

Focus pull at 15.678s. The selected crop sharpens while the rest of the scene blurs, then the audit-record scene replaces it over 0.45s with `sine.inOut`.

### Depth Layers

BG: deep frame + slow localized glow.
MG: real product capture.
FG: stage rail, floating question crop, connector, human-review line.

### SFX

None. A short natural pause before the final two sentences is the transition cue.

## BEAT 4 — THE DECISION STAYS HUMAN (15.678–22.20s; VO begins 16.128s)

**VO:** “AI surfaces the gap. A qualified person decides.”

### Concept

The motion resolves into an audit view with no visual ambiguity about authority. A thin path links the memo, completed analysis, and reviewer decision. The final statement holds long enough to become the thesis of both the reel and the redesigned homepage.

### Visual

- The audit-trail product capture sits inside a clean white frame over `#071014`.
- Three audit events illuminate in sequence: memo pasted, analysis completed, reviewer decision.
- Large statement at left: “AI surfaces the gap.” followed by the Instrument Serif line “A qualified person decides.”
- The Rulix mark returns beside `REVIEW RECORD / COMPLETE`.
- A compact status plate reads `HUMAN SIGNOFF REQUIRED`.
- The final 0.9s holds with product, statement, and logo fully visible.

### Mood

Definitive and quiet. The last frame should feel like a conclusion, not another feature card.

### Assets

- `capture/assets/product/07-export-ready.png` — audit record and final-state product proof.
- `capture/assets/svgs/logo-b2ef4711.svg` — closing brand anchor.

### Animation Choreography

- Product frame EMERGES from the focus pull with blur clearing over 0.65s.
- Audit events LIGHT in chronological order.
- Connector path DRAWS through all three events.
- First statement SLIDES into place with precision.
- Serif conclusion RISES slowly and settles.
- Status plate STAMPS in once.
- Logo and completion label FADE in together.
- Final scene alone may soften to 92% opacity during the last 0.25s; no other scene performs an exit.

### Transition

Final hold, then restrained dip toward `#050B12` during the last 0.25s.

### Depth Layers

BG: reviewer-night canvas + subtle teal edge light.
MG: audit-record product frame.
FG: timeline connector, statements, status plate, closing mark.

### SFX

No added SFX. End on the natural finish of “decides.”

## Production Architecture

```text
rulix-motion-reel-2026-07-23/
├── index.html
├── DESIGN.md
├── SCRIPT.md
├── STORYBOARD.md
├── narration.txt
├── narration.wav
├── transcript.json
├── capture/
│   ├── screenshots/
│   ├── assets/
│   │   ├── product/
│   │   └── svgs/
│   └── extracted/
├── compositions/
│   ├── beat-1-review-failure.html
│   ├── beat-2-source-gap.html
│   ├── beat-3-decision-path.html
│   └── beat-4-human-decision.html
├── snapshots/
└── renders/
```
