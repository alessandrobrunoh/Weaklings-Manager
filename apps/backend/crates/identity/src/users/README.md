# Users module

## Overview

The users module provides profiles, metrics, user listing, Albion identity linking, specialization management, and Discord-role synchronization. Identity, display-name resolution, roles, and specializations have separate implementation boundaries.

## Interface

The router documents APIs under `/api/users`: caller profile/metrics/specializations; user list/create/detail; other-user specializations; and role list/assign/remove operations. Role assignment requires `roles.manage`; managing another user's specializations requires `UsersSpecializationsManage`.

Member weapons (`GET`/`PUT /api/users/me/weapons` and `/api/users/{user_id}/weapons`) are served by `backend_combat::user_weapons` and merged into this router by the app registry, because validating a key needs the item catalog and the catalog crate depends on this one. The rows, DTOs and lookups live here in `weapons.rs`: one `user_weapons` row per member and `weapon:{BASE}` key, with a declared level (`main`, `good`, `basic`) and/or an officer lock. A row with no level and no lock is never stored.

Key types include `UserProfile`, `UserMetrics`, `CreateUserRequest`, `UpdateSpecializationsRequest`, and `UserRolesView`.

## Invariants

- User email and optional Discord ID are unique. Discord snowflake is the stable identity: email can claim only a row without a Discord ID, only when Discord marked it verified (login drops an unverified one), and a missing, unverified or colliding address gets a generated `<discord_id>@discord.invalid` placeholder.
- `UserProfile.email` is returned only for the caller's own row and to `users.create`/`roles.manage` holders (tenant owner and platform admins included); `GET /api/users` has no email filter.
- Display names prefer the linked Albion character name, then the stored username; missing user rows resolve to `"Unknown"`.
- Specialization keys are canonicalized by trimming, lowercasing category, uppercasing identifier, and removing a leading `T1_`–`T8_` tier prefix. Duplicate canonical keys keep the maximum level.
- Specialization DTOs document levels `0..=120` for weapon/armor and `0..=100` for mastery; bulk updates are capped at 500 rows.
- A member cannot declare a weapon an officer locked for them, and replacing their own weapons never changes or deletes locked rows. Managing another member's weapons (which can clear locks) always needs `UsersSpecializationsManage`, even for the caller's own rows.
- Role assignment/removal rejects the generic staff role and roles without a Discord link. Editors who do not bypass priority (`UserContext::bypasses_priority`: platform admins and the tenant owner) cannot act on higher-priority roles than their own highest named-role priority.
- The generic staff role is derived from held, linked roles marked `grants_staff`.

## Side Effects

`create_linked_member` inserts a user and Albion link in a database transaction. Role add/remove calls the Discord API, reconciles the derived staff role, refreshes cached highest role, and attempts an audit log. Role listing may query Discord for held role IDs.

## Verification

From the repository root, run `cargo test -p backend-identity`.
