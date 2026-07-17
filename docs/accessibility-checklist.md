# Frontend accessibility checklist

Run this checklist for both `/app` and `/dashboard` at 390, 768, and 1440 pixels.

- [ ] One visible `h1`; heading levels describe the page structure.
- [ ] Header, navigation, main, complementary, dialog, menu, and status landmarks have useful names.
- [ ] All controls have accessible names after responsive labels are visually hidden.
- [ ] Keyboard order follows the visual task order; no keyboard trap exists.
- [ ] Focus is visible at 3:1 or better and is restored when dialogs/drawers close.
- [ ] Command search, drawers, tabs, menus, tables, filters, comments, and destructive confirmations work without a pointer.
- [ ] Context menus support Escape and Arrow Up/Down and close on viewport/navigation changes.
- [ ] Text and essential icons meet WCAG AA contrast; status is never communicated by color alone.
- [ ] Content reflows at 320 CSS pixels and 400% zoom without losing actions or meaning.
- [ ] Touch targets are at least 44 by 44 CSS pixels where space permits.
- [ ] Loading, empty, error, offline, permission, and conflict states are announced and actionable.
- [ ] Reduced-motion removes nonessential transitions; no flashing content is introduced.
- [ ] Tables preserve headers/cell relationships and provide a useful small-screen representation.
- [ ] Axe reports no critical violations; keyboard, screen-reader landmark, zoom, contrast, and reduced-motion checks are manually sampled.

Automated coverage lives in `e2e/rulix-smoke.spec.ts` and runs all four roles across the three target widths while collecting console, page, and request failures.
