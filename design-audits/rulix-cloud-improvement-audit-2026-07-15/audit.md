# Rulix Cloud Improvement Audit

Date: 2026-07-15

Surface: local marketing site at `http://127.0.0.1:4173/`

User goal: understand the product, trust the review boundary, inspect proof, and request access.

Accessibility target: clear responsive reflow, readable form controls, keyboard-accessible states, and understandable feedback.

## Overall verdict

The visual direction is strong and distinctive. The highest-value work is now conversion and reassurance rather than another redesign. No critical visual break was found. Two high-impact issues remain: the access form depends on a mail client, and the mobile access jump places a long FAQ before the first field.

## Flow steps

1. Landing entry - healthy. The editorial headline, product proof, review-path rail, and two CTAs create a clear hierarchy. Evidence: `01-landing-entry.jpg`.
2. Product proof - healthy with one behavior risk. The real workspace media and outcome labels are credible, but the selected demo continues auto-rotating every six seconds while the visitor reads. Evidence: `02-product-proof.jpg`.
3. Trust and reassurance - visually healthy, content needs more specificity. The human-signoff boundary is clear, but the section does not yet answer concrete procurement questions such as retention, encryption, model-training use, hosting region, or deletion. Evidence: `03-trust-and-safety.jpg`.
4. Desktop request access - needs improvement. The form is attractive and validation focuses the first missing field, but a completed submission opens `mailto:` rather than reliably capturing the lead and providing inline success or failure. Evidence: `04-request-access.jpg`.
5. Mobile entry - healthy. The headline, CTAs, product media, and navigation reflow cleanly with no horizontal overflow at 390 x 844. Evidence: `05-mobile-entry.jpg`.
6. Mobile request access - needs improvement. The jump lands at the section title, with the FAQ consuming most of the first viewport before the first input. The mobile page is 9,405px tall and the conversion section is about 1,336px tall. Evidence: `06-mobile-request-access.jpg`.

## Strengths

- Strong, ownable Instrument Serif and Rulix teal identity.
- Real product recordings make the experience more credible than generic software mockups.
- Clear separation between software assistance and human judgment.
- Semantic tab, accordion, pressed, expanded, and label structures are present.
- Desktop and mobile screenshots showed no horizontal overflow or console errors.
- Focus and native required-field validation are visible and functional.

## Priority improvements

### P1 - Replace the mail-client submission

Send the access request to a real application endpoint or lead service. Add pending, success, and error states; preserve entered values after failure; give fields stable names and autocomplete hints; and show the expected reply window. The current mail-client handoff can fail silently when no mail client is configured.

### P1 - Put the form first on mobile

On small screens, place the form before the FAQ or anchor directly to the first form field. Keep one short reassurance line beside the CTA and move FAQs below the submission path.

### P2 - Give visitors control over demo motion

Stop automatic tab rotation after any manual interaction, pause when the section is not visible, and consider a visible pause control. The audit observed the selected story change while the proof section was being read.

### P2 - Make trust claims concrete

Replace one or two principle-only rows with verified facts about data retention, encryption, model-training use, deletion, and hosting. Link the section directly to the security page. Do not add claims that cannot be substantiated.

### P2 - Shorten the mobile journey

The mobile page is over 9,400px tall. Compress repeated explanation across Product, Review loop, Comparison, and Fit check. A sticky or scroll-linked product story could preserve interactivity while reducing repetition.

### P2 - Improve form readability

Computed mobile form labels are 11px and inputs are 12px. Placeholder contrast measured about 4.05:1 against the dark field, below the 4.5:1 target for normal text. Raise labels to 13-14px, input text to 16px, and placeholder contrast above 4.5:1; 16px also avoids Safari focus zoom.

### P3 - Add one tangible proof artifact

Offer a downloadable sample review record or an annotated public memo. This would make the output concrete without inventing testimonials or customer logos.

## Evidence limits

- The completed mailto flow was not triggered because that would open an external application.
- Screenshots and DOM structure do not establish full WCAG compliance; a dedicated keyboard and screen-reader pass is still needed.
- This audit covered the local build, not production hosting, analytics, or real lead delivery.
