# Event API routes

## Overview

This intermediate directory groups event-specific API routes. Its child route handles [event-ID requests](%5Bid%5D/README.md).

## Interface

No direct runtime source or symbols are defined at this level; the event-ID route boundary is defined by the child directory.

## Invariants

This directory adds no route logic of its own; request behavior belongs to the child endpoint.

## Side Effects

No direct implementation is present here. The descendant roster route configures its own WebSocket proxy.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
