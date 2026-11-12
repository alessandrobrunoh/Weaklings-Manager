# Platform administration

## Overview

This directory contains control-plane pages for the platform hub, platform admins, tenant feature flags, tenants, ranks, and tenant details.

## Interface

- `PlatformHub` displays tenant/admin counts and panel links.
- `PlatformAdmins` lists admins in an `app-data-table`. Access is granted from a dialog opened by the header action; each row menu removes access after a confirmation dialog. The page closes with an explanation of what platform admin access allows.
- `PlatformHub` is the operator landing page. An `app-summary-band` shows tenant and admin counts (from the two list requests it already makes, `—` when a count is unavailable), then three groups: Tenants, Access and Configuration. Each entry is a link with an icon, a name and one line on what happens there. Feature flags are stored per tenant, so their entry opens the tenant list.
- `PlatformAdmins` lists and assigns/revokes admins.
- `PlatformFeatureFlags` displays a tenant feature catalog and saves flag values.
- `PlatformAdmins` lists and assigns/revokes admins.
- `PlatformFeatureFlags` lists the feature catalog for one tenant as a table (rank allowance, tenant override, toggle), filters it by search, state and changed rows, confirms before turning any feature off, and saves the flag values.
- `PlatformRanks` lists ranks with the modules each unlocks; creating a rank and editing its modules happen in dialogs, and deleting asks for confirmation.
- `PlatformTenants` lists, creates, suspends, and resumes tenants.
- `PlatformTenantDetail` shows one tenant: status and the next action in the entity header (resume when suspended; suspend sits in the overflow menu behind a confirmation), then tabs for the record and display name, SuperAdmin and rank, the Albion guild link, and feature flags (loaded the first time that tab opens).

## Invariants

- Hub counts load independently; a failed count remains unavailable. The band shows a skeleton until both requests settle.
- Hub entries only link to routes that exist under `/platform`; the guard is unchanged.
- `PlatformTenants` lists guild and alliance tenants in a data table with a summary band (total, guilds, alliances, suspended), a search and kind/status filter bar, and a row menu to suspend or resume; creates tenants from a dialog.

## Invariants

- Hub counts load independently; a failed count remains unavailable.
- Tenants page summary counts cover every loaded tenant and show an em dash while loading; search and facets filter only the rows.
- Admin assignment trims IDs, avoids duplicate rows, and blocks self-revocation.
- Feature display uses local override, API value, then `false`; tenant state changes are limited to `active` and `suspended`.
- Feature saves send every flag. Save stays disabled until a flag differs from the saved value, and a save that turns a feature off waits for confirmation. A failed save keeps the edits.
- Each tenant detail section saves only its own fields in one PATCH; suspending always asks for confirmation first.

## Side Effects

The inspected pages issue platform tenant/admin/feature API requests and show success/error toasts. Initial page loads begin from component constructors.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. `platform-ranks.ts` was not inspected because it exceeds 300 lines.
