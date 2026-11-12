# Platform administration

## Overview

This directory contains control-plane pages for the platform hub, platform admins, tenant feature flags, tenants, ranks, and tenant details.

## Interface

- `PlatformHub` displays tenant/admin counts and panel links.
- `PlatformAdmins` lists and assigns/revokes admins.
- `PlatformFeatureFlags` lists the feature catalog for one tenant as a table (rank allowance, tenant override, toggle), filters it by search, state and changed rows, confirms before turning any feature off, and saves the flag values.
- `PlatformTenants` lists, creates, suspends, and resumes tenants.

## Invariants

- Hub counts load independently; a failed count remains unavailable.
- Admin assignment trims IDs, avoids duplicate rows, and blocks self-revocation.
- Feature display uses local override, API value, then `false`; tenant state changes are limited to `active` and `suspended`.
- Feature saves send every flag. Save stays disabled until a flag differs from the saved value, and a save that turns a feature off waits for confirmation. A failed save keeps the edits.

## Side Effects

The inspected pages issue platform tenant/admin/feature API requests and show success/error toasts. Initial page loads begin from component constructors.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. `platform-ranks.ts` and `platform-tenant-detail.ts` were not inspected because each exceeds 300 lines.
