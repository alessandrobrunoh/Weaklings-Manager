# Battles

## Overview

This directory contains the battle list, battle detail analytics, multi-battle group view, and outcome-label helper. The list distinguishes canonical guild Fight aggregates from raw personal AlbionBB battles.

## Interface

- The list uses `guild` and `me` tabs, supports `BattleSummary | FightListItem` rows, and sets page size 10 with a 300-second refresh interval.
- The list state lives in the URL: `tab`, `search`, `outcome`, plus the table's `page`, `size` and `sort`. The filter bar and tabs write `tab`, `search` and `outcome`; the data table writes its own keys. Every change to that state reloads the list.
- The summary band shows figures for the rows on the page. The guild tab shows K/D or win rate and the largest fight; the personal tab shows deaths and players. Guild fights do not expose deaths yet, so the deaths column is personal only.
- The table is in server mode with no cell accessors or comparators, so the client never filters the server's page again. Outcome uses `app-status-chip` with a tone override: victory is success, defeat is error, draw and unknown are neutral.
- Detail types include tab/filter/role unions and enriched player/guild rows. The group page derives totals and K/D from loaded battles.
- `battle-outcome.ts` defines the displayed outcome vocabulary and translation lookup.

## Invariants

- Display outcomes are `victory`, `defeat`, `draw`, or `unknown`; missing outcomes map to `unknown`.
- Group K/D returns kills when deaths are zero and kills are positive, otherwise zero when both are zero.
- Group chart maxima have a floor of one; comparative charts show up to eight guilds.

## Side Effects

Templates expose refresh, tab, navigation, copy-link, and scout actions. Handler effects for the larger pages were outside the inspected ranges; the outcome helper performs a translation-key lookup.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. Large sources were inspected only through bounded excerpts; tests were excluded.
