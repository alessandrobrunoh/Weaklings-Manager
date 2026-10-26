# Discord message builders

## Overview

This directory builds Discord embeds, components, and message payloads for the bot's application/ticket, battle, giveaway, and event workflows. Shared theme and formatting helpers live in `theme.ts`.

## Interface

- `createBaseEmbed` and `createResponseEmbed` provide branded and status-oriented embed builders; `buildAsciiBar`, `buildAsciiChart`, and `formatCompactNumber` provide display helpers.
- Application builders create application panels, forms, status messages, resolution controls, and ticket responses.
- Battle and giveaway builders create result/list embeds and giveaway announcement/action payloads.
- Event builders create event embeds, calendar controls, and announcement, reminder, Mass, Start, and alliance-lifecycle payloads.

## Invariants

- Event and giveaway message payloads suppress generic parsed mentions and explicitly allowlist the roles or users they intend to mention.
- Event timestamps fall back to the event date when mass or start times are absent.
- Giveaway participation controls are disabled unless the giveaway is open.
- The application modal requires a 2–64 character short-text value and limits its title to 45 characters; final application controls are disabled in final responses.
- Calendar action rows include scheduled/live events with thread IDs, with at most 25 events considered.

## Side Effects

- The inspected builders return Discord embed, component, or message-payload objects; they do not send messages, call the backend, or persist state.
- `GUILD_NAME` is read from configuration when the shared theme module initializes.

## Verification

From the repository root, run `npm test --prefix apps/discord-bot`. This builds the bot and runs its configured test suite.
