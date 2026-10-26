# Albion settings

## Overview

`AlbionSettings` manages the current user's Albion character link and provides player/guild lookup.

## Interface

The page shows link status and optional link date, an unlink confirmation dialog, and search results for players and guilds. Selecting a player exposes fame and guild details.

## Invariants

- Search requires at least two trimmed characters and is disabled while a request is in progress.
- Fame ratio is kill fame divided by death fame; when death fame is nonpositive, zero kill fame displays `0.00` and positive kill fame displays infinity.

## Side Effects

Construction loads `api/albion/link/me`; failures show a toast. The template exposes search and player selection handlers, but their implementations were beyond the 300-line scan range.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The source scan was limited to the first 300 lines of a 350-line file.
