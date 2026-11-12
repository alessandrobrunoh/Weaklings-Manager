# Event sessions

## Overview

This module starts a Tokio background worker that periodically stops expired event sessions, attempts due giveaway draws, and refreshes pending battle links.

## Interface

- `spawn` starts the worker using the database connection, AlbionBB and AlbionData services, configuration, and tenant ID. It returns neither a result nor a task handle.
- `refresh_pending_links` is exposed from the public `battle_linker` submodule. `auto_stop_expired_sessions` lives in `modules::events::auto_stop`, next to the lifecycle it drives.
- The worker runs its cycle every 30 seconds.

## Invariants

- Auto-stop considers only `live` events with an elapsed deadline; events without deadlines or with future deadlines are skipped.
- A tenant without an Albion guild id or region still gets auto-stop and giveaway draws every tick; only link refresh is skipped. The worker logs a WARN with the tenant id on every such tick (battle sync does the same), so the misconfiguration is visible.
- Link refresh selects `in_progress` and `pending` sessions whose status is `live`, `stopped`, `auto_stopped` or `cancelled`, ordered by `started_at` then id (so an earlier event deterministically keeps a battle two events share). `scheduled` sessions are never polled. A `cancelled` leftover is just closed (cancelling now sets `link_status = completed`).
- A stopped session whose grace period elapsed is finalized: `completed`, or `failed` when its last linking attempt left `link_last_error` set. A session that was never attempted (the tenant had no Albion guild while it ran) first gets one linking attempt, so it is not marked `completed` without a lookup. Other sessions receive a linking attempt.
- A linking attempt covers `[earliest(started_at, start_time_utc, mass_time_utc) - 30 min, (stopped_at or now) + 20 min]`, walks the AlbionBB list newest first and stops at the first page entirely older than the window. A failed page does not discard battles from earlier pages; the attempt and its error (or the cleared error) are stored in `link_attempts` / `link_last_error`. A first upstream failure is logged at debug, repeated ones at warn.
- After each attempt (and before finalizing) up to 5 linked battles without a snapshot are hydrated with `get_battle_detail_with_losses`, so linked battles have kills and losses for the event page and regear extraction. `battle_sync` also re-fetches (up to 5 per tick) snapshots of battles that ended less than 30 minutes ago, because kills arrive late.
- A query failure in auto-stop or pending-link selection propagates from the cycle and skips later work in that cycle. Giveaway-draw errors and per-session stop/link/extraction failures are logged and do not abort the full loop.
- Regear extraction follows successful finalization. Validation failures are ignored; other extraction failures are logged.

## Side Effects

The spawned task continues until process exit; no cancellation or join handle is exposed. Each cycle reads event rows, delegates stop/finalize/link work to services, attempts giveaway draws and regear extraction, and writes tracing logs.

## Verification

From the repository root, run `cargo test -p backend`.
