# Guild overview

## Overview

`GuildOverviewPage` brings combat, roster, economy, meta, and leaderboard data from a `GuildReport` into one reporting window.

## Interface

- Sections are Overview, Roster & Operations, Economy, Combat Meta, and Leaderboards, switched with the page tabs.
- Periods are 7, 30, 90, or custom days, switched with a segmented control. Initial state selects Overview and a 30-day period.
- Each section opens with one summary band of the figures an officer acts on (at most six). Detail follows as charts and `app-data-table` tables; the band holds the totals, so tables and charts do not repeat them.
- Lists that can grow (members, comps, enemies, timeline, notable fights) are tables. Leaderboards show the top five per category.

## Invariants

- Custom date ranges require both valid dates and `from < to`; invalid ranges are rejected.
- An initial load uses loading state when there is no report; later period loads use refreshing state.
- Invalid refresh ranges do not issue a request, and a failed refresh preserves the current report.
- The members, notable-fight and timeline tables do not write to the URL. The comps and enemies tables sync search, sort and page to the URL under the `comps` and `enemies` keys so they never collide.

## Side Effects

Construction starts a load. Loads and refreshes call `IntelService.report` or `refreshReport` with ISO-formatted range endpoints; invalid ranges and failures can show error toasts.

## Verification

No spec covers this page yet. Check it through the running app and the period, custom range, and tab flows.
