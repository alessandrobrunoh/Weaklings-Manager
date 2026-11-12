# Combat module

## Overview

This directory contains the combat module, bundled data, calculation code, and database-backed service code. Detailed contracts are limited to the bounded route/simulation/service excerpts below.

## Interface

The router documents APIs under `/api/combat`:

- Dataset metadata: `GET /dataset`.
- Item Power at a hypothetical Destiny Board level (`max` or a flat `fixed` level; members' own levels are not stored): `POST /item-power`, plus `GET /api/comps/builds/{id}/item-power` for a stored build (`comp_routes.rs`).
- Burst simulation: `POST /simulate`.
- Scenario/run reads: `GET /tests`, `GET /tests/{id}`, `GET /tests/{id}/runs`, `GET /runs/{run_id}`, and `POST /tests/{id}/run`.
- Scenario management: `POST /tests`, `PATCH /tests/{id}`, `POST /tests/{id}/versions`, and archive/unarchive operations.

- Member weapons, mounted under `/api/users`: `GET`/`PUT /me/weapons` and `GET`/`PUT /{user_id}/weapons` (`user_weapons.rs`). Auto-fill treats a weapon an officer locked for a member as a hard block (`fit::MemberWeapons`) and scores a member on a seat by the level they declared on its weapon (`main` 3, `good` 2, `basic` 1; no declared weapons 0.5, other weapons only 0.1), plus a signup-preference bonus (`fit::score`).

(Details pending/documentation failed) Runtime permission mapping and full request/response shapes need a compliant bounded router review.

## Invariants

- The bounded simulation excerpt preserves cast order, reports unresolved spells, and does not resolve geometry or scale baseline spell values by caster IP.
- (Details pending/documentation failed) Item Power and scenario invariants require a compliant bounded review.

## Side Effects

The bounded service excerpts show scenario creation writing a scenario row and scenario execution inserting a run row.

(Details pending/documentation failed) Other scenario-management and database effects require a compliant bounded review.

## Verification

From the repository root, run `cargo test -p backend-combat`.
