# Albion Guild Manager — Discord Bot

A Discord bot built with **discord.js v14** and **TypeScript** that mirrors the Albion Guild Manager web app functionality 1:1 directly in Discord.

## Features

| Feature | Slash Command / Trigger |
|---|---|
| View Events | `/events [page]` |
| Create Event | `/event-create` (Officer+) |
| Refresh Content Pings / Call to Arms calendars | `/event-calendar-refresh` (`events.edit`) |
| Join Event by Role | `/event-join [event_id]` + role/build select menus |
| Leave Event | `/event-leave [event_id]` |
| Start Event | `/event-start [event_id]` (Officer+) |
| Stop Event | `/event-stop [event_id]` (Officer+) |
| View Balance | `/balance` |
| Request Withdrawal | `/balance-request` |
| View Battles | `/battles [page]` |
| View Build | `/build [nome]` — uses `Nome Categoria Creatore` without hyphens and sends one item-collage image |
| View Members | `/users [search] [page]` |
| Link Albion Account | `/link [player_id] [player_name]` |
| Auto-announce Events | Polling → events channel (Admin → Discord integration in the web app) |
| Auto-announce Battles | Polling → battles channel (Admin → Discord integration in the web app) |

## Setup

### 1. Create Discord Application & Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new Application → add a Bot
3. Enable **Message Content Intent** under Privileged Gateway Intents
4. Copy the **Token** and the **Client ID**
5. Invite the bot to your server with: `applications.commands` + `bot` scopes, `Send Messages`, `Embed Links` permissions

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in:

```env
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_client_id
BACKEND_URL=http://localhost:3000
BOT_API_SECRET=choose_a_strong_random_secret
GUILD_NAME=YourInGameGuildName
```

> **Backend setup**: The backend must also have `BOT_API_SECRET` set and must support the `X-Bot-Secret` / `X-Discord-Id` authentication headers.

> **Channels and roles**: the events/battles announcement channels and the event-ping role are no
> longer env vars here — set them once in the web app under **Admin → Discord integration** (after
> logging in with an Admin account). The bot fetches them from the backend at startup and
> refreshes periodically, so a change there takes effect without restarting the bot.

> **Multi-server**: one bot process serves every Discord server it is invited to. There is no
> "the" server: slash commands are registered per guild, and each registered tenant gets its own
> settings cache, poller, and checkpoint file. A server that has not completed onboarding on the
> website gets a registration link instead of command output.

### 3. Install & Run

```bash
cd apps/discord-bot
npm install
npm run dev      # Development with hot reload
npm run build    # TypeScript compile
npm start        # Production
```

## Overview

The bot is a long-running Discord.js v14 process. One process can serve multiple Discord guilds; registered guilds are treated as tenants with guild-scoped API clients, pollers, and checkpoint state.

## Interface

- Startup requires non-empty `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, and `BOT_API_SECRET`. `BACKEND_URL` and `FRONTEND_URL` are URL-validated; `POLL_INTERVAL_MS`, `POLLER_STATE_DIR`, and `GUILD_NAME` have defaults documented in the [source overview](src/README.md).
- Slash commands and component interactions form the Discord interface; the existing feature list and setup instructions above describe user-facing commands and deployment configuration.
- Backend requests use `X-Bot-Secret` and may include `X-Discord-Id`, `X-Guild-Id`, and actor-bound role IDs.

## Invariants

- Environment configuration is validated at startup; invalid configuration logs validation issues and exits.
- Pollers are reconciled per registered guild and use guild-scoped API clients. Guild state and settings are isolated rather than shared across Discord servers.
- Discord role claims are sent only when the requested Discord actor matches the client actor.

## Side Effects

- The process communicates with Discord and the backend API, registers slash commands, and runs recurring guild polling.
- Poller checkpoints are stored per guild beneath `POLLER_STATE_DIR` (default `/app/data`). The Docker image configures this directory but does not declare a volume; persistence across container replacement depends on the launch configuration.
- The container runs `node dist/index.js` as a non-root user and exposes no inbound port.

## Verification

Run the configured check from the repository root:

```bash
npm test --prefix apps/discord-bot
```

This runs the TypeScript build and the bot's configured Node test suite.

## Architecture

The runtime entrypoint is `src/index.ts`; its child-module boundaries are summarized in the [source README](src/README.md):

- `src/api/` owns backend HTTP access and shared API types.
- `src/commands/` defines slash-command builders and executors.
- `src/embeds/` builds Discord embeds, controls, and message payloads.
- `src/handlers/` routes button, modal, and select-menu interactions.
- `src/services/` contains poller, tenant, event lifecycle, and other reusable workflows.

## Button Custom ID Format

Button handlers split custom IDs on `:` and dispatch by namespace and action. Remaining parts are action-specific; not every ID has an entity ID.

```
{namespace}:{action}[:{entityId}[:{extra}]]
```

Examples:
- `ticket:create` — Start a ticket
- `ticket:close:42` — Close ticket #42
- `application:manage:42` — Open management controls for application #42

## Polling State

The poller stores separate checkpoint state for each numeric guild ID beneath `POLLER_STATE_DIR` (default `/app/data`). Checkpoints include event and battle cursors along with Discord thread, signup-card, calendar, split-sync, voice-check, application, and giveaway state. An uninitialized checkpoint is seeded so existing records are not treated as new announcements on startup. The Docker image does not declare a volume, so mount `/app/data` if checkpoint persistence across container replacement is required.
