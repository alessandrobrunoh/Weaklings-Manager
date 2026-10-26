# Sidebar

## Overview

`app-sidebar` renders active-tenant navigation sections, a server header, and a desktop collapse control.

## Interface

- Required `sections`; `ariaLabelKey` defaults to `nav.aria.primary`; `collapsed` defaults to `false`.
- Outputs: `navigate` for navigation and `toggleCollapse` for collapse control.
- Re-exports `NavItem` and `NavSection`.

## Invariants

Visible sections are derived through `filterNavSections` using profile permissions, platform-admin status, feature keys, and tenant kind. The server label uses trimmed tenant name or translated product title; section-collapse state is local and signal-backed.

## Side Effects

Navigation and collapse controls emit outputs. Clicking a category updates local collapsed-section state. The inspected component performs no explicit storage or network I/O.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
