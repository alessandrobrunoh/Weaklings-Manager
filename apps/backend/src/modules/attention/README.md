# Attention module

## Overview

Attention computes current findings rather than maintaining an alert history. `GET /api/attention/findings` synchronously recomputes findings before reading them; the module documents no cache or scheduled recompute.

## Interface

The findings route requires `Permission::IntelReportView` (`intel.report.view`) and returns `Vec<AttentionFindingView>`. A view contains rule key/version, severity, subject, period, metric and optional baseline, sample size, JSON evidence, and computation time.

## Invariants

- Rules are pure functions over aggregated inputs; the writer owns database queries and persistence.
- Visible rule definitions use `RULE_VERSION = 1` and store numeric/identifier evidence rather than generated prose.
- The finding entity uses polymorphic `subject_type` and `subject_id` strings; `subject_id` has no declared foreign key in the entity.
- Persisted invalid `evidence_json` becomes an internal error rather than a panic.
- The rules source documents six implemented rules; not every rule implementation was covered by the bounded scan.

## Side Effects

Each findings request writes to `attention_findings`: the writer queries a 60-day fight window, splits current and prior 30-day periods, evaluates rules, then deletes and reinserts rows by rule key in a transaction. Its inspected inputs include fight outcomes/stats, battle-loss estimates, event attribution, and enemy-guild intel.

## Verification

From the repository root, run `cargo test -p backend`.
