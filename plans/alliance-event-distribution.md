# Alliance event distribution

**Status:** Slices 1–6 are implemented and ready for review. Cross-tenant settlement is idempotent and retryable, but is not a single atomic transaction across tenant databases.
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
- Guild-origin sharing still attempts `create_mirror` inline for low latency, then records failures in the durable `event_mirror_requests` outbox. The backend retry worker uses leases and backoff; `GET /api/events/{id}/mirror-status` exposes progress and `POST /api/events/{id}/mirror-retry` re-arms a failed request for an authorized guild manager. Destination events persist source identity before later mirror steps, and the control plane enforces one link per source/destination pair so retries recover the same event rather than creating duplicates.
- `apps/backend/src/modules/platform/service.rs` retains inactive membership and disables event sync on departure. The existing link model can provide historical references, but an explicit direction and owner are not stored.
- Financial models live in tenant databases. Cross-tenant ledger writes cannot be treated as one atomic database transaction.
- The UI-wide radius changes are a separate design-system change and are not part of event distribution.

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
- **Status:** ready for review. Tests cover flash-event fanout to two guilds with different local delivery settings, an organized event with copied comp/build/roster role, a simulated retry after destination event creation but before outbox acknowledgement, a guild departure before processing, outbox lease reclaim/fencing/idempotency, rejection of guild-to-guild fanout, and guild-origin mirror recovery after membership returns with a destination event already created but not yet linked. Failed requests can be manually re-armed, and archived/cancelled sources are marked inactive rather than mirrored.
- **Review boundary:** stop before multi-copy lifecycle synchronization and money projection.
- **Known boundary:** guild-origin sharing remains alliance-only. Destination comp/build/split assets can be orphaned if the process fails after copying them but before the event and asset-map rows are completed; event copies themselves are protected by the unique source identity. Mirror retries stop after 12 attempts; an authorized guild manager can inspect status and manually re-arm a failed request.

### 4. Multi-copy event lifecycle and participant attribution

- **Outcome:** joins, leaves, event updates, cancel/archive and relevant state changes synchronize across every active linked copy. Guild context fixes attribution; alliance context asks only when multiple active guilds are possible.
- **Scope:** stable account identity, a control-plane participant→guild attribution record, permission boundaries, user-facing Discord and web flows, and refresh of tenant-local poller state. Proposed API: `GET /api/events/{id}/participation-guilds` returns the caller's eligible active guilds; `POST /api/events/{id}/participate?guild_tenant_id=...` requires an eligible guild only in alliance context. A guild tenant always attributes to itself.
- **Status (implemented):** `event_participant_attributions` stores one durable guild attribution per canonical event + Discord ID (never switched once recorded). `GET /api/events/{id}/participation-guilds` returns the caller's eligible guilds (guild tenant = itself; alliance = active membership guilds joined to `user_tenant_memberships`; none → actionable 409). `POST /participate?guild_tenant_id=` validates the choice against that list and resolves/persists attribution before any roster write; joins and leaves propagate to the canonical event, non-guild copies, and only the attributed guild's copy — not sibling guilds. Legacy signups without a stored attribution keep the propagate-to-all-peers behavior. Owner-authorized update/cancel/uncancel/archive/delete now converge every active copy: alliance sources enqueue a durable `update`/`archive` fanout job (visible and retryable through the existing outbox), guild-origin sources converge their alliance mirror inline and return errors for retry. Guild copies with an enabled sync link reject management actions. The web and Discord join/button/select/thread flows implement the zero/one/many guild attribution cases.
- **Verification evidence:** the current worktree passed `cargo check -p backend --tests`; PostgreSQL-focused tests passed for event lifecycle (8), fanout worker (4), control migrations (2), and alliance scope loading (1), including the guild mirror retry/cancel and concurrent split cases. The full backend lib suite did not complete within the 5-minute limit and reported failures; at least one representative DB-backed test fails in the existing SQLite fixture migration because SeaORM SQLite does not support the migration's multiple alter options. Frontend event-detail tests/build and the Discord-bot build/focused join tests passed in earlier runs; no live Discord or staging smoke test was run.
- **Review boundary:** stop before tenant-local poller refresh and Discord publication reconciliation (Slice 5), and before split/transaction distribution (Slice 6).
- **Verification:** API tests for guild/alliance contexts, ambiguous choice, repeated join/leave and transient failures; bot slash/button tests; owner-only edit/cancel.
- **Review boundary:** stop before split/transaction distribution.

### 5. Tenant-local Discord publication, VOD, and split displays

- **Outcome:** each tenant publishes a linked event using its own configured Calendar/Channel message/Forum mode, VOD destination, and tags; non-owner split copies are clearly read-only.
- **Scope:** event payload/config separation, poller state keyed by tenant and event identity, forum controls, private calendar threads, VOD lifecycle, and ownership-aware UI.
- **Verification:** delivery matrix across all three modes; safe retry; VOD archive/restore; forum buttons; calendar privacy/invites; responsive and keyboard checks.
- **Status (implemented):** the Discord poller uses each tenant's stored delivery mode and configuration. Channel messages keep a plain parent ping with a discussion-thread signup card; calendar events keep private discussion threads linked from the calendar; forum delivery edits the forum starter with signup controls. Content-only changes use `updated_at` in the revision fingerprint. Forum creates with ambiguous results are not automatically retried; known threads are reused after a failed starter edit. Archived announcements are deleted and tracked in a tenant-local restore tombstone; scheduled/live restored events republish once through the configured mode. Confirmed-deleted VOD posts return to pending on restore, while ambiguous VOD creates remain non-retriable. Event/split copies are labeled, event owner controls are hidden in the UI, and server handlers/service guards reject management mutations on active copies. Old mirror event identity is resolved from active control-plane links; a departed guild's inactive link is no longer treated as read-only.
- **Verification evidence:** bot build and full test suite passed (205/205); frontend focused events/splits tests passed (61/61), and the frontend production build passed. `cargo check -p backend --tests` passed. The focused PostgreSQL lifecycle suite passed (5/5), including event start/status convergence and VOD restore across tenants. The isolated service-level VOD restore test and route-authority test could not be run because the repository's SQLite fixture migration fails with SeaORM's “Sqlite doesn't support multiple alter options”; the Postgres lifecycle coverage passed. No live Discord forum/channel/calendar smoke test or manual keyboard/mobile browser pass was run.
- **Review boundary:** stop before financial transaction projections.

### 6. Alliance split validation and guild transaction projections

- **Outcome:** alliance split remains canonical; one batch creates only the correct guild-local transaction records, or creates none and reports an actionable error if any participant's guild attribution is invalid/inactive.
- **Scope:** stable member-to-guild mapping, full-batch preflight, durable idempotent distribution batch, audit details, retry/reconciliation, transaction visibility, and manual removal workflow.
- **Verification:** exact amount/remainder tests; inactive or ambiguous guild blocks all writes; transient partial failure can resume without duplicates; retries and concurrent confirms are idempotent; per-tenant isolation and audit tests.
- **Review boundary:** stop before any rank-based economic benefits or historical data conversion.
- **Status (implemented):** Alliance-owned event splits use the existing durable `event_participant_attributions` and active alliance membership as the only routing authority. Completion preflights every participant's linked Discord identity, stored guild attribution, active membership, destination account, and positive share before creating a batch or writing any tenant ledger. Missing/ambiguous attribution or a departed guild blocks the whole split; staff remove affected participants manually and retry. A control-plane batch and per-recipient rows record source split, guild, amount, state, transaction id, actor, and errors. Guild-local transactions have a unique distribution key and expose their source alliance split id. A repeated completion resumes incomplete recipient credits and does not duplicate already-created rows; only after all credits succeed is the alliance split finalized. Split owners/admins can inspect recipient progress at `GET /api/splits/{id}/distribution-status`. Guild-origin and ordinary guild split completion behavior is unchanged.
- **Verification evidence:** the control/tenant migration integration test passed; weighted-share remainder test passed; Postgres lifecycle integration test verified inactive-guild all-or-none preflight, manual roster removal, a transient second-recipient failure followed by retry without duplicate credits, guild-ledger isolation, source traceability, and idempotent repeat (1/1). `cargo check -p backend --tests` passed. Cross-database transactions are not atomic: a transient error after some recipient rows are written leaves a durable failed batch; retrying the same completion endpoint resumes using destination idempotency keys. There is no autonomous split-distribution retry worker; an authorized operator retries the completion endpoint after inspecting the status route.

## Risks and controls

- **Cross-database consistency:** tenant databases cannot participate in one ordinary transaction. Use a control-plane outbox, idempotency keys, per-target status, retry, and reconciliation. Do not claim atomic multi-tenant writes.
- **Identity and privacy:** map by stable account/Discord identity, not names. Expose only the guild-local transactions appropriate to the tenant.
- **Membership changes:** take and persist the membership/participant attribution used for each distribution; departures block an uncompleted batch rather than silently redirecting funds.
- **Discord ambiguity:** if Discord may have accepted a post but the response was lost, do not blindly repost. Preserve the existing manual reconciliation safety rule.
- **Migration compatibility:** support old one-to-one links while deploying expanded links/outbox. Do not delete existing event mirrors or ledger rows as a migration shortcut.
- **Rollout:** apply additive control-plane migration before code that writes new rows. Keep new alliance-to-guild fanout disabled until migration and focused tests pass. No production deployment or push is included.
- **External verification:** real Discord delivery and live tenant membership cannot be proven from this workspace; require a staging guild/alliance smoke test before enabling.

## Open implementation assumptions

- Tenant user matching and event participant attribution use Discord IDs rather than names; verify identity uniqueness and membership behavior in staging before enabling cross-tenant settlement.
- An alliance owner/admin, not a guild administrator, controls edits and cancellation of alliance-owned events.
- VOD opt-in/opt-out for a linked event needs a per-tenant choice or tenant default; copying the source's boolean to every destination is not acceptable.
- Financial projection must not start until transaction schema, idempotency, audit fields, and failure recovery are inspected and tested against current tenant models.
