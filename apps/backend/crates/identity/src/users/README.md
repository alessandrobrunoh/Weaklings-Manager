# Users module

## Overview

The users module provides profiles, metrics, user listing, Albion identity linking, declared weapons, and Discord-role synchronization. Identity, display-name resolution, roles, and weapons have separate implementation boundaries.

## Interface

The router documents APIs under `/api/users`: caller profile/metrics; user list/create/detail; and role list/assign/remove operations. Role assignment requires `roles.manage`.

Member weapons (`GET`/`PUT /api/users/me/weapons` and `/api/users/{user_id}/weapons`) are served by `backend_combat::user_weapons` and merged into this router by the app registry, because validating a key needs the item catalog and the catalog crate depends on this one. The rows, DTOs and lookups live here in `weapons.rs`: one `user_weapons` row per member and `weapon:{BASE}` key, with a declared level (`main`, `good`, `basic`) and/or an officer lock. A row with no level and no lock is never stored.

Key types include `UserProfile`, `UserMetrics`, `CreateUserRequest`, and `UserRolesView`.

## Invariants

- A member can be blocked from the manager (`POST`/`DELETE /api/users/{user_id}/block`, `roles.manage`). Blocking sets `users.blocked_at/blocked_by/blocked_reason` and is audited (`USER_BLOCK`, `USER_UNBLOCK`); enforcement lives in `auth/rbac.rs` (see the auth README). Nothing changes on Discord. Self, the tenant owner, platform admins and higher-priority roles cannot be blocked. `UserProfile.blocked*` and the `blocked` list filter are only honoured for `roles.manage` viewers.
- User email and optional Discord ID are unique. Discord snowflake is the stable identity: email can claim only a row without a Discord ID, only when Discord marked it verified (login drops an unverified one), and a missing, unverified or colliding address gets a generated `<discord_id>@discord.invalid` placeholder.
- `UserProfile.email` is returned only for the caller's own row and to `users.create`/`roles.manage` holders (tenant owner and platform admins included); `GET /api/users` has no email filter.
- Display names prefer the linked Albion character name, then the stored username; missing user rows resolve to `"Unknown"`.
- Members' Destiny Board levels are not stored; declared weapons (`user_weapons`) are the only member-skill data.
- A member cannot declare a weapon an officer locked for them, and replacing their own weapons never changes or deletes locked rows. Managing another member's weapons (which can clear locks) always needs `users.weapons.manage`, even for the caller's own rows.
- Role assignment/removal rejects the generic staff role and roles without a Discord link. Editors who do not bypass priority (`UserContext::bypasses_priority`: platform admins and the tenant owner) cannot act on higher-priority roles than their own highest named-role priority.
- The generic staff role is derived from held, linked roles marked `grants_staff`.

## Side Effects

`create_linked_member` inserts a user and Albion link in a database transaction. Role add/remove calls the Discord API, reconciles the derived staff role, refreshes cached highest role, and attempts an audit log. Role listing may query Discord for held role IDs.

## Verification

From the repository root, run `cargo test -p backend-identity`.
