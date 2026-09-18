# Plan: Synchronize guild and alliance events

**Status**: Active

## Goal

When a guild creates an event with alliance sharing enabled, the alliance receives a linked mirror event and participation changes are reflected on both sides.

## Acceptance criteria

- Creating an alliance-enabled guild event creates exactly one linked event in the alliance tenant.
- The API exposes the synchronization relationship and does not create duplicate mirrors on retries.
- Joining, changing a build, and leaving from either tenant updates the corresponding participant in the linked event.
- Event cancellation/archive and core schedule fields propagate to the linked event without recursive updates.
- A linked split can be identified and synchronized through the same relationship.
- Existing non-alliance events and existing snapshot sharing continue to behave unchanged.

## Slices

1. Persist an idempotent event-link relationship and create the alliance mirror.
2. Synchronize participation mutations in both directions.
3. Synchronize event lifecycle and schedule updates.
4. Link split mirrors and synchronize split participants/amounts.
5. Add UI indicators and recovery tooling for broken links.
