# Client disconnect plugin

## Overview

This directory registers a Nitro plugin intended to handle unhandled rejections caused by client disconnects.

## Interface

The default export installs a process-level `unhandledRejection` listener and classifies reasons through `clientDisconnectCode`.

## Invariants

Recognized disconnects are suppressed and may be warned about outside production. Unrecognized rejections are rethrown.

## Side Effects

Plugin initialization registers a process listener; recognized disconnects may write a console warning outside production.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
