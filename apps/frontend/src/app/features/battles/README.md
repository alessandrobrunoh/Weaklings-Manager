# Battles

## Overview

This directory contains the battle list, battle detail analytics, multi-battle group view, and outcome-label helper. The list distinguishes canonical guild Fight aggregates from raw personal AlbionBB battles.

## Interface

- The list uses `guild` and `me` tabs, supports `BattleSummary | FightListItem` rows, and sets page size 10 with a 300-second refresh interval.
- Battle detail has four tabs (overview, players, guilds, kills). Its header is `app-entity-header` with a summary band of six figures and an overflow menu (copy link, open on Albion Battles). Players, alliances, guilds and the kill feed are `app-data-table`; the kill feed filters with `app-tabs` (segmented) and `app-filter-bar`, and a kill's gear opens in a dialog.
- Detail types include tab/filter/role unions and enriched player/guild rows. The group page derives totals and K/D from loaded battles; it uses a page header with a back link, one summary band, and a guild table.
- `battle-outcome.ts` defines the displayed outcome vocabulary and translation lookup.

## Invariants

- Display outcomes are `victory`, `defeat`, `draw`, or `unknown`; missing outcomes map to `unknown`.
- Group K/D returns kills when deaths are zero and kills are positive, otherwise zero when both are zero.
- Group chart maxima have a floor of one; comparative charts show up to eight guilds.

## Side Effects

Templates expose refresh, tab, navigation, copy-link, and scout actions. Clicking a timeline minute filters the kill feed to that minute and opens the kills tab. Handler effects for the larger pages were outside the inspected ranges; the outcome helper performs a translation-key lookup.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. Large sources were inspected only through bounded excerpts; tests were excluded.
