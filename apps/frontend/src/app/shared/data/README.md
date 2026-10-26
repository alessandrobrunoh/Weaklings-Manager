# Shared Albion and ownership data

## Overview

This directory provides Albion ability/equipment/Destiny Board and item quality/enchantment helpers, plus ownership-scope utilities.

## Interface

- Ability helpers expose `AbilitySlotView`, icon/catalog keys, slot construction, selection, and display-name helpers.
- Destiny Board types and helpers include weapon/armor classification and specialization-node merging.
- Equipment catalog helpers cover legacy catalog names/identifiers and rendering.
- Enchantment and quality modules export supported values, derived types, defaults, validation/normalization, labels, and icon helpers.
- Ownership scope exports the `'mine' | 'all'` type and validation, list-parameter, and picker-label helpers.

## Invariants

- Enchantment levels are integers 0–4, defaulting to 0; quality IDs are integers 1–5, defaulting to Excellent (4).
- Ability slots follow catalog slot counts and omit slots without choices; clearing a choice removes it from a copied map.
- Ownership list parameters use `{ mine: true }` only for the `mine` scope.

## Side Effects

Reviewed helpers transform input data and return values; no network, storage, or other I/O was observed in the scanned portions.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. Two long sources were limited to their first 300 lines; their full exports and later invariants are not enumerated.
