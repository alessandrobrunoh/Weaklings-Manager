# Entity header

## Overview

`app-entity-header` is the header of a detail page (a composition, a build): title, meta line, one primary action, an overflow menu for secondary actions and an optional band of key numbers. It replaces the row of eight equal buttons the detail pages used to have.

## Interface

- Selector: `app-entity-header`.
- Inputs: required `title` (rendered as the page `h1`); `description` (optional free text under the meta line); `menuItems: readonly EntityMenuItem[]` (default `[]`); `menuLabel` (accessible name of the menu button and menu, default `More actions`, pass a translated string).
- `EntityMenuItem`: `{ id, label, icon?, danger?, disabled?, separatorBefore? }`. Labels must already be translated.
- Output: `menuSelect: string`, the `id` of the chosen entry.
- Content projection (all optional, matched by attribute):
  - `[entityBadges]` - small status chips right after the title (Archived, Shared with alliance).
  - `[entityMeta]` - the meta line (version switcher, category, author, date). Project one wrapper element (for example a `div` with `entityMeta`) that holds the facts; the page lays the facts out inside it as a wrapping row.
  - `[entityPrimary]` - the single primary action, normally `<button class="btn btn--primary">`.
  - `[entitySummary]` - a band of key numbers below the title, separated by a hairline; hidden when empty.

## Invariants

- There is at most one primary action; everything else belongs in the menu. The menu button is not rendered when `menuItems` is empty.
- The menu is an accessible menu button: the trigger has `aria-haspopup="menu"`, `aria-expanded` and `aria-controls` (while open); the panel is `role="menu"` with `role="menuitem"` buttons that are not in the Tab order. ArrowDown/ArrowUp move (wrapping, skipping disabled entries), Home/End jump, ArrowDown/ArrowUp on the trigger open it focusing the first/last entry, Escape closes and returns focus to the trigger, choosing an entry closes and returns focus to the trigger, Tab or a click outside closes.
- Destructive entries (`danger`) use the error colour and are meant to be placed last with `separatorBefore`; the label, not the colour, says what they do.
- Layout wraps instead of overflowing: on a phone the title takes the first row and the primary action and the menu button sit to its right or wrap below it.

## Side Effects

Listens for document clicks while open to close the menu; it focuses elements after the menu renders. No network or storage access.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
