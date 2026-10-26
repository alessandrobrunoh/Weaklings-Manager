# Combat module

## Overview

This directory contains the combat module, bundled data, calculation code, and database-backed service code. Detailed contracts are limited to the bounded route/simulation/service excerpts below.

## Interface

The router documents APIs under `/api/combat`:

- Dataset and mastery metadata: `GET /dataset`, `GET /mastery-groups`.
- Item Power and member Item Power: `POST /item-power`, `GET /members/{user_id}/item-power`.
- Burst simulation: `POST /simulate`.
- Calibration: `GET /calibration`.
- Scenario/run reads: `GET /tests`, `GET /tests/{id}`, `GET /tests/{id}/runs`, `GET /runs/{run_id}`, and `POST /tests/{id}/run`.
- Scenario management: `POST /tests`, `PATCH /tests/{id}`, `POST /tests/{id}/versions`, and archive/unarchive operations.

(Details pending/documentation failed) Runtime permission mapping and full request/response shapes need a compliant bounded router review.

## Invariants

- The bounded simulation excerpt preserves cast order, reports unresolved spells, and does not resolve geometry or scale baseline spell values by caster IP.
- (Details pending/documentation failed) Item Power, readiness, and scenario invariants require a compliant bounded review.

## Side Effects

The bounded service excerpts show scenario creation writing a scenario row and scenario execution inserting a run row.

(Details pending/documentation failed) Other scenario-management and database effects require a compliant bounded review.

## Verification

From the repository root, run `cargo test -p backend`.
