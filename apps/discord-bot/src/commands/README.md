# Slash-command modules

## Overview

This directory defines the bot's slash-command interface plus registered message context actions. `index.ts` maps slash commands and the `Flash mass` message action to their modules.

## Interface

- The shared `BotCommand` contract pairs a slash-command builder (`data`) with an async `execute(interaction, api)` function.
- `BotMessageCommand` registers Discord message context-menu actions; the `Flash mass` action opens the same editable modal as `/flash` with title/time/notes prefilled from the selected message.
- Command executors receive a `ChatInputCommandInteraction` and an `ApiClient`.
- The command set covers event, battle, balance, build, member, registration, application, moderation, progression, and related guild workflows. The top-level bot README retains the user-facing feature list.

## Invariants

- The registry keys match the names supplied by each command builder.
- Command executors commonly include the invoking Discord user ID on user-scoped API requests.
- Only `applications-panel` sets `ManageGuild` as builder-level default permission in this directory. Descriptions such as “Officer+” are not themselves permission enforcement; additional authorization may occur outside this module.
- `event-join` displays signup controls; participation is submitted later by the interaction handler.
- `event-create` creates the backend event and delegates announcement work to the poller rather than posting its own announcement or thread.
- `/flash` creates a comp-less binary event. Backend `events.create` permission controls launch access; the poller is still the sole announcement owner, gives the author 30 seconds to undo before the role ping, and retries delivery failures from its checkpoint.

## Side Effects

- Commands respond to Discord interactions and may call backend APIs or mutate Discord messages and channels.
- `applications-panel` sends the configured panel and persists its message ID through the API.
- Event calendar refresh/start/stop commands delegate to poller or event-lifecycle services; balance, moderation, and progression commands submit their corresponding API operations.
- A warning is persisted before its best-effort direct message; failure to DM does not undo the warning.

## Verification

From the repository root, run `npm test --prefix apps/discord-bot`. This builds the bot and runs its configured test suite.
