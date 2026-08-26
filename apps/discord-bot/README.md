# Albion Guild Manager — Discord Bot

A Discord bot built with **discord.js v14** and **TypeScript** that mirrors the Albion Guild Manager web app functionality 1:1 directly in Discord.

## Features

| Feature | Slash Command / Trigger |
|---|---|
| View Events | `/events [page]` |
| Create Event | `/event-create` (Officer+) |
| Join Event by Role | `/event-join [event_id]` + role buttons |
| Leave Event | `/event-leave [event_id]` |
| Start Event | `/event-start [event_id]` (Officer+) |
| Stop Event | `/event-stop [event_id]` (Officer+) |
| View Balance | `/balance` |
| Request Withdrawal | `/balance-request` |
| View Battles | `/battles [page]` |
| View Members | `/users [search] [page]` |
| Link Albion Account | `/link [player_id] [player_name]` |
| Auto-announce Events | Polling → events channel (Admin → Discord integration in the web app) |
| Auto-announce Battles | Polling → battles channel (Admin → Discord integration in the web app) |

## Setup

### 1. Create Discord Application & Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new Application → add a Bot
3. Enable **Message Content Intent** under Privileged Gateway Intents
4. Copy the **Token**, **Client ID**, and your **Server (Guild) ID**
5. Invite the bot to your server with: `applications.commands` + `bot` scopes, `Send Messages`, `Embed Links` permissions

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in:

```env
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_client_id
DISCORD_GUILD_ID=your_server_id
BACKEND_URL=http://localhost:3000
BOT_API_SECRET=choose_a_strong_random_secret
GUILD_NAME=YourInGameGuildName
```

> **Backend setup**: The backend must also have `BOT_API_SECRET` set and must support the `X-Bot-Secret` / `X-Discord-Id` authentication headers.

> **Channels and roles**: the events/battles announcement channels and the event-ping role are no
> longer env vars here — set them once in the web app under **Admin → Discord integration** (after
> logging in with an Admin account). The bot fetches them from the backend at startup and
> refreshes periodically, so a change there takes effect without restarting the bot.

### 3. Install & Run

```bash
cd apps/discord-bot
npm install
npm run dev      # Development with hot reload
npm run build    # TypeScript compile
npm start        # Production
```

## Architecture

```
src/
├── index.ts          # Entrypoint: login, register commands, start poller
├── config.ts         # Env var validation with Zod
├── api/
│   ├── client.ts     # Fetch-based HTTP client for the backend
│   └── types.ts      # Shared API type definitions
├── commands/         # One file per slash command
├── handlers/
│   └── button.ts     # All ButtonInteraction handling
├── embeds/
│   ├── event.embed.ts   # Event embeds + role-selection buttons
│   └── battle.embed.ts  # Battle result embeds
└── services/
    ├── poller.ts     # Polling loop for new events/battles
    └── registry.ts   # Slash command registration
```

## Button Custom ID Format

All buttons follow this format so the handler can parse them:

```
{namespace}:{action}:{entityId}[:{extra}]
```

Examples:
- `event:join:42:healer` — Join event #42 as healer
- `event:leave:42` — Leave event #42
- `events:next:2` — Go to page 2 of events list
- `battles:prev:3` — Go to page 2 of battles list

## Polling State

The poller persists its state in `data/poller-state.json`:

```json
{
  "lastEventId": 42,
  "lastBattleId": 100
}
```

Delete this file to re-announce all existing events/battles on next startup.
