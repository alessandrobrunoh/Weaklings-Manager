# Application layout

## Overview

This directory defines application navigation data and composes the shell, sidebar, tenant rail, and topbar.

## Interface

- `NavItem`, `NavSection`, and `AdminPanel` describe navigation entries and groups.
- `ADMIN_ACCESS_PERMISSIONS`, `isAdminUrl`, `isPlatformUrl`, `filterNavSections`, and `APP_NAV_SECTIONS` provide permission-aware navigation data and helpers.
- Child boundaries: [shell](shell/README.md), [sidebar](sidebar/README.md), [tenant rail](tenant-rail/README.md), and [topbar](topbar/README.md).

## Invariants

URL helpers strip query and fragment portions. Navigation filtering applies permissions, platform-admin status, tenant kind, and feature checks; empty sections are removed.

## Side Effects

The direct navigation helpers create filtered data without I/O. UI state and router effects are owned by the linked layout components.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The `nav.ts` scan exceeded the 300-line cap; findings are limited to the first 300 lines.
