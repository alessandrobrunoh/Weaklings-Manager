# Build validation

## Overview

This directory contains pure validation helpers for build and composition forms.

## Interface

- `FieldError` contains readonly `field` and `message`.
- `BuildDraft` and `BuildValidationContext` describe draft values and validation context.
- `validateBuildName` returns an error or `null`; `validateBuildDraft` returns an error list; `summarizeErrors` joins messages.

## Invariants

- Names are trimmed, limited to 80 characters, and checked for case-insensitive duplicates excluding the current name.
- Category validation is enabled by default and rejects falsy/nonpositive IDs.
- A nonempty trimmed role and a slot named exactly `weapon` are required.

## Side Effects

Validation is pure: it returns errors in name, category, role, then weapon order without mutating inputs or performing I/O.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
