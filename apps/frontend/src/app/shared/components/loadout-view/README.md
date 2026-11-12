# Loadout view

## Overview

`app-loadout-view` shows a build's equipment read-only as compact slot rows. It replaces the 3x3 paper doll wherever a loadout is only being read: the composition roster, the inspect dialog, and (in phase 2) the build page.

## Interface

- Selector: `app-loadout-view`. No outputs, no content projection.
- Inputs:
  - `items: readonly BuildItemSlot[] | null | undefined` - the build's items with both loadouts mixed, exactly as `BuildDetail.items` delivers them. An item without `loadout` is treated as `main`.
  - `loading: boolean` (default `false`) - shows a busy skeleton (`aria-busy`, `role="status"` with a screen-reader label) instead of rows.
  - `unavailable: boolean` (default `false`) - the detail request failed; shows a short message.
- Layout is driven by container queries, not the viewport: the swap sits beside the main set when the component's own container is at least 40rem wide and stacks below it otherwise; a section's rows are one line (slot, icon, name, spells) when the section is at least 28rem wide and two lines when narrower.

## Invariants

- Slot order is weapon, off-hand, head, armor, shoes, cape, bag, food, potion, mount. Optional slots with no item are omitted; the core slots (weapon, head, armor, shoes) of the main set show "Not set" when empty. An empty `items` shows an empty message.
- A row is the item icon (falls back to the first letter of the item name if the image fails), the item name, the tier written like the game (`T8.3`, `T6`, never `TT8`) and the quality as text only when it is not the guild default (Excellent) and the slot has quality at all (not food, potion, mount).
- Swap shows only the slots the swap defines, under a "Swap" heading with a hint, and each row says which main item it replaces. It never renders the empty slots.
- Chosen spells are small icon buttons with `aria-label="Q: Spell name"` (key, then name; `Passive` for passives). The name is visible on hover, on keyboard focus and after a tap or click (pinned until blur, a second tap or Escape), so it is not mouse-only. A spell image that fails shows its key letter.
- Spell names come from the shared ability catalog (`AlbionAbilitiesService`, one cached fetch for the session). An id the catalog does not know is shown as the id.
- All text goes through the `loadout.*` and `equipment.slot.*` translation keys.

## Side Effects

Calls `AlbionAbilitiesService.load()` once on creation (cached, static data). It performs no other I/O.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
