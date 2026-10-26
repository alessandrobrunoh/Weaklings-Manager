# Equipment grid

## Overview

`EquipmentGrid` is a reusable Albion equipment paper-doll and item picker for build authoring and detail views. The parent owns search and selection state; the grid forwards interactions.

## Interface

The documented contract covers the item list, management mode, editing slot, draft tier/search/item selection, results/loading, and ability slots. Outputs forward slot toggling, picker edits, save/cancel/remove actions, and ability choices. The source example is not a complete type-level interface inventory.

## Invariants

- The ten slots are presented in a fixed order: bag, head, cape, weapon, armor, off-hand, potion, shoes, food, mount.
- The template labels the grid as an Equipment group and picker results as a listbox.
- The source describes interaction ownership as parent-controlled rather than grid-owned persistence.

## Side Effects

The grid emits interaction events and updates local picker presentation; no API or storage operation is documented in its scanned source portion.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The scan exceeded the 300-line cap because the reader returned the full source; findings are limited to lines 1–300.
