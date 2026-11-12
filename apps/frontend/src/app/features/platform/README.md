# Platform administration

## Overview

This directory contains control-plane pages for the platform hub, platform admins, tenant feature flags, tenants, ranks, and tenant details.

## Interface

- `PlatformHub` displays tenant/admin counts and panel links.
- `PlatformAdmins` lists and assigns/revokes admins.
- `PlatformFeatureFlags` displays a tenant feature catalog and saves flag values.
- `PlatformTenants` lists, creates, suspends, and resumes tenants.
- `PlatformTenantDetail` shows one tenant: status and the next action in the entity header (resume when suspended; suspend sits in the overflow menu behind a confirmation), then tabs for the record and display name, SuperAdmin and rank, the Albion guild link, and feature flags (loaded the first time that tab opens).

## Invariants

- Hub counts load independently; a failed count remains unavailable.
- Admin assignment trims IDs, avoids duplicate rows, and blocks self-revocation.
- Feature display uses local override, API value, then `false`; tenant state changes are limited to `active` and `suspended`.
- Each tenant detail section saves only its own fields in one PATCH; suspending always asks for confirmation first.

## Side Effects

The inspected pages issue platform tenant/admin/feature API requests and show success/error toasts. Initial page loads begin from component constructors.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. `platform-ranks.ts` was not inspected because it exceeds 300 lines.
