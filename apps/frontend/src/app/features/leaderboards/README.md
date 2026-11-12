# Leaderboards

## Overview

`SeasonOverview` shows the active season's timeline and totals, the caller's standing, and category rankings. Season XP comes from the progression leaderboard; every Intel category and the battle and fame totals come from `IntelService`.

## Interface

- Selector: `app-season-overview`; the page uses `OnPush` change detection.
- Board keys include `season` and Intel categories `kills`, `killfame`, `attendance`, `payout`, `deaths`, `siphoned`, and `deathfame`.
- `selectTab`, `reloadAll`, and `reloadActive` control the visible board and refresh behavior.

## Invariants

- The active tab defaults to `season`; non-forced loads skip data already marked loaded.
- Intel boards and the report load after the season resolves and are scoped to the active season window (`from`/`to`). With no known season the backend default (the last 30 days) applies, and the page says so.
- Season and Intel results have separate load generations; stale results are discarded.
- Season selection prefers an active season, then the first season, with profile season as fallback.
- An empty board renders an empty state that names the period it was checked against; a failed load renders the error state, never the empty state.
- Rankings are plain `app-data-table` lists (rank, player, value). There is no podium or medal treatment.

## Side Effects

The page requests progression seasons/profile/leaderboard data and calls `IntelService` for leaderboards and the report, passing the season window. Failures set the relevant error state and clear its loaded flag.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
