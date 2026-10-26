# Fight analytics module

## Overview

This directory contains fight-analytics aggregation, persistence, and read API code. The bounded module overview describes analytics as eagerly recomputed and rebuildable, with stale/computed timestamps for freshness visibility.

## Interface

- `GET /{fight_id}` (documented as `/api/fight-analytics/{fight_id}`) requires `Permission::FightsView` and returns `FightAnalyticsView`.
- Bounded excerpts expose `compute_fight_analytics`, `get_fight_analytics`, and `recompute_fight_analytics`.

## Invariants

- Outcome classification delegates to `battles::outcome::classify` for segments and `combine_segments` across them.
- Player counts deduplicate by `player_key`; combat contributions sum across appearances.
- (Details pending/documentation failed) Remaining aggregation and persistence rules require a compliant bounded review.

## Side Effects

The bounded excerpts show a read path for fight/stats data and a recompute path that transactionally writes the fight and stats row.

(Details pending/documentation failed) Remaining writer inputs, triggers, and error handling require a compliant bounded review.

## Verification

From the repository root, run `cargo test -p backend`.
