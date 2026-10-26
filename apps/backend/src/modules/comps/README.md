# Builds and compositions module

## Overview

The comps module manages build/comp categories, builds and loadouts, compositions and build quantities, versions/archive state, and live market-price views.

## Interface

The router provides category CRUD; build CRUD, item/spell updates, versioning, performance, Item Power, roster-fit and price views; and comp CRUD, readiness/performance/price, versioning, archive, build membership, and quantity operations.

List filters support pagination and `mine=true` for the current user's records. Loadout queries default to `main` and reject unknown values. Build/comp price views return decimal totals, breakdowns, and an RFC3339 pricing timestamp.

## Invariants

- Loadouts are `main` or `swap`; `main` is the default. Quality defaults to 4 and is limited to 1–5; enchantment defaults to 0 and is limited to 0–4.
- Build creation checks category, rejects duplicate item slots, validates catalog items, and inserts the build, main-loadout items, and validated spell rows transactionally.
- Expansion comps must have strictly greater capacity than their parent. Parent validation rejects self-parenting, missing parents, cycles, and descendants; merging quantities uses checked addition.
- Price calculations use main-loadout items. Build totals sum item prices; comp totals multiply per-build unit totals by quantity. Empty comps total zero; missing listings resolve to zero and unparseable/unresolved item rows are skipped.
- Price cache entries are keyed by tenant, pricing location, and build/comp ID, with a 300-second TTL. The fallback strategy is not part of the key.

## Side Effects

Build/comp price handlers read regear settings, consult an in-memory cache, and call Albion Online Data on cache misses; results are cached but not persisted to the database. Market request failures become empty price results, which can produce zero-priced cached views. Build and composition mutation operations write database rows; build creation is transactional.

## Verification

From the repository root, run `cargo test -p backend`. Review price fallback provenance before relying on returned city labels or immediately changing fallback strategy.
