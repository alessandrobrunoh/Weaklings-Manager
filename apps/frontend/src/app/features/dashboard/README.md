# Dashboard

## Overview

The member and officer home. It answers, in order: what needs me (attention items, live and upcoming events), the figures for my season, bank and splits (one summary band), and what recently finished. Guild-wide finance and officer queues live on `/guild` and `/admin`.

## Interface

`Dashboard` (`dashboard.ts`) is the routed page. It reads only the signed-in member's data:

- `api/bank/balance`, `api/users/me/metrics`, `api/progression/me`, `api/albion/link/me`
- `api/events` three times: scheduled and live events for the upcoming list and attention items, and stopped and auto-stopped events for recent activity

The header holds the greeting, the role badge, the linked Albion character (or "not linked") as subtitle, one "Open profile" action and an overflow menu with "Refresh snapshot". Exported helpers: `selectUpcomingEvents` (live first, then scheduled events whose start has not passed), `selectNextMass`, `eventMassAt`, `formatMassEta` and `formatCompactSilver`.

## Invariants

- Every section follows loading, then error (with retry), then empty, then data; a failed source never renders as an empty list or as "all caught up".
- The attention list only holds actionable items: withdrawals awaiting payout, silver available to request, pending regears, an unlinked Albion character, and a mass that is live or starts within six hours.
- Summary figures are not repeated elsewhere on the page. A missing figure shows an em dash with the error in its hint.
- The page is single-column and tables scroll inside their own container, so it fits at 390px.

## Side Effects

Read-only. Refresh re-requests the six endpoints above; nothing is written.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
