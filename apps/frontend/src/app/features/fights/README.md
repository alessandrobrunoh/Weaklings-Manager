# Fights

## Overview

This directory contains canonical fight detail analytics and rolling performance trends. Fight detail covers attached battle segments, matchups, guilds, players, losses, and roster evidence.

## Interface

- `FightTab`, `CombatRole`, and row/summary interfaces describe fight detail state; `PendingFightMutation` distinguishes merge, split, and move requests.
- `FightTrendsPage` displays rolling 30-day performance against the previous period, including fight volume, coverage, and planned builds/compositions.

## Invariants

- Detail merge is disabled during a mutation; split also requires at least two attached battle IDs.
- Trends omit comparisons when either period's metric is `null`; percent conversion multiplies values at or below one by 100.
- Build/composition assignments aggregate by ID and sort by descending count, then name.

## Side Effects

`FightTrendsPage` loads `api/fights/trends` at construction and through refresh/retry, updating loading, error, and data state. Detail-page mutation effects were beyond the 300-line scan range.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The detail source was inspected only through its first 300 lines.
