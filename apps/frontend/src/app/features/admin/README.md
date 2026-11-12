# Admin features

## Overview

This directory contains administrative pages and helpers for tenant configuration, giveaways, permissions, guild islands, finance, roles, and related operations. The source scan was necessarily partial because many page files exceed the per-file read cap.

## Interface

- `AdminFeatures` reads and saves `TenantFeaturesView` through `api/admin/features`. It lists every catalog feature grouped by area; features outside `allowed_keys` and the platform-managed `sidebar` key are shown locked with the reason and are not sent on save.
- `AdminGiveawayDetail` loads `GiveawayDetailView` for the route's giveaway ID and exposes draw/cancel controls when eligible.
- `AdminAlliance` reads `AllianceContext` (`api/alliances/me`) and saves Discord role settings. Its sections are the alliance status, the member guilds (`app-data-table`, pending invites counted in a summary band) and what is shared (Discord roles). Accept, link, leave, redo-link and re-invite are the header action or menu entries; link, leave, redo-link and re-invite open a dialog before they call the API.
- `groupPermissions` maps catalog or available permission keys into permission groups. `groupIslandsBySourceGuild` groups island records by source guild.
- `AdminApplications` edits the Discord applications panel (`api/admin/settings`): an open/closed `app-tabs` switch, channel and role pickers, and bot copy, saved with one primary action. It has no applicant queue: the backend has no list endpoint for applications.
- `AdminDiscord` edits the guild's Discord channels, split forum, notifications and roles in one form with one save. It writes `api/admin/settings` and `api/admin/autorole`; its connection status comes from loading the Discord channel and role catalog.
- `AdminFinance` loads `api/bank/admin/summary` (whole ledger, ignores the period) and `api/intel/report` twice (the selected window and the window before it, for deltas). Each section tab shows one `app-summary-band` and then one chart or one `app-data-table`; the ledger breakdown and member ledger are tables with a totals row.
- Other admin pages use shared API model contracts; this scan does not establish the complete page or route inventory.

## Invariants

- Feature rows are all catalog entries. A row is editable only when its key is in `allowed_keys` and it is not platform-managed; enabled state resolves from local override, API value, then `false`. Save sends only editable rows and is disabled while nothing has changed.
- Giveaway actions are displayed only for an open giveaway and users with `giveaways.manage`; this is a frontend gate, not evidence of backend authorization.
- `AdminDiscord` hides its form when the guild settings or default join role cannot be read, so a save never writes blank defaults over them. A failed catalog load shows a "not connected" status with retry and keeps the form.
- Finance income comes only from splits the user created (`split_*` economics); battle data is never used to infer earnings.
- Permission grouping prefers a nonempty catalog. Island grouping uses trimmed source-guild IDs, sorts unknown groups last, and sorts items by name then ID.

## Side Effects

The inspected feature and giveaway pages issue API requests, update local state, and display success/error toasts. Grouping helpers perform local transformations without service calls.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. Fifteen large admin page sources were not inspected because each exceeds 300 lines; the module scan covered selected files within the 50 KB directory budget.
