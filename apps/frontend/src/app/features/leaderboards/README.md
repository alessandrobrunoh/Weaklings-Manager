# Leaderboards

## Overview

`SeasonOverview` loads season XP rankings and Intel leaderboard/report data.

## Interface

- Selector: `app-season-overview`; the page uses `OnPush` change detection.
- Board keys include `season` and Intel categories `kills`, `killfame`, `attendance`, `payout`, `deaths`, `siphoned`, and `deathfame`.
- `selectTab`, `reloadAll`, and `reloadActive` control the visible board and refresh behavior.

## Invariants

- The active tab defaults to `season`; non-forced loads skip data already marked loaded.
- Season and Intel results have separate load generations; stale results are discarded.
- Season selection prefers an active season, then the first season, with profile season as fallback.

## Side Effects

The page requests progression seasons/profile/leaderboard data and calls `IntelService` for leaderboards and reports. Failures set the relevant error state and clear its loaded flag.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The scan covered 299 source lines, within the per-file cap.
