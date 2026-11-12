# Intelligence

## Overview

Intel is one section with five tabs, each answering one question about the guild's fights. `IntelShell` owns the page header, the tabs and the shared period; each tab is a child route of `/intel`.

| Route | Page | Answers | Permission |
| --- | --- | --- | --- |
| `/intel` | `IntelOverviewPage` | How are we doing, and what changed since the previous period? | `intel.view` |
| `/intel/players` | `IntelPlayersPage` | How is each member doing? | `intel.view` (members see only themselves; `intel.report.view` sees everyone) |
| `/intel/players/:userId` | `IntelPlayerDetailPage` | One member's trend, fights, weapons, roles, builds and comps | own page with `intel.view`; any member with `intel.report.view` |
| `/intel/fights` | `IntelFightsPage` | Every fight, filtered by period, outcome, opponent, comp and size | `intel.view` |
| `/intel/comps` | `IntelCompsPage` | Which comps do well, and against whom? | `intel.view` |
| `/intel/opponents` | `Opponents` | Who do we face? Guilds and Players need `intel.opponents.view`; Scouted comps and Matchups need `intel.view` | see left |
| `/intel/opponents/guilds/:id`, `/intel/opponents/players/:id` | enemy dossiers | One enemy guild or player | `intel.opponents.view` |
| `/intel/opponents/scouts/:scoutId` | `IntelDetailPage` | One scouted composition: edit, similar, counters | `intel.view` |

## Interface

- `IntelPeriodState` (provided by the shell and by the player detail page) holds the selected period and mirrors it to the URL as `period` or `from`/`to`. `IntelPeriod` is the selector. Pages react to `IntelPeriodState.query`.
- `IntelFormat` formats numbers, dates and Albion ids; missing values render as an em dash.
- `OutcomeChip` renders a fight outcome as icon plus word. `unknown` is neutral, never a loss.
- `intel-charts.ts` builds the weekly trend chart and its table twin.
- `ScoutLibrary` and `MatchupMatrix` are the two member-visible views embedded in `Opponents`.

## Invariants

- Rates are `null` when their denominator is empty; the UI shows an em dash, not `0%`.
- Fights with an unknown outcome are left out of the win rate.
- The estimated silver lost is withheld by the backend without `intel.report.view`, so the KPI is simply absent for members.
- Pages ignore a response that is not for the latest request, so switching the period quickly cannot show stale numbers.
- Dossier pages use route-bound string IDs. Invalid numeric IDs clear the dossier and stop loading; a 404 leaves it empty without setting the general failure state.
- Scout editing requires `intel.edit` in both edit-start and save paths.

## Side Effects

Pages call `IntelService` and `EnemiesService`, navigate to related destinations, and may show error or success toasts. Period changes rewrite the page URL in place.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
