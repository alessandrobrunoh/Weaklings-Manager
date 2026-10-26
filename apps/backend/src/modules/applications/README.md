# Discord applications module

## Overview

This directory contains the implementation files for `modules::applications`, declared by the sibling `modules/applications.rs`. It implements Discord application tickets: HTTP handlers, lifecycle operations, and the `discord_applications` entity.

## Interface

Routes are relative to this module's router:

| Route | Behavior |
|---|---|
| `POST /` | Creates an application ticket. |
| `GET /active`, `GET /latest` | Returns the caller's open ticket or most recently created ticket. |
| `POST /{id}/reopen` | Reopens the caller's own non-open ticket. |
| `POST /{id}/accept`, `POST /{id}/decline` | Manager actions; require `ApplicationsManage`. Accept may request trial status. |
| `POST /{id}/close` | Applicant may close their own ticket; another caller needs `ApplicationsManage`. |

Responses use `ApiResponse` and `ApplicationView`, which omits internal user/resolution metadata and may include role or trial fields.

## Invariants

- Creation and reopening require applications to be open in guild settings.
- Creation trims and validates channel ID and username and rejects an existing open ticket for the same Discord ID. The duplicate check is read-then-insert; no atomic uniqueness guarantee is shown here.
- In-game names are trimmed, blank values become absent, and retained names are capped at 64 characters. Reopening without a nonblank value preserves the stored name.
- Reopening checks ownership and rejects an already-open ticket or another open ticket for that applicant. It reuses the row, clears resolution metadata, records reopen time, and increments `reopen_count` with saturating arithmetic.
- Resolution only transitions rows currently marked `open`; the entity stores status as a string.

## Side Effects

Creation inserts a `discord_applications` row. Reopen updates the existing row; resolve records status, time, and resolver. Trial acceptance checks configuration, resolves the application, then starts a trial; no encompassing transaction is visible in these files. The accept handler returns role IDs but makes no direct Discord role-assignment call.

## Verification

From the repository root, run `cargo test -p backend`.
