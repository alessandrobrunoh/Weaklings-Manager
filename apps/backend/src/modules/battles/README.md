# Battles module

## Overview

This directory contains the battles module, evidence files, and shared outcome logic. Detailed service behavior remains pending a compliant bounded source review.

## Interface

| Method and path | Behavior |
|---|---|
| `GET /api/battles` | Lists configured-guild battles. |
| `GET /api/battles/{battle_id}` | Returns battle detail, estimated losses, and optional linked-event data. |
| `GET /api/battles/me` | Lists battles for the caller's linked Albion character. |

The bounded router excerpt registers guild battle list, battle detail, and current-user battle routes under `/api/battles`.

(Details pending/documentation failed) Handler authorization, query fields, DTOs, and service helper contracts need a compliant bounded review.

## Invariants

(Details pending/documentation failed) Outcome classification, normalization, and persistence invariants require a compliant bounded review.

## Side Effects

The bounded evidence-writer excerpt shows a transactional persistence path for guild/player evidence and kill/item rows.

(Details pending/documentation failed) External calls and whether request handlers invoke each helper require a compliant bounded review.

## Verification

From the repository root, run `cargo test -p backend`.
