# Albion module

## Overview

This directory contains the Albion client, service, router, and link-related module code. Detailed router and service behavior remains pending a compliant bounded review.

## Interface

The bounded client excerpt exposes search, player, guild, guild-member, and alliance calls. The entity excerpt defines `albion_link::Model` with Discord ID, Albion player ID/name, and link timestamp.

(Details pending/documentation failed) HTTP route mappings, authorization, and service behavior need a compliant bounded review.

## Link approval

Albion has no way to prove who owns a character, so a self-service link (`POST /albion/link`,
`POST /albion/register`) is a **request**, not a link:

- The claim goes to `albion_link_requests` (one open request per Discord account; asking again
  replaces it). It is deliberately *not* in `albion_links`, which loot, regear and split
  attribution all read, so an unvetted claim reaches none of it. No nickname change, Guild role
  or alliance copy happens either.
- A caller holding `roles.manage` is linked at once (`claim_character` in `router.rs`).
- Officers (`roles.manage`) list claims with `GET /albion/link/requests`, then
  `POST /albion/link/requests/{id}/approve` or `/reject`. Approval creates the link, drops
  competing claims on the same character, then applies the nickname, Guild role and alliance
  fan-out (`apply_link_effects`). It never displaces an existing link (`409`).
- When a member files a request, `notify.rs` posts it to the guild's audit-log channel (`discord_audit_log_channel_id`) with a link to the Members page. Best-effort and in the background; no role is pinged, and with no channel or bot token configured it does nothing.
- `DELETE /albion/link` on an account with only a request withdraws it.
- Audited as `ALBION_LINK_REQUEST`, `ALBION_LINK` (`via: approval`), `ALBION_LINK_REJECT` and
  `ALBION_LINK_REQUEST_CANCEL`. Creating a real link (admin or fan-out) clears the account's
  open request.

## Invariants

- The bounded entity excerpt marks both Discord ID and Albion player ID unique.
- (Details pending/documentation failed) Link validation, roster selection, and role-assignment rules require a compliant bounded service/router review.

## Side Effects

The bounded client excerpt makes HTTP requests to the regional Albion game-data service with a 30-second timeout.

(Details pending/documentation failed) Database, Discord, and alliance-fanout effects require a compliant bounded service/router review.

## Verification

From the repository root, run `cargo test -p backend-identity`.
