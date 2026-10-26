# Combat tests

## Overview

This is an application feature for saved combat scenarios, not a unit-test harness. It lists and creates scenarios, presents scenario setup/results, and supports timeline editing.

## Interface

- `Tests` switches between active and archived scenario lists and navigates to scenario details.
- `TestDetailPage` presents setup, timeline, and results, with unit groups, imports, weapon selection, and timeline tools.
- `hpOverTimeSeries` derives ally/enemy HP points from a scenario result.
- The timeline editing boundary is documented in [timeline](timeline/README.md).

## Invariants

- Scenario creation trims names and rejects blank values.
- The archived list filters for scenarios with `archived_at`.
- HP replay floors unit HP at zero, ignores unknown target IDs, and expects casts ordered by landing time; healing is not capped at starting HP.

## Side Effects

The list reads and creates `api/combat/tests` scenarios and archives/unarchives through action endpoints. It navigates to detail pages and shows toasts. The detail template exposes save/run/archive/rename/version/import actions; their handlers were outside the scan range.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The detail source was limited to its first 300 lines.
