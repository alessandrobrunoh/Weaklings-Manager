# Warns module

## Overview

The warns module issues and lists user warnings, supports soft revocation, and manages warning escalations. Warn and escalation records are stored separately.

## Interface

| Method and path | Behavior |
|---|---|
| `POST /api/warns` | Issues a warn; requires `warns.issue`. |
| `GET /api/warns` | Lists warns; requires `warns.view`. |
| `POST /api/warns/{id}/revoke` | Revokes a warn; requires `warns.issue`. |
| `GET /api/warns/escalations` | Lists escalations; requires `warns.view`. |
| `POST /api/warns/escalations/{id}/ack` | Acknowledges an escalation; runtime permits `warns.issue` or `progression.settings.manage`. |

`IssueWarnRequest` accepts target user, reason, optional severity, multiplier, and multiplier expiry. `WarnService` handles issuance, list/revoke, and escalation operations.

(Details pending/documentation failed) Service behavior after the first 300 lines requires review.

## Invariants

- Severity values are `note`, `warn`, and `strike`; omitted severity defaults to `warn`. All non-revoked rows, including `note`, count toward escalation thresholds.
- Revocation is soft and records actor/time; revoked rows no longer count toward the threshold.
- Issuance trims and requires a non-empty reason, then may open an escalation when the active count reaches the current threshold.
- Revoking an already-revoked warn conflicts. If revocation lowers the active count below the threshold, an open escalation may be closed.
- Escalations retain the threshold and active-warn count at opening time.

## Side Effects

Issuance inserts the warn, may apply a progression account multiplier, may open an escalation, attempts an audit log, and best-effort notifies the target when issuer and target differ. Revocation updates the warn, recalculates the active count, may close an escalation, and attempts an audit log. These service operations are sequential and do not open a transaction.

(Details pending/documentation failed) Side effects after the first 300 lines of the service implementation were not assessed.

## Verification

From the repository root, run `cargo test -p backend`.
