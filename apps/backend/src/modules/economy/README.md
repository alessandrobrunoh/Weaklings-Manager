# Economy module

## Overview

This directory contains the economy feature module for battle, fight, and event economy views. The bounded module overview states that combat-loss estimates are cost context, not income.

## Interface

All routes require `intel.report.view`.

| Route | Behavior |
|---|---|
| `GET /api/economy/battles/{battle_id}` | Returns the estimate and `trade_net` (`enemy_estimated_loss - friendly_estimated_loss`), or 404 if no estimate exists. |
| `GET /api/economy/fights/{fight_id}` | Aggregates priced segment estimates; unknown fights return 404, while missing estimates appear in coverage counts. |
| `GET /api/economy/events/{event_id}` | Returns event P&L and informational combat-loss/regear coverage; unknown events return 404. |

(Details pending/documentation failed) DTO details, aggregation semantics, and exact authorization behavior beyond the bounded route excerpt require review.

## Invariants

- Combat-loss estimates are cost context rather than income; income is sourced from declared ledger records.
- (Details pending/documentation failed) Per-endpoint aggregation, price coverage, and database constraints require a compliant bounded review.

## Side Effects

The module has read endpoints and a separate estimate-persistence writer; its bounded writer excerpt shows market-price retrieval and estimate-row persistence.

(Details pending/documentation failed) Transaction boundaries, fallback pricing, and failure behavior require a compliant bounded review.

## Verification

From the repository root, run `cargo test -p backend`.
