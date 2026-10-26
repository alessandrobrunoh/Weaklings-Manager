# Giveaways module

## Overview

The giveaways module manages giveaway records, prizes, and entries, including entry lifecycle, cancellation, drawing, and stored Discord message references.

## Interface

| Method and path | Behavior |
|---|---|
| `GET /api/giveaways` | Lists giveaways with pagination, status, search, and sorting filters; requires `GiveawaysView`. |
| `POST /api/giveaways` | Creates a giveaway; requires `GiveawaysCreate`. |
| `GET /api/giveaways/{id}` | Returns a giveaway and its entries; requires `GiveawaysView`. |
| `POST /api/giveaways/{id}/enter`, `DELETE /api/giveaways/{id}/enter` | Enters or leaves for the session-authenticated caller. |
| `POST /api/giveaways/{id}/cancel` | Cancels an open giveaway; requires `GiveawaysManage`. |
| `POST /api/giveaways/{id}/draw` | Draws with `force = true`; requires `GiveawaysManage`. |
| `PUT /api/giveaways/{id}/discord-message` | Stores Discord message references; requires `GiveawaysManage`. |

Entities map to `giveaways`, `giveaway_prizes`, and `giveaway_entries`. `GiveawayService` is the application service.

## Invariants

- Status values are `open`, `drawn`, `cancelled`, and `expired_empty`; only `open` is non-terminal.
- Entry and leave reject non-positive user IDs and require an open giveaway. Duplicate entry conflicts are treated as success; leaving without a matching row is a no-op.
- Cancellation only changes an open giveaway. A non-forced draw before the deadline is rejected; a draw with no entries becomes `expired_empty`.
- Scheduled `draw_due` selects open giveaways past their deadline and logs per-giveaway draw failures without stopping iteration.

## Side Effects

Entry and leave insert or delete entry rows. Cancellation updates status/time/officer and attempts an audit log. Drawing runs in a database transaction; a positive silver prize creates a pending bank transaction, and a positive regear bonus calls the regear credit service. After commit, drawing attempts an audit log and best-effort winner notification. A Discord-message update trims and validates both IDs before storing them.

## Verification

From the repository root, run `cargo test -p backend`.
