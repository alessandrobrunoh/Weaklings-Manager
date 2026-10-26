# Page stack

## Overview

`app-page-stack` provides vertical spacing between projected page sections.

## Interface

The component declares no inputs or outputs and renders caller content through `ng-content`.

## Invariants

The host is an `OnPush` flex column. Its gap is `var(--page-gap, var(--spacing-16, 1rem))`.

## Side Effects

It applies flex layout and spacing to its host; it has no state or imperative behavior.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
