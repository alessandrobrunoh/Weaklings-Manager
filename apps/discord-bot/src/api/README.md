# API client and contracts

## Overview

This directory adapts bot workflows to the backend HTTP API. It contains the fetch-based client, shared TypeScript request/response types, Discord role-ID normalization, and user-resolution helpers.

## Interface

- `ApiClient` exposes `get`, `post`, `patch`, `put`, `delete`, `getDiscordProfile`, `withGuild`, and `withDiscordActor`.
- `ApiError` carries the HTTP status for failed requests.
- `ApiResponse<T>` requires `status: 'success'` and `data: T`; `PaginatedData<T>` carries `items`, `total_items`, `total_pages`, `current_page`, and `limit`. These are TypeScript declarations, not runtime validation.
- `discordRoleIdsFromMember` handles raw and cache-backed Discord member role representations. `resolveInternalUserId`, `asListItems`, `parseMultiplier`, and `expiryFromDays` are shared data helpers.

## Invariants

- Standard requests include `X-Bot-Secret`; Discord and guild identity headers are included when supplied.
- Discord role claims are sent only when the request's Discord ID matches the configured actor. Role IDs are digit-filtered and deduplicated.
- Successful API responses are unwrapped from `data`; HTTP 204 returns `null`. Non-success responses raise `ApiError`.
- `withGuild` creates a guild-scoped client without carrying an actor claim forward.

## Side Effects

- `ApiClient` sends outbound HTTP requests to the configured backend and serializes request bodies as JSON.
- `getDiscordProfile` treats failed or malformed lookups as unavailable and returns `null`; user-resolution helpers return `null` when all lookup paths fail.
- Role and list normalization helpers do not perform network or Discord operations.

## Verification

From the repository root, run `npm test --prefix apps/discord-bot`. This builds the bot and runs its configured test suite.
