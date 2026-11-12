# Albion module

## Overview

This directory contains the Albion client, service, router, and link-related module code. Detailed router and service behavior remains pending a compliant bounded review.

## Interface

The bounded client excerpt exposes search, player, guild, guild-member, and alliance calls. The entity excerpt defines `albion_link::Model` with Discord ID, Albion player ID/name, and link timestamp.

(Details pending/documentation failed) HTTP route mappings, authorization, and service behavior need a compliant bounded review.

## Linking

A self-service link (`POST /albion/link`, `POST /albion/register`) applies immediately; there is
no approval step (`claim_character` in `router.rs`):

- `create_link` inserts the `albion_links` row and the audit row in one transaction. One
  Discord account holds one link and one character belongs to one account (unique columns, `409`
  otherwise); only a `roles.manage` holder can re-assign a character
  (`POST /albion/link/users/{user_id}`).
- Then, best effort, `apply_link_effects` sets the nickname, the Guild role (only for a character
  in the configured Albion guild) and copies the link to paired alliance/guild tenants.
- `notify.rs` posts a "character linked" notice to the guild's audit-log channel
  (`discord_audit_log_channel_id`) so officers still see links happen. Best-effort, in the
  background, never pings a role; with no channel or bot token configured it does nothing.
- Audited as `ALBION_LINK`, `ALBION_UNLINK` and `ALBION_RELINK` (`via` says which door).
- Migration `m20261113_000001` applied every claim still waiting in the old
  `albion_link_requests` queue and dropped the table.

## Invariants

- The bounded entity excerpt marks both Discord ID and Albion player ID unique.
- (Details pending/documentation failed) Link validation, roster selection, and role-assignment rules require a compliant bounded service/router review.

## Side Effects

The bounded client excerpt makes HTTP requests to the regional Albion game-data service with a 30-second timeout.

(Details pending/documentation failed) Database, Discord, and alliance-fanout effects require a compliant bounded service/router review.

## Verification

From the repository root, run `cargo test -p backend-identity`.
