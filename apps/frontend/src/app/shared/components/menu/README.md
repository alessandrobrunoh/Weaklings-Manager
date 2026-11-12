# Menu

## Overview

`app-menu` is the shared overflow ("more actions") menu: the menu button of a page header, a list or table row and a card. It generalizes the old comps `RowMenu` and the menu inside `app-entity-header`, which now both use it. Secondary actions go here; the one primary action stays a visible button.

## Interface

- Selector `app-menu`. Inputs: `items: readonly MenuItem[]` (default `[]`), required `label` (accessible name of the menu, and of the trigger when it has no visible text; say which row or page it belongs to), `triggerLabel` (visible text for a labelled trigger such as "Export"; omit for the icon-only button), `appearance: 'ghost' | 'outline'` (default `ghost`; `outline` sits next to a primary button), `align: 'end' | 'start'` (default `end`).
- `MenuItem`: `{ id, label, icon?, danger?, disabled?, separatorBefore? }`. Labels must already be translated.
- Output `itemSelect: string`, the `id` of the chosen entry.

## Invariants

- Renders nothing when `items` is empty.
- WAI-ARIA menu button: trigger has `aria-haspopup="menu"`, `aria-expanded` and `aria-controls` (while open); the panel is `role="menu"` with `role="menuitem"` buttons outside the Tab order. ArrowDown/ArrowUp move (wrapping, skipping disabled entries), Home/End jump, ArrowDown/ArrowUp on the trigger open on the first/last entry, Escape closes and returns focus to the trigger, choosing an entry closes and returns focus, Tab or a click outside closes.
- The panel is `position: fixed`, placed from the trigger rectangle, so a scrolling table wrapper or card cannot clip it. It flips upwards near the viewport bottom and closes on any scroll or window resize.
- Destructive entries (`danger`) use the error colour, go last and use `separatorBefore`; the label, not the colour, says what they do.

## Side Effects

Listens to document clicks, window resize and (while open) captured document scroll events. Focuses an entry after the panel renders. No network or storage access.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
