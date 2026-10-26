# Admin module

## Overview

This directory contains tenant-level admin router, service, models, and entity code.

## Interface

The router documents its API under `/api/admin` and provides:

- Permission matrix read/reload.
- Role create/update/delete and permission replacement.
- Discord role/channel/member pickers.
- Settings, branding, and autorole read/update operations.
- Tenant feature read/update operations.

(Details pending/documentation failed) Request/response shapes and routes beyond the bounded router-registration excerpt require review.

## Invariants

- The bounded permission-update handler rejects missing roles and unknown keys, deduplicates keys, and replaces the role's permission set.
- (Details pending/documentation failed) Role lifecycle, settings, and tenant-feature invariants require a compliant bounded review.

## Side Effects

The bounded permission-update handler commits database changes before reloading in-memory permissions.

(Details pending/documentation failed) Other database, audit, cache, and Discord effects require a compliant bounded review.

## Verification

From the repository root, run `cargo test -p backend`.
