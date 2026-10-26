# Alliance sharing module

## Overview

This module publishes build, comp, and split snapshots from a guild tenant into its alliance tenant, not into other guild tenants. Published splits are read-only snapshots in the alliance tenant.

## Interface

| Method and path | Behavior |
|---|---|
| `POST /api/alliance/shares` | Shares the requested build, comp, or split artifact. |
| `GET /api/alliance/shares/build/{id}`, `/comp/{id}`, `/split/{id}` | Returns share status. |
| `DELETE /api/alliance/shares/build/{id}`, `/comp/{id}`, `/split/{id}` | Removes a share; returns no content. |

Share creation and removal require `alliance.share`. `ArtifactType` serializes as `build`, `comp`, or `split`; responses include source/published IDs and share actor/time.

## Invariants

- Sharing requires authorization, a non-alliance source tenant, and an active alliance membership.
- A requested source artifact must exist and match its requested artifact type. Existing mappings are keyed by source tenant, artifact type, and source ID.
- Sharing a comp first ensures that referenced builds are published and maps source-build IDs to published-build IDs.
- Share mappings are stored in the control plane; the module uses raw SQL for `alliance_shares` and `alliance_memberships`.

## Side Effects

Sharing reads source artifacts, loads the active alliance tenant, copies or updates the published artifact graph, then inserts or updates the control-plane share mapping. Unsharing deletes or hides the published build as applicable and removes its mapping. Operations span source-tenant, alliance-tenant, and control databases; this module does not establish atomicity across them.

## Verification

From the repository root, run `cargo test -p backend`.
