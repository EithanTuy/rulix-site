# Rulix Cloud Marketing Site Audit

Date: 2026-06-28
URL reviewed: http://127.0.0.1:4173/
Scope: Homepage desktop, mobile, key anchored sections, demo tabs, use-case tabs, FAQ accordion, and request-access section.

## Screenshots

- 01-desktop-top.png: desktop hero
- 02-desktop-product-demo.png: product demo section
- 03-desktop-fit-check.png: fit-check section
- 04-desktop-how-it-works.png: workflow overview
- 05-desktop-trust.png: defensibility section
- 06-desktop-use-cases.png: use-case tabs
- 07-desktop-request-access.png: request-access form
- 08-mobile-top.png: mobile hero
- 09-mobile-product-demo.png: mobile product demo
- 10-mobile-request-access.png: mobile request access
- 11-desktop-sample-review.png: credibility/sample-review section
- 12-desktop-security.png: security section
- 13-desktop-demo-resolve.png: demo tab interaction
- 14-desktop-usecase-universities.png: use-case tab interaction
- 15-desktop-faq-hallucination.png: FAQ accordion interaction

Note: 01-desktop-full.png was captured but rejected as primary evidence because the full-page stitch repeated fixed/animated sections.

## Step Health

1. Homepage hero: Strong aesthetic, clear product category, good immediate proof via UI video. Tone is confident, not overly pushy.
2. Product demo: Strongest section for explaining the product without jargon. The phrase "buyer question" is more internal than customer-facing.
3. Fit check: Very healthy. This is the best "is this made for us?" signal because it includes fit, boundary, and not-a-fit language.
4. How it works: Clear and plain enough. It explains the product better than a feature list.
5. Trust/defensibility: Strong. The human-judgment framing reduces regulatory anxiety and keeps the product from sounding like autonomous legal advice.
6. Use cases: Good indirect targeting. It lets legal, compliance, founders, operations, and universities self-identify without feeling boxed in.
7. Credibility/sample review: Needs cleanup before launch. Visible placeholder copy and a visible TODO currently undermine trust.
8. Security/privacy: Needs copy cleanup before launch. Current wording reads like internal caution notes, not a client-facing security posture.
9. FAQ: Helpful and appropriately cautious. The hallucination-risk answer is plain and reassuring.
10. Request access: Not too pushy, but the form could feel more approachable with one sentence about what happens after submission.
11. Mobile: Responsive layout works and avoids horizontal overflow. The nav is dense but usable; the stacked CTA layout feels acceptable.

## Findings

- Overall: The site is not too pushy. It is cautious, specific, and buyer-aware. The repeated "human judgment stays in control" boundary is the right move for this market.
- Aesthetic: The dark, technical, high-contrast look feels premium and serious. The real app visuals make it feel more credible than abstract marketing.
- Product clarity: The page explains Rulix best when it talks about gaps, evidence, reviewer actions, and review-ready records. It gets weaker when it leans on abstract terms like "defensible AI" without a nearby plain-language translation.
- Client fit: The fit-check and use-case sections do the indirect targeting well. They help a visitor recognize themselves without feeling called out or sold to.
- Ship blocker: Remove visible placeholder proof in the credibility section.
- Ship blocker: Rewrite the security paragraph so it does not expose internal uncertainty.
- Polish risk: "Short demos that answer the buyer question" sounds like internal positioning. A visitor-facing version would be "See what Rulix helps reviewers catch."
- Conversion risk: The request-access form opens a mail client. That is acceptable for an early gated beta, but higher-trust buyers may expect a normal confirmation or scheduling flow.

## Recommended Copy Direction

- Keep: "Rulix helps teams find gaps in reasoning, surface review risk, and turn draft memos into audit-ready decision records."
- Consider changing the hero headline to: "Review export-control memos with evidence-aware AI support."
- Consider changing product-demo title to: "See what Rulix helps reviewers catch."
- Replace the credibility placeholder with an unnamed proof-safe statement, such as: "Built around real export-control review patterns: scattered evidence, reviewer comments, unresolved assumptions, and final signoff."
- Replace the security intro with: "Rulix is designed for controlled review workflows: account-based access, review history, and clear data-boundary guidance for hosted workspaces."

## Evidence Limits

- This audit used screenshots, DOM inspection, and light interaction checks only.
- I did not submit the request-access form.
- I did not validate full WCAG compliance, live email behavior, backend delivery, analytics, or production deployment behavior.
