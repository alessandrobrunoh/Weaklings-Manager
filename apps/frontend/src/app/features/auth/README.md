# Authentication pages

## Overview

This directory contains the public login page, post-OAuth server selection, no-tenant server listing, and first-time tenant registration wizard.

## Interface

- `Login` provides Discord login plus theme/language controls and a `no_tenant` alert.
- `ChooseServer` displays pending tenants; `NeedsTenant` displays registerable guilds and optional bot-invite/logout actions.
- `RegisterTenant` presents a three-step wizard for tenant identity, guild/alliance selection, and review.

## Invariants

- Login accepts `next` only when it begins with `/`; otherwise routing depends on whether the profile has a tenant.
- Tenant kind is `guild` or `alliance`; region is `europe`, `americas`, or `asia`.
- Server selection calls `selectTenant` and navigates to `/dashboard` on success.

## Side Effects

The pages call authentication and API services, navigate between login/onboarding routes, and show toasts. The login action starts OAuth; logout uses a full-page navigation to `/login`.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The scan read all shorter files and only the first 300 lines of `register-tenant.ts`.
