# Memo Builder design QA — concurrent conversation redesign

## Comparison target

- Product target: the latest `EithanTuy/rulix-site` signed-in Memo Builder, updated to use the calm, conversation-first interaction pattern in the supplied ChatGPT, Claude, and Codex references.
- ChatGPT source visual: `C:\Users\prana\Pictures\Screenshots\Screenshot 2026-07-23 094445.png` (`2542 × 1262` pixels).
- Claude source visual: `C:\Users\prana\Pictures\Screenshots\Screenshot 2026-07-23 094421.png` (`2556 × 1354` pixels).
- Codex source visual: `C:\Users\prana\Pictures\Screenshots\Screenshot 2026-07-23 094348.png` (`2552 × 1592` pixels).
- Final browser-rendered implementation: `C:\Users\prana\.codex\visualizations\2026\07\23\019f8f37-6dec-7a03-8aca-022425886559\implementation-empty-final.png` (`1280 × 720` pixels).
- Data recommendation state: `C:\Users\prana\.codex\visualizations\2026\07\23\019f8f37-6dec-7a03-8aca-022425886559\implementation-data-recommendation.png`.
- Plus-menu state: `C:\Users\prana\.codex\visualizations\2026\07\23\019f8f37-6dec-7a03-8aca-022425886559\implementation-plus-menu.png`.
- Generated-memo artifact state: `C:\Users\prana\.codex\visualizations\2026\07\23\019f8f37-6dec-7a03-8aca-022425886559\implementation-artifact.png`.
- Four-up full-view comparison: `C:\Users\prana\.codex\visualizations\2026\07\23\019f8f37-6dec-7a03-8aca-022425886559\comparison-full.png` (`1800 × 1420` pixels).
- Focused prompt/composer comparison: `C:\Users\prana\.codex\visualizations\2026\07\23\019f8f37-6dec-7a03-8aca-022425886559\comparison-focused.png` (`1800 × 1030` pixels).

The browser viewport was `1280 × 720` CSS pixels at device pixel ratio `2`; the in-app browser returned a normalized `1280 × 720` PNG. The source screenshots have different desktop chrome, density, theme, and application navigation, so the full captures were aspect-fit into equal comparison cards and the prompt/composer regions were separately cropped into equal `836 × 376` evidence regions. The comparison judges the shared conversation hierarchy rather than treating different product chrome as drift.

State: signed-in export-control officer, local application route `/app/#/memo-builder`, light theme for the final full-view capture. Dark theme was also opened and checked. Dynamic fixture chat titles differ intentionally from the static references.

## Full-view comparison evidence

- Layout and spacing: Rulix now shares the references' dominant centered prompt, wide integrated composer, generous task canvas, compact history navigation, and low-noise header. The existing Rulix primary navigation and recent-memo rail remain because they are product requirements, not a fidelity mistake.
- Typography: the repository's Inter product typography remains intact. The prompt uses a clear display scale, while history metadata, action hints, and quick choices use compact optical weights without competing with the primary task.
- Color and tokens: the implementation uses Rulix's existing navy, cool-gray, white, and teal tokens. Focus, selected-chat, recommendation, disabled, error, and dark-theme states are coherent and readable.
- Image and asset fidelity: the existing Rulix logo and Lucide icon family are used. No source asset was replaced with CSS art, custom SVG, emoji, placeholder illustration, or fake product imagery.
- Copy and content: the removed instruction paragraph and approval footer no longer crowd the empty state. Prompt text, choices, loading labels, data recommendations, retry messaging, and artifact actions are concise and specific to memo work.
- Affordances: the composer now has one obvious send action, Enter sends, Shift+Enter creates a line break, and the bottom-left plus opens attachments and data handling. Dynamic recommendations appear as a compact, accept-in-place suggestion.

## Focused region comparison evidence

The focused four-up comparison keeps each prompt, composer, and first-choice action readable. Rulix intentionally adds a two-by-two choice set beneath the composer because the requested workflow includes one-click answers and an `Other` path. The plus action occupies the same bottom-left composer position as ChatGPT and Claude, and the send action occupies the same bottom-right position as all three references.

The additional focused browser captures verify details too small in the full view:

- `implementation-data-recommendation.png`: recommendation hierarchy, source-based explanation, and one-click adoption.
- `implementation-plus-menu.png`: attachments, all five data boundaries, current selection, AI recommendation, and concise reviewer-signoff note.
- `implementation-artifact.png`: generated memo title, reviewer actions, review notes, section navigation, readable document surface, and follow-up composer.

## Primary interactions tested

- Created a new memo and verified an independent composer while another session could remain active.
- Enter sent the prompt; the user message stayed visible immediately and the chat title changed to `XA-2400 public datasheet`.
- The local provider was intentionally unavailable; the message remained visible, the session changed to `Needs attention`, and a clear `Try again` action appeared instead of losing the prompt.
- Opened the plus menu and checked attachments, current data-class selection, recommendation, and reviewer-signoff explanation.
- Opened an existing generated memo and verified the artifact, Copy, Download, Add to Reviews, Add & Analyze, review notes, and follow-up composer.
- Opened light and dark themes.
- Checked browser logs after the interaction sequence: no console warnings, console errors, or framework error overlay. Vite development notices were the only entries.

Automated interaction coverage additionally verifies the real loading interval, immediate optimistic message, Enter/Shift+Enter behavior, two simultaneous memo requests, session-specific completion, automatic titles, data recommendation controls, generated artifacts, copy/download, and create/analyze actions.

## Comparison history

### Iteration 1

- [P2] Quick-start labels were compressed into a single four-card row at the browser's `1280 × 720` viewport.
  - Evidence: the first browser capture truncated `Show me an example` and secondary labels, making the requested guided choices harder to scan.
  - Fix: changed the desktop quick-start layout to a balanced two-column grid while retaining a one-column mobile layout.
  - Post-fix evidence: `implementation-empty-final.png`, `comparison-full.png`, and `comparison-focused.png` show complete labels with consistent spacing and no clipping.

### Final comparison

No actionable P0, P1, or P2 mismatch remains. The extra quick choices, Rulix application chrome, and light-theme final capture are intentional product differences; they preserve the interaction hierarchy of the references while satisfying the requested guided memo workflow.

## Findings

No actionable P0/P1/P2 findings.

## Open questions

None.

## Implementation checklist

- [x] Keep sent messages visible immediately.
- [x] Send with Enter and reserve Shift+Enter for line breaks.
- [x] Give every memo an independent request state and background status.
- [x] Update conversation titles from the first meaningful context.
- [x] Keep completed memo artifacts visible with reviewer actions.
- [x] Consolidate attachments and data handling behind the plus button.
- [x] Present data recommendations and suggested answers as easy one-click choices.
- [x] Add reduced-motion-aware AI drafting glow and progress treatment.
- [x] Verify the full repository test suite, production build, browser interactions, and visual comparison.

## Follow-up polish

- [P3] The small Rulix sparkle mark adds more brand presence than the nearly unadorned ChatGPT prompt. It is consistent with the existing product and does not compete with the task, so no change is recommended.

final result: passed
