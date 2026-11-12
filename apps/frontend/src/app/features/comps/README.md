# Compositions and builds

## Overview

This directory groups the build/composition workspace components with helpers for loadouts, party layouts, list/filter/sort models, create-flow models, creator grouping, and version comparison.

## Interface

- `Builds` and `Compositions` delegate to `Comps` (`comps.ts`) with different `page` values. `Comps` is a thin shell: header, a List / Categories tab toggle, and the create dialogs.
- `CompsList` and `BuildsList` are dense sortable tables (rows are one stretched link to the detail page, with the shared overflow `app-menu`). They share `ListFilterBar` (built on the shared `app-filter-bar`), `list-table-styles.ts` and `ListArchiveDialog`; filtering, grouping, role mix and sorting live in `comps-list-model.ts`. The comps list loads win rate and role mix per row (two requests each, six at a time); the builds list folds older versions under the latest.
- `CompCategories` (`comp-categories.ts`) manages categories of either kind; a delete refused with 409 is explained inline.
- `CompCreateDialog` and `BuildCreateDialog` are the New composition / New build flows. Their pure rules (totals, duplicate and version warnings, validation, role carry-over when copying a build) are in `comp-create-model.ts` and `build-create-model.ts`.
- `CompDetailPage` (`comp-detail.ts`) is the `/comps/:id` page: an `app-entity-header` summary (key numbers, one Edit/Done action, an overflow menu) over three views, Roster, Parties and Analytics. `CompAddBuildDialog` (`comp-add-build-dialog.ts`) is its single "Add build" surface (inputs `assignedIds`, `saving`; outputs `add`, `closed`).
- `build-loadouts.ts` is the single source of truth for slots: `SLOT_ORDER`, `SLOT_LABEL_KEYS`, `CORE_SLOTS`, `BUILD_ITEM_TIERS`, quality/enchantment support, item selection helpers and two-handed slot capacity (`isTwoHandedWeaponKey`, `mainSlotCapacity`, `mainSlotProgress`, `weaponKeyOfItems`); `comp-parties.ts` exposes party view types, `simulateCompParties`, `groupPartySeats` (seats of one party grouped by build) and `partyRoleMix`.
- `version-diff.ts` returns grouped added/removed/changed entries with per-token before/after (item, ability, quality, version, quantity), and matches a composition's builds by lineage so v1 to v3 is one line; `group-by-creator.ts` groups builds by creator.

## Invariants

- On the detail page build loadouts are fetched lazily, the first time a row is expanded or a party line inspected, and cached for the page's lifetime. Editing is one mode: quantity steppers save after a short pause, removal and addition refresh the composition in place, and toasts use translated text only.
- Items without a loadout are treated as `main` and sorted by the declared slot order.
- Party simulation expands quantities, sorts by role order, and chunks into parties of 20 by default.
- A variant is shown flat, with a "Variant of X" link to its parent, instead of nested in a tree.
- Copying a build copies the main loadout only (never the swap) and never overwrites a role the officer picked.
- Version comparison identifies build slots across loadouts and compares composition entries by build name and version.

## Side Effects

Inspected helper functions build local arrays/maps/sets and perform no I/O. The two thin wrapper components delegate their page rendering to `Comps`.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The composition detail page and add-build dialog have component specs (`comp-detail.spec.ts`, `comp-add-build-dialog.spec.ts`); the list, create and menu logic is covered by `comps-list-model.spec.ts`, `comp-create-model.spec.ts`, `build-create-model.spec.ts` (the shared menu has its own `menu.spec.ts`).
