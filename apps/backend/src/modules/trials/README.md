# Trials module

## Overview

This module persists trial periods created from accepted applications. The current implementation is limited to configuration lookup and trial creation; listing and manager actions are not implemented here.

## Interface

- `TrialConfig` carries the configured trial role ID and default duration in days.
- `TrialService::trial_config` reads guild settings and validates that configuration.
- `TrialService::start_from_accept` creates a trial from an accepted application; `TrialService::start` is the lower-level creation operation.
- `entities::Model` represents a trial row, including member/application identifiers, start and end timestamps, status, and creator/ender IDs. This module exposes no HTTP router.

## Invariants

- Guild settings must exist. The role ID is trimmed and must be non-empty; duration must be between 1 and 365 days inclusive.
- New trials have `active` status, an end time derived from the configured duration, and the creating actor recorded.
- `ends_at` is the due time; remaining time is derived rather than stored.

## Side Effects

Configuration lookup reads guild settings. Starting a trial inserts a trial row. The module does not call Discord APIs.

## Verification

From the repository root, run `cargo test -p backend`.
