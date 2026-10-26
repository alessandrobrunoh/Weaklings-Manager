# Platform module

## Overview

The platform module provides control-plane administration, public tenant onboarding, and alliance membership APIs. Its routers operate on control-plane state rather than a tenant schema `search_path`.

## Interface

The platform-admin API is documented under `/api/platform` and includes tenant CRUD, feature catalog and tenant feature flags, rank management, and platform-admin management/reload.

The public onboarding API is documented under `/api/tenants`: tenant status, registration, Albion search, and attachable-guild lookup. The alliance API is documented under `/api/alliances`: current alliance, member listing, member update, and member acceptance.

`PlatformAdmin` is an extractor that identifies a platform administrator from the session. `PlatformService` backs the routers. The module re-exports `router`, `public_router`, and `alliance_router`.

## Invariants

- Tenant status is `provisioning`, `active`, or `suspended`; tenant kind distinguishes `guild` and `alliance`.
- Guild registration normalizes its Albion region and requires an Albion guild ID. Alliance registration resolves a non-empty set of unique member IDs; each must be an active guild without an existing alliance membership.
- Membership is active when the guild owner registers, otherwise pending. Member inserts are transactional.
- Omitted feature keys are left unchanged. Feature allowlist enforcement is conditional; the platform feature route passes `false`.
- Platform-admin extraction requires a valid private session cookie and a matching Discord ID in the platform-admin cache.

## Side Effects

Tenant registration checks guild-management access and may fetch a Discord guild icon before creating tenant/settings/membership state. Albion search calls the Albion service. Feature updates upsert flags, evict the tenant from `TenantRegistry`, then reload the feature view. Platform-admin assignment inserts the fixed SuperAdmin role assignment, treating conflicts as a no-op.

## Verification

From the repository root, run `cargo test -p backend`.
