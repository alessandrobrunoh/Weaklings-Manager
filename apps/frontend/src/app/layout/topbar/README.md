# Topbar and notifications

## Overview

This directory contains the sticky application header and its notification inbox/broadcast panel.

## Interface

- `Topbar` accepts tenant-rail collapsed/toggleable state and emits `toggleTenantRail` and `menuToggle`.
- `NotificationsPanel` is embedded inside `Topbar` and obtains data/actions from injected services.
- The panel provides inbox open/close, read-state, row selection, and permission-gated broadcast composition.

## Invariants

- Both components use `OnPush`.
- Route titles ignore query and fragment suffixes; unread badges display `99+` above 99.
- Broadcast requires `notifications.broadcast`; trimmed title/body must be nonempty and within 120/2,000 characters.

## Side Effects

Topbar subscribes to router navigation events until destruction. Opening notifications loads the inbox; other visible controls call theme, login, toast, and notification handlers.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The scan inspected only the first 300 lines of each larger implementation.
