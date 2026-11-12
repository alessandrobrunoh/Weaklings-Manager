# Albion settings

## Overview

`AlbionSettings` shows the Albion character linked to the current account and provides a live player and guild lookup against the Albion API. Guild and region are tenant settings set by the platform admin, so this page does not edit them.

## Interface

- **Character link** section: helper text (linking applies at once), then a one-row table of the linked character (name, linked date, status chip) with a row menu holding Unlink. Unlink opens a confirmation dialog that names the consequence. With no link, an empty state explains that battle statistics and leaderboards only count linked characters.
- **Player and guild lookup** section: `app-filter-bar` search. Results are two small tables, players (selectable names) and guilds. Selecting a player shows a summary band of kill fame, death fame, fame ratio and guild.
- Loading uses skeletons, failures show `app-error-state` with retry, and an empty result uses the compact empty state.
- The save state of the one write (unlink) is a status line under the character table: saving, unlinked (success), or failed. Failures also show in the dialog.

## Invariants

- The lookup starts after the last keystroke has paused for 350 ms and requires at least two trimmed characters. Responses for an older query are dropped, so a slow request cannot overwrite a newer result.
- Selecting a player shows the search row at once, then refreshes it from the player endpoint. A failed refresh keeps the search row.
- Fame ratio is kill fame divided by death fame; when death fame is nonpositive, zero kill fame displays `0.00` and positive kill fame displays infinity.
- Unlink is ignored while a save is in flight; closing the dialog is blocked during that save.
- Error text shown to the user comes from i18n keys (`common.error`, `albionSettings.save.failed`), never from the API response.
- A partial search (`partial: true`, Albion search unreachable) shows a notice; only guild members are listed in that case.

## Side Effects

- Construction loads `api/albion/link/me`.
- Each lookup calls `api/albion/search`; selecting a player calls `api/albion/players/{id}`.
- Confirming unlink calls `DELETE api/albion/link`.
- A successful unlink shows a toast and clears the link locally; no other state is written.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. This page has no spec file yet.
