# Application shell

## Overview

`app-shell` composes the tenant rail, sidebar, topbar, active router outlet, and—when a tenant exists—the Albion link gate.

## Interface

The shell derives navigation sections and route mode from the current router URL and `AuthService` profile. Child navigation controls are connected to shell toggle/close handlers.

## Invariants

- Platform navigation takes precedence over admin and regular app navigation.
- Admin navigation for `/users` requires at least one admin-access permission.
- The tenant rail depends on tenant/profile features and is hidden on platform routes; the main element is the route scroll container.

## Side Effects

The shell reads and writes sidebar/tenant-rail collapsed state in `localStorage`, subscribes to router navigation events until destruction, resets scroll after navigation, and closes the drawer on Escape.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
