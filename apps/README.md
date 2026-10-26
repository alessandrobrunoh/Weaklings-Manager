# Application components

## Overview

This directory groups the three deployable application components of Albion Guild Manager: the
Rust backend API, the Angular web dashboard, and the Discord bot. The backend owns the shared
application API and persistence boundary; the frontend and bot consume that API for user-facing
workflows.

## Interface

- [Backend API](./backend/README.md) — HTTP API, domain services, database access, and background
  event-session work.
- [Web dashboard](./frontend/README.md) — browser and server-rendered application for guild
  management.
- [Discord bot](./discord-bot/README.md) — slash commands and announcements integrated with the
  backend.

## Invariants

- The backend is the system of record for application state shared with the frontend and bot.
- The frontend and bot communicate with the backend through its HTTP API rather than owning
  separate copies of guild state.
- Bot-to-backend authentication settings must agree on both sides.

## Side Effects

- The backend reads and writes PostgreSQL data and communicates with Discord and Albion-related
  services.
- The frontend issues HTTP and WebSocket requests to the backend.
- The bot connects to Discord and makes authenticated HTTP requests to the backend.

## Verification

Run the component checks from the repository root:

- `cargo test -p backend`
- `npm test --prefix apps/frontend`
- `npm test --prefix apps/discord-bot`
