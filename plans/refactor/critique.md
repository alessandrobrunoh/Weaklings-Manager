# Critique of the four sub-designs (sync-engine, discord-outbox, member-sync, shared-actions)

Reviewer stance: skeptical principal engineer. Scope: contradictions between the documents, owner-decision violations, code that would break, missing failure modes, slice realism, missing data migrations.
Paths are relative to `apps/backend/src` unless stated. "SE" = sync-engine.md, "DO" = discord-outbox.md, "MS" = member-sync.md, "SA" = shared-actions.md.

Verified against the worktree (HEAD f7f60e44): `events/service.rs` line anchors (3556, 3681, 3873, 3948, 4007, 4060, 4555/4568, 4922) are correct; `modules/events/lifecycle.rs:28-142`; `event_sessions/auto_stop.rs` and `event_sessions/mod.rs`; `splits/service.rs` (`sync_participants_from_event` 1353, `sync_event_participants` 1401, `deny_mutation` 760, `update_split` 1215); `splits/router.rs:32-65`; `auth/permission_cache.rs:27`; `platform/service.rs:1046 mark_alliance_left`; `control_migration/mod.rs:56`; `control_migration/m20261028_000001`; `m20261030_000001`; `m20261102_000001`; `tenant.rs:84,270-310`; `postgres.rs:104-115`; `Cargo.toml`. Not verified: the other ~100 anchors, all bot-side line numbers, anything in `areas.json` beyond what the designs quote.

Overall verdict: each document is individually strong and grounded. Together they are NOT mergeable as four parallel programs. Four of them claim the same things (event write choke point, alliance membership hooks, Discord role mutation, "is this row a copy", link/user propagation, expel). Section 1 lists what must be decided once before any slice starts. Sections 2-6 are defects that survive even after that.

---

## 1. Cross-document contradictions (decide once, in this order)

### X1 [BLOCKER] Three different "event write choke points" for the same ten functions
- SE 3.1: `mutate_origin(db, kind, id, op, f)` opens its own txn, calls `guard::assert_writable`, then `emit`. SE 5.1/5.2 add `apply_origin_state` and `EventService::finish_copy_session`.
- DO 5.2: `lifecycle::transition(txn, event_id, Transition, Cause)` is "the one choke point"; it emits `discord_outbox` rows. `converge_copy_to_source` must call it with `Cause::Sync`.
- SA 3.4: `engine::execute` opens ONE txn, locks the row, calls `*_in_txn` cores of `start/stop/cancel/uncancel/archive/unarchive`, and ALSO "enqueues `def.effects` through `EffectSink`" and writes `action_log`.
- All three need the same refactor of `start_event` 3948 (no txn, no lock), `cancel_event` 3873, `uncancel_event` 3909, `archive_event` 3681, `stop_event_with_xp_policy` 4007 (own txn, then `SplitService::sync_event_participants(db, id)?` AFTER commit with `?`, so the request fails after the commit).
- Consequences: (a) `mutate_origin` cannot nest inside `engine::execute` (takes `&DatabaseConnection`, begins its own txn). (b) Double emission: `transition` emits `event.start + event.upsert + calendar.sync` and `engine::execute` enqueues `def.effects` again via `EffectSink` (names differ, see X4), so a web Start produces two sets of rows. (c) DO 5.3's equivalence test ("web == bot == scheduler == sync") and SA's SA-7 acceptance cannot both be true.
- Resolution (recommended): ONE module `events::lifecycle` exposes `transition_in_txn(txn, id, Transition, Cause, actor) -> TransitionOutcome { view, effects, sync_outbox_id }`. It performs the status write, the XP snapshot, the split-participant sync (moved INSIDE the txn, which requires `SplitService::sync_event_participants` to accept `&impl ConnectionTrait`), `sync::outbox::emit` and `discord_delivery::emit`. `engine::execute` locks, evaluates and calls it; it must NOT enqueue effects itself, it only reports `outcome.effects`. The scheduler, converge and the legacy routes call the same function. `mutate_origin` is only for non-lifecycle writes (roster, content) and must accept an existing txn (`mutate_origin_in(txn, ..)`).
- Order constraint: this refactor is the first slice of the whole program, before SE-S3, DO-S3, SA-4. Today it is hidden inside three slices that would be written in parallel.

### X2 [BLOCKER] Membership lifecycle and member/link/role propagation are designed twice, with colliding schema
| Item | SE | MS |
|---|---|---|
| queue | `sync_jobs` (control) kinds `Member`, `role.grant`, `role.revoke`, `membership.backfill`, `membership.detach` (SE 5.7, 8) | `identity_jobs` (control) kinds `member_joined`, `link_sync`, `effects_sync`, `alliance_backfill`, `alliance_detach`, `link_origin_backfill` (MS 2.2, 2.10-2.12) |
| hook points | same txn as status flip in `accept_alliance_membership` :871 and `mark_alliance_left` :1046 (SE 8.1/8.2) | same two hooks (MS 2.11) |
| `alliance_memberships` columns | `left_reason`, `sync_state`; status CHECK extended with `'expelled'` | `left_reason` (`left|expelled|reset`), `left_by`; status stays `left` |
| revocations | import `alliance_role_revocations` into `sync_jobs`, DROP the table in SE-S9 | keep the table, add `attempts/next_attempt_at/lease_until`, add a worker (MS 2.11) |
| user deactivation flag | `users.deactivated_at` ("shared with member-sync", SE 2.2/14) | `users.active/left_at/left_reason/...` (MS 2.2). `deactivated_at` is never defined in MS. |
| expel route | `POST /api/alliances/{id}/members/{guild}/expel`, perm `alliance.manage_members` (SE 7) | same path, authority "alliance tenant owner or platform admin" (MS 2.11); SA lists `alliance.expel` action with `alliance.*` + tenant owner (SA 3.6) |
| placeholder email | `discord-{id}@alliance.local` (SE 5.7) | `<id>@discord.invalid`, and S2 deletes the `@alliance.local` pattern (MS 2.3) |
| user provisioning fn | `identity::upsert_discord_user` (SE 5.2, 14) | deprecated by `ensure_member` (MS 2.3) |
| Discord REST client | `DiscordRoleClient` in `SyncCx` (SE 4.3) | `DiscordRest` trait from MS-S3 (MS 2.12), per-guild token bucket 4 req/s |
- Verified fact: `alliance_memberships_status_check` is today `('pending','active','left')` (`m20261028_000001:20-26`); `'expelled'` does not exist anywhere. Two designs that both `ADD COLUMN left_reason` and disagree on `status='expelled'` vs `left_reason='expelled'` will not merge. `CONTROL_MIGRATION_COUNT` is a hard-coded `26` (`control_migration/mod.rs:56`, asserted at :134 and :324), so any two control-migration PRs conflict textually even when independent.
- Also double work on join: SE `membership.backfill` phase `Member` and MS `alliance_backfill` both scan linked users and role grants; on leave, SE emits `role.revoke` jobs per `alliance_role_grants` row and MS inserts `alliance_role_revocations` rows from the same txn.
- Resolution (recommended): single owner. MS owns identity (`users`, `albion_links`, gateway, reconcile, role resolver, `LinkOrchestrator`, `ensure_member`, `DiscordRest`). SE owns the queue/lease/fence/backoff/status primitives. Member-side job kinds become handlers registered in the SE engine (`member.link_sync`, `member.effects_sync`, `tenant.reconcile`, `membership.backfill` with phases). `identity_jobs` disappears (its `dirty`-flag coalescing and `once_key` go into SE jobs as options). One migration for `alliance_memberships` (status gets `expelled`, `left_reason`, `left_by`, `sync_state`), one expel endpoint and one authority rule (tenant owner or `alliance.manage_members`), `users.active` is the flag and SE's `deactivated_at` is dropped. `alliance_role_revocations` is either imported or kept, not both.
- If the owner insists on two queues, they must share one Rust queue library (claim/lease/fence/backoff) written once in SE-S1; MS-S5 must consume it.

### X3 [BLOCKER] "What is a copy?" has four answers and they disagree on detached rows
- SE: `sync_copies(kind, local_id)` with `state active|detached|archived_by_detach` and `read_only` (SE 2.2); `events.source_tenant_id` kept "denormalized" and still written until SE-S9.
- DO 8.2: origin = `source_tenant_id IS NULL`; copy = not origin (so scheduler skips Start/AutoStop for copies).
- SA: stand-in `LegacyOrigin::copy_info` from `event_sync_links` (SA 0), later `sync::guard::copy_info`.
- Existing: `lifecycle.rs:28 assert_manageable_source_event` reads `event_sync_links ... AND sync_enabled`; `is_mirror_event`.
- Concrete bug (verified): SE 8.2 says on leave/expel "live events -> left running, detached" and flips `sync_copies.read_only=false`. `events.source_tenant_id` stays set, SE 5.1 step 8 adds `AND NOT EXISTS (SELECT 1 FROM sync_copies ...)` WITHOUT `state='active'`, and DO's `plan()` keys on `source_tenant_id IS NULL`. Neither scheduler path will ever auto-stop that live event. Today it does stop: `auto_stop.rs:34-62` stops every live session whose deadline passed, with `award_xp = !is_mirror_event` (a disabled link is not a mirror, `sync_enabled` is respected). SE+DO therefore regress detached live events to "live forever". Also detached SCHEDULED copies are archived per SE, but DETACHED terminal-or-live copies still need `started_at/auto_stop_deadline` handled locally.
- Also: SE-S9 "drop `events.source_*` writes when no reader remains" while DO's scheduler reads `source_tenant_id`. Nobody lists it as a reader.
- Resolution: one accessor `sync::copy_role(db, kind, id) -> Origin | ActiveCopy | DetachedCopy | NotSynced`, backed by `sync_copies` only. Scheduler/auto-stop treat `DetachedCopy` as origin. Add it to the cutover note: before SE-S3, set `sync_copies` for every `event_sync_links` row (including `sync_enabled=false`, as `read_only=false`).

### X4 [HIGH] Effect vocabulary: SA's "closed enum owned by the outbox design" is not the outbox design's enum
- SA 3.6 effect names: `event.announce`, `alliance.announce`, `event.card.upsert`, `event.card.retire`, `event.start_notice`, `event.stop_notice`, `voice.provision`, `voice.teardown`, `event.thread.close`, `split.forum.upsert/retire`, `bank.audit_post`, `regear.audit_post`, `ticket.update`, `discord.role.assign/remove/sync/revoke`, `applications.panel.upsert`, `giveaway.post.upsert/update`.
- DO 4 kinds: `event.upsert/close/remove/mass/start/reminder`, `voice.release`, `voice.sweep`, `calendar.sync`, `split.upsert`, `giveaway.post/update/result`, `battle.announce`, `dm.send`, `application.panel`, `vod.create/delete`. DO 0/D8: no cross-tenant items, no `alliance_discord_message_id`: so `alliance.announce` cannot exist; DO has no kind for `bank.audit_post`, `regear.audit_post`, `ticket.update`, `discord.role.*`.
- `AuditService::log` Discord echo is "best effort after commit" in SA 3.4 step 7, but SA also lists `bank.audit_post` as an effect in the same txn: pick one.
- Resolution: SA's `ActionDef.effects` becomes derived data (`effects_preview`) read from DO's `kinds.rs` policy table, not a second list. Add the missing kinds (audit posts, ticket update) to DO or drop them from SA. SA-7 acceptance ("identical kinds web vs Discord") is then a consequence of X1.

### X5 [HIGH] Who mutates Discord roles/nicknames: bot outbox or backend REST?
- SE 5.7 and MS 2.10: backend calls Discord REST with the bot token (`assign_discord_role`). SA 3.6: `discord.role.assign/remove/sync/revoke` through the outbox executed by the bot (`albion_link.link -> discord.role.sync`, `application.accept -> discord.role.assign`). Owner decision says "effects reach the bot via a persistent outbox; bot only executes" (stated for scheduling, but SA applies it to roles).
- Same token used by backend REST and discord.js in the bot: no shared rate-limit bucket; MS's 4 req/s per-guild bucket only protects the backend half.
- Resolution: pick one. Recommendation: backend REST for role grants/revocations tied to the grant ledger (they need synchronous 403/404 classification and the ledger); outbox only for message-shaped effects. Remove `discord.role.*` from SA, or move the ledger logic into the bot reducer (worse). Register one `DiscordRest` (MS-S3) in `SyncCx`.

### X6 [HIGH] Wake-up and runtime topology are specified three ways
- SE: `Notify` + `pg_notify('sync')` on the CONTROL pool + advisory-lock singleton (`pg_try_advisory_lock`, SE 3.4). DO: `pg_notify('discord_outbox', current_schema())` inside TENANT txns + `PgListener`, "no leader election". MS: `Notify` + 15 s poll, "single replica documented".
- Verified: control and tenant data may live in different clusters (`tenant.rs:301-304`: `CONTROL_DATABASE_URL` may point at a different cluster). DO's `PgListener` must listen on the tenant cluster, SE's on the control cluster. Neither document states which URL the listener uses, and `sea_orm::sqlx` re-export + `tokio-stream`/`async-trait` are not dependencies today (`Cargo.toml` has neither; migrations get `async_trait` via `sea_orm_migration::prelude`). DO flags the first two as "to verify"; SE does not.
- A session-level advisory lock on a pooled connection (SE) is lost silently on a connection drop; the design says leases stay correct, true, but then the lock buys nothing and costs a dedicated connection.
- Resolution: one `runtime` module: `Wake` trait (in-process `Notify` + optional `PgListener` per cluster), one spawn point in `lib.rs`, one rule: correctness never depends on the lock or on NOTIFY. Drop the advisory lock from SE.

### X7 [HIGH] Same slice names and duplicated slices
- MS-S7 `refactor/link-orchestrator` and SA-12 `refactor/link-orchestrator` are the same branch and the same scope (LinkOrchestrator, `/unlink`, `/link-user`).
- Expel appears in SE-S5, MS-S9, SA-13.
- Stale cross-references: SA-7 depends on "Discord outbox slices 12b/12c" (DO has S1-S11); DO 5.2 and 8.2 tell the scheduler to call `sync_owner_change_to_copies` (lifecycle.rs:110) after commit, i.e. the legacy inline path `process_due_targets` that SE-S3 deletes. SE 5.1 step 7 calls `delivery::enqueue(T, Event(copy_id), reason)` AFTER commit; DO's API is `touch_event(conn, event_id, Cause, Reason)` inside the txn (re-opens the lost-effect window; the 60 s drift sweep only partly saves it).
- Resolution: one program-level dependency graph (section 7 below), and a single glossary of function names.

### X8 [MED] "User exists" semantics collide: MS `active` vs SE auto-provisioning
- MS: `Presence::Unknown` creates `active=false, left_reason='not_joined'`; lists/leaderboards/pickers default to `active` only (MS 2.8). SE 5.2 projection "auto-provisions via `upsert_discord_user` for absent ones", split payout and roster projection need the user in the alliance tenant, and officers add members by user picker (`GET /users`).
- Result: in the alliance tenant every guild member who is not in the alliance Discord is `not_joined`/inactive, so an alliance officer cannot find them in the picker (SE 5.2 "officer add" flow), though the roster/XP/payout flows need them. Either pickers must include `not_joined` rows for alliance tenants, or alliance participants must be resolved by `discord_id` search against `user_tenant_memberships` of member guilds.
- SE 5.2 `attribution` and MS `identity::member_guilds` are two implementations of "which guilds can this person act for": SE reads `user_tenant_memberships ∩ active members`; MS redefines that table as "Discord-present" but its own pruning only runs after MS-S5 reconcile. SE-S4 (attribution) therefore depends on MS-S5 for correctness (a user who left a guild still attributes to it) and nobody declares it.
- `MemberLifecycleHooks::on_member_left` (MS 2.8) is "registered by the events slice"; no SE slice registers it and no acceptance test covers it.

### X9 [MED] Authority rules for the same actions differ
Expel: `alliance.manage_members` (SE) vs owner/platform admin (MS) vs `alliance.*`+owner (SA). Split complete/archive: SA `CreatorOr(SplitsEdit)`/`CreatorOr(SplitsDelete)` + new `SplitsManage` implication, SE says "lives in splits". Sync status/retry: `sync.view`/`sync.manage` (SE) vs "event manage authority" vs `event.retry_sync` (SA). Tenant-kind gating of `/api/sync/*`, `/api/members/*`, `/api/bot/*`, `/api/discord/*` is not in SA's capability catalogue (SA 2.1 lists no module for them); with `MODULE_KIND_ENFORCEMENT=enforce` the behaviour for unknown prefixes must be specified (default allow, and say so).

---

## 2. Violations or gaps against the owner decisions

1. Guild leaves: "archive future copies, unlink shares, remove alliance Discord role, keep history". SE 8.2 leaves live copies running and (per X3) un-stoppable; MS 2.11 deletes the albion link of an inactive owner on a competing claim ("released (deleted) and audited", MS 2.9 step 7) which loses the player name used by history rows. Release by `detached_at`, not delete.
2. "Splits: complete/close/archive/fee/value to creator AND holders of the general manage permission." SA reaches it as `CreatorOr(SplitsEdit)` + `SplitsManage => Edit/Delete/...`, so every `splits.edit` holder keeps full power (superset, SA 14.3 admits it). Acceptable only if the owner confirms "general manage" does not mean "exclusively `splits.manage`". Also SA 4.2 `update: &[Pending, AwaitingEvent]` REGRESSES existing behaviour: `load_editable(.., allow_completed=true)` (`splits/service.rs:1198-1215`, `update_split` 1221) lets officers amend a COMPLETED split; the router docstring (`splits/router.rs:287`) says "Completed splits can be amended ... new signed split_credit rows". Neither SA nor SE says how an amended completed ALLIANCE split re-distributes (`transactions.alliance_distribution_key` is unique per recipient, so a second payout round for the delta is blocked) nor how the copies in guilds refresh.
3. "XP exists only at guild level." SE 5.6/S7 replicate `(level, guild_rank)` into `member_standing` in the alliance tenant ("badge in the alliance roster"); SA's capability matrix gives the alliance NO progression module, so the table has no reader, no API owner and arguably leaks XP-derived data. Either drop it or give it a defined read endpoint and keep it out of leaderboards.
   Also SE 14 requires `retry_pending_event_completion_xp` to run for alliance tenants; DO 8.1 moves it into `run_tenant` for GUILD tenants only. With "XP only at guild level" the alliance never has XP rows; delete the SE requirement.
   Regear and attendance "to attributed members only" (SE 1.4) has no slice, no acceptance test, no mention in SA's regear actions (`regear.request` has no attribution filter).
4. "Alliance owns canonical roster; copies render it read-only." Fine for alliance-origin events. For guild-origin events (`ping_alliance`) the origin guild holds the roster (SE 1.2), so alliance/sibling members' signups land in a guild tenant as foreign users; this is consistent with "origin owns" but means SE 1.4's NULL-attribution fallback ("or NULL for never-synced events") would award XP in the ALLIANCE tenant for legacy alliance participations. Make NULL mean "origin tenant's own member" only when origin is a guild.
5. "Joining backfills (non-terminal events, users/links, roles)": see X2 duplication; additionally backfilled copies would announce with a role ping (see 3.8).
6. "ping_alliance: drop the legacy direct post; announced once on the alliance Discord and visible to other member guilds." SE 14 / DO 10 make sibling guild copies announce in the sibling guilds' Discords too (their own `discord_event_delivery`). That is a visible behaviour change (every sibling guild gets a new announcement for another guild's shared event). Confirm with owner or restrict sibling copies to "visible in web, no Discord post" via a delivery flag on the copy.
7. "Frontend keeps SSR; Discord-style". SA's `CapabilitiesStore`, `moduleGuard`, `X-Capabilities-Version` and the `/switch-tenant?tenant=&next=` route never mention SSR (server render with cookie forwarding, per-request injector). `next` must be validated as a same-origin relative path (open redirect). The "drop Zed layer" decision is not addressed by any design; if it is out of scope say so.

---

## 3. Places where a design ignores existing code (verified)

3.1 [HIGH] Dependency copies vs policy-driven retirement (SE 1.3 / 3.3 / 5.1). Guild-origin `build/comp` target ONLY the alliance. But an alliance-origin event may use a guild-origin comp copy; SE 5.1 step 4 `ensure_copy(Comp)` for target H creates the link `(Comp, origin=G, id, H)`. The next relay for that comp computes `desired = {alliance}` and `existing_active \ desired = {H}` and retires H's copy (SE 3.3 step 2). The event then re-creates it, flapping, and a G comp edit never reaches H because H is outside the policy. Fix: `targets()` = policy ∪ dependency set (targets whose active events/roster roles reference the entity), or forbid alliance events from referencing copied comps in the UI. Same for roster-role builds (SE 5.1 step 4).

3.2 [HIGH] Roster projection and terminal transition are separate jobs, XP snapshot is irreversible. SE 5.1 applies `event` (incl. `finish_copy_session` -> `snapshot_event_completion_xp`, which reads `event_participations` at that instant, `events/service.rs:4060-4095`, idempotency key `event_completion:{event}:{source}:{user}`) and 5.2 applies `event_roster` as another job. No ordering key ties them (`event:{origin}:{id}:{target}` vs unspecified). If the terminal event job runs before the latest roster job, the copy snapshots XP for a stale roster, permanently. Fix: apply roster inside the `event` job whenever the status moves to a terminal state, or give both kinds the same `ordering_key`, and make the roster apply a precondition (`synced_roster_version >= origin_version_at_stop`).
   Also `snapshot_event_completion_xp(creator_id)` awards `xp_event_create` to `created_by` of the copy row on every tenant that stops it; today `award_xp=false` for mirrors prevents it (`stop_event_with_xp_policy:4007`). SE 1.4 states the intent but no signature change (a filter struct replacing the boolean) is specified.

3.3 [HIGH] Local splits on a copy event take the full canonical roster. `sync_participants_from_event` (`splits/service.rs:1353`) imports ALL `event_participations` (no attribution filter, no status check). SE assumption 4 ("every copy shows the full canonical roster") + SE 5.1 `finish_copy_session` ("sync_event_participants for local splits") means a guild's own split on an alliance event pays in other guilds' members. SE 5.5 only guards splits that are themselves copies. Fix: attribution filter in the importer for copy events; add a test.

3.4 [MED] `event_participations` replace-on-project. `event_roster_assignments` has an FK `(event_id,user_id) -> event_participations ON DELETE CASCADE` (`m20260901_000012:29`) and builds are `ON DELETE RESTRICT` (`m20260901_000009:25-26`). SE 5.2 "replace event_participations ... replace assignments" must diff by `(event_id,user_id)`, not delete+insert, or seat assignments, regear links and any FK from later tables are lost mid-transaction. State it.

3.5 [MED] `roster_version` has two writers on a copy. SE 5.2 sets `events.roster_version` of the copy to the origin's; a pending local signup also bumps it via `advance_roster_version` (service.rs:1705). DO's fingerprint includes `roster_version` and the web uses `expected_roster_version`. Versions can go backwards or collide (same number, different content), so a fingerprint match skips a needed Discord refresh. Use a separate `projection_version` column on copies, keep local `roster_version` strictly monotonic.

3.6 [MED] Mass/reminder idempotency stamps are never reset on reschedule. DO adds `events.mass_notified_at/reminder_notified_at` plus `once_key event:{id}:mass`. `update_event` (3556) changing `mass_time_utc/start_time_utc` after the stamp is set (or an uncancel -> reschedule) neither clears the stamp nor the `once_key`, so a postponed event never re-masses or re-reminds. SE's `converge` also copies times to copies without clearing the copy's stamps. Add: time change clears stamps and uses `once_key` suffixed with the scheduled time.
Also on `on`-flip: all existing events have NULL stamps, so an event whose mass time passed and was already announced by the poller re-masses if the state-file import is missing. Backfill `mass_notified_at = now() WHERE mass_time_utc <= now()` in the tenant migration, don't rely only on the importer.

3.7 [MED] `CONTROL_MIGRATION_COUNT` (26) and migration naming: SE tenant `m20261107_000001_create_sync_tables`, DO tenant `m20261107_000001_create_discord_delivery`, SA `m20261107_000002_create_action_log`; SE control `m20261107_000001_sync_engine`, DO control `m20261107_000001_discord_delivery`. Unique by suffix, but every control-migration PR edits the same constant and `mod.rs` list; designate a rebasing order or turn the count into `Migrator::migrations().len()`.

3.8 [MED] Backfilled/late-created copies would announce with role pings. DO suppresses pings only for `created_at < cutover_at`. A guild accepting an invite with 30 upcoming alliance events gets 30 `event.upsert` creates, each pinging `discord_event_role_id`. Fix: `Cause::Sync` + `backfill=true` => `payload.ping=false` (or batched digest), and the same for `legacy_import`/reconcile re-creates.

3.9 [MED] `sync_jobs` insert statement (SE 3.3 step 3) is not valid Postgres as written: one `INSERT` cannot have both `ON CONFLICT (dedupe_key) DO NOTHING` and `ON CONFLICT (coalesce cols) WHERE ... DO UPDATE`. With only the coalesce arbiter, replay of an outbox row whose job already finished (state `done`, so no coalesce hit) violates `dedupe_key UNIQUE` and raises; the relay transaction (batch of 200) aborts and that tenant's relay is stuck on the poison row. Use plain `ON CONFLICT DO NOTHING` plus a second `UPDATE` for coalescing, or record relayed outbox ids in a table.

3.10 [HIGH] Command ordering key is shared across emitters but `origin_version` is per-emitter. SE 5.2: `ordering_key = cmd:{origin}:{event}:{discord_id}` and `sync_inbox` skips a command when `job.origin_version <= last_seq`. `origin_version` is the outbox id of the EMITTING tenant. A member of two guilds can leave via guild G1's copy (outbox id 900) and re-join via guild G2's copy (outbox id 12): 12 <= 900, silently dropped as "replay" (SE 5.2 even advertises "leave then re-join with a different eligible guild"). Compare `sync_jobs.seq` (global identity) or scope `sync_inbox` by `(ordering_key, emitter_tenant)`. Same issue for `command_seq_seen` on pending rows (1.5).

3.11 [MED] SE 4.2 state `retry` + coalesce: an emit pulls a `retry` job forward (`next_attempt_at = LEAST(.., now())`) without resetting `attempts`, so a burst of edits against a failing target burns attempts to `exhausted` in seconds. Reset backoff but not the budget, or cap bumps per minute.

3.12 [MED] `alliance_split_distribution` batches and amended splits, see 2.2. Also SE 5.5 turns `complete()` into "enqueue and return"; callers currently get synchronous per-recipient errors (alliance_distribution.rs:150-290). SE keeps the preflight, good, but the HTTP response shape (`complete` returns before credits exist) changes the web/bot "completed" semantics; SA's `split.complete` ActionResult must say so.

3.13 `event_sessions::spawn` (30 s per tenant) keeps running `auto_stop`, XP retry, giveaway draw until DO-S4; DO's gating is per-tenant `off|shadow|on`. Matrix not tested: {mode off/on} x {origin/copy/detached} x {legacy auto_stop, scheduler} x {sync legacy/engine}. Specify the combined predicate in one place (`lifecycle::who_stops(event, tenant_mode)`) and test it.

---

## 4. Missing or weak failure modes

| Scenario | Status |
|---|---|
| Target tenant SUSPENDED (not deleted; tenant deletion only exists in tests, `postgres.rs:235`) | SE: `get_or_load` returns NotFound for non-active tenants (`tenant.rs:262-270`), mapped to `Retryable`: 12 attempts, ~8 h, then `exhausted`, needs manual re-arm after resume. MS says "jobs skip suspended tenants", DO's scheduler only visits active tenants. Add an `inactive`/`paused` state re-armed by tenant resume. |
| Guild leaves mid-sync | SE and MS handle in-flight jobs well. Gap: engine-applied archives of copies (detach, `apply_origin_state`) must go through `transition` so `event.remove`/`event.close` rows exist (X7); otherwise only the 60 s drift sweep fixes Discord. |
| Crash mid-job | Well covered (adopt via `sync_copies`, intent-first jobs, `recovering=true`). One hole: SE `ensure_copy` holds a control-plane row lock/txn open across a TENANT-cluster write (possibly another database), so a slow tenant pins control pool connections; cap and time-box. |
| Duplicate delivery | Covered in all four. DM `once_key` does not prevent a duplicate after a crash between Discord send and ack; DO relies on the footer marker scan of last 25 messages, fine for guild channels, check the DM channel path (`createDM`). |
| Bot offline hours | DO covers expiry/coalescing/fairness. MS covers via reconcile. Not covered: while the bot is offline the BACKEND keeps starting/stopping events, so on reconnect `event.close` for an event whose thread never existed (announcement never created) must ack `skipped`; DO's `render.skip` handles `terminal` only for archived, specify `no binding + terminal => skipped(never_announced)`. |
| Relay cache staleness | SE 3.3: participating-tenant set cached 30 s; unrelayed rows of non-participating tenants older than 1 d are discarded and "the join backfill brings them up to date". An event emitted by a guild in the 30 s after its accept, with the backfill scan cursor already past events, is dropped until the hourly reconcile (SE-S8, not available before S8). Make the cache invalidate on accept, or have the backfill job re-scan once at completion. |
| Rollback | DO has a runbook (13.5). SE explicitly has "no dual-write period"; after a slice flips its producers, rolling back the binary leaves copies unsynced and legacy rows unmaintained, but the legacy tables stay until SE-S9. Add the rollback rule: legacy producers can be re-enabled per kind via `SYNC_KINDS_DISABLED`-style flag until S9, and S9 waits one release. |
| Mixed rollout (alliance `on`, member guild `off`) | DO 13.2 turns alliance tenants on last; DO-S9 (drop `ping_alliance` direct post) is a bot/backend change for guilds. Between the alliance flipping to `on` and DO-S9, a guild still `off` posts directly to the alliance channel while the alliance executor also announces the mirrored copy: double announcement (the exact alliance-8 bug). Gate alliance announcements of a copy on "origin guild's mode is `on`" until S9. |
| Local-time / reschedule | see 3.6. |
| Member leaves guild but stays in the alliance Discord | MS withdraws future signups in that tenant (hook never registered, X8); attributed rows on ALLIANCE events keep pointing to the guild they left; `eligible_participation_guilds` (`events/attribution.rs:30`) reads `user_tenant_memberships`, so until reconcile prunes, the user can still pick it. No design covers re-attribution of existing rows. |
| `POST /members/ensure` vs `user_ref` | MS requires the bot to verify the target is in the guild before calling `/members/ensure`; SA 3.6 `warn.issue` takes `user_ref` and resolves server-side, where the backend has no presence proof. Two provisioning paths with different trust. Pick one (recommend `user_ref` resolving to `Presence::Unknown`, no activation). |
| Tests across subsystems | Each document has good unit/integration tests; none has a cross-subsystem scenario suite. Add one Postgres scenario per milestone: (a) guild event `ping_alliance` -> alliance copy -> exactly one alliance announcement -> sibling member signs up from the alliance Discord -> origin roster -> terminal stop -> XP only at attributed guilds; (b) accept -> backfill (events, builds, users, roles, no pings); (c) leave while bot offline -> roles revoked later, live copy still auto-stops, history intact. |

---

## 5. Missing data migrations / cutover steps

1. `sync_copies` rows for existing mirrors must exist before any code path reads them (X3). SE-S3 imports `event_sync_links`; DO-S4's scheduler lands independently and reads `source_tenant_id`. Make the import a pre-slice (SE-S1.5) that runs once, so DO/SA can rely on `sync_copies`.
2. Tenant migration for `events.mass_notified_at/reminder_notified_at`: backfill stamps from `mass_time_utc/start_time_utc` (3.6).
3. `event_fanout_assets` dedupe (SE 9): "latest job wins" can point the canonical build at a duplicate that existing `comp_builds` of the destination comp do not reference; the comp diff then re-points rows. Specify the re-point step and verify FKs (`primary_build_id ... RESTRICT`).
4. `alliance_role_revocations` ownership conflict (X2) and its `ambiguous` rows.
5. `event_participant_attributions -> event_participations.attributed_guild_tenant_id`: feasible (schema keyed `(source_tenant_id, source_event_id, discord_id)`, verified), but copies' own pre-existing participations (made before attribution existed) have NULL and the XP rule in SE 1.4 treats NULL as "mine". Decide per-origin-kind (2.4).
6. `albion_links` origin markers: MS `link_origin_backfill` infers origin by equal `(discord_id, albion_player_id)` rows in both tenants; rows that were edited on both sides get an arbitrary origin; report a count and a manual-merge list.
7. Users created by old fanout have fake emails of four patterns; MS's data-fix SQL covers three (`@discord.invalid`, `@alliance.local`, `@event-sync.invalid`, `@example.invalid`); verify against `identity.rs:16 fallback_email` and `mirror_retry` stored `actor_email`. MS also must NULL out `event_mirror_requests.actor_email` (real emails stored in control plane).
8. Existing guild copies and alliance data when `users.active` is introduced: default `true`, `roles_checked_at NULL`, first reconcile deactivates ex-members. SE projection users created `not_joined` before MS ships will later be deactivated by reconcile if the 95% gate passes: add `provisioned_via='sync'` exemption (MS table 2.2 sets the column but 2.6 step 4 does not exclude it).
9. Frontend `/auth/me` + cookie format changes (MS 2.7 `issued_at`) force a global re-login at deploy; say so.
10. Discord: 13.4 importer reads `poller-state-*.json` from the bot volume; if the file is gone, empty import recreates every scheduled/live event announcement silently (adoption by name). Name-based adoption is only as good as thread names; acceptable, but add a dry-run report endpoint listing "would create" before flipping `on`.

---

## 6. Technical defects inside single designs (not cross-doc)

- SE 4.1 claim query: correlated `NOT EXISTS` on `ordering_key` is correct, but `retry` rows with long backoff (up to 1 h) block every later job with the same key; for command keys that is intended, for `event:{origin}:{id}:{target}` a failing earlier version blocks a coalesced newer one only because coalescing merges into the same row. Fine. Document the head-of-line cost.
- SE 3.1 `emit` "returns early when the entity is a copy and kind is a state kind": roster edits on a copy are forbidden by the guard, but tenant-local mutations that legitimately change the projected view (pending signups) call `advance_roster_version` without emitting. Fine, but the early-return silently hides a missing guard; log at debug.
- SE 5.2 officer-add: `422 attribution_required` is a new error on an existing route; bot `/event-add` (SA backlog row 11) must handle it. Add to SA's params schema (`guild_tenant_id` with `x-options`).
- DO 6.4 SSE: `Last-Event-ID` dropped in favour of instance leases; the stated reconnect fast path reclaims everything leased by `instance_id` immediately. If two bot processes ever share an `instance_id` (default hostname; containers), they evict each other in a loop. Require explicit `BOT_INSTANCE_ID`.
- DO 8.2 voice-empty stop now yields `auto_stopped` (also changes XP policy: `auto_stop.rs` passes `auto=true`, same XP, fine) and depends on a bot-observed signal; "a blind bot never stops events" is right, but then voice-empty stop silently stops working when the bot is degraded; surface in the delivery panel.
- MS 2.7: `classify_member_status` change + 6 h stale window fails closed to default role; a bot-removed-from-guild (10004) keeps stale roles for 6 h then the whole guild degrades to default role. Acceptable, but admin banner needed (listed under S10, i.e. last).
- MS 2.4: auto-provision on `X-Discord-Role-Ids` presence; the header is also sent by flows that run inside DMs/ephemeral follow-ups? Verify `withDiscordActor` is only set for guild interactions (`client.ts:122-137`).
- SA 3.4 `idempotency_key` unique index is `(actor_user_id, action, idempotency_key)` but entity id is missing: the same key reused for a different entity is a false replay. Add `entity_type, entity_id` to the key.
- SA `Transport::Direct` roster ops bypass `engine::execute` but SA still claims `allowed` from `evaluate`: they must also go through `mutate_origin` (SE) or the guard is evaluated twice with two reason vocabularies (`copy_read_only` vs `ReadOnlyCopy`).
- SA 3.7 `start_local` in tenant timezone is converted by the backend: good; but `flash` event derivation is "verify during implementation" in DO 5.4: a dependency in the wrong direction (DO needs it for the undo window, SA-9 defines the create contract).

---

## 7. Slice realism and a single ordering

Too big for one PR (each would exceed ~2k changed lines or touch >15 files in unrelated areas):
- SE-S3 `sync-events`: handler + monotonic lifecycle + guard replacement at 24 call sites (`events/router.rs`, count verified: 24 `assert_manageable_source_event`) + scheduler skip + `lifecycle_catchup` + three legacy imports + adapters + loop retirement + XP filter. Split into: (a) guard + `sync_copies` + legacy `event_sync_links` import; (b) copy convergence handler (create/update/archive/monotonic); (c) `ping_alliance` scope + retire mirror loops; (d) lifecycle catchup + XP attribution filter.
- SE-S4 roster: commands, projection, attribution move, ~20 officer functions into `mutate_origin`, notification, WebSocket publish: split commands+projection from officer actions from attribution/XP.
- SE-S5 membership: backfill + detach + expel + role jobs + `Member` handler + four entry points + import: obsolete once X2 is decided; the remainder splits into backfill and detach.
- DO-S3 `event-effects`: `transition`, `touch_event` at ~20 sites, render endpoints, drift sweep, settings re-arm, responses with `effects[]`, `discord` block: split `transition` refactor (this IS X1) / `touch_event` sites / render+drift.
- DO-S5 bot executor: new client, dispatcher, event/calendar/voice reducers AND rewiring of commands/buttons/modals/thread-commands off `pollNow` and `startDiscordEvent`: at least three PRs. The 2254-line poller semantics being ported (ambiguous announce states, calendar fingerprints, split head-of-line) are the highest-risk code in the program and have the thinnest acceptance tests (fakes only).
- SA-4 `action-engine-events`: engine + `action_log` + `events/status.rs` + `_in_txn` cores + route shims + web `ActionBar` + bot `act:` handler + deletions: four PRs; the `_in_txn` cores are X1 and must come first.
- SA-11 admits several PRs; SA-9 is nine feature areas; MS-S8 deletes `alliance_fanout.rs` (651 lines) while adding three handlers.

Not independently mergeable as written:
- MS-S1 calls `ensure_member(Present, Via::Web, ...)` and `MemberSeed` (MS 2.14 auth-1) but `ensure_member`, `Presence`, `Via` and the `users` columns they need (`provisioned_via`, `member_event_at`) are introduced in S2. Move `ensure_member` + its migration to S1, or S1 keeps `upsert_discord_user`.
- DO-S1 is declared "inert" but includes SQL backfill of split/giveaway/voice ids into bindings, a one-time data move with no consumer until S7.
- SA-3 flips `MODULE_KIND_ENFORCEMENT=enforce` in the same PR that deletes `FEATURE_GATES`; if the `log` period surfaced offenders (alliance poller hitting guild-only prefixes) the flip must be a config change in a later release, not part of a code PR.
- DO-S9 depends on a sync "mirror slice" that is not named; with X7 it is SE-S3(c) plus the alliance announcement path.

Recommended single ordering (each line is one or more PRs):
0. WP0 baseline (all four assume it).
1. Shared foundations, no behaviour change: (a) `sync_copies`/`copy_role` + `event_sync_links` import (X3); (b) event `transition_in_txn` cores + `SplitService::sync_event_participants` accepting a txn (X1); (c) queue/lease/backoff library + `Wake` + `DiscordRest` (X2, X5, X6); (d) `CONTROL_MIGRATION_COUNT` policy.
2. MS-S1/S2 (identity hardening + provisioning with `ensure_member`), SA-1 (OpenAPI), DO-S1/S2 (outbox tables + bot API), SE-S1 (engine core) in parallel; they touch disjoint code.
3. SE-S2 (build/comp incl. dependency-driven targets, 3.1), DO-S3 split into effects/render, SA-2/SA-3 (capabilities), MS-S3/S4/S5 (REST client, gateway, reconcile).
4. SE-S3(a-d), DO-S4 (scheduler, using `copy_role`), SA-4 (descriptors for events, using the cores from 1b).
5. SE-S4 roster, MS-S6/S7, DO-S5/S6 (bot executor, cutover), SA-5/SA-6.
6. Membership lifecycle (single design from X2), SE-S6 splits payout (after SA-5 permission rule), DO-S7/S8, SA-7 (now just wiring), SA-8.
7. SE-S7/S8, DO-S9/S10, SA-9..SA-14, MS-S10, SE-S9.

Parallelizable teams then work on foundations 1a-1c first; today's plan lets three teams rewrite the same service functions concurrently.

---

## 8. Decisions needed from the lead/owner before implementation

1. Approve X1 (single lifecycle core, effects owned by DO), X2 (MS owns identity, SE owns queue, one membership hook list), X3 (`sync_copies` is the only copy truth, detached = origin), X5 (backend REST for roles).
2. Owner questions: (a) sibling guilds announce another guild's shared event in their own Discord? (2.6); (b) does "general manage permission" exclude plain `splits.edit` holders? (2.2); (c) amending a completed alliance split: reject, or distribute the delta? (2.2/3.12); (d) should guild comps/builds also reach sibling guilds (3.1)?
3. Accept the small behaviour changes DO lists in 19.6 plus: no Discord post for backfilled copies without a ping; detached live events keep local auto-stop.
