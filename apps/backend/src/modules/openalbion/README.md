# OpenAlbion module

## Overview

This module serves the historical OpenAlbion API shape from bundled local catalog data; it does not call the third-party OpenAlbion API. Item and ability data are lazily initialized from embedded JSON.

## Interface

The bounded route excerpt documents session-cookie-protected catalog endpoints under `/api/openalbion`:

- `GET /weapons` lists weapons.
- `GET /weapons/{id}/stats` returns a raw JSON array.
- `GET /items` lists items with a type filter.
- `GET /catalog` returns the full item list.
- `GET /categories` lists top-level categories as a raw JSON array.
- `GET /abilities` returns the ability map.

(Details pending/documentation failed) Per-route query/response shapes and the full handler contract require a compliant bounded review.

## Invariants

- Item types are exact lowercase values: `weapon`, `armor`, `accessory`, or `consumable`.
- Categories have four stable top-level IDs (1 through 4); the category response has no nested subcategories.
- Weapon stats return an empty array for a catalog weapon and not-found for unknown/non-weapon IDs.
- Ability entries use tier- and enchantment-stripped identifiers.
- (Details pending/documentation failed) Filter behavior beyond the bounded excerpts requires review.

## Side Effects

The bounded service excerpt shows item and ability data parsed lazily into `OnceLock` statics; invalid embedded JSON panics during initialization.

(Details pending/documentation failed) Remaining initialization, network, and persistence effects require a compliant bounded review.

## Verification

From the repository root, run `cargo test -p backend`.
