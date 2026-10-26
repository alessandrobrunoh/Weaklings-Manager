# Route guards

## Overview

This directory contains Angular route guards for authentication, tenant selection, permission checks, guild-only pages, and platform administration.

## Interface

- `authGuard` requires a signed-in profile and redirects unauthenticated navigation to `/login`, preserving the requested URL as `next`.
- `redirectIfAuthenticatedGuard` keeps signed-in users out of public login routes.
- `tenantGuard` requires a profile with a `tenant_id`.
- `permissionGuardTo(redirectPath, ...keys)` creates a guard that permits access when any listed permission is present; `permissionGuard(...keys)` uses `/dashboard` as its redirect.
- `guildOnlyGuard` excludes alliance tenants. `platformGuard` permits platform administrators and routes other profiles to their appropriate destination.

## Invariants

- Guards return `true` to activate a route or a `UrlTree` to redirect; they do not navigate imperatively.
- The permission factory uses OR semantics. An empty permission list does not grant access.
- `next` is accepted only when it is a nonempty path beginning with `/`.
- Tenant checks load a profile only when one is not already available.

## Side Effects

The guards inject `AuthService` and, where required, `Router`. Asynchronous guards may call `AuthService.load()`; redirects are represented as router URL trees.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. This runs the frontend package's Vitest suite.
