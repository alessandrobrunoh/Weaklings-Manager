# Intelligence

## Overview

This directory contains Intel overview/report/scout pages, saved scout dossiers, enemy guild/player lists, and individual enemy dossiers.

## Interface

- `Intel` presents reports and scout library; `IntelDetailPage` presents a saved dossier and similar scouts.
- `Opponents` lists enemy guilds and players; detail pages present guild and player dossiers.
- Dossier pages use route-bound string IDs. The opponent table accepts query-derived paging/search/sort state and an optional numeric guild filter.

## Invariants

- Invalid numeric dossier IDs clear the dossier and stop loading. A 404 leaves the dossier empty without setting the general failure state.
- Opponent guilds load initially; player loading is deferred until the Players tab is opened.
- Scout editing requires `intel.edit` in both edit-start and save paths. Secondary report/matchup failures are handled separately from the main library load.

## Side Effects

Pages call `IntelService`, `EnemiesService`, and `ApiService`, navigate to related destinations, and may show error/success toasts. Scout editing updates local dossier state after the service call.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. Source ranges stayed within the 50 KB directory budget; large files were reviewed through selected excerpts.
