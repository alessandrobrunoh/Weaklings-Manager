# Alliance event distribution

**Status:** Slices 1–3 are implemented and ready for review. Slice 4's backend (attribution + lifecycle sync) is implemented and awaiting review; its Discord bot and frontend flows, and Slices 5–6, remain unimplemented.
**Goal:** Events should behave as one event across guild and alliance servers while each tenant keeps its own Discord delivery settings and financial records.

## Outcome and non-goals

- A guild-created event is published in that guild using its local event delivery setup. If shared, it has an alliance copy only; it is not fanned out to other guilds.
- An alliance-created event is published in the alliance using its local setup and distributed to every active member guild, each using that guild's setup.
- A join or leave from any linked event copy updates the same participant across all linked copies and synchronizes each linked event split.
- Event ownership determines where a split is authoritative. Guild-origin splits remain owned by the creating guild. Alliance-origin splits remain owned by the alliance; guild systems receive only the transaction records attributable to their own members.
- If a guild represented in an alliance split has left the alliance, the entire distribution fails. An authorized person must remove the affected people from that split manually before retrying.
- No rank-based financial benefits, automatic historical XP recalculation, or implicit migration of existing ledgers.

## Confirmed product rules

- A signup from a guild's Discord server or guild tenant is attributed to that guild. Do not ask the user to select another guild in that context.
- A signup from the alliance context is attributed to the user's member guild; if more than one is eligible, ask the user to choose.
- A participant has one linked signup. Leaving from any linked copy removes that signup everywhere.
- Guild-origin events shared to an alliance stay owned by the source guild; the alliance displays a synchronized copy.
- Alliance-origin events fan out to all active member guilds. The alliance is the event and split owner.
- A departure that makes an alliance split's roster invalid blocks the whole distribution. The affected people are removed manually from the split before retry.
- The event owner is the authority for event edits and cancellation. Guild copies of alliance-owned events allow participation but not event management (proposed safe default).
- Event announcement delivery, VOD forum routing, and other Discord destinations are local to each receiving tenant.
- The UI-wide rounded-corner update is a separate design-system change; it is not part of the event data contract.

## Verified current implementation

- The control-plane link schema now allows one canonical event to link to multiple copies. `linked_event_peers` resolves the canonical event and every active sibling; participation fanout maps builds through `event_fanout_assets` or the existing guild-to-alliance share mapping.
- Alliance event creation enqueues a publish job for an active-membership snapshot. `fanout_worker` claims targets with leases, copies the event and organized comp/build graph, records the origin identity inside the destination event transaction, and links the copy only while the membership row remains active.
- Per-target attempts/errors are durable and visible through `GET /api/events/{id}/fanout-status`, which requires event management authority. A periodic backend worker retries failed or expired leases.
- Copies store the destination tenant's configured `discord_event_delivery`; the Discord poller routes through that tenant's own channel/forum settings. The event's VOD opt-in is inherited, while the destination bot uses its own configured VOD forum.
- Guild-origin sharing still uses the existing direct `create_mirror` path. A failure is logged after the source event commits but is not yet represented by the new durable retry/status path.
- `apps/backend/src/modules/platform/service.rs` retains inactive membership and disables event sync on departure. The existing link model can provide historical references, but an explicit direction and owner are not stored.
- Financial models live in tenant databases. Cross-tenant ledger writes cannot be treated as one atomic database transaction.
- The current worktree has unrelated, uncommitted UI radius changes in `DESIGN.md`, `apps/frontend/src/styles.css`, and several frontend style/component files. Preserve them; do not fold them into event-sync changes.

## Proposed design

Use the control database as the authority for event relationships and pending cross-tenant work. Replace the one-source/one-peer assumption with event links that can represent one source event linked to multiple destination events, with explicit owner/source direction and enabled state. Add a durable, idempotent outbox for mirror creation/update/archive and participant mutations. Process work with retries and visible terminal errors; never return a failure that implies the source event was rolled back after it committed.

For signups, resolve the actor in the current tenant first. A guild context fixes the attribution to that guild. An alliance context resolves the linked member guild(s); if ambiguous, require a choice. Propagate one stable user identity and the chosen guild attribution to all linked tenant rosters. Never infer ownership from a display name.

For money, keep the source event's split authoritative. For alliance-owned splits, compute a per-guild projection from stable user identity and current active membership, then persist idempotent, auditable guild transaction rows. Validate every roster participant before writing any guild projection. One departed or unresolved guild blocks the whole distribution. Keep the projection retryable and prevent duplicate transactions. Do not claim cross-tenant atomicity; use a durable batch state and compensating/reconciliation path.

## Reviewable implementation slices

### 1. One-to-many event relationships and participation propagation

- **Outcome:** the control plane can store one canonical event with multiple destination links, and a participant mutation from either a canonical event or one of its copies resolves the canonical event and all linked siblings.
- **Scope:** additive control-plane migration drops the one-source/one-copy constraint while retaining unique destination copies; peer resolution and participant propagation handle all active links. Existing guild-to-alliance links remain valid.
- **Verification:** migration bookkeeping and application test; focused peer-resolution tests for canonical fanout, mirror-to-sibling fanout, and unrelated events.
- **Status:** ready for review. The migration rollback path has a guard that refuses rollback if fanout links exist; that rollback refusal has not been exercised against a live PostgreSQL instance.
- **Review boundary:** no event-copy fanout creation, outbox/retry worker, user attribution selection, or financial projection is included yet. Those require later slices.

### 2. Durable fanout job storage

- **Outcome:** control-plane tables can durably record an event operation and each tenant target's retry state without coupling databases.
- **Scope:** job/target tables, operation idempotency key, attempt/error state, retry time and lease fields, and migration registration.
- **Verification:** control-plane migration application test confirms tables exist; focused migration registry test; rustfmt and diff check.
- **Status:** ready for review. Runtime producers, claims, workers, and destination event idempotency are not included.
- **Review boundary:** no event fanout is enabled by this schema alone.

### 3. Durable event-copy creation and Alliance-to-Guild fanout

- **Outcome:** an alliance event creates one idempotent copy per active guild, while guild-origin sharing remains Alliance-only. A failed target can recover without duplicating the source or a destination copy.
- **Scope:** outbox producer/claim/worker, stable target-side source identity, tenant asset copies, event links, retries and membership departure handling, and status/reporting.
- **Verification:** zero/one/many guilds; transient and crash-window retries; no duplicate copies; membership changes; no guild-to-guild fanout; local per-tenant delivery configuration.
- **Status:** ready for review. Tests cover flash-event fanout to two guilds with different local delivery settings, an organized event with copied comp/build/roster role, a simulated retry after destination event creation but before outbox acknowledgement, a guild departure before processing, outbox lease reclaim/fencing/idempotency, and rejection of guild-to-guild fanout.
- **Review boundary:** stop before multi-copy lifecycle synchronization and money projection.
- **Known boundary:** guild-origin sharing remains alliance-only, but a failed direct mirror does not yet enter the outbox. Destination assets can be orphaned if the process fails after copying them but before the event and asset-map rows are completed; event copies themselves are protected by the unique source identity.

### 4. Multi-copy event lifecycle and participant attribution

- **Outcome:** joins, leaves, event updates, cancel/archive and relevant state changes synchronize across every active linked copy. Guild context fixes attribution; alliance context asks only when multiple active guilds are possible.
- **Scope:** stable account identity, a control-plane participant→guild attribution record, permission boundaries, user-facing Discord and web flows, and refresh of tenant-local poller state. Proposed API: `GET /api/events/{id}/participation-guilds` returns the caller's eligible active guilds; `POST /api/events/{id}/participate?guild_tenant_id=...` requires an eligible guild only in alliance context. A guild tenant always attributes to itself.
- **Status (backend subset, implemented):** `event_participant_attributions` stores one durable guild attribution per canonical event + Discord ID (never switched once recorded). `GET /api/events/{id}/participation-guilds` returns the caller's eligible guilds (guild tenant = itself; alliance = active membership guilds joined to `user_tenant_memberships`; none → actionable 409). `POST /participate?guild_tenant_id=` validates the choice against that list and resolves/persists attribution before any roster write; joins and leaves propagate to the canonical event, non-guild copies, and only the attributed guild's copy — not sibling guilds. Legacy signups without a stored attribution keep the propagate-to-all-peers behavior. Owner-authorized update/cancel/uncancel/archive/delete now converge every active copy: alliance sources enqueue a durable `update`/`archive` fanout job (visible and retryable through the existing outbox), guild-origin sources converge their alliance mirror inline and return errors for retry. Guild copies with an enabled sync link reject management actions. Covered by Postgres integration tests: guild fixed attribution, alliance 0/1/many choices, leave from a different copy, owner-only management rejection, cancel/uncancel convergence, and retry after a partial target failure.
- **Review boundary (remaining in slice 4):** Discord bot slash/button flows and frontend selection UI are not included; tenant-local poller refresh of changed copies is not wired (Slice 5 territory).
- **Verification:** API tests for guild/alliance contexts, ambiguous choice, repeated join/leave and transient failures; bot slash/button tests; owner-only edit/cancel.
- **Review boundary:** stop before split/transaction distribution.

### 5. Tenant-local Discord publication, VOD, and split displays

- **Outcome:** each tenant publishes a linked event using its own configured Calendar/Channel message/Forum mode, VOD destination, and tags; non-owner split copies are clearly read-only.
- **Scope:** event payload/config separation, poller state keyed by tenant and event identity, forum controls, private calendar threads, VOD lifecycle, and ownership-aware UI.
- **Verification:** delivery matrix across all three modes; safe retry; VOD archive/restore; forum buttons; calendar privacy/invites; responsive and keyboard checks.
- **Review boundary:** stop before financial transaction projections.

### 6. Alliance split validation and guild transaction projections

- **Outcome:** alliance split remains canonical; one batch creates only the correct guild-local transaction records, or creates none and reports an actionable error if any participant's guild attribution is invalid/inactive.
- **Scope:** stable member-to-guild mapping, full-batch preflight, durable idempotent distribution batch, audit details, retry/reconciliation, transaction visibility, and manual removal workflow.
- **Verification:** exact amount/remainder tests; inactive or ambiguous guild blocks all writes; transient partial failure can resume without duplicates; retries and concurrent confirms are idempotent; per-tenant isolation and audit tests.
- **Review boundary:** stop before any rank-based economic benefits or historical data conversion.

## Risks and controls

- **Cross-database consistency:** tenant databases cannot participate in one ordinary transaction. Use a control-plane outbox, idempotency keys, per-target status, retry, and reconciliation. Do not claim atomic multi-tenant writes.
- **Identity and privacy:** map by stable account/Discord identity, not names. Expose only the guild-local transactions appropriate to the tenant.
- **Membership changes:** take and persist the membership/participant attribution used for each distribution; departures block an uncompleted batch rather than silently redirecting funds.
- **Discord ambiguity:** if Discord may have accepted a post but the response was lost, do not blindly repost. Preserve the existing manual reconciliation safety rule.
- **Migration compatibility:** support old one-to-one links while deploying expanded links/outbox. Do not delete existing event mirrors or ledger rows as a migration shortcut.
- **Rollout:** apply additive control-plane migration before code that writes new rows. Keep new alliance-to-guild fanout disabled until migration and focused tests pass. No production deployment or push is included.
- **External verification:** real Discord delivery and live tenant membership cannot be proven from this workspace; require a staging guild/alliance smoke test before enabling.

## Open implementation assumptions

- Existing tenant user records can be linked safely by Discord ID; verify uniqueness and account-link behavior before the lifecycle slice.
- An alliance owner/admin, not a guild administrator, controls edits and cancellation of alliance-owned events.
- VOD opt-in/opt-out for a linked event needs a per-tenant choice or tenant default; copying the source's boolean to every destination is not acceptable.
- Financial projection must not start until transaction schema, idempotency, audit fields, and failure recovery are inspected and tested against current tenant models.
