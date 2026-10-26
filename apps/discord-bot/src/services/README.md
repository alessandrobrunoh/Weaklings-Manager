# Bot services

## Overview

This directory contains reusable bot workflows and lifecycle services used by command and interaction handlers. The inspected boundaries include per-guild poller management, tenant and website-account gates, command registration, event lifecycle operations, and application/event-thread helpers.

## Interface

- `poller-manager.ts` reconciles pollers against registered guilds and provides per-guild setup and teardown.
- `tenant-gate.ts` checks guild registration and supplies a guild-scoped `ApiClient` for registered tenants.
- `registry.ts` serializes slash commands and registers them with Discord.
- `event-lifecycle.ts` coordinates Mass, Start, Stop, and voice-channel lifecycle operations.
- `application-ticket.ts` and `event-announcement-thread.ts` provide reusable ticket and event-thread operations.
- Other service modules cover additional bot workflows; see their implementation for their specific entry points.

## Invariants

- Poller reconciliation skips overlapping runs, starts pollers for registered guilds, and does not tear down a running poller solely because a status check failed.
- Guild-specific pollers use guild-scoped API clients. Tenant status is cached per guild for 60 seconds.
- Event auto-stop requires that a live voice channel was occupied and then remained empty for two consecutive ticks. Stop retains an occupied voice channel.
- Poller checkpoints are per numeric guild ID. An uninitialized checkpoint is used to avoid treating existing records as new announcements at startup.

## Side Effects

- Services make backend API requests and register commands with Discord.
- Event, ticket, and announcement workflows create, update, lock, archive, or delete Discord threads and voice channels; cleanup is best-effort in several failure paths.
- Poller services persist per-guild checkpoint state and manage recurring polling and reconciliation work.
- Tenant-gate failures are logged and treated as unregistered; Discord-facing gate responses are ephemeral.

## Verification

From the repository root, run `npm test --prefix apps/discord-bot`. This builds the bot and runs its configured test suite.
