# Compositions and builds

## Overview

This directory groups the build/composition workspace components with helpers for loadouts, party layouts, composition trees, creator grouping, and version comparison.

## Interface

- `Builds` and `Compositions` delegate to `Comps` with different `page` values.
- `build-loadouts.ts` exposes canonical slot ordering and item selection helpers; `comp-parties.ts` exposes party view types and `simulateCompParties`.
- `comp-tree.ts` exposes forest construction/filtering/flattening; `version-diff.ts` returns added/removed/changed entries; `group-by-creator.ts` groups builds by creator.

## Invariants

- Items without a loadout are treated as `main` and sorted by the declared slot order.
- Party simulation expands quantities, sorts by role order, and chunks into parties of 20 by default.
- Tree construction sorts deterministically, recovers missing/cyclic parent links, and filtering retains ancestor paths.
- Version comparison identifies build slots across loadouts and compares composition entries by build name and version.

## Side Effects

Inspected helper functions build local arrays/maps/sets and perform no I/O. The two thin wrapper components delegate their page rendering to `Comps`.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. Three large page implementations were not inspected because each exceeds 300 lines; helper scans stayed within the 50 KB directory budget.
