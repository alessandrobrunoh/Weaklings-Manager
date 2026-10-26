# Guild overview

## Overview

`GuildOverviewPage` brings combat, roster, economy, meta, and leaderboard data from a `GuildReport` into one reporting window.

## Interface

- Tabs are Overview, Roster, Economy, Meta, and Leaderboards.
- Periods are 7, 30, 90, or custom days. Initial state selects Overview and a 30-day period.

## Invariants

- Custom date ranges require both valid dates and `from < to`; invalid ranges are rejected.
- An initial load uses loading state when there is no report; later period loads use refreshing state.
- Invalid refresh ranges do not issue a request, and a failed refresh preserves the current report.

## Side Effects

Construction starts a load. Loads and refreshes call `IntelService.report` or `refreshReport` with ISO-formatted range endpoints; invalid ranges and failures can show error toasts.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The source scan used selected bounded portions of the 1,158-line implementation; its template and remaining logic were not reviewed.
