# Rulix frontend design system

The reviewer app and operator dashboard share Rulix's navy/teal identity while preserving different jobs: the app is a task-focused review workbench; the dashboard is an operator control room.

## Visual foundations

- Deep navy (`--px-navy`) anchors global navigation and creates strong separation from work surfaces.
- White and cool-gray surfaces use thin blue-gray borders. Teal is reserved for active state, progress, primary action, focus, and trustworthy status—not decoration.
- Typography uses the existing Inter/Instrument Serif assets. Product UI remains dense, left aligned, and readable; marketing typography is not changed.
- Cards use restrained radii, no ornamental gradients, and minimal shadows. Contrast and hierarchy come from surfaces, borders, type weight, spacing, and state color.
- Icons come from the existing Lucide library and brand marks. Do not substitute emoji, text symbols, inline SVG approximations, or decorative icon boxes.

## Shared interaction primitives

Use the existing shell, header, action bar, table, filters, progress path, banner, skeleton, dialog, drawer, toast, empty/error state, and context-menu patterns before adding a new variant.

- Every interactive element has a visible hover, pressed, disabled, and `:focus-visible` state.
- Context menus clamp to the viewport, close on outside click, Escape, blur, resize, user scroll, and route change, and expose arrow-key navigation.
- Shortcut labels adapt to Command on Apple platforms and Ctrl elsewhere.
- Destructive audited actions require explicit confirmation. Safe reversible actions should expose undo where supported by the underlying command.
- Loading, empty, offline, permission, conflict, expired approval, partial result, and destructive states must be designed—not represented by a generic blank panel.

## Responsive behavior

- `1440px`: persistent sidebar and three-pane review workbench.
- `768px`: compact global header, drawer navigation, task tabs, stacked workbench cards.
- `390px`: touch targets remain usable, progress and tabs scroll horizontally, metadata moves behind the review action menu, and content reflows without horizontal page overflow.

Marketing pages remain visually unchanged; product styles must stay under product-specific class names.
