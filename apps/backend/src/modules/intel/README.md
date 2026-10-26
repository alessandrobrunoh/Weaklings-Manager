# Intel module

## Overview

This directory contains the intel feature module. Its detailed contract is limited to the bounded excerpts listed below; additional service behavior remains pending.

## Interface

The router documents routes under `/api/intel` for scout list/detail/update/delete, battle scouting and backfill, scout similarity/counters, composition threats, matchups, reports and refresh, leaderboards, and player reports.

(Details pending/documentation failed) Runtime permission mapping, response shapes, and routes beyond the bounded router excerpt require review.

## Invariants

- The bounded model excerpt defines `full_weapon_coverage` as `weapon_sample_size >= player_count`.
- The bounded listing excerpt excludes archived scouts by default, rejects unknown categories, and falls back to `saved_at` for unknown sort values.
- (Details pending/documentation failed) Merge semantics, report rules, and schema-level uniqueness need a compliant bounded review.

## Side Effects

The bounded `scout_battle` excerpt shows that dry-run returns before persistence and the normal path inserts or merges scouts and links battles.

(Details pending/documentation failed) Update/delete, report caching, and other persistence or notification effects need a compliant bounded review.

## Verification

From the repository root, run `cargo test -p backend`. Schema-level uniqueness and cascade behavior should be checked against migrations before relying on the service comments as database guarantees.
