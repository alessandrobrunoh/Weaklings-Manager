# Tenant rail

## Overview

`app-tenant-rail` provides tenant switching, an add-server link, and a collapse control.

## Interface

- No inputs are declared.
- Outputs: `navigate` and `toggleCollapse`.
- Tenant selection and add-server controls emit navigation; collapse emits the toggle output.

## Invariants

- Active tenant ID comes from `AuthService.profile()?.tenant_id`, or an empty string.
- Selection is ignored for the active tenant or while a switch is in progress; tenant buttons are disabled during switching.
- A tenant-load failure produces an empty list.

## Side Effects

Construction loads tenants and subscribes to router navigation events. Switching calls `AuthService.switchTenant`, navigates to `/dashboard`, then emits `navigate`.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
