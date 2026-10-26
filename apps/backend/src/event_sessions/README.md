# Event sessions

## Overview

This module starts a Tokio background worker that periodically stops expired event sessions, attempts due giveaway draws, and refreshes pending battle links.

## Interface

- `spawn` starts the worker using the database connection, AlbionBB and AlbionData services, configuration, and tenant ID. It returns neither a result nor a task handle.
- `auto_stop_expired_sessions` and `refresh_pending_links` are exposed from their respective public submodules.
- The worker runs its cycle every 30 seconds.

## Invariants

- Auto-stop considers only `live` events with an elapsed deadline; events without deadlines or with future deadlines are skipped.
- Link refresh selects `in_progress` and `pending` sessions. Completed linkers are finalized; other sessions receive a linking attempt.
- A query failure in auto-stop or pending-link selection propagates from the cycle and skips later work in that cycle. Giveaway-draw errors and per-session stop/link/extraction failures are logged and do not abort the full loop.
- Regear extraction follows successful finalization. Validation failures are ignored; other extraction failures are logged.

## Side Effects

The spawned task continues until process exit; no cancellation or join handle is exposed. Each cycle reads event rows, delegates stop/finalize/link work to services, attempts giveaway draws and regear extraction, and writes tracing logs.

## Verification

From the repository root, run `cargo test -p backend`.
