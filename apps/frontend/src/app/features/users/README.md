# Users

## Overview

This directory contains the server-paged guild member directory and individual member profile/detail pages.

## Interface

- The bounded beginning of `users.ts` describes a member directory and shows username, email, role, and actions with page size 10.
- `UserDetailPage` takes a required `userId` input and exposes permission-gated profile operations.
- Member-creation request details are not documented from the compliant bounded excerpt.

## Invariants

- Detail loading rejects non-finite or nonpositive IDs. Progression adjustment requires a reason and at least one adjustment, followed by confirmation.
- No list-loading invariant is asserted because the relevant `users.ts` implementation was outside the compliant excerpt.

## Side Effects

Selected bounded ranges in `user-detail.ts` show profile-related loads, progression adjustment, and Albion link/unlink actions. List request effects are not asserted here.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. **Scan cap caveat:** the scout read all 588 lines of `users.ts`, exceeding the 300-line limit. Claims about that file are restricted to its initial directory/page description and table excerpt; `user-detail.ts` was inspected in bounded selected ranges.
