# Rulix Motion Design System

## Overview

Rulix pairs a pale mineral-teal marketing canvas with an ink-dark reviewer workspace. The website uses oversized editorial headlines, restrained glass framing, and real product captures to keep the work credible. The motion reel pushes the same system into a cinematic review-room sequence: broad light-to-dark contrast, evidence-linked zooms, and one decisive human-review payoff.

## Colors

- **Mist Canvas**: `#EFF7F6` — primary light marketing surface.
- **Paper White**: `#FFFFFF` — product documents and high-contrast content.
- **Headline Ink**: `#101719` — display typography on light scenes.
- **Reviewer Night**: `#071014` — cinematic product-proof surface.
- **Deep Frame**: `#050B12` — media chrome and final title scene.
- **Action Teal**: `#0AAEB1` — primary action and active-review state.
- **Electric Teal**: `#74EEEF` — focus ring, scan line, and motion accent.
- **Body Slate**: `#516166` — supporting copy on light scenes.
- **Conflict Amber**: `#D98A00` — review-needed state only.
- **Conflict Red**: `#E34450` — blocking claim state only.

## Typography

- **Editorial display**: Instrument Serif, weight 400. Use sparingly for the human-judgment phrase and large transition words.
- **Technical voice**: IBM Plex Mono, weights 500-700. Use for scene numbers, evidence labels, timecode, and small interface annotations.
- **Display scale**: 96-148px for hero statements, with tight tracking and short lines.
- **Body scale**: 28-36px for narration support; never below 20px in rendered motion.
- **Data**: use tabular numerals for timestamps, counts, and review-state labels.

## Elevation

The light site uses broad atmospheric blur, edge-lit glass, and low-contrast teal shadows. Product proof shifts to crisp 1px borders over `#071014`, with a bright inner rim around the captured interface and localized teal bloom behind the current point of focus. Depth comes from overlapping screenshot planes, foreground evidence markers, and controlled camera scale rather than stacked cards.

## Components

- **Floating Glass Navigation**: a wide translucent header with a fine cyan edge and restrained shadow.
- **Reviewer Cinema Frame**: a dark rounded shell containing the real Rulix capture, status line, and human-decision label.
- **Evidence Focus Ring**: animated reticle and connector line that identifies the exact memo passage or reviewer state before the camera moves in.
- **Decision Rail**: three concise review stages connected by one hairline path; the active stage receives teal light.
- **Human Signoff Card**: compact final-state panel that separates AI assistance from the qualified person’s decision.
- **Proof Transcript**: mono labels and timecode that make the motion feel auditable, not decorative.

## Do's and Don'ts

### Do's

- Preserve the light mist canvas and ink-dark product proof contrast.
- Use the real captured product UI as the dominant visual asset.
- Let camera moves terminate on a specific evidence, gap, or decision state.
- Use teal for orientation and amber/red only when the product is showing real review risk.
- Keep human signoff visually and narratively authoritative.

### Don'ts

- Do not invent certifications, autonomous decisions, customer metrics, or legal outcomes.
- Do not use generic dashboard cards, bright rainbow gradients, or playful particles.
- Do not blur the product interface so heavily that its evidence trail becomes unreadable.
- Do not turn every scene into the same centered text-plus-screenshot layout.
- Do not use uncontrolled infinite animation, randomized motion, or fake app interactions.
