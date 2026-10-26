# AlbionBB module

## Overview

AlbionBB is a reusable HTTP integration and read API. The `battles` module consumes its service and reshapes data for a configured guild.

## Interface

All handlers use session-cookie security and the application mounts this router at `/api/albionbb`:

- `GET /battles` lists with optional server/search/guild/player filters and page.
- `GET /battles/{battle_id}` returns detail.
- `GET /battles/{battle_id}/kills` returns kill events with the upstream payload in `raw`.
- `GET /guilds/{guild_id}` returns guild information.
- `GET /players/{player_id}/stats` returns upstream JSON player stats.

`AlbionBbService` exposes corresponding battle, kill, player-stat, and guild operations.

## Invariants

- Server aliases normalize to `eu`, `na`, or `asia`; absent/unrecognized values default to `eu`.
- Typed battle/guild models tolerate upstream field naming/shape variation and ignore unknown JSON fields. Player stats remain `serde_json::Value`.
- Battle-detail and guild caches are separate, process-local caches keyed by normalized server and resource ID, with 24-hour freshness and a 500-entry cap. Battle lists, kills, and player stats are not cached.
- Current battle-list metadata documents totals as unavailable (`None`).

## Side Effects

Client requests go to the AlbionBB API over HTTP; service caches live in shared in-memory `Arc<RwLock<HashMap<...>>>` state. The service does not persist results to the database.

## Verification

From the repository root, run `cargo test -p backend`. No upstream requests are made by this check.
