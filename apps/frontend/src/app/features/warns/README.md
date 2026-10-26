# Warn register

## Overview

`app-warns` presents a guild warn register and escalation queue, including issue/revoke and escalation acknowledgement workflows.

## Interface

- `WarnsTab` is `register | escalations`.
- `IssueDraft` carries user, reason, severity, multiplier, and expiry fields.
- The visible register table is server-paginated with page size 20.

## Invariants

- The issue control is shown only for users with issue permission on the register tab; otherwise a permission note is displayed.
- The empty issue draft defaults severity to `warn`.

## Side Effects

The inspected excerpt wires refresh, tab, issue-form, retry, and page-change events to handlers. Their request effects were outside the 300-line boundary.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. **Scan cap caveat:** the scout read the full 812-line source, exceeding the 300-line limit; findings here are limited to the first 300 lines.
