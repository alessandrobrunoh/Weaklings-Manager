# Fights

## Overview

This directory contains canonical fight detail analytics and rolling performance trends. Fight detail covers attached battle segments, matchups, guilds, players, losses, and roster evidence.

## Interface

- `FightTab`, `CombatRole`, and row/summary interfaces describe fight detail state; `PendingFightMutation` distinguishes merge, split, and move requests.
- `FightDetailPage` uses `app-entity-header` (summary band of six figures, officer merge/split in its menu), `app-tabs` for the five sections, `app-filter-bar` for the guild and player lists, and `app-data-table` for every table.
- `FightTrendsPage` displays rolling 30-day performance against the previous period, including fight volume, coverage, and planned builds/compositions.

## Invariants

- Detail merge is disabled during a mutation; split also requires at least two attached battle IDs.
- "Ours" is the backend's `is_own` / `is_friendly` verdict; the Discord server name is never compared with guild names.
- A 404 from `api/fights/:id` (or a non-numeric id) shows the not-found state; any other failure shows the retryable error state.
- Trends omit comparisons when either period's metric is `null`; percent conversion multiplies values at or below one by 100.
- Build/composition assignments aggregate by ID and sort by descending count, then name.

## Side Effects

`FightTrendsPage` loads `api/fights/trends` at construction and through refresh/retry, updating loading, error, and data state. Detail-page mutations (merge, split, move) post to `api/fights/merge`, `api/fights/:id/split` and `api/fights/:id/move-battle` after a confirmation dialog, then reload or navigate to the resulting fight.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The detail page spec covers the split review dialog, friendly-side flags and the 404 state.
