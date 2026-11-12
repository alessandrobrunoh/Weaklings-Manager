# Users

## Overview

This directory contains the server-paged guild member directory and individual member profile/detail pages.

## Interface

- `users.ts` is the member directory: a summary band (total, plus admin, officer and member counts for the current page), a filter bar (search by name, role facet, and status facet for `roles.manage` holders), and an `app-data-table` of name, email (only for `users.create`/`roles.manage` holders), role, status and a row "more actions" menu. Page size is 10. Search, `role` and `status` are URL params, and the table's page and sort are mirrored to the URL too, so a shared link restores the list. The header has one primary action (New member) and a menu for Refresh.
- `UserDetailPage` takes a required `userId` input and exposes permission-gated profile operations.
- Member-creation request details are not documented from the compliant bounded excerpt.
- Blocking: holders of `roles.manage` get a Status column (status chip with text and glyph, filterable through the `status` facet, sent as the `blocked` query param) and a Block/Unblock entry in each row's "more actions" menu, plus the same action on the detail page. `BlockUserDialog` (`block-user-dialog.ts`) confirms, takes an optional reason (max 500 characters) and calls `POST` / `DELETE api/users/{id}/block`. Nobody sees the action on their own row.

## Invariants

- Detail loading rejects non-finite or nonpositive IDs. Progression adjustment requires a reason and at least one adjustment, followed by confirmation.
- No list-loading invariant is asserted because the relevant `users.ts` implementation was outside the compliant excerpt.

## Side Effects

Selected bounded ranges in `user-detail.ts` show profile-related loads, progression adjustment, and Albion link/unlink actions. List request effects are not asserted here.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. **Scan cap caveat:** the scout read all 588 lines of `users.ts`, exceeding the 300-line limit. Claims about that file are restricted to its initial directory/page description and table excerpt; `user-detail.ts` was inspected in bounded selected ranges.
