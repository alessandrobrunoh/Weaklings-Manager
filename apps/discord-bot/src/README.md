# Discord bot source

## Overview

This directory contains the bot runtime entrypoint, environment configuration, and shared formatting helper, with behavior split across API, command, embed, handler, and service modules. The container launches JavaScript compiled from `index.ts`.

## Interface

- `Config` and `config` expose the Zod-validated runtime configuration; `formatSilver` formats silver amounts.
- The [API modules](api/README.md) own backend requests and wire types.
- The [command modules](commands/README.md) define slash-command builders and executors.
- The [embed modules](embeds/README.md) construct Discord presentation payloads.
- The [interaction handlers](handlers/README.md) route buttons, modal submissions, and select menus.
- The [services](services/README.md) own reusable workflows, tenant gates, and polling/lifecycle work.

## Invariants

- Configuration is parsed eagerly. `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, and `BOT_API_SECRET` must be non-empty; URL settings are validated.
- `POLL_INTERVAL_MS` defaults to `60_000`, `POLLER_STATE_DIR` defaults to `/app/data`, and `GUILD_NAME` defaults to `Weaklings`.
- Invalid configuration is logged and terminates the process with exit status 1.

## Side Effects

- Importing `config.ts` reads environment variables and exits the process if validation fails.
- `formatSilver` only formats a value. Backend requests, Discord interactions, and poller state are handled by the child modules.

## Verification

From the repository root, run `npm test --prefix apps/discord-bot`. This builds the bot and runs its configured test suite.
