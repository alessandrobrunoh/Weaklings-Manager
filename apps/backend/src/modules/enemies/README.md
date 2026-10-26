# Enemies module

## Overview

The enemies module builds enemy guild/player identity records from normalized battle evidence. Tallies and observed builds are derived from battle participation rather than stored as identity rollups.

## Interface

All four GET endpoints require `intel.opponents.view`:

- `GET /api/enemies/guilds` lists guilds with search and sorting.
- `GET /api/enemies/guilds/{id}` returns a guild dossier.
- `GET /api/enemies/players` lists players with search, guild, latest-role, and sorting filters.
- `GET /api/enemies/players/{id}` returns a player dossier.

`EnemyService` provides the read operations; `aggregate_battle` derives evidence and `persist_enemy_facts` stores it.

## Invariants

- Guild identity uses a trimmed Albion guild ID when available; otherwise it uses trimmed lowercase name. Guilds marked friendly are excluded.
- Kill counts include only kills between a friendly side and a resolved enemy player. Kills between friendly players or enemy players do not contribute, and a kill-feed participant without a player-stat row does not become an enemy fact.
- Rollups distinguish battle records from deduplicated fights; ungrouped battles count as one fight.
- Identity snapshots advance only for observations at least as recent as stored `last_seen_at`. First/last-seen times widen to the minimum/maximum observed times; guild alias history is retained independently.
- The router defines read-only GET operations; it has no mutation endpoint.

## Side Effects

`aggregate_battle` is pure synchronous aggregation. `persist_enemy_facts` opens a transaction, upserts identities and aliases, replaces that battle's enemy-player participation rows, and commits. Facts whose guild key cannot be resolved are warned about and skipped.

## Verification

From the repository root, run `cargo test -p backend`.
