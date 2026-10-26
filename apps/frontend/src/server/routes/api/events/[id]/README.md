# Event ID routes

## Overview

This is an intermediate route directory for event-specific API endpoints. It contains the [roster endpoint](roster/README.md).

## Interface

No direct runtime source or symbols are defined at this level; the endpoint boundary is owned by the child route.

## Invariants

The directory contributes only the event-ID route grouping. Route-specific request behavior is documented by its child.

## Side Effects

There is no direct implementation here. Runtime effects are implemented in the child roster route.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
