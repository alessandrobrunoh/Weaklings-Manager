# Albion Guild Manager

> A self-hosted guild management platform for [Albion Online](https://albiononline.com/) guilds — web dashboard, Discord bot, and a REST API backed by live Albion data.

Albion Guild Manager helps a single Albion Online guild run its day-to-day operations in one place: track the guild bank and loot splits, organize and run game events, review battles with loss estimates, manage compositions and builds, log siphoned energy, and give members a self-service way to link their Discord to their in-game character.

The platform is a **monorepo** with three deployable components:

| Component | Directory | Stack |
| --- | --- | --- |
| **Backend API** | [`apps/backend`](apps/backend) | Rust · Axum · SeaORM · PostgreSQL |
| **Web Dashboard** | [`apps/frontend`](apps/frontend) | Angular 21 · SSR (Express) · Tailwind CSS 4 |
| **Discord Bot** | [`apps/discord-bot`](apps/discord-bot) | TypeScript · discord.js v14 |

---

## Features

### Authentication & Access Control
- **Discord OAuth2 login** (identify + email scopes) with CSRF state tokens and a secure, http-only session cookie (7-day expiry).
- **Role-based access control**: `SuperAdmin`, `Admin`, `Officer`, `User` — resolved automatically from the Discord guild roles.
- **Runtime-reloadable permission cache**: permissions are stored in the database and can be reloaded via `POST /api/admin/permissions/reload` without redeploying.

### Guild Bank
- Per-member ledger with **live-derived balances** (`pending`, `requested`, `withdrawn` states) — no stored balance column.
- **Two-step withdrawal workflow**: a member requests a payout, then an officer accepts (records the payer) or rejects it.
- Guild-wide payout summary for the dashboard; full transaction history with filters and pagination.

### Loot Splits
- Create, update, and delete splits with participant weights (net proceeds distributed proportionally).
- Lifecycle states: `pending`, `completed`, `lost`, `not_completed`.
- **OCR-assisted participant matching**: upload a screenshot, the backend extracts player names via Mistral AI (`POST /api/utils/ocr`) and matches them against the split.

### Events
- Full event lifecycle: create / update / delete, role-based participation (e.g. join as `healer`), and start / stop sessions.
- **Event sessions**: a background worker auto-stops sessions past their deadline and keeps polling AlbionBB until battles are linked to the event.
- **Battle analytics per event/comp**: win rate, kills/deaths, kill fame, top opponents, and linked loot-split stats.
- **Call-to-arms**: announce events to a configured Discord channel with a role ping.

### Battles & Live Albion Data
- Paginated battle list for the configured guild (via [AlbionBB](https://albionbb.com/)) with player/kill timeline detail.
- **Loss estimates** enriched from the Albion Data Project.
- **"My battles"**: battles the calling user participated in, resolved through their linked Albion character.
- Allied guilds are configurable so friendly forces never leak into opponent charts.

### Compositions & Builds
- Categories, builds (with item lists), and compositions with a comp↔build mapping — used by event analytics.

### Siphoned Energy Ledger
- Batch ingestion of siphoned-energy entries with **idempotent batches**, per-player balances (deposited / withdrawn / net debt), filtering, and batch management.

### Audit & Observability
- Full audit log stored in the database, with optional Discord notifications (`DISCORD_AUDIT_LOG_CHANNEL_ID`).
- Structured `tracing` logging (`RUST_LOG`) and an OpenAPI-compliant docs UI.

### Discord Bot (mirror of the web app)
- Slash commands for events, balance, battles, members, and Albion linking — see [the bot's README](apps/discord-bot/README.md).
- Polls the backend and auto-announces new events and battles to configured channels.

---

## Architecture

```mermaid
graph LR
    subgraph Clients
        W[Web Dashboard<br/>Angular 21 + SSR]
        B[Discord Bot<br/>discord.js]
    end

    subgraph Backend[Rust Backend - Axum]
        API[REST API /api/*]
        DOCS[OpenAPI Docs<br/>/scalar]
        WORKER[Background Worker<br/>event sessions]
        PERMS[Permission Cache]
    end

    subgraph External[External Services]
        DISCORD[Discord OAuth2 + API]
        ALBION[Albion Online API]
        ALBIONBB[AlbionBB API]
        DATA[Albion Data Project]
        MISTRAL[Mistral AI - OCR]
        OPENALBION[OpenAlbion]
    end

    DB[(PostgreSQL)]

    W -->|HTTP / session cookie| API
    B -->|HTTP / X-Bot-Secret| API
    API --> DB
    WORKER --> DB
    API --> DISCORD
    API --> ALBION
    API --> ALBIONBB
    API --> DATA
    API --> MISTRAL
    API --> OPENALBION
    WORKER --> ALBIONBB
    DOCS --> API
    PERMS --> API
```

The backend exposes a single Axum router nested under `/api` with one module per domain (`auth`, `users`, `bank`, `splits`, `events`, `battles`, `comps`, `siphoned`, `albion`, `albionbb`, `albiondata`, `openalbion`, `admin`, `audit`, `health`, `utils`). A long-running background task handles event-session auto-stop and battle linking.

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Backend | Rust (edition 2024), [Axum 0.8](https://github.com/tokio-rs/axum), Tokio, SeaORM 1.1 (PostgreSQL), utoipa / Scalar |
| Database | PostgreSQL (see `docker-compose.yml` for the pinned image) |
| Frontend | Angular 21, Angular SSR (Express), Tailwind CSS 4, Vitest, Prettier |
| Bot | TypeScript 5.9, discord.js 14, Zod |
| Deployment | Docker / Docker Compose, images published to `ghcr.io/alessandrobrunoh/*` |

---

## Repository Layout

```
albion-guild-manager-from-weaklings/
├── apps/
│   ├── backend/            # Rust API (Axum + SeaORM + Postgres)
│   │   └── src/
│   │       ├── modules/    # One module per domain (bank, splits, events, ...)
│   │       ├── migration/  # SeaORM migrations
│   │       └── event_sessions/  # Background worker
│   ├── frontend/           # Angular 21 + SSR web dashboard
│   │   └── src/app/
│   │       ├── core/       # Guards, models, services, tokens
│   │       ├── features/   # Page-level feature modules
│   │       ├── layout/     # Shell, topbar, sidebar
│   │       └── i18n/       # Localization
│   └── discord-bot/        # discord.js slash-command bot
│       └── src/
│           ├── commands/   # One file per slash command
│           ├── embeds/     # Event / battle embed builders
│           └── services/   # Polling loop, command registry
├── plans/                  # Design plans (e.g. siphoned module)
├── DESIGN.md               # UI/UX design specification
├── docker-compose.yml      # Full stack deployment
└── Cargo.toml              # Workspace manifest (backend)
```

---

## Getting Started

### Prerequisites

- [Docker](https://www.docker.com/) + Docker Compose (recommended path), **or**
- Rust 1.88+ (backend), Node.js 22+ (frontend & bot), PostgreSQL (local path)
- A **Discord Application** with a bot user (see [Discord Developer Portal](https://discord.com/developers/applications))
- An **Albion Online guild ID** and API region
- *(Optional)* A [Mistral AI](https://mistral.ai/) API key for the OCR feature

### 1. Configure environment

Copy `.env.example` to `.env` and fill in the values. The most important ones:

```env
# Database
POSTGRES_USER=weaklings
POSTGRES_PASSWORD=change_me
POSTGRES_DB=weaklings
DATABASE_URL=postgres://weaklings:change_me@localhost:5434/weaklings

# Backend
BACKEND_PORT=3000
FRONTEND_URL=http://localhost:5000
RUST_LOG=backend=debug,tower_http=debug

# Discord OAuth2 (backend)
DISCORD_CLIENT_ID=your_client_id
DISCORD_CLIENT_SECRET=your_client_secret
DISCORD_REDIRECT_URI=http://localhost:5000/api/auth/discord/callback
DISCORD_GUILD_ID=your_server_id
SUPER_ADMIN_DISCORD_ID=your_discord_user_id

# Albion
ALBION_GUILD_ID=your_in_game_guild_id
ALBION_API_REGION=europe   # americas | europe | asia
ALBION_ALLIED_GUILD_IDS=   # optional, comma-separated
ALBION_ALLIED_GUILD_NAMES= # optional, comma-separated

# Optional features
MISTRAL_API_KEY=your_mistral_key
DISCORD_BOT_TOKEN=your_bot_token
BOT_API_SECRET=strong_random_secret
```

A full reference table with every variable is in [Environment Variables](#environment-variables).

### 2. Run the full stack with Docker Compose

```bash
docker compose up -d
```

This starts:

| Service | Address |
| --- | --- |
| PostgreSQL | `localhost:5434` |
| Backend API | `localhost:8001` (container port 3000) |
| Web Dashboard | `localhost:5000` |
| Discord Bot | background process (no inbound port) |

The Compose file pulls prebuilt images from `ghcr.io/alessandrobrunoh/weaklings-{backend,frontend,discord-bot}`. To build them locally instead, run `docker compose build` first.

### 3. Run locally (development)

**Backend**

```bash
cd apps/backend
cargo run
```

The backend runs pending migrations at startup, so no manual step is needed. API docs are served at `http://localhost:3000/scalar`.

**Frontend**

```bash
cd apps/frontend
npm install
npm start   # dev server on http://localhost:4200
```

The Angular dev server proxies `/api` and `/scalar` to `http://localhost:3000` via [`proxy.conf.json`](apps/frontend/proxy.conf.json).

**Discord Bot**

```bash
cd apps/discord-bot
npm install
npm run dev   # watch mode, loads ../../.env
```

> The bot expects the backend to be reachable at `BACKEND_URL` and to accept requests carrying the shared `BOT_API_SECRET` (`X-Bot-Secret` header) — set the same `BOT_API_SECRET` on both sides.

---

## Environment Variables

### Backend (`apps/backend`)

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `BACKEND_PORT` | no | `3000` | HTTP listen port |
| `DATABASE_URL` | yes | — | PostgreSQL connection string |
| `DISCORD_CLIENT_ID` | yes | — | Discord OAuth2 client ID |
| `DISCORD_CLIENT_SECRET` | yes | — | Discord OAuth2 client secret |
| `DISCORD_REDIRECT_URI` | yes | — | OAuth2 redirect URI (`.../api/auth/discord/callback`) |
| `DISCORD_GUILD_ID` | yes | — | Discord server (guild) ID for role resolution |
| `SUPER_ADMIN_DISCORD_ID` | yes | — | Discord user ID granted `SuperAdmin` |
| `FRONTEND_URL` | no | `http://localhost:3001` | Where to redirect after login |
| `ALBION_GUILD_ID` | yes | — | In-game guild ID for roster / battles |
| `ALBION_API_REGION` | no | `europe` | `americas` \| `europe` \| `asia` |
| `ALBION_ALLIED_GUILD_IDS` | no | — | Comma-separated allied guild IDs |
| `ALBION_ALLIED_GUILD_NAMES` | no | — | Comma-separated allied guild names (fallback) |
| `MISTRAL_API_KEY` | yes | — | Used by `POST /api/utils/ocr` |
| `ALBIONBB_BASE_URL` | no | `https://api.albionbb.com` | AlbionBB API base URL |
| `ALBIONBB_REQUEST_TIMEOUT_SECS` | no | `60` | AlbionBB request timeout |
| `ALBIONDATA_REQUEST_TIMEOUT_SECS` | no | `30` | Albion Data Project timeout |
| `DISCORD_BOT_TOKEN` | no | — | Bot token for server-side Discord calls |
| `BOT_API_SECRET` | no | — | Enables bot-header auth (`X-Bot-Secret` / `X-Discord-Id`) |

The audit-log channel, transaction-spam channel, call-to-arms channel and event-ping role used to
be set via `DISCORD_AUDIT_LOG_CHANNEL_ID` / `DISCORD_TRANSACTION_SPAM_CHANNEL_ID` /
`DISCORD_BATTLES_CTA_CHANNEL_ID` / `DISCORD_EVENT_ROLE_ID` here. They now live in the
`guild_settings` DB table instead, editable from **Admin → Discord integration** in the web app —
no redeploy needed to change one.

### Discord Bot (`apps/discord-bot`)

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | yes | Bot token |
| `DISCORD_CLIENT_ID` | yes | Application client ID |
| `DISCORD_GUILD_ID` | yes | Server ID for command registration |
| `BACKEND_URL` | yes | Backend base URL |
| `BOT_API_SECRET` | yes | Must match the backend's `BOT_API_SECRET` |
| `GUILD_NAME` | no | Display name used in announcements |
| `POLL_INTERVAL_MS` | no | Polling cadence for new events/battles |

The events/battles channels and event-ping role used to be set here too (`DISCORD_EVENTS_CHANNEL_ID`
/ `DISCORD_BATTLES_CHANNEL_ID` / `EVENT_ROLE_ID`). The bot now fetches them from the backend's
**Admin → Discord integration** settings at startup and refreshes periodically, so a change there
takes effect without redeploying the bot.

See [apps/discord-bot/README.md](apps/discord-bot/README.md) for full bot setup instructions (creating the Discord application, gateway intents, and the invite link).

---

## API Documentation

The backend ships an OpenAPI 3.x description generated at compile time with [utoipa](https://github.com/juhaku/utoipa), served through a [Scalar](https://scalar.com/) UI:

```
http://localhost:3000/scalar
```

Every endpoint documents its request/response schemas, security requirements (session cookie or bot header), and error conditions (`ProblemDetails` bodies).

---

## Roles & Permissions

Roles are resolved from the user's Discord roles in the configured guild and mapped to a local hierarchy:

```
SuperAdmin  >  Admin  >  Officer  >  User
```

Permission checks are centralized on a **permission cache** loaded from the database at startup. Role → permission mappings can be edited in the database and applied at runtime via `POST /api/admin/permissions/reload`, without a redeploy.

---

## Design & Plans

- [`DESIGN.md`](DESIGN.md) — UI/UX design specification for the dashboard (dark theme, sidebar layout, color tokens).
- [`plans/`](plans) — module design plans written before implementation (e.g. the siphoned-energy module contract).

---

## License

[MIT](LICENSE) © 2026 Weaklings.
