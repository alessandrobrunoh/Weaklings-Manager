# Version switcher

## Overview

`app-version-switcher` renders version-selection controls and an optional create-version control. It emits actions rather than implementing version changes.

## Interface

- Required inputs: `versions: readonly VersionRef[]` and `currentId: number`.
- Optional `canManage` and `busy` default to `false`; labels default to Version and New version.
- `select` emits a version ID; `create` emits `void`.

## Invariants

The group renders only with multiple versions or management permission. Version controls require multiple versions; create requires permission. Busy disables controls, and the current item receives `aria-current="true"`.

## Side Effects

Clicks emit `select` or `create`. No network or storage operations are present.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
