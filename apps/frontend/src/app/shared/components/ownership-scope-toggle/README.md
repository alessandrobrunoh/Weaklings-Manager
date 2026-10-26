# Ownership scope toggle

## Overview

`app-ownership-scope-toggle` switches between the Mine and Everyone ownership scopes using `app-view-toggle`.

## Interface

- `scope` input is `OwnershipScope` and defaults to `mine`.
- `scopeChange` emits an `OwnershipScope`.

## Invariants

The only options are `mine` and `all`, with translated labels. Invalid values and the current value are ignored.

## Side Effects

The component uses `TranslateService` for labels and emits `scopeChange` only for a valid, changed scope.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
