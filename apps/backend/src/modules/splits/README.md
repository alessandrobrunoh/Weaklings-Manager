# Splits module

## Overview

The splits module manages split records, participants, bags, island tabs, completion states, and Discord synchronization. Its entities also capture whether a split is an alliance-origin read-only snapshot.

## Interface

The router documents routes under `/api/splits` for island/tab management, split summary and CRUD, archive/unarchive, participant management, donation, batch completion, completion outcomes, and participant matching. The merged Discord-sync router provides discovery and per-split sync-state read/update operations.

(Details pending/documentation failed) Runtime permission mapping and payload shapes require a compliant bounded router review.

## Invariants

- `SplitStatus` values are `pending`, `awaiting_event`, `completed`, `not_completed`, and `lost`, stored as strings. `SplitIslandCity` maps seven cities to stable lowercase keys.
- Bag normalization rejects negative amounts and drops zero amounts. A non-empty bag list takes precedence over `bags_value`; otherwise positive `bags_value` becomes a single bag.
- Discord discovery cursors are ordered by `(updated_at, id)`; `after_id` requires `updated_after`, and timestamps are RFC3339.
- Request documentation differs on whether event-linked splits may begin without participants; verify the route/service behavior before relying on either description.
- (Details pending/documentation failed) Entity relations and database constraints need a compliant bounded review.

## Side Effects

Bounded service excerpts show participant/bag replacement, split-credit transaction creation, completed-credit reconciliation, and per-split Discord-sync state updates.

(Details pending/documentation failed) Remaining service and Discord-sync side effects require a compliant bounded review.

## Verification

From the repository root, run `cargo test -p backend`.
