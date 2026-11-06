# SPEC: consolidated implementation spec (second wave)

> **Decisioni del proprietario aggiunte dopo la consolidazione (2026-11-05):**
> - Q1 (prima di ID-6): l'accesso web a un tenant richiede la membership nel suo server Discord, anche per l'alleanza.
> - Q2 (prima di SY-6b): uno split alleanza completato e distribuito non si modifica; le correzioni si fanno con uno split di rettifica separato.
> - DB di test: per ora niente Postgres reale; solo test SQLite, i test Postgres restano saltati. Le invarianti di concorrenza vanno coperte il più possibile con test SQLite e con vincoli/`UPDATE ... WHERE` condizionali verificabili.
> - Tutte le altre decisioni prodotto sono in AUDIT-PLAN.md §6 e nelle risposte riportate nei design.


Status: consolidates `sync-engine.md` (SE), `discord-outbox.md` (DO), `member-sync.md` (MS), `shared-actions.md` (SA) and resolves every point of `critique.md` (CR). Adds the remaining plan.md work packages (WP1, WP2, WP3, WP4, WP14, WP15, WP16, WP17, WP18) as slices of the same ordered list.
Base: HEAD `f7f60e44`, worktree `.delta/worktrees/p5c46fnark18/Weaklings-Manager`. Paths relative to `apps/backend/src` unless stated (`BOT` = `apps/discord-bot/src`, `FE` = `apps/frontend/src/app`). Owner decisions are final and not re-opened.

## 0. How to read this document

* Precedence: this SPEC wins over SE/DO/MS/SA wherever they disagree. Where it says "as SE §x" the sub-design section is normative for the detail (columns, SQL, algorithms) and only the stated deltas apply.
* Section 2 is the list of resolutions (every CR item). Section 3 is the single glossary of names. Section 11 is the globally ordered slice list; each slice is one PR.
* Verified in the worktree while writing: no `sqlx`, `tokio-stream`, `async-trait` or `futures` dependency in `apps/backend/Cargo.toml`; `CONTROL_MIGRATION_COUNT = 26` at `control_migration/mod.rs:56` (asserted :134, :324); only `alliance.share`, `alliance.leave`, `splits.manage` exist in `auth/permissions.rs` (no `alliance.manage*`, no `sync.*`); `PermissionCache::role_has` (`auth/permission_cache.rs:27`) only implies for `EventsManage`; fanout worker is spawned at `lib.rs:118`; frontend is AnalogJS/Nitro SSR (`main.server.ts` exports `render(url, document)`, no request/cookie reaches the render, `AuthService.fetchProfile` short-circuits to "signed out" on the server); `styles.css` is a Discord token layer (lines 1-1715) overridden by a Zed block (lines 1719-1808); `DESIGN.md` currently holds the Zed reference, the Discord one is `git show 9edd00ed:DESIGN.md`.

---

## 1. Architecture in brief

```
 web / bot command / scheduler / sync-engine apply / member events
                  |
        events::lifecycle::transition_in_txn(txn, id, Transition, Cause, actor)      <- ONE choke point (R1)
        sync::mutate_origin_in(txn, kind, id, op, f)                                  <- non-lifecycle writes
                  |  same tenant txn
     +------------+------------------------------+
     | domain rows | sync_outbox (tenant)          | discord_outbox (tenant)  | action_log (tenant)
     +------------+--------------+---------------+------------+-------------+
                                  |                            |
                    sync relay (control loop)           Discord hub (SSE + poll fallback)
                                  v                            v
                  control.sync_jobs  (ONE queue)        bot executor (stateless reducers)
                  leases, fencing, backoff, ordering          |  bindings / ack / fail / signals
                                  v
       handlers (event, event_roster, build, comp, split, split.payout, warn, regear_request,
                 member.*, tenant.reconcile, membership.backfill/detach, role.grant/revoke)
                                  v
        tenant copy rows + sync_copies (marker, truth) + control.sync_links (mapping)
```

* Origin owns, copies are read-only and link back (`ReadOnlyCopy` 403 + `origin`). Topology is a star around the origin; a copy never re-emits state, only commands (signups) and tenant-local effects.
* ONE sync queue (`control.sync_jobs`), ONE Discord-effect queue (`tenant.discord_outbox`), ONE lifecycle core, ONE copy truth (`sync_copies`), ONE identity layer (`users.active` + `ensure_member`), ONE Discord REST client (`DiscordRest`, backend side for roles), ONE wake/runtime module. Everything else in SE/DO/MS/SA is built on those.
* The backend decides scheduling (mass, start, 1h, auto-stop) for guild and alliance tenants; the bot only executes outbox items and forwards gateway events/signals.
* Frontend and bot are renderers of backend-owned capabilities, action descriptors and generated OpenAPI types; SSR stays.

---

## 2. Resolutions (every conflict and critique item)

| # | Item (CR ref) | Resolution |
|---|---|---|
| R1 | Three event write choke points (X1) | One module `events::lifecycle` exposes `transition_in_txn(txn, id, Transition, Cause, actor) -> TransitionOutcome { view, effects: Vec<EffectRef>, sync_outbox_id: Option<i64>, wake: WakeSet }`. Inside the txn it: writes status, takes the XP snapshot (with `XpFilter`, R14), runs local-split participant sync (`SplitService::sync_event_participants(&impl ConnectionTrait, ..)`, inside a SAVEPOINT: a failure logs + marks the split `needs_resync`, never rolls back the stop), recomputes `awaiting_event` splits (FIN-1), calls `sync::outbox::emit` (origin only) and `discord_delivery::emit`. `start_event/stop_event_with_xp_policy/cancel/uncancel/archive/unarchive` become wrappers (`begin; transition_in_txn; commit; outcome.after_commit(&runtime)`). `actions::engine::execute` locks the row, evaluates, calls it, and NEVER enqueues effects itself (it only reports `outcome.effects`). Scheduler, sync converge, legacy routes and bot routes call the same function. `sync::mutate_origin_in(txn, ..)` (takes an existing txn) is the wrapper for non-lifecycle writes (roster, content, comps...); `mutate_origin(db, ..)` is a thin `begin/commit` around it. This is slice F1 and precedes every other event slice. |
| R2 | Membership + member/link/role sync designed twice (X2) | MS owns identity (users, links, gateway, reconcile, role resolver, `LinkOrchestrator`, `ensure_member`, `DiscordRest`). SE owns the queue. `identity_jobs` is NOT created. Member-side work are handlers registered in the SE engine: `member.joined`, `member.left`, `member.link_sync`, `member.effects_sync`, `tenant.reconcile`, `link.origin_backfill` (once-job), `membership.backfill` (phases), `membership.detach`, `role.grant`, `role.revoke`. `sync_jobs` gains `subject text not null default ''` (discord id for member kinds) in the coalesce index; `dirty` flag is unnecessary (a new emit while `processing` inserts a new pending row, blocked by the shared `ordering_key` until the running one ends); `once_key` = `dedupe_key`; cross-tenant mutual exclusion of the same member uses `ordering_key = member:{discord_id}`. `member_facet_state` and `tenant_member_sync` (MS) stay as control-plane read models. ONE migration for `alliance_memberships`: `status` CHECK unchanged (`pending|active|left`), add `left_reason text` (`left|expelled|reset`), `left_by text`, `sync_state text not null default 'ready'` (`ready|backfilling|detaching|detached`). `'expelled'` is a derived API state, never a status value. `users.active/left_at/left_reason` is the only deactivation flag (SE `deactivated_at` dropped). Placeholder email is `<discord_id>@discord.invalid` only (`@alliance.local` dropped; data-fix covers the four legacy patterns). `identity::upsert_discord_user` stays as a deprecated wrapper over `ensure_member(Unknown)` (so legacy fanout files are NOT edited by identity slices); new code calls `ensure_member` directly. `alliance_role_revocations`: imported into `sync_jobs(kind=role.revoke)` (pending -> pending, ambiguous -> resolved by the snapshot rule of MS §2.11 or `blocked`, verified dropped), table kept read-only until SY-9 (no MS columns added). `alliance_role_grants` stays the ledger. One expel route `POST /api/alliances/{alliance_id}/members/{guild_tenant_id}/expel`, authority = tenant owner of the alliance OR platform admin (needs the auth-6 owner fix, slice ID-1); delegation permission `alliance.manage_members` is added to the enum but seeded to nobody. |
| R3 | What is a copy (X3) | `sync_copies` (tenant) is the only truth. One accessor `sync::copy_role(db, kind, id) -> Origin \| ActiveCopy \| DetachedCopy \| NotSynced`. DetachedCopy behaves as Origin for scheduler, auto-stop and guard (fixes the "detached live event never stops" regression). Until `sync_copies` is populated (SY-3a) the accessor is backed by the legacy sources (`event_sync_links` incl. `sync_enabled=false` -> DetachedCopy, `splits.origin_read_only`) behind the same signature (F2), so DO/SA/FIN code programs only against `copy_role`/`guard` from day one. SY-3a imports `event_sync_links` into `sync_copies` (every row, `sync_enabled=false` as `read_only=false`) before any engine handler runs. `events.source_*` and `splits.origin_read_only` remain written by the engine until SY-9 (rollback guarantee, R20) but have no reader outside `sync::*`. |
| R4 | Effect vocabulary (X4) | DO `discord_delivery/kinds.rs` is the only list. SA `ActionDef.effects` is removed; `effects_preview` is derived from `kinds::effects_for(entity, action)`. SA's `alliance.announce` does not exist (alliance announcement = `event.upsert` in the alliance tenant). `discord.role.*` and `alliance.announce` are removed from SA. Missing message-shaped kinds are added by their owner slice into `kinds.rs`: `audit.post` (bank/regear/warn Discord echo, DO-7b; until then `AuditService::log` echo stays best-effort AFTER commit, never in the action txn), `application.decision` (ticket update, SA-11c). |
| R5 | Who mutates Discord roles (X5) | Backend REST (`DiscordRest`, ID-3) for every role grant/revoke/nickname (they need synchronous 403/404 classification and the grant ledger). Executed as sync_jobs (`role.grant`, `role.revoke`, `member.effects_sync`). Application accept assigns its role the same way (job `role.grant`, origin=target=tenant). The outbox carries message-shaped effects only. The bot keeps only `assignJoinRole` on GuildMemberAdd (default role, no ledger). Shared-token rate limits: backend token bucket 4 req/s per guild, 429 -> `Retry-After`; the bot's discord.js limiter is independent (documented residual risk, backend role traffic is low). |
| R6 | Wake-up / topology (X6) | New `runtime` module (F3): `Wake` (in-process `Notify`), one spawn point `runtime::spawn_all(control, registry, deps)` replacing `lib.rs:118`, panic-supervised tasks with restart (backend-perf-9), per-loop start jitter. NO advisory lock and NO `PgListener` in v1: correctness depends only on leases/fencing/conditional UPDATEs and on short polls (relay 5 s, executor 5 s, Discord hub 2 s, scheduler 5 s). Post-commit `outcome.after_commit(&runtime)` kicks the loops for sub-second latency in the single-replica deployment (documented). LISTEN/NOTIFY is an optional later optimisation (would need a direct `sqlx` dependency and one listener per cluster since control and tenants may be on different clusters, `tenant.rs:301-304`); not scheduled. New dependencies added in F3 only: `tokio-stream`, `async-trait`. |
| R7 | Duplicate slices / stale refs (X7) | `refactor/link-orchestrator` exists once (ID-7); SA-12 is dropped. Expel exists once (MEM-3). SA-7 (action effects) is dissolved: it is the acceptance test of DO-3a + SA-4b ("web == bot == scheduler == sync effects"). Scheduler/converge never call `sync_owner_change_to_copies` after commit: `transition_in_txn` writes the sync outbox row; while an event kind is still on the legacy path (`SYNC_ENGINE_KINDS` lacks `event`) `outcome.after_commit` invokes the legacy propagation. Engine-applied copies call `touch_event(txn, ..)` INSIDE the apply txn (no after-commit `delivery::enqueue`). |
| R8 | `not_joined` users vs pickers (X8) | `users::visible(kind)`: guild tenants = `active`; alliance tenants = `active OR left_reason='not_joined'` (so alliance officers find guild members who are not in the alliance Discord). Leaderboards/broadcast/giveaways stay `active`-only. Reconcile never deactivates `not_joined` rows; rows with `provisioned_via IN ('sync','alliance_sync','event_sync')` that are absent from Discord are set `active=false, left_reason='not_joined'` (not `left`). `identity::member_guilds` (MS) is THE function behind `events/attribution.rs::eligible_participation_guilds`; SY-4c depends on ID-5 for correctness. `MemberLifecycleHooks::on_member_left` is registered by SY-4c (withdraw future signups, flag `attribution_state=guild_left` on attributed rows of alliance events; no silent re-attribution). |
| R9 | Authority rules (X9) | Expel: R2. Sync status/retry: `sync.view`/`sync.manage` (new permissions, seeded to roles holding `alliance.share`) OR the entity's manage authority (creator-or-`events.edit` / `splits.*`). Splits: `CreatorOr(SplitsEdit)` for update/complete/not_completed/lost/participants, `CreatorOr(SplitsDelete)` for archive/unarchive, plus `SplitsManage` implies View/Create/Edit/Delete in `role_has` (superset, nobody loses anything; default assumption, see §13). `update` on a COMPLETED split stays allowed for guild-origin/local splits (today `load_editable(.., allow_completed=true)`, `splits/service.rs:1198-1215`); for an alliance-origin split with a distribution batch it is rejected `409 completed_alliance_split_immutable` until the owner decides about delta distribution (§13). Catalogue modules added in SA-2 so `MODULE_KIND_ENFORCEMENT=enforce` is explicit: `sync` (both kinds), `members` (both), `discord` (both, permission-gated), `alliance` (alliance + guild-as-member); `/api/bot/*` and `/api/openapi.json` are never gated; any other unknown prefix defaults to ALLOW. |
| R10 | Guild leaves: live copy + link release (CR §2.1) | Leave/expel archives not-started copies only; live copies are detached (`DetachedCopy`, becomes local, local scheduler can stop them); terminal copies are detached (history). An Albion link released by a competing claim (owner inactive, or a detached copy) is not lost: the row is moved in the same txn to the new tenant table `albion_links_history` (all `albion_links` columns + `released_at`, `release_reason`, `claimed_by_discord_id`) and removed from `albion_links`, which keeps the unique constraints on `discord_id`/`albion_player_id` valid (they are column-level `unique_key()` in `m20260709_000004`, not droppable on SQLite) and keeps the player name for history rows. Copies of a left guild get `detached_at` and stay until a claim releases them. |
| R11 | Splits permission/regression (CR §2.2) | See R9. Re-distribution for amended completed alliance splits: rejected (default), question parked in §13. Alliance `complete()` keeps its synchronous preflight and `load_or_create_batch`, then enqueues one `split.payout` job per guild; the `split.complete` ActionResult carries `distribution: { batch_id, state: 'queued', total_items }` (clients render "payout in progress"). |
| R12 | `member_standing` / XP at alliance (CR §2.3) | XP lives only in guild ledgers. `retry_pending_event_completion_xp` stays guild-only (SE §14 requirement dropped). `progression.summary`/`member_standing` becomes the optional last sync slice SY-7b (level + guild_rank per member, shown as a badge in the alliance directory, no leaderboard route, no XP totals). Owner may drop it with zero impact on other slices. Regear request and attendance for alliance events are restricted to participants attributed to the tenant in SY-3d. |
| R13 | Guild-origin roster owner (CR §2.4) | Roster owner = origin. For guild-origin shared events the guild holds the roster; foreign signups land as foreign users in the guild (`ensure_member(Unknown)`). Attribution NULL means "origin tenant's own member" only when origin kind is `guild` and the event was never synced; for alliance-origin events and all copies NULL means "unattributed": no XP, no regear, flagged `attribution_required` for officers. |
| R14 | XP filter signature (CR §3.2) | `award_xp: bool` is replaced by `XpFilter { Everyone, AttributedTo(tenant_id), OwnMembersOnly }` in `stop_event_with_xp_policy` and `snapshot_event_completion_xp`. `xp_event_create` goes to the creator only in the origin tenant when the origin is a guild. |
| R15 | Sibling guild announcements (CR §2.6) | Owner text: "announced once on the alliance Discord and visible to other member guilds". Sibling guild copies of a guild-origin event are visible in web and DO NOT post to the sibling guild's Discord: `sync_copies.deliver_discord boolean not null default true` is false for sibling copies of guild-origin events (true for alliance copies and for guild copies of alliance-origin events). The DO render returns `skip: "copy_no_delivery"`. One-line flip in `sync::policy` if the owner wants it. |
| R16 | Frontend SSR / Zed (CR §2.7) | SSR kept. FE-1 forwards the session cookie to the backend during render (Analog server context in `main.server.ts`), so the server renders the real shell instead of the signed-out one; SSR responses are `private, no-store`. Data stores are root-provided (per-request injector on the server, no module-level singletons). Capabilities store (SA) is SSR-safe by construction (fetched in `provideAppInitializer`, transferred with `TransferState`). `/switch-tenant?tenant=&next=` validates `next` as a same-origin relative path. "Drop the Zed layer": slice FE-6 deletes the Zed block (`styles.css` 1719-1808 + any `zed`-only classes, `compact-feature.styles.ts` audit), restores `DESIGN.md` from `9edd00ed`, loads the Discord fonts. |
| R17 | Dependency copies vs policy retirement (CR 3.1) | `Kind::targets()` = policy set UNION dependency set (tenants whose active events/roster roles reference the entity). A guild-origin comp/build referenced by an alliance event is therefore copied to sibling guilds (origin stays the guild) and is retired only when no active reference remains. |
| R18 | Roster vs terminal ordering, XP snapshot (CR 3.2) | `event` and `event_roster` jobs for the same (origin, event, target) share ONE `ordering_key = event:{origin}:{id}:{target}`; on a terminal origin transition `transition_in_txn` emits `EventRoster` first and `Event` second in the same txn (so seq order = roster then status). The `event` apply for a terminal status additionally refuses (`Retryable(roster_behind)`, no attempt consumed) while `sync_copies(event_roster).origin_version < payload.roster_version_at_stop`. |
| R19 | Local splits on copy events (CR 3.3) | `SplitService::sync_participants_from_event` (`splits/service.rs:1353`) imports only participants attributed to the tenant when the event is a copy (or alliance-origin), skips non-`pending` splits and splits with `roster_locked=true` (FIN-1). |
| R20 | Rollback (CR §4) | Per kind flag `SYNC_ENGINE_KINDS` (comma list, default empty = legacy). The engine keeps writing the legacy rows (`event_sync_links`, `events.source_*`, `splits.origin_read_only`, `alliance_shares`) until SY-9, so flipping a kind back to legacy loses nothing. `SYNC_KINDS_DISABLED` pauses a kind without code change. SY-9 waits one full release after the last flip. DO has per-tenant `discord_delivery_mode` (off/shadow/on) as its rollback. |
| R21 | Projection details (CR 3.4, 3.5) | Roster apply diffs `event_participations` by `(event_id, user_id)` (UPDATE/INSERT/DELETE), never delete+insert (FK from `event_roster_assignments` ON DELETE CASCADE, builds RESTRICT). Copies get a separate `events.projection_version bigint` (origin roster version applied); local `roster_version` stays strictly monotonic and is bumped by both local pending signups and projection; DO fingerprint uses `roster_version` only. |
| R22 | Mass/reminder stamps (CR 3.6) | `update_event` that changes `mass_time_utc`/`start_time_utc` (and uncancel->reschedule) clears `mass_notified_at`/`reminder_notified_at` when the new time is in the future; `once_key` includes the scheduled epoch (`event:{id}:mass:{epoch}`), so a postponed event re-masses. DO-1's tenant migration backfills `mass_notified_at = now() WHERE mass_time_utc <= now()` and `reminder_notified_at = now() WHERE start_time_utc - 1h <= now()` for non-terminal events (no re-mass at cutover when the importer file is missing). SE converge never copies the stamps. |
| R23 | Migration numbering (CR 3.7) | `CONTROL_MIGRATION_COUNT` constant removed in F3 (tests assert against `control_migration::migrations().len()`). Migration files are append-only at the end of `migrations()` (a rebase conflict is one line). Names `m<yyyymmdd>_<seq>_<snake_name>` use the merge date of the slice, unique suffixes. All tenant migrations: ONE `alter_table` per column, JSON stored as `TEXT` or `JSON` (never `JSONB`), partial indexes via `execute_unprepared` (SQLite-safe, WP0 rule). Control migrations are Postgres-only. |
| R24 | Backfilled / late copies must not ping (CR 3.8) | `Cause::Sync` with `backfill=true` (membership backfill, reconcile re-create, legacy import) sets `payload.ping=false` on `event.upsert`. A backfill of 30 events produces 30 silent announcements (or one digest, later). |
| R25 | `sync_jobs` insert statement (CR 3.9, 3.11) | Relay per outbox row: (1) `UPDATE sync_jobs SET origin_version=GREATEST(..), op=..., updated_at=now(), next_attempt_at=CASE WHEN state='pending' THEN LEAST(next_attempt_at, now()) WHEN state='retry' AND updated_at < now()-interval '30 seconds' THEN now() ELSE next_attempt_at END WHERE <coalesce key> AND state IN ('pending','retry')` (attempts never reset, so a burst cannot exhaust a failing target); (2) if 0 rows: `INSERT ... ON CONFLICT (dedupe_key) DO NOTHING`; (3) on a unique violation of the coalesce index (race) loop to (1) once. Replay of an already-finished job is a no-op, never an error. |
| R26 | Command ordering across emitters (CR 3.10) | Commands carry `issued_at` (emitting txn `now()`, microseconds) and `emitter_tenant`. `sync_inbox(ordering_key, last_issued_at, last_seq)`: apply only if `(issued_at, seq) > (last_issued_at, last_seq)`, otherwise `Done(result={status:"superseded"})`. `origin_version` is never compared across emitters. Pending rows carry `command_seq_seen` per (event, discord_id) with the same pair. |
| R27 | Suspended tenants (CR §4) | `sync_jobs.state` gains `paused`: `get_or_load` returning NotFound-for-inactive maps to `Paused(reason)` (no attempt burn); `PlatformService` tenant resume calls `sync::on_tenant_resumed(tenant)` which re-arms `paused -> pending`. The Discord scheduler only visits active tenants (already). |
| R28 | Bot-offline terminal events (CR §4) | `render/event` returns `skip: "never_announced"` when the entity is terminal/archived and has no binding; reducers ack `skipped`. |
| R29 | Relay cache staleness (CR §4) | The participating-tenant cache (30 s) is invalidated explicitly by `accept_alliance_membership` / `mark_alliance_left` (in-process call after commit) and `membership.backfill` re-scans events once at completion (second pass over the window since job start). |
| R30 | `/members/ensure` vs `user_ref` (CR §4) | Two trust levels, both documented: bot-verified presence -> `POST /api/members/ensure` (`ensure_member(Present)`, activates); backend-only references (`user_ref` on `warn.issue`, `progression/adjust`, officer add) -> resolve existing row or `ensure_member(Unknown)` (never activates, `not_joined`). |
| R31 | Scheduler predicate (CR 3.13) | `events::lifecycle::who_stops(role: CopyRole, tenant_mode) -> Stopper { Legacy, Scheduler, Nobody }` is the single predicate used by `event_sessions/auto_stop.rs` (legacy) and `discord_delivery::scheduler`: Origin/Detached + mode `on` -> Scheduler; Origin/Detached + mode `off|shadow` -> Legacy; ActiveCopy -> Nobody (status follows converge). Table-tested on {mode} x {role} x {sync legacy/engine}. |
| R32 | Mixed rollout (CR §4) | Until DO-9, an alliance copy of a guild-origin event does not emit its `event.upsert` while the origin guild's `discord_delivery_mode != on` (the guild's legacy poller still posts directly to the alliance channel); when the origin flips to `on` the tenant-mode flip re-arms and emits it with `ping=false`. Documented residual: events already posted by the legacy path get one extra (silent) announcement. |
| R33 | Failure of `touch_event` forgetting | Drift sweep (DO-3c) is the safety net; `choke_points_call_emit` static test (SE §3.2) and `touch_event` grep test list the call sites. |
| R34 | Idempotency key (CR §6) | `action_log` unique index is `(actor_user_id, action, entity_type, coalesce(entity_id,0), idempotency_key) WHERE idempotency_key IS NOT NULL`. |
| R35 | Direct roster ops (CR §6) | `Transport::Direct` ops call `sync::guard::assert_writable` inside `mutate_origin_in`; `actions::evaluate` maps `AppError::ReadOnlyCopy` to `reason_code=copy_read_only` (one vocabulary). |
| R36 | Flash undo window | DO-3b owns `available_at = created_at + 30 s` for `event_kind='flash'` (reads `commands/flash.ts` + `services/flash-time.ts` first); SA-9 only passes the kind. |
| R37 | Explicit bot instance id | `BOT_INSTANCE_ID` is mandatory in `DELIVERY_MODE=outbox` (the bot refuses to start without it, otherwise two containers sharing a hostname would evict each other); the newest connection of the same `instance_id` wins (DO §6.4). |
| R38 | Voice-empty degradation | Delivery admin panel (DO-7b/FE) shows "voice signals stale" when `last_observed_at` is old; a blind bot never stops events (DO §9.3). |
| R39 | `MODULE_KIND_ENFORCEMENT` flip | Never in a code PR: SA-3 deletes `FEATURE_GATES` but ships `log`; the flip to `enforce` is ops gate O2 (§12) after 7 days with `would_block == 0`. |
| R40 | DO-1 data move | DO-1 only creates schema. Seeding bindings from `split_discord_sync`, giveaway ids, VOD, voice columns is `discord_delivery::seed_from_legacy(tenant)` run by DO-6 at mode flip (idempotent, `ON CONFLICT DO NOTHING`), so it reads fresh data, not data frozen at migration time. |
| R41 | Reconcile provisioning | `members_provision_all` default true (directories/leaderboards complete); parked as default in §13. |
| R42 | Web access requires Discord presence | Consequence of auth-4 + owner "ex-members soft-deactivated". Default: yes, per tenant. Parked as BLOCKING question for ID-6 only (§13). |

---

## 3. Glossary (the only names to use)

| Name | Definition |
|---|---|
| `events::lifecycle::transition_in_txn` | R1. Only place that changes event status. |
| `sync::mutate_origin_in / mutate_origin` | guard + closure + `emit`, for non-lifecycle writes. |
| `sync::outbox::emit(conn, SyncEmit)` | writes tenant `sync_outbox` row (coalescing for state kinds, never for commands). No-op on copies for state kinds (debug log). |
| `sync::copy_role(db, kind, id)` | R3. |
| `sync::guard::{assert_writable, copy_info}` | `AppError::ReadOnlyCopy(Box<OriginRef>)` 403, problem type `.../sync-copy-read-only`, field `origin`. |
| `discord_delivery::{emit, touch_event, kinds}` | DO. `touch_event(conn, event_id, Cause, TouchReason)` emits `event.upsert` (+ `calendar.sync`). |
| `Cause` | `Web | Discord | Scheduler | Sync { backfill: bool } | Settings | Reconcile | Import | Manual`. Labels rows only. |
| `identity::ensure_member(db, MemberSeed)` | MS §2.3. |
| `identity::member_guilds(control, discord_id, alliance_id)` | R8. |
| `DiscordRest` | MS-S3 trait (`modules/discord_api`), in `SyncCx`. |
| `runtime::{Wake, WakeSet, spawn_all}` | R6. |
| `SyncCx` | `{ control, registry, hub, discord: Arc<dyn DiscordRest>, runtime, cfg }`. |
| `SYNC_ENGINE_KINDS`, `SYNC_KINDS_DISABLED` | R20. |
| `XpFilter` | R14. |
| `copy deliver_discord` | R15. |

---

## 4. Consolidated data model (delta vs sub-designs)

Control plane (Postgres, schema `control`):
* `sync_links`, `sync_legacy_import` exactly as SE §2.1. `sync_jobs` as SE §2.1 plus `subject text not null default ''` (in the coalesce unique index), `state` CHECK extended with `paused`, `op` CHECK extended with `reconcile`, and kinds registered by handlers (no CHECK on kind). Claim query SE §4.1 excludes `paused` and any target tenant in the in-process circuit-breaker.
* `alliance_memberships`: R2 columns only.
* MS read models: `member_facet_state`, `tenant_member_sync` (MS §2.2). No `identity_jobs`.
* DO: `tenants.discord_delivery_mode`, `discord_bot_instances` (DO §3.2).
* Dropped from SE: `sync_state` alias, `deactivated_at`, status `expelled`. Dropped from MS: `identity_jobs`, revocation worker columns.

Tenant schema (every tenant; SQLite-safe):
* SE: `sync_outbox`, `sync_copies` (+ `deliver_discord boolean not null default true`), `sync_inbox` (`ordering_key pk, last_issued_at timestamptz, last_seq bigint`), `event_participations.{attributed_guild_tenant_id, sync_state, command_seq, attribution_state}`, `events.{lifecycle_epoch, projection_version}`, optional `member_standing` (SY-7b).
* DO: `discord_bindings`, `discord_outbox`, `discord_delivery_state`, `event_voice_presence`, `events.{mass_notified_at, reminder_notified_at}` + backfill (R22), index `ix_events_sched`.
* SA: `action_log` (R34).
* MS: `users.{active,left_at,left_reason,discord_role_ids,roles_checked_at,member_event_at,provisioned_via,last_link_change_at}`, `albion_links.{origin_tenant_id,origin_link_id,albion_guild_id,declared_via,detached_at}`, new table `albion_links_history`, `guild_settings.members_provision_all`.
* FIN-1: `splits.roster_locked boolean not null default false`.

---

## 5. Runtime: loops, leasing, wake-up (single place)

| Loop | Owner slice | Wake | Claim/lease | Retry / terminal |
|---|---|---|---|---|
| sync relay | SY-1 | `Wake` + 5 s | tenant txn `FOR UPDATE SKIP LOCKED` on `sync_outbox` (200) | replay-safe (R25) |
| sync executor x4 | SY-1 | `Wake` + 5 s | SE §4.1 (lease 60 s, 5 min for scans, fencing on `lease_token`) | SE §4.2 states + `paused` (R27); backoff `min(3600, 15*2^min(n,8))*jitter` from `runtime::backoff` |
| sync maintenance | SY-1/SY-8 | 60 s | - | purge, lag watchdog |
| sync reconcile | SY-8 | hourly + boot | job-based | - |
| Discord hub (SSE + poll) | DO-2 | `Wake` + 2 s tick | `claim_due` per tenant, lease 90 s, `instance_id` reclaim | DO §6.5 classes, `ambiguous` needs human |
| Discord scheduler | DO-4 | 5 s | conditional `UPDATE ... WHERE x_notified_at IS NULL` + `once_key` | none needed, multi-replica safe |
| Discord reconcile/drift + janitor | DO-3c | 60 s / hourly | - | - |
| member gateway forwarder | ID-4 (bot) | event | in-memory 2 s debounce | backoff, cap 2000 |
| `tenant.reconcile` | ID-5 | job (30 min self-reschedule) | `sync_jobs` | integrity gate, `suspicious` needs `force` |
| event_sessions (legacy) | existing | 30 s | - | keeps auto-stop for `off|shadow` tenants until DO-10 (R31) |

All loops are started from `runtime::spawn_all`; single replica documented; a second replica is safe by construction (leases, conditional updates), only the in-process circuit breaker and `Wake` are per replica.

---

## 6. API surface (owner slice in brackets; payloads as in the cited sub-design section)

| Group | Routes | Auth |
|---|---|---|
| Sync status [SY-1] (SE §7) | `GET /api/sync/status?entity=kind:id`, `GET /api/sync/summary`, `GET /api/sync/jobs`, `POST /api/sync/jobs/{id}/retry`, `POST /api/sync/retry`, `POST /api/sync/resync`; legacy adapters `fanout-status`, `mirror-status`, `mirror-retry`, `alliance-distribution` (kept until SY-9) | `sync.view` / `sync.manage` or entity manage authority; rows restricted to caller tenant (origin or target) |
| Alliance membership [MEM-1/3] | `GET /api/alliances/{id}/sync/members`, `POST .../members/{guild}/backfill`, `POST .../members/{guild}/resync` (same job), `POST .../members/{guild}/expel` | tenant owner / platform admin (R2) |
| Members [ID-2/4/5/8] (MS §2.13) | `POST /api/members/sync`, `POST /api/members/ensure`, `POST /api/members/reconcile`, `GET /api/members/sync/status`, `GET /api/members/{user_id}/sync`, `POST /api/members/{user_id}/sync/retry`, `GET /api/albion/register/candidates` | bot secret / `users.create` / `roles.manage` |
| Discord bot [DO-2] (DO §6) | `POST /api/bot/sessions`, `GET /api/bot/outbox/stream`, `POST /api/bot/outbox/claim`, `POST /api/bot/outbox/{id}/ack|fail|extend`, `PUT|GET /api/bot/bindings`, `POST /api/bot/signals`, `POST /api/bot/import` (DO-6), `GET /api/bot/render/*` (DO-3c/7) | `BotSecret`, tenant via `X-Guild-Id`; cross-tenant routes in `skip_tenant_resolution` |
| Discord admin [DO-2] (DO §14) | `GET /api/discord/status`, `GET /api/discord/outbox`, `POST /api/discord/outbox/{id}/retry|dismiss`, `POST /api/discord/calendar/refresh`, `PUT /api/platform/tenants/{id}/discord-delivery-mode`, dry-run `GET /api/platform/tenants/{id}/discord-delivery/seed-report` (DO-6) | settings permission / platform admin |
| Capabilities [SA-2] | `GET /api/me/capabilities` (ETag), `GET /api/tenants/{id}/capabilities` (bot), response header `X-Capabilities-Version` | session / bot |
| Actions [SA-4a+] | `GET /api/{entity}/{id}/actions`, `GET /api/{entity}/actions`, `POST /api/{entity}/{id}/actions/{action}`, `POST /api/{entity}/actions/{action}`, `GET /api/actions/catalog` | per `ActionDef` |
| Contracts [SA-1] | `GET /api/openapi.json` (no auth) | public |
| Finance [SA-5/6] | `POST /api/splits/preview`, `GET /api/bank/withdrawable`, `POST /api/bank/withdraw/preview`, `POST /api/bank/actions/withdraw` | existing |
| Live/aggregates [FE-5, FE-3] | `GET /api/live` (WS, tenant-scoped invalidation keys), `GET /api/me/overview`, `GET /api/admin/overview`, `GET /api/events/summary` (WEB-1) | session |

New ProblemDetails members (additive, F2): `code`, `details`, `origin`.

---

## 7. The four legacy copy mechanisms: migration and removal

One boot task `sync::legacy_import::run` per step, marker in `sync_legacy_import`, idempotent, resumable, advisory-lock free (marker + `ON CONFLICT DO NOTHING`), executed before the engine loops. Each step ships with the slice that owns the kind; the legacy producer for that kind is switched off in the same PR via `SYNC_ENGINE_KINDS` default (rollback = remove the kind from the list, R20).

| Legacy | Imported by | Result | Removed |
|---|---|---|---|
| `alliance_shares` (build/comp/split) | SY-2 (build, comp), SY-6a (split) | `sync_links` + alliance-side `sync_copies(read_only=true)`; stale rows (alliance changed / `published_id` missing) skipped as `detached` (alliance-7). Manual share endpoints become "resync/unshare" aliases for one release; FE `ShareWithAllianceButton` removed in SA-10. | SY-9 |
| `event_fanout_jobs/targets/assets` | SY-2 (assets), SY-3b (open jobs) | assets: latest job wins per `(origin,target)`; older duplicates unreferenced by `comp_builds`, `event_roster_roles`, `event_participations`, `event_roster_assignments` are archived (never deleted), referenced duplicates reported in `sync_legacy_report` (log + `GET /api/sync/summary.legacy_duplicates`); build re-point step: the canonical build becomes the target of existing `comp_builds` rows of the destination comp (UPDATE in the apply txn, FK `primary_build_id RESTRICT` checked in test) | SY-9 |
| `event_sync_links` | SY-3a | `sync_links(kind=event)` + tenant `sync_copies` for all rows (disabled links -> `read_only=false`, `state=detached`) | SY-9 |
| `event_mirror_requests` open rows | SY-3c | `sync_jobs(kind=event)` | SY-9 |
| `event_participant_attributions` | SY-4a | `event_participations.attributed_guild_tenant_id` (join on `users.discord_id`; orphans dropped); per-origin-kind NULL semantics R13 | SY-9 |
| `alliance_role_revocations` | MEM-2 | R2 | SY-9 |
| register one-shot (`albion/alliance_fanout.rs`: `after_successful_link/unlink`, `adopt_existing_member_link`, `ensure_user_and_link`, `assign_alliance_roles_on_tenant`) | ID-8 | `member.link_sync`/`member.effects_sync` + `link.origin_backfill` once-job (unmarked copies: origin inferred from identical `(discord_id, albion_player_id)` rows; conflicts counted and listed in the report, never overwritten) ; pure planners (`plan_register_fanout`, `home_guild_tenant_id`, `alliance_hub_role_for_guild`, `shares_albion_alliance`) move to `members/topology.rs` with their tests | ID-8 (file deleted) |
| split distribution loop (`alliance_distribution::complete`) | SY-6b | one `split.payout` job per guild, batch/items tables kept as ledger | - |
| bot `ping_alliance` direct post, `alliance_discord_message_id` | DO-9 | alliance copy `event.upsert` is the only announcement | DO-9 |
| `poller-state-*.json`, `split_discord_sync`, `giveaways.discord_*`, `events.vod_forum_*`, `events.discord_voice_channel_id` | DO-6 (`seed_from_legacy` + importer) | `discord_bindings` / stamps | DO-10 |

Users created by old fanout (four fake-email patterns, `identity.rs:16 fallback_email`, `mirror_retry` stored `actor_email`): ID-2 data-fix sets `provisioned_via='sync'`, rewrites placeholder emails to `<id>@discord.invalid` where unique, NULLs `event_mirror_requests.actor_email`. First login of such a user claims the row by `discord_id` (never by email).

Cutover note (alliance-3): SY-3d runs `lifecycle_catchup` once before the first event reconcile: alliance-origin events `live` past `auto_stop_deadline` are stopped via `transition_in_txn(Cause::Sync)`.

---

## 8. Failure modes added or changed by the resolutions

Everything in SE §11, DO §15, MS §4 stays. Additional, normative:
* Target tenant suspended: `paused` + re-arm on resume (R27). Guild leaves mid-sync: engine archives go through `transition_in_txn` so Discord `event.remove/close` rows exist. Crash in `ensure_copy`: control txn is time-boxed (5 s statement timeout) and never held across the tenant write: control row inserted/locked, committed, tenant txn, then a second short control txn updates the link (adoption by `sync_copies` makes the gap safe).
* Bot offline: R28; stamps/once keys R22; flash undo R36.
* Dual announcement during rollout: R32. Copy of an event for a guild that left: `Inactive`, no row, no ping (R24).
* Member leaves guild but stays in alliance Discord: R8 (hook + `guild_left` flag; picker excludes guilds not in `member_guilds`).
* Roster-version divergence on copies: R21. Terminal-vs-roster race: R18. Command reordering: R26.
* Nothing in a job payload is trusted for state: handlers re-read origin rows. A handler error never aborts a domain transaction (relay/executor are asynchronous).

---

## 9. Test strategy (global)

* SQLite unit tests (`cargo test`, no env): pure functions (policy `targets`, backoff, state machine `next_state`, `monotonic_status`, `merge_roster`, `desired(T,D)`, `plan(now, snapshot)`, `evaluate`, transition tables, `ensure_member`, `resolve_member_roles`, `classify_member_status`), tenant migrations up/down column by column, `emit` coalescing and rollback, static tests `choke_points_call_emit`, `touch_event_sites`, `contracts_are_current`, route-coverage lint.
* Postgres integration (`TEST_DATABASE_URL` only, WP0 removed the `DATABASE_URL` fallback): claim concurrency (`SKIP LOCKED`), lease fencing, ordering, coalescing, relay replay, failpoints, two-scheduler race, row-lock behaviour of `engine::execute`, cross-tenant worlds.
* One shared fixture `testkit::World` (`src/testkit/`, `#[cfg(test)]`, created in F3, extended by SY-1): control schema + alliance + guilds G1..G3 + memberships + users + links + comps, `run_until_idle(runtime)`, `failpoint!`. DO, ID, SA and SY tests all use it (no per-subsystem world builders).
* Three scenario tests (module `src/scenarios/`, each lands in the slice that completes it, all must stay green afterwards):
  * A (lands SY-4b, extended by DO-5b/DO-9): guild event with `ping_alliance` -> alliance copy -> exactly ONE announcement on the alliance Discord (one `event.upsert` in the alliance outbox, zero direct posts) -> sibling guild sees it read-only with no Discord post -> sibling member signs up from the alliance Discord -> origin roster -> terminal stop -> XP/regear only for participants attributed to each guild.
  * B (lands MEM-1): accept -> backfill (non-terminal events silent, builds/comps incl. dependency copies, users/links, roles) with no pings; resumable after crash mid-cursor.
  * C (lands MEM-2): leave while the bot/Discord stub is down -> roles revoked later by `role.revoke` retries, live copy still auto-stops locally (DetachedCopy), future copies archived, history intact; rejoin reattaches without duplicates.
* Bot: `node --test` with fake `ApiClient` and fake discord.js client; golden JSON fixtures written by a Rust test to `apps/discord-bot/test-fixtures/outbox/*.json` and parsed with the runtime zod schemas (both sides fail on contract drift).
* Frontend: vitest through the real `ApiService` envelope, SSR render test (server renders authenticated shell with a forwarded cookie), AXE in CI (FE-8), path/method contract test against `openapi.json` (SA-1).
* Every slice must keep `cargo clippy --all-targets` clean for touched modules and not reduce the count of passing tests.

---

## 10. Hot-file serialization map (what cannot run in parallel)

| File / area | Serial order of slices |
|---|---|
| `events/service.rs` | F1 -> PERF-A -> DO-3b -> SY-3b -> SY-3d -> SY-4b -> SY-4c |
| `events/router.rs` | F2 -> DO-3a -> SA-4b (shims) -> SY-3c (adapters) |
| `events/lifecycle.rs`, `event_sessions/*` | F1 -> F2 -> DO-4 -> SY-3b -> PERF-G |
| `splits/service.rs`, `splits/router.rs` | F1 -> FIN-1 -> SA-5 -> SY-6a -> SY-6b |
| `platform/service.rs` | ID-1 -> MEM-1 -> MEM-2 -> MEM-3 (ID-5 touches only registration hook lines) |
| `auth/service.rs` | ID-1 -> ID-3 -> ID-6 ; `auth/rbac.rs`: ID-2 -> ID-6 -> PERF (none) |
| `albion/*` | ID-3 -> ID-7 -> ID-8 |
| `lib.rs`, `tenant.rs` | F3 -> ALB-1 (friendly_side lines) -> SY-1/DO-1 (register, no new spawn code) -> SA-2/3 (FEATURE_GATES) -> DO-4 (`active_tenant_ids`) |
| `control_migration/mod.rs`, `migration/mod.rs` | append-only, any order (one-line conflicts) |
| `openapi.rs` | SA-1 first, then each slice appends its paths |
| comps/service.rs | CMP-1 -> SY-2 -> CMP-2 -> CMP-3 -> SA-10 |
| BOT `index.ts` | ID-4 -> DO-5a -> DO-5c -> SA-3 (registerCommands) |
| BOT `handlers/button.ts`, `commands/event-*.ts`, `event-thread-command.ts` | DO-5c -> BOT-act -> SA-9b |
| BOT `poller.ts` | untouched until DO-10 (delete); FIN-3 touches only `split-summary.ts` |
| FE `event-detail.ts` | WEB-1 -> FE-S1 (split) -> SA-4b -> SA-8 -> DO delivery panel (FE-9) |
| FE `styles.css` | FE-6 only (all other slices use tokens) |
| FE `app.routes.ts`, `layout/nav.ts` | SA-3 -> FE-2 -> later feature slices append routes |

---

## 11. Globally ordered slices

Legend: `dep` = must be merged first. `par` = may run in parallel with the listed slices (disjoint files, see §10). Risk L/M/H. Every branch is `<type>/<desc>` created from an up-to-date `origin/main` (`git fetch origin && git switch -c <branch> origin/main`), one PR per slice, draft PR, commit message `type(scope): summary`. "Accept" lists the tests a reviewer must see. Sub-design sections are normative for detail.

### 11.0 Ordered table

| # | Slice | Branch | Dep | Wave / parallel set |
|---|---|---|---|---|
| 0 | G0 baseline (WP0) | `chore/baseline-green` | - | W0 (assumed merged in wave 1; if not, first) |
| 1 | F1 | `refactor/event-transition-core` | G0 | W1-a (serial head of the events chain) |
| 2 | F3 | `refactor/runtime-and-queue-lib` | G0 | W1-b par: everything in W1 except ALB-1 (lib.rs, rebase) |
| 3 | ID-1 (WP1) | `fix/auth-identity-hardening` | G0 | W1-c par |
| 4 | ID-1b (WP1) | `fix/audit-vod-hardening` | G0 | W1-c par |
| 5 | FIN-2 (WP2) | `fix/ledger-concurrency` | G0 | W1-d par |
| 6 | FIN-3 (WP2) | `fix/bot-split-summary-decimals` | G0 | W1-d par |
| 7 | WEB-1 (WP4) | `fix/web-broken-calls` | G0 | W1-e par |
| 8 | CMP-1 (WP15) | `fix/comps-correctness` | G0 | W1-f par (comps/router.rs line overlap with WEB-1: rebase) |
| 9 | ALB-1 (WP3) | `fix/tenant-albion-scope` | G0, F3 | W1-g |
| 10 | F2 | `refactor/copy-role-guard` | F1 | W1-a |
| 11 | FIN-1 (WP2) | `fix/split-rules` | F1 | W1-h par with F2 (F2 touches events/router.rs, FIN-1 splits/*) |
| 12 | SA-1 | `feat/contracts-openapi` | WEB-1 | W1-e |
| 13 | SY-1 | `feat/sync-engine-core` | F2, F3 | W2 |
| 14 | DO-1 | `feat/discord-outbox-core` | F3 | W2 par SY-1 |
| 15 | ID-2 | `feat/member-provisioning` | ID-1 | W2 par |
| 16 | ID-3 | `refactor/discord-rest-client` | ID-1, F3 | W2 par |
| 17 | SA-2 | `feat/capabilities-backend` | SA-1 | W2 par |
| 18 | DO-3a | `feat/event-effects-transition` | F1, F2, DO-1 | W2 (after DO-1) |
| 19 | SA-4a | `feat/action-engine-core` | F1, F2, SA-1 | W2 par |
| 20 | FE-S1 | `refactor/event-detail-split` | WEB-1 | W2 FE |
| 21 | FE-1 | `refactor/frontend-ssr-session` | WEB-1 | W2 FE par FE-S1 |
| 22 | FE-6 | `refactor/discord-design-system` | WEB-1 | W2 FE par (styles.css only) |
| 23 | PERF-A | `perf/event-roster-hydration` | F1, F2 | W2 (events/service.rs, before DO-3b) |
| 24 | PERF-B | `perf/albionbb-client-cache` | ALB-1 | W2 par |
| 25 | PERF-C | `perf/tenant-pools-http-layers` | F3 | W2 par |
| 26 | SY-2 | `feat/sync-build-comp` | SY-1, CMP-1 | W3 |
| 27 | SY-3a | `feat/sync-copies-truth` | SY-1, F2 | W3 par SY-2 |
| 28 | SY-4a | `feat/participation-attribution-column` | SY-1 | W3 par |
| 29 | DO-2 | `feat/discord-bot-api` | DO-1, F3 | W3 par |
| 30 | DO-3b | `feat/event-effects-touch` | DO-3a, PERF-A | W3 |
| 31 | ID-4 | `feat/gateway-member-sync` | ID-2 | W3 par |
| 32 | SA-3 | `refactor/capabilities-clients` | SA-2 | W3 par |
| 33 | SA-4b | `feat/action-engine-events-web` | SA-4a, FE-S1 | W3 |
| 34 | FE-2 | `refactor/frontend-data-layer` | FE-1, SA-3 | W3 FE |
| 35 | FE-4 | `refactor/frontend-i18n-lazy` | FE-1 | W3 FE par |
| 36 | PERF-D | `perf/battles-read-paths` | PERF-B | W3 par |
| 37 | PERF-E | `perf/fights-sql` | ALB-1, PERF-B | W3 par PERF-D (fights.rs vs battles/*) |
| 38 | PERF-F | `perf/bank-ledger-queries` | FIN-2 | W3 par |
| 39 | SY-3b | `feat/sync-event-handler` | SY-2, SY-3a, F1 | W4 |
| 40 | DO-3c | `feat/event-render-reconcile` | DO-3b, DO-2 | W4 par SY-3b |
| 41 | DO-4 | `feat/backend-event-scheduler` | DO-3a, F2 | W4 par SY-3b (event_sessions/lifecycle.rs: DO-4 first) |
| 42 | DO-5a | `feat/bot-outbox-client` | DO-2 | W4 bot par |
| 43 | ID-5 | `feat/member-reconcile` | SY-1, ID-3, ID-4 | W4 par |
| 44 | ID-6 | `feat/role-staleness-sessions` | ID-3, ID-4 + Q1 answer | W4 par |
| 45 | ID-7 | `refactor/link-orchestrator` | ID-2 | W4 par |
| 46 | SA-5 | `feat/split-actions-preview` | FIN-1, SA-4a | W4 par |
| 47 | SA-6 | `feat/bank-withdraw-plan` | SA-4a, FIN-2 | W4 par |
| 48 | FE-3 | `feat/overview-aggregates` | FE-2 | W4 FE |
| 49 | FE-7 | `feat/shared-ui-primitives` | FE-2, FE-6 | W4 FE |
| 50 | PERF-G | `perf/battle-linker-and-audit` | DO-4 | W4 |
| 51 | SY-3c | `feat/sync-ping-alliance-share` | SY-3b | W5 |
| 52 | SY-3d | `feat/sync-guild-attribution-effects` | SY-3b, SY-4a | W5 |
| 53 | SY-4b | `feat/sync-participation-commands` | SY-3b, SY-4a | W5 (after SY-3d: both touch events/service.rs) |
| 54 | DO-5b | `feat/bot-event-reducers` | DO-5a, DO-3c | W5 bot par |
| 55 | ID-8 | `feat/alliance-member-propagation` | ID-5, ID-7, SY-1 | W5 par |
| 56 | SY-6a | `feat/sync-splits-structure` | SY-3b, FIN-1 | W5 par |
| 57 | CMP-2 | `perf/comps-list-batching` | SY-2 | W5 par |
| 58 | CMP-3 | `feat/comps-version-groups` | SY-2, CMP-2 | W5 |
| 59 | FE-5 | `feat/api-live-channel` | FE-2, DO-3a | W5 |
| 60 | SY-4c | `feat/sync-officer-roster-actions` | SY-4b, ID-4, ID-5 | W6 |
| 61 | DO-5c | `refactor/bot-commands-via-api` | DO-5b | W6 bot |
| 62 | MEM-1 | `feat/membership-backfill-detach` | SY-3b, SY-2, ID-8 | W6 par |
| 63 | SY-6b | `feat/sync-split-payout` | SY-6a | W6 par |
| 64 | SY-7 | `feat/sync-warns-regear` | SY-1, ID-8, SY-3b | W6 par |
| 65 | DO-6 | `feat/discord-delivery-cutover` | DO-5b, DO-5c | W6 |
| 66 | BOT-act | `feat/bot-act-handler` | SA-4a, DO-5c | W6 bot (after DO-5c) |
| 67 | MEM-2 | `feat/alliance-role-jobs` | ID-3, MEM-1 | W7 |
| 68 | MEM-3 | `feat/alliance-expel-resync` | MEM-1, ID-1 | W7 par MEM-2 (platform/service.rs: MEM-2 first) |
| 69 | DO-7a | `feat/discord-delivery-split-giveaway` | DO-6 | W7 par |
| 70 | DO-7b | `feat/discord-delivery-vod-panel-battle-audit` | DO-6 | W7 par |
| 71 | DO-8 | `feat/discord-dm-delivery` | DO-6 | W7 par |
| 72 | SY-8 | `feat/sync-reconciler` | SY-4b, MEM-1, SY-6b, SY-7 | W7 |
| 73 | SA-8 | `feat/sync-origin-ui` | SA-4b, SY-3b, SY-6b, FE-7 | W7 |
| 74 | SA-9a | `feat/event-create-edit-backend-web` | SA-4b | W7 par |
| 75 | SA-9b | `feat/event-create-edit-bot` | SA-9a, BOT-act | W7 bot |
| 76 | SA-10 | `feat/comp-actions-parity` | SA-4a, SY-2, CMP-2 | W7 par |
| 77 | FE-9 | `feat/web-discord-delivery-panel` | DO-3c, FE-S1 | W7 FE par |
| 78 | SY-7b (optional) | `feat/sync-member-standing` | SY-7 | W7 optional |
| 79 | SA-11a-e (5 PRs) | `feat/member-ops-parity-<regear|warns|applications|giveaway-vod|misc>` | ID-2, SA-4a, DO-7a/b, DO-8 | W8 each par |
| 80 | ID-9 | `feat/member-sync-visibility-ui` | ID-5, ID-8, FE-7 | W8 FE |
| 81 | SA-13 | `feat/alliance-actions-parity` | MEM-3, SA-8 | W8 |
| 82 | ALB-2 | `feat/alliance-aggregate-reads` | SA-3, ALB-1, SY-3b | W8 (needs a 1-page mini design first) |
| 83 | FE-10 | `feat/alliance-experience-ui` | SA-8, ALB-2, FE-7 | W8 FE |
| 84 | FE-8 | `fix/a11y-pass` | FE-7 | W8 FE |
| 85 | FE-11 (4 PRs) | `refactor/split-large-components-<split-detail|comp-detail|battle-detail|admin-finance>` | FE-7, SA-5, SA-10 | W8 FE par |
| 86 | FE-12 | `refactor/generated-api-types` | SA-1, FE-2 | W8 FE |
| 87 | DO-9 | `refactor/drop-ping-alliance-legacy` | SY-3c, DO-6, ops gate O4 | W9 |
| 88 | DO-10 | `chore/remove-poller` | DO-7a/b, DO-8, DO-9, ops gate O5 | W9 |
| 89 | SY-9 | `chore/remove-legacy-sync` | all SY/MEM/ID-8 + one release | W9 |
| 90 | SA-14 | `chore/remove-legacy-shims` | SA-4..SA-13, 14 days of `legacy_route_total=0` | W9 |
| 91 | WP18 | `chore/dead-code-and-docs` | SA-14, SY-9, DO-10 | W9 |

WP5 (bot poller hotfix) is NOT scheduled: the poller is replaced by DO-5/DO-6 and deleted in DO-10. Re-open it only if DO-6 slips by more than one release. Parallel summary: in W1 the only serial pairs are F1->F2, F1->FIN-1, WEB-1->SA-1, F3->ALB-1; W2 can run 6+ slices at once (SY-1, DO-1, ID-2, ID-3, SA-2, SA-4a, FE slices, PERF-B/C); W3-W4 split cleanly into backend-sync, backend-discord, identity, actions and frontend lanes; the two lanes that serialize through shared files are `events/service.rs` and bot `handlers/button.ts` (see §10).

### 11.1 Foundations and baseline

**G0 `chore/baseline-green`** (WP0; assumed merged). `migration/m20261028_000003` split to one `alter_table` per column (up and down), doctests, clippy deny set, `postgres.rs` requires `TEST_DATABASE_URL` (drop `DATABASE_URL` fallback), frontend specs, bot `FRONTEND_URL` in `npm test`. Accept: `cargo test`, `cargo clippy --all-targets`, `npm test` in both apps green. Risk L.

**F1 `refactor/event-transition-core`** dep G0. Scope: `events/lifecycle.rs` (`transition_in_txn`, `Transition`, `Cause`, `TransitionOutcome`, `WakeSet`, `XpFilter` plumbing with legacy `award_xp` mapped to `Everyone/OwnMembersOnly`), `events/service.rs` (`start_event` 3948, `stop_event_with_xp_policy` 4007, `cancel_event` 3873, `uncancel_event` 3909, `archive_event` 3681, `unarchive_event` 3721 become wrappers over the core; `finish_copy_session` signature stub), `splits/service.rs` (`sync_event_participants`/`sync_participants_from_event` take `&impl ConnectionTrait`, run in SAVEPOINT, error never fails the stop; fixes "error after commit" events-5), `event_sessions/auto_stop.rs` (calls the core), `events/router.rs` (wrappers only). Legacy propagation kept via `after_commit` hook. New: none (no tables, no routes). Accept: all existing events/lifecycle/auto-stop tests green unchanged; table test: every transition x Cause yields identical row changes; stop idempotent (second stop writes nothing); split sync failure leaves the event stopped and the split `needs_resync`; SQLite + Postgres. Risk M-H (hot functions).

**F3 `refactor/runtime-and-queue-lib`** dep G0. Scope: `runtime/` (`Wake`, `WakeSet`, `spawn_all`, supervised task with panic restart + jitter, `backoff(attempt, rng)` extracted from `events/mirror_retry.rs:223` and `fanout_worker.rs:105`, `LeaseFence` helper, `next_state` skeleton), `lib.rs:118` spawn moved behind `runtime::spawn_all` (existing fanout/mirror loops registered there unchanged), `control_migration/mod.rs` constant removed (tests assert `migrations().len()`), `Cargo.toml` adds `tokio-stream` and `async-trait`, `testkit::World` skeleton. New: none. Accept: backoff bounds/jitter unit tests; panic in a loop restarts it and increments a counter; both migration-count tests pass without the constant; existing fanout/mirror tests green. Risk L-M.

**F2 `refactor/copy-role-guard`** dep F1. Scope: `modules/sync/{mod,guard,copy_role}.rs` with legacy backing (R3), `AppError::ReadOnlyCopy` + ProblemDetails `code/details/origin` (`errors.rs:34-50`), replace the 24 `assert_manageable_source_event` call sites in `events/router.rs` and `lifecycle.rs:28`, `splits/service.rs deny_mutation` (760-796) keeps its alliance clause but reads the guard, `event_sessions/auto_stop.rs:34-62` uses `copy_role` (Detached = origin). New: variant + fields. Accept: matrix test "every mutating event/split route on a copy fixture -> 403 + origin"; detached (disabled-link) live event still auto-stops with `award_xp` unchanged; non-synced behaviour byte-identical. Risk M.

### 11.2 Quick fixes and WP1-WP4, WP15 first part (wave 1, parallel)

**ID-1 `fix/auth-identity-hardening`** (WP1) dep G0. MS-S1 with the CR correction: `finalize_session` (`auth/router.rs:745`) uses the existing safe `identity::upsert_discord_user` extended with `verified_email`, NOT `ensure_member` (arrives in ID-2); delete `AuthService::upsert_user/update_existing_user` (`auth/service.rs:475-543`) and move its 3 pinning tests; `DiscordUserProfile.verified`; auth-12 email only for owner row/`users.create`/`roles.manage`, drop `UserFilters.email`; auth-19 `bypasses_priority()`; auth-6 `guild_owner_matches` (`platform/service.rs:2103`) generalised to `is_tenant_owner`; `Absent` -> 403 + membership delete on login/switch; `classify_member_status` body code 10007 vs 10004; FE `users.ts`, `user-detail.ts` email optional. Accept: two Discord ids with the same email -> two rows, first keeps `discord_id`; unverified email never stored/claims; plain member sees no emails and no `email` filter; alliance owner without roles passes `RolesManage` and assigns a priority-100 role; Absent -> 403 on login and switch and membership row gone; 10004 never deactivates. Risk M.

**ID-1b `fix/audit-vod-hardening`** (WP1) dep G0. members-6 UTF-8-safe truncation in `audit/service.rs` (char boundary), members-2 server-side VOD thread verification + host allowlist + daily cap (`modules/vods`, `events/router.rs:204-216` VOD claim routes). Accept: audit entry with emoji at the cut point stored intact; VOD submit with a thread not in the guild rejected; cap enforced. Risk L.

**FIN-2 `fix/ledger-concurrency`** (WP2) dep G0. finance-7 `regear/credits.rs:64-134` conditional `UPDATE ... WHERE balance >= amount` + partial unique index for the self-service duplicate guard (tenant migration); finance-10 `giveaways/service.rs:358-490` conditional state flip BEFORE side effects, credit in a SAVEPOINT; finance-11 `bank/service.rs:149-293` GET balance/transactions never write; consolidation only in explicit mutation paths in a transaction with state guards; finance-21 manual transactions linked to splits are not clobbered (`bank/service.rs:894-1019`). Accept: Postgres concurrency tests (two concurrent regear requests cannot overspend; double draw credits once; concurrent GET + withdraw never corrupts); a failed `credit_bonus` does not poison the txn. Risk M-H (ledger, new index needs data check migration).

**FIN-3 `fix/bot-split-summary-decimals`** (WP2) dep G0. BOT `services/split-summary.ts:46-62` (`pendingSplitPool`) sums with decimal strings (`decimal.js`-free fixed-point on strings or bigint cents). Deleted by DO-7a when the backend renders `projected`; ships now because finance-2 is high. Accept: fixtures with decimal strings that previously concatenated give correct net/fee. Risk L.

**WEB-1 `fix/web-broken-calls`** (WP4) dep G0. parity-1 (`event-detail.ts:5515-5521` array without `.data`), parity-2 (`event-detail.ts:5153,5167` PATCH `/splits/{id}`), comps-7 (`comps/router.rs:652-683` 204 -> returns `BuildDetail`), frontend-3 (`tenant-rail.ts:233` reset on tenant switch, `NotificationService.reset`), frontend-9 (HTTP interceptor: 401 -> logout, 403 tenant removal, persistent error toast), frontend-10 (`GET /api/events/summary` replaces 7 list calls in `events.ts:809`), frontend-12 (pre-boot theme script in `index.html` + `theme.service.ts:79`). New route: `GET /api/events/summary`. Accept: specs through the real `ApiService` envelope; HTTP method test for split link/unlink; tenant switch clears dashboard data; no theme flash (script test). Risk L.

**CMP-1 `fix/comps-correctness`** (WP15 part 1) dep G0. comps-6 `update_comp` validates first, then merges, all in one transaction (`comps/service.rs:1892-1904`); comps-8 `comps/pricing.rs:406-420` do not cache failures, `unpriced_item_count`, invalidate on edit; comps-11 server-side catalog resolution of name/icon/tier (`comps/service.rs:83-94`) + bot icon host allowlist (`services/build-image.ts`); comps-14 atomic slot save (new `PUT /api/comps/builds/{id}/items/{slot}` with item+spells in one body, FE `comp-build-detail.ts:1146-1167`); comps-13 FE. Accept: invalid update leaves the comp unchanged; price failure not cached; atomic slot save test. Risk M. (Done before SY-2 so the sync wrappers wrap transactional functions.)

**ALB-1 `fix/tenant-albion-scope`** (WP3) dep G0, F3. battles-6/backend-perf-21 `fights.rs:719-725` and `lib.rs` `friendly_side` from the tenant `AlbionScope` instead of global `Config`; battles-7 rollup key = name+guild when id empty (`albionbb/client.rs:139`) or read `battle_player_stats`; battles-16 BOT `embeds/battle.embed.ts:34` uses backend `outcome` (not env `GUILD_NAME`); battles-17 backend returns `is_friendly/is_own` and FE `fights/fight-detail.ts:1254` stops comparing tenant name. Accept: fixture without player ids; two guilds with different Albion guilds classify differently in one process; bot embed test. Risk M.

**FIN-1 `fix/split-rules`** (WP2) dep F1. finance-1 authority per R9 (`splits/router.rs:24-66`, `PermissionCache::role_has` gains `SplitsManage` implication, `update_split` creator rule); finance-3 `splits/service.rs:1353-1429` skip non-`pending` and `roster_locked` splits (new column `splits.roster_locked`, set on manual participant edit); finance-4 `close_split` accepted from `awaiting_event` and `recompute_awaiting_for_event` called inside `transition_in_txn` on cancel/uncancel/unlink; finance-12 order by `user_id`, non-negative remainder rule (`:455-485`); finance-16 audit inside the txn and for every split lifecycle action (`:1111-1180`); `splits/status.rs` gets the transition table. Accept: SA-5-style matrix (creator, manage holder, unrelated member); cancelled event moves `awaiting_event` split to `pending`; roster sync does not rewrite a completed split; shares sum to net to the cent, deterministic remainder; audit rows present and rolled back with the txn. Risk M-H.

**SA-1 `feat/contracts-openapi`** dep WEB-1. SA §13 SA-1 verbatim (`GET /api/openapi.json`, `apps/contracts/*`, `contracts_are_current`, route coverage lint, `gen:api` scripts, client path/method contract tests with the two known violations now already fixed so the allowlist starts empty). Risk L.

### 11.3 Wave 2: engine and subsystem bases (parallel)

**SY-1 `feat/sync-engine-core`** dep F2, F3. SE-S1 + R2/R6/R25/R26/R27: tables (§4), `modules/sync/{outbox,relay,jobs,engine,error,handler,links,policy,router}`, `SyncInfo`, `/api/sync/*`, `sync.view/sync.manage` seeded, kill-switch, `testkit::World` extended with `run_until_idle` + failpoints, registered with `runtime::spawn_all`, test-only `noop` kind. No handlers, no producers. Accept: SE-S1 list (emit coalescing/rollback, guard, state machine, backoff, claim concurrency, lease fencing, ordering, coalescing, relay replay incl. already-finished job replay (R25), crash failpoints, `paused` re-arm, command inbox ordering by `(issued_at, seq)` across two emitters). Risk M.

**DO-1 `feat/discord-outbox-core`** dep F3. DO-S1 schema only (R40): `discord_bindings`, `discord_outbox`, `discord_delivery_state`, `event_voice_presence`, `events.mass_notified_at/reminder_notified_at` + stamp backfill (R22), control `tenants.discord_delivery_mode`, `discord_bot_instances`; `discord_delivery::{kinds, outbox, bindings}` (kinds table incl. R22 `once_key` epoch). Accept: DO §17.1 outbox/kinds/migration tests; Postgres claim concurrency + crash recovery. Risk L-M.

**ID-2 `feat/member-provisioning`** dep ID-1. MS-S2: users columns migration, `identity::ensure_member` (+ `upsert_discord_user` becomes wrapper, R2), `rbac.rs` bot-path provisioning + `X-Discord-Username`, `POST /api/members/ensure`, `resolve-user.ts` rewrite, delete `website-account.ts` and gate calls, `provisioned_via` data-fix + email normalisation + `event_mirror_requests.actor_email` NULL. Legacy fanout files are NOT edited. Accept: `/register` works with no web login in guild and alliance Discord; `/warn @never-seen` works via ensure; user option outside guild rejected bot-side; concurrent first requests -> one row; `withDiscordActor` set only for `interaction.inGuild()`; old bot vs new backend still passes. Risk M.

**ID-3 `refactor/discord-rest-client`** dep ID-1, F3. MS-S3: `modules/discord_api` (`DiscordRest` trait, typed errors, 4 req/s per-guild bucket, `Retry-After`, base-URL override `Config.discord_api_base`, per-call timeout), port `auth/service.rs:392`, `albion/discord_guild_role.rs`, `albion/discord_nick.rs`, `users/member_roles.rs LiveDiscord`, `admin/service.rs fetch_discord_member`; stub-server helper in `testkit`. Accept: behaviour-preserving; 404/10007 vs 404/10004 vs 403 vs 429 mapping tests. Risk M.

**SA-2 `feat/capabilities-backend`** dep SA-1. SA-2 + R9/R39: catalogue incl. `sync`, `members`, `discord`, `alliance` modules; `GET /api/me/capabilities`, `GET /api/tenants/{id}/capabilities`, `X-Capabilities-Version`; `MODULE_KIND_ENFORCEMENT=log`; `FEATURE_GATES` kept + equivalence test. Accept: SA-2 list; unknown prefix allowed; alliance matrix has no `progression`. Risk L-M.

**DO-3a `feat/event-effects-transition`** dep F1, F2, DO-1. `transition_in_txn` emits Discord effects per DO §5.2 table (Start/Stop/Cancel/Uncancel/Archive/Unarchive) and the Stop sets `awards via XpFilter`; `remind_event` (`events/router.rs:1843`) emits `event.reminder`; `POST /events/{start|stop|cancel|uncancel|remind}` responses add `effects: [{id,kind}]`; `Cause` stored; start stamps `mass_notified_at/reminder_notified_at`; update_event time change clears stamps (R22). Rows written for every tenant (janitor purges in mode `off`). Accept: DO §5.3 equivalence (web == bot route == scheduler == sync-cause, identical `(kind, entity, payload minus cause)`); Stop idempotent without new rows; Start on live -> 409 unchanged. Risk M-H.

**SA-4a `feat/action-engine-core`** dep F1, F2, SA-1. `modules/actions/{model,engine,origin,schema,catalog}`, `action_log` (R34), `events/status.rs` + `EVENT_TRANSITIONS`, event entity descriptors (`start/stop/cancel/uncancel/archive/unarchive/remind/edit/join/leave/roster_edit(direct)/retry_sync` placeholder), `engine::execute` per SA §3.4 minus effect enqueue (R1), `evaluate` ordering SA §3.2, `GET/POST` action routes, `action_log` retention in hourly maintenance. No shims, no clients. Accept: SA §10 engine tests (descriptor matrix, TOCTOU under row lock on Postgres, idempotent replay, noop on same state, no state change when apply fails, denied body == descriptor entry). Risk M.

**FE-S1 `refactor/event-detail-split`** dep WEB-1. `features/events/event-detail.ts` (6,230 lines, 36 API calls, 1 s ticker) split into routed children with `@defer` (header/actions, roster, split/battles, vod, sync/delivery slots left as empty hosts); behaviour identical. Accept: existing `event-detail.spec.ts` ported and green; component count + bundle chunk report. Risk M (large diff, pure refactor, merge first among FE event slices).

**FE-1 `refactor/frontend-ssr-session`** dep WEB-1. R16: `main.server.ts`/Nitro pass request context (Analog server context) so an interceptor forwards `cookie` to the backend; server `API_BASE_URL` from env `BACKEND_INTERNAL_URL`; `AuthService.fetchProfile` (`auth.service.ts:152`) performs the real probe on the server and fills `TransferState`; `Cache-Control: private, no-store` on SSR responses; remove hydration mismatch (login-then-rerender). Accept: SSR render test with a forwarded cookie returns the authenticated shell; no cookie -> login redirect rendered once; no hydration warnings. Risk M. (Verify the Analog API for request context at slice start.)

**FE-6 `refactor/discord-design-system`** dep WEB-1. R16: delete the Zed block `styles.css:1719-1808`, any `zed`-only utility classes (`grep -i zed`, `layout/*`, `compact-feature.styles.ts`), restore `DESIGN.md` (`git show 9edd00ed:DESIGN.md`), keep Discord tokens (top of `styles.css`) as the only token layer, fonts: Inter + Nunito + Geist Mono already in `index.html`, no IBM Plex; a unit test forbids hard-coded radii outside tokens. Accept: AXE contrast check on light and dark for shell/rail/sidebar/cards; `rg -i "zed workbench|IBM Plex"` empty in `apps/frontend/src`. Risk L-M.

**PERF-A `perf/event-roster-hydration`** (WP14) dep F1, F2. backend-perf-11 (`events/service.rs:1580-1635` ~5 queries per participant/comp_build row -> batched), backend-perf-18 (`:1407-1445` VOD polling, islands, readiness). Accept: query-count assertions on a 40-participant event. Risk M.

**PERF-B `perf/albionbb-client-cache`** (WP14) dep ALB-1. battles-2/backend-perf-1 (`battles/service.rs:93-100` shared catalog cache single-flight, TTL per purpose), battles-12 (`albionbb/client.rs:469` retry/backoff/429, semaphore, no payload clones), battles-5 (`albionbb/service.rs:19` in-progress battles not cached 24 h), backend-perf-12/13 (shared `AlbionApiClient`, market price cache). Accept: cache hit test; upstream call log shows one catalog fetch per TTL; 429 handled. Risk M.

**PERF-C `perf/tenant-pools-http-layers`** (WP14) dep F3. backend-perf-7 (`postgres.rs:104-117` per-tenant pool max/idle, refresh instead of `evict`, single-flight migrations), backend-perf-16 (`CompressionLayer`, `TimeoutLayer`, body limit via tower-http features), backend-perf-19 (`events/service.rs:2699` one count), backend-perf-20 (tenant migration: index on `event_battles.albionbb_battle_id`). Accept: pool-limit config test; gzip + timeout layer test; EXPLAIN uses the index. Risk L-M.

### 11.4 Wave 3

**SY-2 `feat/sync-build-comp`** dep SY-1, CMP-1. SE-S2 + R17: `Build`/`Comp` handlers (hash skip, `ensure_copy`, parent mapping, archive-not-delete when referenced), `mutate_origin_in` wrappers in `comps/service.rs` (create/update/version/delete/archive/items/spells 1012-2281), guard on copy mutations, imports of `alliance_shares` (build/comp) + `event_fanout_assets` (latest job wins, duplicate archiving, re-point step §7), `alliance_share` endpoints re-based as resync/unshare aliases, `SyncInfo` on build/comp DTOs, legacy `copy_alliance_comp_to_tenant` delegates to `ensure_copy`. `SYNC_ENGINE_KINDS += build,comp`. Accept: SE-S2 list + dependency flapping test (guild comp used by an alliance event reaches a sibling guild, G edit propagates, retired when unreferenced) + alliance-7 fixture. Risk H.

**SY-3a `feat/sync-copies-truth`** dep SY-1, F2. Import `event_sync_links` -> `sync_links(event)` + tenant `sync_copies` (all rows, disabled -> `read_only=false`, `state=detached`) and `splits.origin_read_only` -> `sync_copies(split)`; `copy_role`/guard switch backing to `sync_copies`; legacy writers (`create_mirror` `events/sync.rs:51`, fanout worker create path) write `sync_copies` in the same tenant txn until retired. Accept: import test twice (idempotent); CR-X3 regression (detached live event auto-stops, XP unchanged); route matrix of F2 still green on the new backing. Risk M.

**SY-4a `feat/participation-attribution-column`** dep SY-1. Tenant migration `event_participations.{attributed_guild_tenant_id, sync_state, command_seq, attribution_state}`; import from control `event_participant_attributions` (join `users.discord_id`; orphans dropped); `events/attribution.rs::{stored_attribution, resolve_join_attribution}` read the column (still dual-write control until SY-9); R13 NULL semantics encoded in one function `attribution_for_award`. Accept: import + dual-write tests; NULL semantics table test. Risk M.

**DO-2 `feat/discord-bot-api`** dep DO-1, F3. DO-S2 minus PgListener (R6): hub with in-process wake + 2 s tick, SSE (`tokio-stream`), `/api/bot/*`, `/api/discord/*`, instance registry with mandatory `BOT_INSTANCE_ID` (R37), mode gating, golden-fixture writer, `skip_tenant_resolution` entries (`tenant.rs:435`), OpenAPI. Accept: DO-S2 list (SSE end-to-end, lease fencing over HTTP, fairness <= 5 per tenant per round, `off` tenant yields nothing, ack side effects voice column/dm status). Risk M-H.

**DO-3b `feat/event-effects-touch`** dep DO-3a, PERF-A. `touch_event` at every site of DO §5.1 table (create incl. engine-created copies via the `_in` create fn, update, `advance_roster_version` 1705 and callers, roster roles/comp swap 2156/2205, `converge`, battles 4243/4398, archive/unarchive, `event_discord_roles`), flash `available_at` (R36), R32 gating, `calendar.sync` debounce, `choke_points`/`touch_event_sites` static test. Accept: per-site emit test; coalescing; flash cancelled within 30 s never announces; mixed-mode alliance copy held (R32). Risk M.

**ID-4 `feat/gateway-member-sync`** dep ID-2. MS-S4: `members/{router,sync}.rs` `POST /api/members/sync`, `apply_role_snapshot` (also from `member_roles.rs:288,349` write-through), `MemberLifecycleHooks` (default no-op), `members::hooks::on_member_event` no-op until ID-8, BOT `services/member-sync.ts` + 4 handlers in `index.ts`, drop the `link/me` call at `index.ts:235-244`, `role_delete`. Accept: MS-S4 list. Risk M.

**SA-3 `refactor/capabilities-clients`** dep SA-2. FE `CapabilitiesStore` (SSR-safe), `moduleGuard`, nav filtering; BOT gate + `registerCommands` from capabilities; delete `hiddenForAlliance`, `guildOnlyGuard`, `featureKey`, `ALLIANCE_ALLOWED_COMMANDS`, `FEATURE_GATES` (ships `log`, R39). Accept: SA-3 list; alliance Discord registers exactly the catalogue's alliance commands. Risk M.

**SA-4b `feat/action-engine-events-web`** dep SA-4a, FE-S1. `core/actions/{action.service,action-bar,params-form,confirm}`, event-detail on `ActionBar` (remove `canEdit/canDelete/canManageParticipants` 3229-3248), legacy event routes become shims over `engine::execute` with `Deprecation` headers + `legacy_route_total`, `management-authority` shim, list rows `allowed_actions`. Accept: SA-4 list (descriptor matrix, denied body equals descriptor, legacy `/start` == `/actions/start`, copy `edit` disabled `copy_read_only`, `join` allowed, no event predicate left in `event-detail.ts`). Risk M.

**FE-2 `refactor/frontend-data-layer`** dep FE-1, SA-3. `core/data` (tenant-keyed resource store, SWR, request dedupe, invalidate-by-key, race protection), `TenantContext` signal resetting every store on tenant switch, root services (`AlbionLinkService`, `AllianceContextService`), migrate the hottest features (dashboard, events, comps, splits, bank) off raw `ApiService` fetches (374 call sites migrate incrementally; later slices use the layer only). SSR-safe (root injector, TransferState). Accept: spec with invalidated data, race test, request-count assertion on dashboard load. Risk M-H.

**FE-4 `refactor/frontend-i18n-lazy`** dep FE-1. `translate.service.ts:3` static dictionaries -> per-language dynamic import (server loads the request language before render), five 150-200 KB dictionaries leave the shared chunk. Accept: bundle report shows shared chunk reduction; SSR renders in request language. Risk L-M.

**PERF-D/E/F** (WP14) as sub-bullets of the table: PERF-D `perf/battles-read-paths` (battles-4 `battles/service.rs:239` read-only GET, persistence in worker; battles-14/backend-perf-14 `:444-505`; battles-11/backend-perf-8 `battle_sync.rs:29,132-145` IN query, no 50-row rehydrate per tick; battles-20 payload trim); PERF-E `perf/fights-sql` (backend-perf-3/battles-8 `fights.rs:475-577` SQL over `fight_stats`, battles-19 single analytics implementation, backend-perf-10 `intel/report.rs:496-565`); PERF-F `perf/bank-ledger-queries` (finance-17 `bank/service.rs:455-561`, backend-perf-6 `bank/alliance.rs:265-290` concurrent k-way merge). Accept: query-count and timing tests with the realistic fixture, results byte-equal to the old path on a snapshot dataset. Risk M each.

### 11.5 Wave 4

**SY-3b `feat/sync-event-handler`** dep SY-2, SY-3a, F1. SE §5.1 + R3/R17/R18/R21/R24: `event` handler (create via `_in` variant of `create_event_with_source_identity` ~3381, update via `apply_origin_state`, archive/delete, content hash, roster-role diff by `build_id`, monotonic lifecycle with `lifecycle_epoch`, tenant-local fields never overwritten, `finish_copy_session` through `transition_in_txn(Cause::Sync)`), `touch_event` inside apply txn, flash events allowed, scope/membership re-check under row lock, shared ordering key with `event_roster`, `SYNC_ENGINE_KINDS += event`; legacy `fanout_worker` target processing disabled for event; adapters `fanout-status/mirror-status/mirror-retry`; open `event_fanout_*` rows imported. Accept: SE-S3 acceptance (a)(b) (publish + 2 updates = same build/comp counts; roster-role build outside comp copied once, linked before roles; auto-stop of alliance origin stops all copies and later updates never reopen; uncancel via epoch reopens; guild leaves mid-job -> `inactive` and no copy; failed target visible and retriable; flash shares; legacy rows imported without duplicates). Risk H.

**DO-3c `feat/event-render-reconcile`** dep DO-3b, DO-2. `render/event`, `render/calendar`, fingerprint (excludes `updated_at`), `reconcile::drift` (R28, R32), `on_settings_changed` re-arm (`admin/service.rs:105`), `GET /api/events/{id}` `discord` block. Accept: DO §17.1 reconcile/render tests; golden fixtures written. Risk M.

**DO-4 `feat/backend-event-scheduler`** dep DO-3a, F2. `discord_delivery/scheduler.rs` (`plan()` pure, `run_tenant`), `TenantRegistry::active_tenant_ids`, R31 `who_stops`, stale rule, voice signals (`signals.rs`, `event_voice_presence`), moves `auto_stop.rs`, `GiveawayService::draw_due`, `retry_pending_event_completion_xp` (guild only) into `run_tenant` for `on` tenants, shadow counters, janitor; alliance tenants included. Accept: DO-S4 list + `who_stops` table test + postponed event re-masses (R22). Risk M-H.

**DO-5a `feat/bot-outbox-client`** dep DO-2. BOT `src/delivery/{outbox-client,dispatcher,classify}.ts`, `DELIVERY_MODE`, golden fixtures consumed; `poller.ts` untouched. Accept: DO §17.3 client/dispatcher tests. Risk M.

**ID-5 `feat/member-reconcile`** dep SY-1, ID-3, ID-4. MS-S5 as a sync-engine handler (`tenant.reconcile`, R2): integrity gate, `suspicious`/`force`, 403 `blocked`, `members_provision_all`, `tenant_member_sync`, `member_facet_state`, endpoints `reconcile` + `sync/status`, boot enqueue with `dedupe_key`, registration hook (`platform/service.rs:288,344`). Accept: MS-S5 list on the stub Discord server; R8 rules for `not_joined`. Risk M-H.

**ID-6 `feat/role-staleness-sessions`** dep ID-3, ID-4 + answer to Q1. MS-S6 (`auth/role_resolver.rs`, non-sliding cookie with `issued_at`, bounded lookup cache, `X-Roles-Stale`, `/users/{id}/roles` gate); includes the admin banner and a global re-login notice (cookie format change, ops gate O6). Accept: MS-S6 matrix; snapshot-fresh request = zero Discord calls (counting fake); per-request query count not higher. Risk M-H.

**ID-7 `refactor/link-orchestrator`** dep ID-2. MS-S7 (single branch name, SA-12 dropped): `albion/link_orchestrator.rs`, all entry points rewired, audit, cooldown, release-to-history (R10), `register/candidates`, `/unlink`, bot `/link` `/register`, `create_user` alliance-aware; old fanout still called. Accept: MS-S7 list. Risk M.

**SA-5 `feat/split-actions-preview`** dep FIN-1, SA-4a. Split descriptors from `SPLIT_TRANSITIONS`, `POST /api/splits/preview`, `projected` on split views, `deny_mutation` -> guard, delete FE `split-access.ts`/`netOf`/`draft*`; Discord `/split-create`, split post buttons (via BOT-act later; here: web + backend + `/split-create`); `complete` returns `distribution` field (R11). Accept: SA-5 list; amended completed alliance split with batch -> 409 (R9). Risk M.

**SA-6 `feat/bank-withdraw-plan`** dep SA-4a, FIN-2. SA §5.1 verbatim. Risk M.

**FE-3 `feat/overview-aggregates`** dep FE-2. `GET /api/me/overview`, `GET /api/admin/overview` (backend) + dashboard/admin hub use them (frontend-6/10). Accept: request-count on dashboard <= 3. Risk M.

**FE-7 `feat/shared-ui-primitives`** dep FE-2, FE-6. `ListPage`, `DetailPage`, `ConfirmDialog` (replaces `confirm()`), `FormField`, `MoneyPipe`, `DateTimePipe` (tenant tz from capabilities, parity-8/frontend-4), adopt `DataTable`; dedupe ~40 `formatAmount/formatDate` helpers (frontend-18, 19). Accept: specs; grep shows no raw `confirm(`/`<select` in migrated features. Risk M.

**PERF-G `perf/battle-linker-and-audit`** dep DO-4. backend-perf-2 (`events/service.rs:4277-4302` stop by time window, `link_updated_at` separate, exclude cancelled; events-10/11), backend-perf-5/members-7 (`audit/service.rs:112-155` Discord echo spawned with a shared timeout client; replaced by `audit.post` in DO-7b), auth extractor cost is covered by ID-6. Accept: linker page count bound; audit echo not awaited in request. Risk M.

### 11.6 Wave 5

**SY-3c `feat/sync-ping-alliance-share`** dep SY-3b. Guild-origin `ping_alliance` policy (alliance + siblings, `deliver_discord` R15), retire on `ping_alliance=false`, `event_mirror_requests` open rows imported, `mirror_retry` and `fanout_worker` loops no longer spawned when kinds are engine, `create_mirror` deleted from the path. Accept: SE-S3 (c): `ping_alliance=false` retires alliance + sibling copies; one `event.upsert` in the alliance tenant; sibling `skip=copy_no_delivery`. Risk H.

**SY-3d `feat/sync-guild-attribution-effects`** dep SY-3b, SY-4a. `lifecycle_catchup` once-job, `XpFilter::AttributedTo` in `snapshot_event_completion_xp`, creator XP rule, regear request/attendance restricted to attributed participants (`regear/service.rs` request path), local split importer filter (R19), `retry_pending_event_completion_xp` guild-only. Accept: XP only to participants attributed to each guild; unattributed alliance participant gets nothing and is flagged; local split on a copy pays only own members; catch-up stops overdue alliance live events. Risk M-H.

**SY-4b `feat/sync-participation-commands`** dep SY-3b, SY-4a (after SY-3d). SE §5.2 command path + projection with R18/R21/R26: pending rows, `sync_inbox`, diff-by-key projection, `projection_version`, rejection notifications, `hub.publish` to peers, `EventRoster` emits in `participate*`/`cancel_participation`, scenario test A. Accept: SE-S4 acceptance (a)-(c) (pending shows immediately, peer down -> success then converge, origin reject -> pending row removed + notification, leave in G1 then join in G2 ordered by `issued_at`, duplicates idempotent) + scenario A. Risk H.

**DO-5b `feat/bot-event-reducers`** dep DO-5a, DO-3c. `reducers/{event-upsert,event-close,event-lifecycle,calendar}` with `ensureVoice`, `verify`, checkpoints; fake discord.js tests; `poller.ts` untouched. Accept: DO §17.3 reducer tests (crash after parent create -> adopt, no second ping; self-heal 10008). Risk H.

**ID-8 `feat/alliance-member-propagation`** dep ID-5, ID-7, SY-1. MS-S8 as handlers `member.joined/left/link_sync/effects_sync`, `link.origin_backfill`, `members/topology.rs`, status endpoints, `identity::member_guilds`, delete `albion/alliance_fanout.rs` and cross-tenant `record_membership`, `link/me` pure read, hooks on role/setting change. Accept: MS-S8 list. Risk H.

**SY-6a `feat/sync-splits-structure`** dep SY-3b, FIN-1. `Split` handler (structure, participants, bags, island tab by name, event mapped via link), import of `alliance_shares` split rows, `Split` emits on every split mutation, `splits.origin_read_only` kept in sync, `finalize` stays. Accept: SE-S6 structure part: copy shows completed state; closed splits not rewritten; guard on copy edits. Risk M-H.

**CMP-2 `perf/comps-list-batching`** (WP15) dep SY-2. comps-5 (`comps/service.rs:658-690` batched categories/users/counts + stats in list, remove the per-comp `/performance` call from FE), comps-15 (`openalbion/service.rs:94-96` ETag + no clone), comps-16 (`combat/service.rs:156-190`), comps-13 server sort. Accept: query-count assertions. Risk M.

**CMP-3 `feat/comps-version-groups`** (WP15) dep SY-2, CMP-2. comps-4 `group_id` per `(name, category)` per tenant, `is_latest` + filter (`comps/service.rs:285-302`), existing homonymous groups NOT merged (default §13), copies map group from the origin. Accept: version switcher; copy of a version keeps grouping. Risk M.

**FE-5 `feat/api-live-channel`** dep FE-2, DO-3a. Backend `GET /api/live` (WS, tenant-scoped, keys like `event:123`, `events`, `split:9`, `bank`, `sync:event:123`), published from `TransitionOutcome::after_commit`, sync apply, Discord ack; generalises `events/roster_hub.rs` and FE `realtime-roster.service.ts`; FE `LiveService` invalidates `core/data` keys. Accept: change made from Discord/another officer refreshes an open page; reconnect resubscribes. Risk M.

### 11.7 Wave 6

**SY-4c `feat/sync-officer-roster-actions`** dep SY-4b, ID-4, ID-5. Officer add/set/remove/seat/roster-role functions through `mutate_origin_in` (~20 fns, SE §3.2), `attribution_required` 422 (+ SA params `guild_tenant_id` x-options), `PUT /events/{id}/participants/{user_id}/attribution`, `on_member_left` hook registration (R8), eligible guilds via `identity::member_guilds`, `ReadOnlyCopy` for copy officers. Accept: SE-S4 (d)(e): officer actions on origin appear on all copies (WS observed), officer on copy gets ReadOnlyCopy, split payout with officer-added participant works, member leaving a guild withdraws future signups and flags past attributed rows. Risk H.

**DO-5c `refactor/bot-commands-via-api`** dep DO-5b. Remove `pollNow` (`commands/event-create.ts:112`, `handlers/modal.ts:161`, `handlers/button.ts:503`, `event-thread-command.ts:103`), `startDiscordEvent/stopDiscordEvent` callers (`commands/event-start.ts:29`, `event-stop.ts:26`, `button.ts:865,985`, `event-thread-command.ts:181,203`) -> API start/stop/cancel/uncancel + ephemeral reply from `effects`, `findEventIdForThread` -> bindings LRU, `/event-calendar-refresh` -> backend. Accept: DO §12.2 table; parity test web vs bot start (identical outbox rows); bot suite green with `DELIVERY_MODE=poller` unchanged. Risk H.

**MEM-1 `feat/membership-backfill-detach`** dep SY-3b, SY-2, ID-8. R2/R24/R29: `alliance_memberships` migration, hooks in the same control txn in `accept_alliance_membership` (`platform/service.rs:871`), `register_alliance_tenant` (:294), `configure_alliance_setup` (:700), `mark_alliance_left` (:1046, also used by `reset_alliance_setup :648`); `membership.backfill` phases (events -> build/comp -> split -> members (inserts `member.link_sync` jobs) -> warns) resumable with cursor and heartbeat, `membership.detach` per SE §8.2 (archive not-started copies, detach live/terminal, split payout items blocked `guild_left`), relay cache invalidation, `GET /api/alliances/{id}/sync/members`. Accept: SE-S5 backfill/detach acceptance + scenario B. Risk H.

**SY-6b `feat/sync-split-payout`** dep SY-6a. SE §5.5: `complete()` keeps preflight + `load_or_create_batch`, enqueues one `split.payout` job per guild, handler = `project_one` for the guild's pending items, finalize on last item, resume after restart, ledger `split_id` link + audit + notification, exclusion of the credit from `outflow_other` (finance-13, `economy`/`bank` query), `POST .../alliance-distribution/retry` -> sync retry. Accept: SE-S6 payout list (kill after 1 of 3 guilds -> restart completes, one credit per recipient; unregistered participant -> `blocked`, fix + retry completes; guild left -> `blocked{guild_left}`). Risk H.

**SY-7 `feat/sync-warns-regear`** dep SY-1, ID-8, SY-3b. `Warn` (alliance origin -> home guild via `members/topology`, guild origin -> alliance; copies excluded from escalation counting) and `RegearRequest` (decided only) handlers + emits in `warns/service.rs` (51, 230) and `regear/service.rs` (270, 434). Accept: SE-S7 minus progression. Risk M.

**DO-6 `feat/discord-delivery-cutover`** dep DO-5b, DO-5c. `POST /api/bot/import`, `delivery/import-legacy-state.ts` (tolerant zod, `*.tmp` ignored, missing file = empty import), `seed_from_legacy` (R40), dry-run `seed-report` endpoint, platform mode-flip endpoint, runbook (DO §13.2/13.5), dashboards. Accept: DO-S6 list (idempotent import, empty import silent recovery with name adoption, no duplicate mass after import, mode set last). After this slice tenants may be flipped (ops gate O2). Risk H.

**BOT-act `feat/bot-act-handler`** dep SA-4a, DO-5c. `handlers/action.ts` (`act:{entity}:{id}:{action}`), `action-render.ts`, `action-params.ts`, confirm flow with interaction id as idempotency key, legacy customIds dual-parsed, delete `event-authority.ts`. Accept: SA §10 bot list. Risk M.

### 11.8 Wave 7

**MEM-2 `feat/alliance-role-jobs`** dep ID-3, MEM-1. `role.grant`/`role.revoke` handlers over `DiscordRest` (404 member-not-found = done, 403 = blocked, 429/5xx retry 20 attempts), `alliance_role_grants` ledger writes, import of `alliance_role_revocations`, remove `retry_alliance_role_revocations` (`platform/service.rs:1141`) and the inline retry in `leave_active_alliance :995`, `reset_alliance_setup` path, scenario C. Accept: SE-S5 role acceptance + scenario C (Discord stub down at leave -> revoked later). Risk M-H.

**MEM-3 `feat/alliance-expel-resync`** dep MEM-1, ID-1. `PlatformService::expel_alliance_member`, expel + resync routes (R2), notifications, `alliance.manage_members` permission key (unseeded). Accept: owner/platform admin only (others 403); expel == leave semantics with `left_reason=expelled`; re-invite reattaches. Risk M.

**DO-7a `feat/discord-delivery-split-giveaway`** dep DO-6. `split.upsert` (bindings replace `split_discord_sync`, backend-rendered `projected` net, deletes FIN-3 code), `giveaway.post/update/result` (+ web entry refresh). Accept: DO-S7 list for these kinds. Risk M-H.

**DO-7b `feat/discord-delivery-vod-panel-battle-audit`** dep DO-6. `vod.create/delete`, `application.panel`, `battle.announce` (hook in `battle_sync`, `battle_floor_id`), `voice.sweep`, `audit.post` (moves the `AuditService::log` echo to the outbox, R4), delivery panel warning for stale voice signals (R38). Accept: per-kind idempotency tests; battle floor prevents history flood; VOD `ambiguous` retry flow. Risk M.

**DO-8 `feat/discord-dm-delivery`** dep DO-6. `dm.send` from `NotificationService::notify` (`notifications/service.rs:158-267`), `render/notification`, DM reducer + throttle, drop `/warn` self-DM. Accept: DO-S8 list. Risk M.

**SY-8 `feat/sync-reconciler`** dep SY-4b, MEM-1, SY-6b, SY-7. Reconcile loop (watermark scan per kind, orphan copies, link/copy mismatch, member/role drift), maintenance purges, metrics, `/api/sync/summary` lag, `paused` re-arm on tenant resume wired in `PlatformService`. Accept: SE-S8 list. Risk M.

**SA-8 `feat/sync-origin-ui`** dep SA-4b, SY-3b, SY-6b, FE-7. `sync` block on event/split/comp/build views from `guard::copy_info` (one batched query per page), `/switch-tenant?tenant=&next=` (same-origin relative `next` only), `OriginBadge`, `SyncStatusPanel`, list origin filter, `event.retry_sync`/`split.retry_distribution` actions; the Discord copy footer + "Open original" is rendered by the DO reducers from `render.copy`. Accept: SA-8 list + open-redirect test on `next`. Risk M.

**SA-9a `feat/event-create-edit-backend-web`** dep SA-4b. `event.create` collection action with tenant timezone (`start_local`, DST test Europe/Rome), `share_alliance` alias of `ping_alliance`, web flash toggle/share toggle/remind. Accept: SA-9 shared fixture. Risk M.

**SA-9b `feat/event-create-edit-bot`** dep SA-9a, BOT-act. `/event-create` modal + options step, `/event-edit`, `/event-add`, `/event-remove` (handles `attribution_required`), share toggle, `/event-battles`. Accept: SA-9 list. Risk M.

**SA-10 `feat/comp-actions-parity`** dep SA-4a, SY-2, CMP-2. Comp/build descriptors, `search`/`limit` for autocomplete, `/comp`, `/build` autocomplete, remove web share buttons. Accept: SA-10 list. Risk M.

**FE-9 `feat/web-discord-delivery-panel`** dep DO-3c, FE-S1. Delivery chip + thread link + retry in event-detail child route, admin Discord page (failed/ambiguous/skipped list, bot-offline banner). Accept: component specs via real envelope. Risk L-M.

**SY-7b (optional) `feat/sync-member-standing`** dep SY-7. `ProgressionSummary` handler, `member_standing`, directory badge in alliance tenants, no leaderboard route. Skippable (R12). Risk L.

### 11.9 Wave 8

**SA-11a..e `feat/member-ops-parity-<regear|warns|applications|giveaway-vod|misc>`** dep ID-2, SA-4a, DO-7a/b, DO-8. Backlog rows 13, 25-36, 41, 45 of SA §12; `user_ref` on `warns`/`progression/adjust` (R30); application accept assigns the role through a `role.grant` job + `application.decision` kind (R4, R5); trial expiry worker registered in `runtime`; `GET /applications`, `GET/POST /trials`, `GET /warns/me`. Each PR: row's Discord command and web page call the same action id (`parity.json` `todo` -> `done`). Risk M each.

**ID-9 `feat/member-sync-visibility-ui`** dep ID-5, ID-8, FE-7. MS-S10 (status chip, facets panel, member-sync health card, resync/expel buttons, stale-roles banner, 403 handling after tenant switch). Risk L-M.

**SA-13 `feat/alliance-actions-parity`** dep MEM-3, SA-8. `alliance.*` descriptors (decline, expel), Discord `/alliance`, `/role`, web Decline/Expel + sync overview. Risk L-M.

**ALB-2 `feat/alliance-aggregate-reads`** dep SA-3, ALB-1, SY-3b. Not covered by the four designs; write a 1-page mini design first. Scope per plan 4.4: `AllianceReadScope` (friendly set from `alliance_memberships`), battles/fights/bank read-through aggregated over member guilds with bounded concurrency, read-only, `battles` module `agg/ro` in the catalogue. Accept: two-guild fixture; no member-guild write path reachable. Risk M-H.

**FE-10 `feat/alliance-experience-ui`** dep SA-8, ALB-2, FE-7. `AllianceScopeBar` (guild filter + sync badge), alliance dashboard (`dashboard.ts:707`), tenant rail for alliances (frontend-16). Risk M.

**FE-8 `fix/a11y-pass`** dep FE-7. Route titles in `app.routes.ts`, contrast tokens, min text size, drawer focus trap, `axe-core` in vitest CI (frontend-15). Risk L-M.

**FE-11 `refactor/split-large-components-<...>`** (4 PRs) dep FE-7, SA-5, SA-10. split-detail, comp-detail (1,690-1,711 rules removed), battle-detail, admin-finance into child routes with `@defer`. Risk M each.

**FE-12 `refactor/generated-api-types`** dep SA-1, FE-2. `api.gen.ts`/`actions.gen.ts`, `api.models.ts` becomes aliases folder by folder (finishes under SA-14). Risk L-M.

### 11.10 Wave 9: removals

**DO-9** dep SY-3c, DO-6, O4: delete `alliance_discord_message_id`, `AlliancePingTargets`, `load_alliance_ping_targets` (`events/service.rs:323-380`), `EventView.alliance_*`, bot `postAllianceAnnouncement/Lifecycle`, `shouldPingAllianceDiscord`; scenario A final assertion. **DO-10** dep DO-7a/b, DO-8, DO-9, O5: delete `poller.ts`, `poller-manager.ts`, tests, `listSinceCheckpoint`, `split_discord_sync` table + routes, VOD claim routes, `PUT/DELETE discord-voice-channel`, `discord_delivery_mode` column (on hard-wired), legacy `event_sessions` auto-stop. **SY-9** dep all sync + one release: delete `fanout_outbox.rs`, `fanout_worker.rs`, `mirror_retry.rs`, `events/sync.rs` legacy parts, `lifecycle.rs` legacy fns, `alliance_share/service.rs` copy fns, final control migration dropping `event_sync_links`, `event_fanout_*`, `event_mirror_requests`, `alliance_shares`, `event_participant_attributions`, `alliance_role_revocations`; stop writing `events.source_*`/`origin_read_only`; remove `SYNC_ENGINE_KINDS`. **SA-14** dep SA-4..13 + 14 clean days: shims, `management-authority`, alias fields, `ping_alliance`, strict `parity.json`, empty `undocumented.allowlist`. **WP18** `chore/dead-code-and-docs`: dead routes (`albionbb/*`, `economy/*`, `attention/*` raw passthroughs, battles-13 permissions), `albion-settings`, `audit/middleware.rs`, README/OpenAPI drift (comps-19), members-9/11/12 leftovers, god-file splits (backend-perf-22). Accept: `cargo check`, full suites, `rg` of every removed symbol empty. Risk L-M each (H for SY-9 data drop: requires a verified backup and the migration down/up test on a production-like snapshot).

---

## 12. Ops gates (non-code, tracked in the PRs that need them)

* O1 Run `SYNC_ENGINE_KINDS` rollout kind by kind after the owning slice: build,comp -> event -> event_roster -> split -> warn/regear; observe `sync_job_total{state}` and `/api/sync/summary` for 48 h between flips; rollback = remove the kind.
* O2 Discord cutover (DO §13.2): canary tenant `shadow` 48 h, flip canary, tenant by tenant, alliances last.
* O3 First `tenant.reconcile` per tenant: review any `suspicious` result in the admin card before `force`.
* O4 DO-9 only after every guild tenant is `on` (R32).
* O5 DO-10 only after one release with all tenants `on`.
* O6 ID-6 forces a global re-login (cookie format); announce before deploy.
* O7 `MODULE_KIND_ENFORCEMENT=enforce` after 7 days with `would_block == 0` (R39).
* O8 SY-9: DB backup, then deploy; keep legacy tables one release after the last flip.

## 13. Defaults assumed and open questions

Blocking (answer needed before the named slice):
1. Q1 (ID-6, R42): is Discord presence in a tenant's Discord required for web access to that tenant? Default YES. Consequence: guild officers who are not in the alliance Discord lose web access to the alliance (today granted by `record_membership` fanout).
2. Q2 (SY-6b acceptance, R9/R11): amending a COMPLETED alliance split after distribution: reject (default, coded) or distribute the delta as a second payout round (needs a new idempotency key scheme on `transactions.alliance_distribution_key`)?

Defaults taken (non-blocking, one-line changes):
* "General manage permission" = `splits.manage` implies edit/delete; plain `splits.edit` holders keep their power (superset).
* Sibling guild copies of a guild-origin shared event: visible on web, no Discord post (R15).
* Guild comps/builds reach sibling guilds only as dependencies of an alliance event (R17).
* Reconcile provisions every non-bot guild member (`members_provision_all=true`).
* Scheduler changes accepted: scheduler/voice-empty stops are `auto_stopped`; no 1 h reminder for events created inside the last hour; overdue (> 4 h) `scheduled` events are not auto-started; `/event-start` reply no longer states the voice link synchronously.
* Backfilled copies are announced silently (no role ping).
* Comp/build version groups: no merge of existing homonymous groups.
* `member_standing` (SY-7b) is optional.
