# Admin features

## Overview

This directory contains administrative pages and helpers for tenant configuration, giveaways, permissions, guild islands, finance, roles, and related operations. The source scan was necessarily partial because many page files exceed the per-file read cap.

## Interface

- `AdminFeatures` reads and saves `TenantFeaturesView` through `api/admin/features`; its rows are drawn from the feature catalog.
- `AdminGiveawayDetail` loads `GiveawayDetailView` for the route's giveaway ID and exposes draw/cancel controls when eligible.
- `groupPermissions` maps catalog or available permission keys into permission groups. `groupIslandsBySourceGuild` groups island records by source guild.
- `AdminWithdrawals` is the officer withdrawal queue. Status tabs (`status` URL param) read `api/bank/transactions`; the summary band and tab counts come from a `requested` fetch and limit-1 count calls that ignore search. Each player's requested transactions form one row; pay and reject post every id of that row to `api/bank/transactions/withdraw/{accept,reject}` after a confirmation.
- Other admin pages use shared API model contracts; this scan does not establish the complete page or route inventory.

## Invariants

- Feature rows are restricted to `allowed_keys`; enabled state resolves from local override, API value, then `false`.
- Giveaway actions are displayed only for an open giveaway and users with `giveaways.manage`; this is a frontend gate, not evidence of backend authorization.
- Withdrawal rows group `requested` transactions by guild tenant and player; the row's pay action sends every id of that row, while the review dialog may send a selected subset.
- Permission grouping prefers a nonempty catalog. Island grouping uses trimmed source-guild IDs, sorts unknown groups last, and sorts items by name then ID.

## Side Effects

The inspected feature and giveaway pages issue API requests, update local state, and display success/error toasts. Grouping helpers perform local transformations without service calls.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. Fifteen large admin page sources were not inspected because each exceeds 300 lines; the module scan covered selected files within the 50 KB directory budget.
