# Users

## Overview

This directory contains the server-paged guild member directory and individual member profile/detail pages.

## Interface

- The bounded beginning of `users.ts` describes a member directory and shows username, email, role, and actions with page size 10.
- `UserDetailPage` takes a required `userId` input and exposes permission-gated profile operations. It uses `app-entity-header` (status and role chips, the season XP summary band, and an overflow menu with adjust progression, unlink, and block or unblock as the last, danger entry). Sections are `app-tabs`: overview (Albion link, Discord roles), combat intel (or the own-standing panel), weapons, progression adjustment (only with `progression.adjust`) and warns (only with `warns.view`, an `app-data-table`). A 404 renders the not-found state; other load failures render the error state with retry.
- Member-creation request details are not documented from the compliant bounded excerpt.
- Blocking: holders of `roles.manage` get a Status column (text and icon chip, filterable through the `blocked` query param) and a Block/Unblock action per row and on the detail page. `BlockUserDialog` (`block-user-dialog.ts`) confirms, takes an optional reason (max 500 characters) and calls `POST` / `DELETE api/users/{id}/block`. Nobody sees the action on their own row.

## Invariants

- Detail loading rejects non-finite or nonpositive IDs. Progression adjustment requires a reason and at least one adjustment, followed by confirmation.
- No list-loading invariant is asserted because the relevant `users.ts` implementation was outside the compliant excerpt.

## Side Effects

Selected bounded ranges in `user-detail.ts` show profile-related loads, progression adjustment, and Albion link/unlink actions. List request effects are not asserted here.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. **Scan cap caveat:** the scout read all 588 lines of `users.ts`, exceeding the 300-line limit. Claims about that file are restricted to its initial directory/page description and table excerpt; `user-detail.ts` was inspected in bounded selected ranges.
