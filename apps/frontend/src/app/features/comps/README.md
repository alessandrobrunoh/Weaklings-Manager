# Compositions and builds

## Overview

This directory groups the build/composition workspace components with helpers for loadouts, party layouts, composition trees, creator grouping, and version comparison.

## Interface

- `Builds` and `Compositions` delegate to `Comps` with different `page` values.
- `CompDetailPage` (`comp-detail.ts`) is the `/comps/:id` page: an `app-entity-header` summary (key numbers, one Edit/Done action, an overflow menu) over three views, Roster, Parties and Analytics. `CompAddBuildDialog` (`comp-add-build-dialog.ts`) is its single "Add build" surface (inputs `assignedIds`, `saving`; outputs `add`, `closed`).
- `build-loadouts.ts` is the single source of truth for slots: `SLOT_ORDER`, `SLOT_LABEL_KEYS`, `CORE_SLOTS`, `BUILD_ITEM_TIERS`, quality/enchantment support and item selection helpers; `comp-parties.ts` exposes party view types, `simulateCompParties`, `groupPartySeats` (seats of one party grouped by build) and `partyRoleMix`.
- `comp-tree.ts` exposes forest construction/filtering/flattening; `version-diff.ts` returns grouped added/removed/changed entries with per-token before/after (item, ability, quality, version, quantity), and matches a composition's builds by lineage so v1 to v3 is one line; `group-by-creator.ts` groups builds by creator.

## Invariants

- On the detail page build loadouts are fetched lazily, the first time a row is expanded or a party line inspected, and cached for the page's lifetime. Editing is one mode: quantity steppers save after a short pause, removal and addition refresh the composition in place, and toasts use translated text only.
- Items without a loadout are treated as `main` and sorted by the declared slot order.
- Party simulation expands quantities, sorts by role order, and chunks into parties of 20 by default.
- Tree construction sorts deterministically, recovers missing/cyclic parent links, and filtering retains ancestor paths.
- Version comparison identifies build slots across loadouts and compares composition entries by build name and version.

## Side Effects

Inspected helper functions build local arrays/maps/sets and perform no I/O. The two thin wrapper components delegate their page rendering to `Comps`.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The composition detail page and add-build dialog have component specs (`comp-detail.spec.ts`, `comp-add-build-dialog.spec.ts`).
