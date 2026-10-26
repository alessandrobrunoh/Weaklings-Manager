# API models

## Overview

`api.models.ts` is the frontend's shared TypeScript contract catalog for API payloads and requests across authentication, tenants, users, finance, events, combat, Albion data, compositions, scenarios, and other product areas.

## Interface

- Common contracts include `ApiResponse<T>`, `PaginatedData<T>`, `ProblemDetails`, and `BlockingReference`.
- The exported declarations include domain view and request types used by feature pages and services, including auth/tenant, banking, events/rosters, combat, compositions, and regear models.
- `discordGuildIconUrl` builds a Discord CDN icon URL from a guild ID and icon hash.

## Invariants

- These interfaces and aliases express compile-time TypeScript constraints; they do not perform runtime response validation.
- The success wrapper requires `status: 'success'`; pagination metadata is numeric.
- Several status fields use string-literal unions. `PermissionKey` is a closed set of string literals in the declaration, while `Role` is typed as `string`.

## Side Effects

The model declarations do not perform I/O. `discordGuildIconUrl` is a pure URL builder: it returns `null` without an icon hash and chooses GIF for animated hashes, PNG otherwise.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The model catalog is intentionally large; its documentation scan used bounded excerpts and does not enumerate every exported declaration.
