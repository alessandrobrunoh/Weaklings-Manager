# Progression module

## Overview

Progression provides season-scoped XP accounts, levels, awards, leaderboards, and administrative adjustment. Other modules should award XP through `ProgressionService::award` rather than implementing the curve themselves.

## Interface

The router documents operations under `/api/progression`: caller snapshot, leaderboard, message award, settings, season list/create/update/activate, user snapshot/ledger, and user adjustment. Message award is documented as bot-only. The service also exposes `award` for module callers.

## Invariants

- `threshold(level)` is zero at level 1 or below and otherwise rounds the configured curve; `level_for_xp` is capped at `max_level.max(1)`, and `xp_to_next` is zero at cap.
- Multiplier awards floor the adjusted amount plus carried fractional remainder. Non-finite results apply zero XP and zero remainder.
- Account XP is documented as nonnegative; account multipliers are clamped to `[0, 5]`. Season start/end are inclusive and entity comments specify at most one active season.
- XP source tags are stable snake-case values. Ledger idempotency is keyed by season and idempotency key.
- Awards skip non-positive rates, require a covering active season, and return `Duplicate` for an existing season/key pair. Message awards also check eligibility, cooldown, and duplicate message key.

## Side Effects

An award locks the account row, writes a ledger row, and creates or updates the season account in one transaction. Expired multipliers reset to 1; message awards update `last_message_xp_at`. `apply_account_multiplier` can create an account and clamps the multiplier.

## Verification

From the repository root, run `cargo test -p backend`. The scan did not inspect migration constraints or callers outside this directory.
