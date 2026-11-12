# Equipment grid

## Overview

The build detail page now edits with `app-loadout-editor` (see its README); this grid remains for read views and for the New build dialog until that dialog moves to the editor.

`EquipmentGrid` is a reusable Albion equipment paper-doll and item picker for build authoring and detail views. The parent owns search and selection state; the grid forwards interactions.

## Interface

The documented contract covers the item list, management mode, editing slot, draft tier/search/item selection, results/loading, and ability slots. Outputs forward slot toggling, picker edits, save/cancel/remove actions, and ability choices. The source example is not a complete type-level interface inventory.

## Invariants

- The ten slots are presented in a fixed order: bag, head, cape, weapon, armor, off-hand, potion, shoes, food, mount.
- The template labels the grid as an Equipment group. Picker results are a group of `aria-pressed` buttons, not a listbox.
- The tier, enchantment and quality selects show the draft values. Slot order and labels come from `features/comps/build-loadouts.ts`.
- Results show the tier (for example T8), never the raw catalogue identifier.
- The source describes interaction ownership as parent-controlled rather than grid-owned persistence.

## Side Effects

The grid emits interaction events and updates local picker presentation; no API or storage operation is documented in its scanned source portion.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The scan exceeded the 300-line cap because the reader returned the full source; findings are limited to lines 1–300.
