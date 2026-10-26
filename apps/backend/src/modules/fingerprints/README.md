# Fingerprints module

## Overview

This directory contains fingerprint computation, read-query, and persistence modules. The bounded module entrypoint describes separate compute, service, and writer layers.

## Interface

All routes require `Permission::IntelReportView` and are documented under `/api/fingerprints`:

- `GET /` lists fingerprints with pagination, mode/role/match filters, and sort.
- `GET /{id}` returns fingerprint detail and observation history.
- `GET /builds/{build_id}` returns observations for an internal build.
- `GET /meta` returns ranked fingerprints for one side.

The router lists fingerprints, retrieves detail, lists build observations, and returns side-ranked metadata. All routes require `IntelReportView`.

(Details pending/documentation failed) Request/response shapes and persistence API behavior require a compliant bounded review.

## Invariants

- The bounded entity excerpt separates fingerprint identity rows from battle observation rows; observation rows carry battle, player, side, fingerprint, and occurrence-time fields.
- (Details pending/documentation failed) Matching, upsert, and rollup invariants require a compliant bounded source review.

## Side Effects

(Details pending/documentation failed) Database read/write behavior, transaction boundaries, and candidate filtering require a compliant bounded source review.

## Verification

From the repository root, run `cargo test -p backend`.
