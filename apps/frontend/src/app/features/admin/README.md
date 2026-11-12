# Admin features

## Overview

This directory contains administrative pages and helpers for tenant configuration, giveaways, permissions, guild islands, finance, roles, and related operations. The source scan was necessarily partial because many page files exceed the per-file read cap.

## Interface

- `AdminFeatures` reads and saves `TenantFeaturesView` through `api/admin/features`; its rows are drawn from the feature catalog.
- `AdminGiveawayDetail` loads `GiveawayDetailView` for the route's giveaway ID and exposes draw/cancel controls when eligible.
- `groupPermissions` maps catalog or available permission keys into permission groups. `groupIslandsBySourceGuild` groups island records by source guild.
- Other admin pages use shared API model contracts; this scan does not establish the complete page or route inventory.

## Invariants

- Feature rows are restricted to `allowed_keys`; enabled state resolves from local override, API value, then `false`.
- Giveaway actions are displayed only for an open giveaway and users with `giveaways.manage`; this is a frontend gate, not evidence of backend authorization.
- Permission grouping prefers a nonempty catalog. Island grouping uses trimmed source-guild IDs, sorts unknown groups last, and sorts items by name then ID.
- Island list (`admin-islands`): a summary band, then one `app-data-table` per source guild for alliance tenants (headed by the guild name) or a single table for guild tenants. Each table has its own URL sync turned off. Edit is a row button and delete sits in the row menu. Adding tabs happens on the detail page only.
- Island detail (`admin-island-detail`): `app-entity-header` (delete in its menu) with a summary band, then sections for the island details (guild tenants only), its chest tabs (`app-data-table` with a row menu for move and delete), and who manages it.

## Side Effects

The inspected feature and giveaway pages issue API requests, update local state, and display success/error toasts. Grouping helpers perform local transformations without service calls.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. Fifteen large admin page sources were not inspected because each exceeds 300 lines; the module scan covered selected files within the 50 KB directory budget.
