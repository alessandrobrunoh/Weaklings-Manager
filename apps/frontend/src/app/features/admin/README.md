# Admin features

## Overview

This directory contains administrative pages and helpers for tenant configuration, giveaways, permissions, guild islands, finance, roles, and related operations. The source scan was necessarily partial because many page files exceed the per-file read cap.

## Interface

- `AdminFeatures` reads and saves `TenantFeaturesView` through `api/admin/features`; its rows are drawn from the feature catalog.
- `AdminGiveawayDetail` loads `GiveawayDetailView` for the route's giveaway ID and exposes draw/cancel controls when eligible.
- `groupPermissions` maps catalog or available permission keys into permission groups. `permissionParts` splits a key into its verb and object for plain-language row titles. `groupIslandsBySourceGuild` groups island records by source guild.
- `AdminPermissions` is the role x permission matrix. It uses `app-filter-bar` for search, the area select and the visible-roles facet, and `app-summary-band` for roles, permissions and permissions no role grants. Each row shows its title, its key and the roles that hold it. Each box saves on its own; saves for one role run in a queue so each starts from the permissions the previous save left. The save state line above the matrix reports saving, saved or failed.
- Other admin pages use shared API model contracts; this scan does not establish the complete page or route inventory.

## Invariants

- Feature rows are restricted to `allowed_keys`; enabled state resolves from local override, API value, then `false`.
- Giveaway actions are displayed only for an open giveaway and users with `giveaways.manage`; this is a frontend gate, not evidence of backend authorization.
- Permission grouping prefers a nonempty catalog. The last visible role cannot be hidden. Island grouping uses trimmed source-guild IDs, sorts unknown groups last, and sorts items by name then ID.

## Side Effects

The inspected feature and giveaway pages issue API requests, update local state, and display success/error toasts. Grouping helpers perform local transformations without service calls.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. Fifteen large admin page sources were not inspected because each exceeds 300 lines; the module scan covered selected files within the 50 KB directory budget.
