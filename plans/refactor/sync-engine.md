# Design: generic bidirectional alliance <-> guild SYNC ENGINE

Scope: one engine that replaces the four copy mechanisms (`alliance_shares`, `event_fanout_*`, `event_mirror_requests`, the `/register` one-shot copy + split distribution) and covers every domain (events, participation/roster, builds, comps, splits, warns, regear, XP/ranks, members/links/roles).
All paths are relative to `apps/backend/src` unless stated. Line numbers refer to the current worktree (HEAD `f7f60e44`). Findings ids (`alliance-N`, `events-N`, ...) refer to the audit in `areas.json`.

Out of scope here (owned by other subsystem designs, only the contract is named): Discord delivery outbox / bot reducers, the backend lifecycle scheduler (mass/start/1h/auto-stop), identity/onboarding (GuildMember* forwarding), action descriptors and the frontend components. Section 14 lists the exact integration points.

---

## 0. Summary of the design

1. **Origin ownership.** Every synced record has exactly one origin tenant (the creator). All other tenants hold *read-only copies* that point back to the origin. Topology is a **star around the origin**, never a chain: a copy never re-emits; the origin fans out to the alliance tenant and to the other active member guilds (according to the per-kind policy, section 1.3).
2. **One pipeline.** `domain write + sync_outbox row` (same tenant transaction) -> **relay** -> control-plane `sync_jobs` (one row per target) -> **executor** claims jobs with leases/fencing -> per-kind **idempotent handler** converges the target to the *current origin state* (state-based, not delta-based) -> `sync_links` / tenant `sync_copies` record the mapping and last applied version.
3. **Mapping is per entity, not per job.** `sync_links(kind, origin_tenant, origin_id, target_tenant) -> target_id` is the only mapping. This kills `event_fanout_assets` (job-scoped, root of alliance-1/2) and `alliance_shares` (single-alliance, root of alliance-7).
4. **Two flows only:** `to_copy` (origin -> copies, state convergence) and `to_origin` (command from a copy to the origin, used for signups, so the alliance/origin owns the canonical roster). A third class, `effect` jobs (Discord role grant/revoke, split payout credit), reuses the same queue, leases and status API.
5. **Read-only enforcement in the backend** through one guard (`sync::guard`) backed by a tenant-local `sync_copies` table; the error carries the origin reference so clients can link to it.
6. **One status/retry API** (`/api/sync/*`) reading `sync_jobs` + `sync_links`; legacy `fanout-status`, `mirror-status`, `mirror-retry`, `distribution-status` become thin adapters then disappear.
7. **Membership is just two more job kinds** (`membership.backfill`, `membership.detach`) that fan out through the same handlers (via a `backfill_scan` / `detach` method every kind implements).

---

## 1. Model

### 1.1 Glossary

| Term | Meaning |
|---|---|
| origin | tenant + local id of the record that owns the content (creator tenant). Only the origin mutates it. |
| copy | read-only record in another tenant, created/updated only by the engine, linked to the origin. |
| link | control-plane row `sync_links` binding `(kind, origin_tenant, origin_id, target_tenant)` to `target_id`. |
| hub | the alliance tenant. Not special in the data model; it is the target that always exists for guild-origin shared records and the roster authority for alliance-origin events (because origin = alliance). |
| origin_version | monotonic per-origin-tenant number = `sync_outbox.id` of the change that triggered the job. Never a wall-clock. |
| state job | idempotent "make the target equal the origin *now*". Coalescible. |
| command job | "apply this user action at the origin". Ordered, not coalesced. |
| effect job | external side effect (Discord role, ledger credit) with its own idempotency key. |

### 1.2 Topology

```
alliance A (origin of alliance-created records)            guild G1 (origin of its own shared records)
   |  \__ copies in G1, G2, G3 (read-only)                    |  \__ copy in A, G2, G3 (events only), A only for the rest
   v      commands: G2/G3 signup -> A (roster owner)          v      commands: A/G2/G3 signup -> G1
```
* Copies never emit state jobs. They emit only **commands** (signups) and tenant-local effects.
* A guild event with `ping_alliance=true` is a synchronized event whose origin is the guild: target set = alliance + other active member guilds. The roster is owned by the origin (the guild), consistent with "origin owns the record"; "alliance owns the roster" holds for events whose origin is the alliance.
* Event ids are per-schema sequences, so every key always carries the tenant id (`ordering_key`, links, locks).

### 1.3 Per-kind policy (defaults, code-level constants in `modules/sync/policy.rs`)

| Kind | Origin | Targets from alliance origin | Targets from guild origin | Copy semantics |
|---|---|---|---|---|
| `build`, `comp` | any | all active member guilds | alliance only (hub) | read-only; local events may reference copies |
| `event` | any | all active guilds | only when `ping_alliance=true`: alliance + other active guilds | read-only content/lifecycle; tenant-local: voice channel, Discord ids/thread/vod, battle link progress |
| `event_roster` (participations, seats, roster roles, attribution) | event origin | all copies of the event | all copies of the event | read-only projection; pending local signups kept (1.5) |
| `participation.command` | copy tenant | origin | origin | command |
| `split` (structure, bags, participants, status) | any | all active guilds (alliance split) | alliance only | read-only |
| `split.payout` | alliance | the attributed guild of each recipient | n/a | effect: `split_credit` ledger row in guild |
| `warn` | any | the target user's home guild(s) | alliance | read-only, informational; excluded from the copy-tenant escalation counters |
| `regear.request` | guild | n/a | alliance | read-only projection of *decided* requests (visibility) |
| `progression.summary` | guild | n/a | alliance | read-only `(discord_id, level, guild_rank)`; **no XP ledger sync, no alliance leaderboard** |
| `member` (user + albion link + presence) | any | guild(s) matching the user's Albion guild / memberships | alliance | read-only identity copy; ex-member = soft-deactivated flag |
| `role.grant` / `role.revoke` | alliance | Discord guild of the target tenant | alliance Discord | effect |
| `membership.backfill` / `membership.detach` | alliance | the joining/leaving guild | n/a | scan/effect |

Per-guild opt-out per kind is *not* modelled (owner decision: everything syncs). A global kill-switch `SYNC_KINDS_DISABLED=kind,kind` (env) exists for incident response.

### 1.4 XP / attendance / regear attribution (guild level only)

* Every participation row has `attributed_guild_tenant_id` (the guild whose member signed up, resolved with `events::attribution::resolve_join_attribution`, kept but moved from control to the tenant row, see 5.3). Attribution is carried by the roster projection to every copy.
* When an event reaches a terminal state in a tenant (origin or copy), `EventService::snapshot_event_completion_xp` (events/service.rs:4060) is called with a filter: only participants with `attributed_guild_tenant_id = this tenant` (or `NULL` for never-synced events) receive `xp_event_complete`. Creator XP (`xp_event_create`) goes to the creator only in the origin tenant if the creator is attributed there. No alliance-level XP exists.
* `stop_event_with_xp_policy(.., award_xp)` (service.rs:4007) stays; its callers change: router.rs:2139 (`!is_mirror_event`) and `event_sessions/auto_stop.rs:62` pass `award_xp = true` for copies too and rely on the attribution filter. Copies do not run *their own* auto-stop (see 5.1 step 7); a copy reaches a terminal state only through the engine, which then calls the same completion function inside the apply transaction. XP outbox rows are created in the copy tenant (`event_completion_xp`, idempotency key already `event_completion:{event}:{source}:{user}`), retried by the existing `retry_pending_event_completion_xp` worker (event_sessions/mod.rs:63), which must now also run for alliance tenants (see 14).
* Regear and attendance for alliance events are claimed through the guild copy, restricted to attributed participants (`regear_deaths.guild_id` already exists). The `regear.request` projection gives the alliance read-only visibility only.

### 1.5 Pending local signups on a copy

A signup on a copy writes the row in the copy tenant immediately with `event_participations.sync_state = 'pending'` so the user sees success. The origin applies the command; the next roster projection replaces the pending row with the canonical one. If the origin rejects (event full, event closed, build not allowed) the job ends `done` with `result.status = 'rejected'`; the projection removes the pending row and a notification (`notifications` table) tells the user why. The roster projection **never** deletes rows with `sync_state='pending'` whose `command_seq` is newer than the projection's `command_seq_seen` for that user (see 5.2).

---

## 2. Data model

New migrations (one `alter_table` per column, SQLite-safe; WP0 prerequisite). Names follow the current numbering: latest control = `m20261106_000001_mirror_request_inactive_state`, latest tenant = `m20261103_000001_add_alliance_distribution_key`.

### 2.1 Control plane (schema `control`) - `control_migration/m20261107_000001_sync_engine.rs`

```sql
CREATE TABLE sync_links (
  kind              text   NOT NULL,   -- 'event','event_roster','build','comp','split','warn','regear_request','progression_summary','member'
  origin_tenant_id  text   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  origin_id         bigint NOT NULL,
  target_tenant_id  text   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target_id         bigint,                       -- NULL until first successful apply
  state             text   NOT NULL DEFAULT 'active' CHECK (state IN ('active','detached')),
  detach_reason     text   CHECK (detach_reason IN ('left','expelled','origin_deleted','scope_off','target_missing')),
  synced_version    bigint NOT NULL DEFAULT 0,    -- highest origin_version applied
  content_hash      text,                         -- sha256 of canonical origin graph at last apply (skip no-op writes)
  last_synced_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, origin_tenant_id, origin_id, target_tenant_id)
);
CREATE UNIQUE INDEX sync_links_target_uq  ON sync_links (kind, target_tenant_id, target_id) WHERE target_id IS NOT NULL;
CREATE INDEX        sync_links_target_idx ON sync_links (target_tenant_id, state);
CREATE INDEX        sync_links_pair_idx   ON sync_links (origin_tenant_id, target_tenant_id) WHERE state = 'active';

CREATE TABLE sync_jobs (
  id               uuid PRIMARY KEY,
  seq              bigint GENERATED ALWAYS AS IDENTITY,        -- global FIFO tiebreak
  kind             text NOT NULL,
  op               text NOT NULL CHECK (op IN ('upsert','delete','archive','command','scan','effect')),
  flow             text NOT NULL CHECK (flow IN ('to_copy','to_origin','effect')),
  origin_tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  origin_id        bigint NOT NULL,                            -- entity at the origin (0 for scans)
  target_tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  origin_version   bigint NOT NULL,                            -- outbox id (state/command) or 0
  ordering_key     text NOT NULL,                              -- jobs with equal key run one at a time in seq order
  dedupe_key       text NOT NULL UNIQUE,                       -- '{origin}:{outbox_id}:{target}:{kind}' (relay replay safe)
  payload          jsonb NOT NULL DEFAULT '{}',                -- command body / scan cursor / effect args
  priority         smallint NOT NULL DEFAULT 5,                -- 1 command, 3 state, 5 effect, 8 backfill
  state            text NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending','processing','retry','done','exhausted','blocked','inactive','superseded','cancelled')),
  attempts         int  NOT NULL DEFAULT 0,
  max_attempts     int  NOT NULL DEFAULT 12,
  error_class      text CHECK (error_class IN ('retryable','permanent','blocked')),
  last_error       text,
  result           jsonb,                                      -- e.g. {"status":"rejected","reason":"event_full"}
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  lease_until      timestamptz,
  lease_token      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);
-- state jobs coalesce: at most one waiting job per (kind, origin entity, target)
CREATE UNIQUE INDEX sync_jobs_coalesce_uq ON sync_jobs (kind, origin_tenant_id, origin_id, target_tenant_id)
  WHERE op IN ('upsert','delete','archive') AND state IN ('pending','retry');
CREATE INDEX sync_jobs_due_idx    ON sync_jobs (priority, next_attempt_at, seq) WHERE state IN ('pending','retry','processing');
CREATE INDEX sync_jobs_order_idx  ON sync_jobs (ordering_key, seq)               WHERE state IN ('pending','retry','processing');
CREATE INDEX sync_jobs_entity_idx ON sync_jobs (origin_tenant_id, kind, origin_id);
CREATE INDEX sync_jobs_target_idx ON sync_jobs (target_tenant_id, state);

CREATE TABLE sync_legacy_import (name text PRIMARY KEY, done_at timestamptz NOT NULL DEFAULT now());  -- idempotent one-time import markers
ALTER TABLE alliance_memberships ADD COLUMN left_reason text;                                          -- 'left'|'expelled'
ALTER TABLE alliance_memberships ADD COLUMN sync_state text NOT NULL DEFAULT 'ready';                  -- 'backfilling'|'ready'|'detaching'|'detached'
-- status check extended: ('pending','active','left','expelled')
```
`event_participant_attributions` is kept read-only until slice 9 (imported in 5.3).

### 2.2 Tenant schema (every tenant, guild and alliance) - `migration/m20261107_000001_create_sync_tables.rs` (+ one file per later alter)

```sql
CREATE TABLE sync_outbox (
  id          BIGSERIAL PRIMARY KEY,                 -- = origin_version
  kind        TEXT   NOT NULL,
  entity_id   BIGINT NOT NULL,
  op          TEXT   NOT NULL,                       -- upsert | delete | archive | command
  command     JSON   NULL,                           -- command body (participation join/leave, ...)
  ordering_key TEXT  NULL,                           -- commands only
  not_before  TIMESTAMPTZ NULL,                      -- debounce (progression.summary = +60s)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  relayed_at  TIMESTAMPTZ NULL,
  relay_error TEXT NULL
);
CREATE INDEX sync_outbox_pending_idx ON sync_outbox (id) WHERE relayed_at IS NULL;
CREATE INDEX sync_outbox_entity_idx  ON sync_outbox (kind, entity_id) WHERE relayed_at IS NULL;

CREATE TABLE sync_copies (                          -- authoritative marker "this local row is a copy"
  kind             TEXT   NOT NULL,
  local_id         BIGINT NOT NULL,
  origin_tenant_id TEXT   NOT NULL,
  origin_id        BIGINT NOT NULL,
  origin_version   BIGINT NOT NULL DEFAULT 0,       -- last applied
  origin_epoch     BIGINT NOT NULL DEFAULT 0,       -- events: lifecycle_epoch at last apply (allows uncancel)
  read_only        BOOLEAN NOT NULL DEFAULT TRUE,
  state            TEXT   NOT NULL DEFAULT 'active', -- active | detached | archived_by_detach
  content_hash     TEXT   NULL,
  applied_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, local_id),
  UNIQUE (kind, origin_tenant_id, origin_id)
);
CREATE TABLE sync_inbox (                           -- origin side idempotency/ordering for commands
  ordering_key TEXT PRIMARY KEY,
  last_seq     BIGINT NOT NULL,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- domain columns (separate alter files)
ALTER TABLE event_participations ADD COLUMN attributed_guild_tenant_id TEXT NULL;
ALTER TABLE event_participations ADD COLUMN sync_state TEXT NULL;              -- NULL | 'pending'
ALTER TABLE event_participations ADD COLUMN command_seq BIGINT NULL;           -- outbox id of the pending command
ALTER TABLE events               ADD COLUMN lifecycle_epoch BIGINT NOT NULL DEFAULT 0; -- bumped by uncancel/unarchive
ALTER TABLE users                ADD COLUMN deactivated_at TIMESTAMPTZ NULL;   -- shared with the member-sync subsystem
-- progression summary projection (alliance schema only is populated)
CREATE TABLE member_standing (discord_id TEXT NOT NULL, guild_tenant_id TEXT NOT NULL, level INT NOT NULL, guild_rank TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (guild_tenant_id, discord_id));
-- seed permissions (like migration/m20260916_000002_seed_alliance_share_permission.rs): 'sync.view','sync.manage' granted to roles that hold 'alliance.share'
```
`events.source_tenant_id/source_event_id` (entities.rs:78-80) and `splits.origin_read_only` stay as denormalized legacy columns, still written by the handlers until slice 9, but **all logic moves to `sync_copies`**.

Types: `JSON` (not `JSONB`) in tenant DDL so SQLite unit tests apply the same migrations; control plane is Postgres-only (`jsonb` ok).

---

## 3. Emit, relay, wake-up

### 3.1 Emit inside the domain transaction (`modules/sync/outbox.rs`)

```rust
pub enum SyncKind { Event, EventRoster, Build, Comp, Split, Warn, RegearRequest, ProgressionSummary, Member }
pub struct SyncEmit { pub kind: SyncKind, pub entity_id: i64, pub op: SyncOp, pub command: Option<serde_json::Value>, pub ordering_key: Option<String>, pub not_before: Option<DateTime<Utc>> }
pub async fn emit(db: &impl ConnectionTrait, ev: SyncEmit) -> Result<i64 /*outbox id*/, AppError>;
```
* State emits coalesce: `DELETE FROM sync_outbox WHERE kind=? AND entity_id=? AND relayed_at IS NULL AND op <> 'command'` then `INSERT` (new, higher id) - both in the caller's transaction. Commands never coalesce.
* `emit` returns early (no row) when `sync_copies` says the entity is a copy **and** the kind is a state kind (copies never originate state).
* **Wrapper that makes guard + emit hard to forget:**

```rust
pub async fn mutate_origin<T>(db: &DatabaseConnection, kind: SyncKind, id: i64, op: SyncOp,
        f: impl AsyncFnOnce(&DatabaseTransaction) -> Result<T, AppError>) -> Result<T, AppError> {
    let txn = db.begin().await?;
    guard::assert_writable(&txn, kind, id).await?;      // 403 ReadOnlyCopy(origin ref)
    let out = f(&txn).await?;
    emit(&txn, SyncEmit::state(kind, id, op)).await?;
    txn.commit().await?;
    kick();                                              // non-blocking wake-up, never awaited
    Ok(out)
}
```
Services that today use several non-transactional statements (`CompService::update_comp` comps/service.rs:1838, `update_build` :1128, `SplitService::update_split` splits/service.rs:1220, `EventService::update_event` events/service.rs:3556) get wrapped. Services already transactional (`stop_event_with_xp_policy`, `create_event_with_source_identity`) just call `emit(&txn, ..)` before commit.

### 3.2 Where emits go (the complete choke-point list; this replaces every `sync_owner_change_to_copies`, `sync_participation`, `create_mirror`, `after_successful_link` call site)

| Domain | Functions (events/service.rs unless noted) | Emitted |
|---|---|---|
| event content/lifecycle | `create_event_with_source_identity` (~3381), `update_event` 3556 (also `ping_alliance` toggle at 3593), `delete_event` 3671, `archive_event` 3681, `unarchive_event` 3721, `cancel_event` 3873, `uncancel_event` 3909 (bumps `lifecycle_epoch`), `start_event` 3948, `stop_event_with_xp_policy` 4007 | `Event` upsert/delete/archive |
| roster | `assign_roster_seat` 1728, `clear_roster_seat` 1812, `swap_roster_seats` 1877, `auto_fill_roster` 1968, `create_event_roster_role` 2156, `delete_event_roster_role` 2205, `participate*` 4555-4590, `add_member_with_roster_version` 4590, `set_participant*` 4607-4620, `cancel_participation` 4922, router remove participant (router.rs:~1730) | `EventRoster` upsert (origin) or `participation.command` (copy tenant) |
| tenant-local (NO emit) | `bind_event_voice_channel` 3792, `clear_event_voice_channel` 3839, vod forum post fns 1407-1505, battle linker (4243-4537) | none |
| build | `comps/service.rs`: `create_build` 1012, `update_build` 1128, `create_build_version` 1210, `delete_build` 1318, `archive_build` 1390, `unarchive_build` 1406, `upsert_build_item` 1422, `set_build_item_spells` 1494, `remove_build_item` 1538 | `Build` |
| comp | `create_comp` 1718, `update_comp` 1838, `delete_comp` 2090, `archive_comp` 2141, `unarchive_comp` 2157, `add_comp_build` 2174, `update_comp_build_quantity` 2242, `remove_comp_build` 2281, `create_comp_version` 557 | `Comp` |
| split | `splits/service.rs`: `create_split` 968, `update_split` 1220, `mark_not_completed` 1159, `mark_lost` 1174, `complete_split` 2139, `complete_splits_batch` 2103, `delete_split` 1440, `archive_split` 1454, `unarchive_split` 1476, `add_or_update_participant` 1999, `remove_participant` 2049, bags; `alliance_distribution::finalize_source_split` | `Split` |
| warns | `warns/service.rs`: `issue` 51, `revoke` 230 | `Warn` |
| regear | `regear/service.rs`: `accept_request` 270, `reject_request` 434 (decided only) | `RegearRequest` |
| progression | `award_in_season` 120, `adjust` 770, rank change in `update_settings` 285 | `ProgressionSummary` (`not_before = now+60s`) |
| members | `albion/service.rs`: `create_link` 268, `delete_link` 311, `admin_link_user` 348, `admin_unlink_user` 409 (fixes auth-8: admin paths used to skip the fan-out), `users/identity::upsert_discord_user`, membership deactivate (member-sync subsystem) | `Member` |

This list is also encoded as a unit test (`sync::tests::choke_points_call_emit`): a static array of `(file, fn)` pairs is grepped in the source text at test time to catch a new mutating fn that forgets `emit` - cheap, crude, effective. The reconciler (6.4) is the safety net for anything that slips through.

### 3.3 Relay (`modules/sync/relay.rs`)

Per participating tenant (alliance tenants + guilds with an active membership; set cached 30 s from `alliance_memberships`):
1. In a tenant txn: `SELECT * FROM sync_outbox WHERE relayed_at IS NULL AND (not_before IS NULL OR not_before <= now()) ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED` (Postgres; SQLite tests skip the lock clause).
2. For each row call `Kind::targets(cx, origin_tenant, entity_id) -> TargetPlan { desired: Vec<TenantId>, existing_active: Vec<TenantId> }`. `desired` = policy (1.3) evaluated on current origin state + active memberships; `existing_active` from `sync_links`. Jobs: `upsert` for each desired; `delete`/`archive` for `existing_active \ desired` (this is how `ping_alliance=false` retires mirrors, and how a left guild stops receiving).
3. Insert jobs into control `sync_jobs` with `dedupe_key = '{origin}:{outbox_id}:{target}:{kind}'`, `ON CONFLICT (dedupe_key) DO NOTHING`; state jobs use the coalescing index: `ON CONFLICT (kind, origin_tenant_id, origin_id, target_tenant_id) WHERE ... DO UPDATE SET origin_version = GREATEST(sync_jobs.origin_version, EXCLUDED.origin_version), op = EXCLUDED.op, next_attempt_at = LEAST(sync_jobs.next_attempt_at, now()), updated_at = now()`.
4. Commit the tenant txn setting `relayed_at`. A crash between 3 and 4 only replays inserts, which dedupe.
5. Tenants with no targets: rows are marked relayed immediately (cheap). A daily maintenance deletes relayed rows older than 7 d; unrelayed rows of non-participating tenants older than 1 d are discarded (the join backfill, not the outbox, brings a new member up to date).

### 3.4 Wake-up

* In-process: `SyncEngine::kick()` = `tokio::sync::Notify::notify_one()` (single replica, documented).
* Cross-process safety net: `pg_notify('sync', tenant_id)` issued by `kick()` on the control pool and a `PgListener` (`sea_orm::sqlx::postgres::PgListener::connect_with(control.get_postgres_connection_pool())`) in the engine, reconnecting with backoff.
* Fallback tick: relay 5 s, executor 5 s, so a lost notification costs at most one tick. NOTIFY is an optimization, never a guarantee (matches principle in plan section 4.1).
* The HTTP request never awaits relay/executor. Today `process_due_targets` is awaited inline after commit (events/lifecycle.rs:142, events/router.rs:1078); this is removed, which is the structural fix for "error after commit" (alliance-6, events-5).
* Engine singleton: at startup take `pg_try_advisory_lock(0x53594e43)` on a dedicated connection; if not acquired, do not start loops (replaces the implicit single-task assumption of `fanout_worker::spawn`, lib.rs:118). Leases remain correct even if two engines ever run.

---

## 4. Jobs: claim, state machine, retry

### 4.1 Claim (`modules/sync/jobs.rs`, generalizes `fanout_outbox::claim_due` fanout_outbox.rs:138 and `mirror_retry::claim_due` mirror_retry.rs:140)

```sql
WITH picked AS (
  SELECT j.id FROM sync_jobs j
  WHERE j.state IN ('pending','retry','processing')
    AND j.next_attempt_at <= now()
    AND (j.lease_until IS NULL OR j.lease_until <= now())
    AND NOT EXISTS (SELECT 1 FROM sync_jobs p                    -- per-key ordering
                    WHERE p.ordering_key = j.ordering_key AND p.seq < j.seq
                      AND p.state IN ('pending','retry','processing'))
  ORDER BY j.priority, j.next_attempt_at, j.seq
  LIMIT $1 FOR UPDATE SKIP LOCKED)
UPDATE sync_jobs j SET state='processing', attempts=j.attempts+1,
  lease_until=now()+($2||' seconds')::interval, lease_token=$3, updated_at=now()
FROM picked WHERE j.id=picked.id RETURNING j.*;
```
* Lease 60 s default, 5 min for `scan` jobs, with `heartbeat(job)` extending `lease_until` between batches.
* **Fencing** exactly as `finish_target` (fanout_outbox.rs:257): every terminal update has `WHERE id=$1 AND lease_token=$2 AND state='processing'`; 0 rows -> `Conflict("lease expired or replaced")` and the handler result is discarded (handlers are idempotent so the replacement worker converges anyway).
* `ordering_key` examples: `event:{origin_tenant}:{id}:{target}` (state), `cmd:{origin_tenant}:{event_id}:{discord_id}` (signup commands, strict order), `split.payout:{batch_id}:{guild}`, `member:{origin}:{discord_id}:{target}`. Terminal states (`done/exhausted/blocked/inactive/superseded/cancelled`) do not block later keys.
* Concurrency: executor runs N=4 tasks; in-process `DashMap<TenantId, Arc<Semaphore(2)>>` caps concurrent applies per *target* tenant (avoids exhausting a tenant pool, cf. backend-perf-7); `priority` + per-kind cap (backfill scan jobs max 1 in flight per alliance) prevents backfill from starving live traffic.

### 4.2 State machine

```
pending --claim--> processing --Ok(Done)--------------> done
                              --Ok(Inactive(reason))--> inactive      (membership no longer active, scope off)
                              --Ok(Superseded)--------> superseded    (origin gone and nothing to clean up / newer version applied)
                              --Err(Retryable)--------> retry (attempts<max, next_attempt_at=backoff) | exhausted (attempts>=max)
                              --Err(Permanent)--------> exhausted     (no more automatic attempts, error_class=permanent)
                              --Err(Blocked{..})------> blocked       (needs human: e.g. participant unregistered); re-armable
retry/exhausted/blocked --POST retry--> pending (attempts=0)
pending/retry --coalesce by newer emit--> same row, origin_version bumped, next_attempt_at=now
exhausted/blocked + newer emit for the same entity --> a NEW pending row (the coalescing index ignores terminal states)
```
`SyncError` (modules/sync/error.rs): `Retryable(String)` (DB/tenant load/Discord 5xx/429/roster-version conflict/lease conflict), `Permanent(String)` (target schema violates an invariant that retrying cannot fix, unsupported op), `Blocked { code, detail }` (`participant_unresolved`, `guild_left`, `discord_forbidden`, `build_unmappable`), `Inactive(reason)`. Classification fixes alliance-20 (a guild event without active alliance or with deleted comp burned 12 attempts: now `Inactive`/`Permanent` immediately) and alliance-16 (no cap: `max_attempts` per kind, terminal `exhausted`).

Backoff: `delay = min(3600, 15 * 2^min(attempt,8)) * (0.8 + 0.4*rand)` (the existing `retry_delay_seconds` fanout_worker.rs:105 / mirror_retry.rs:223 plus jitter, shared). Defaults: state 12, command 8, effect 20 (Discord), payout 30, scan 5. A per-target circuit breaker (5 consecutive `Retryable` load/connection errors for one tenant) pauses claims for that tenant 60 s.

### 4.3 Worker loops (`modules/sync/engine.rs`, replaces `events::fanout_worker::spawn` spawned at lib.rs:118)

`SyncEngine::spawn(control, registry, hub: RosterHub, discord: DiscordRoleClient, cfg)` starts:
1. **relay loop** (3.3) - wake: Notify/`NOTIFY sync` or 5 s.
2. **executor loop** x4 - claim up to 8 per round (4.1), dispatch to `HandlerRegistry[kind].apply`, finish with fencing, `hub.publish` for roster/event kinds after commit.
3. **maintenance loop** (60 s): outbox lag watchdog (`WARN` if oldest unrelayed > 120 s), expired `processing` leases surfaced as metrics (they are reclaimed by the claim query itself), purge `done|superseded|inactive` jobs > 30 d and `cancelled` > 7 d, discard stale outbox.
4. **reconcile loop** (hourly + at boot after legacy import, 6.4).
5. **membership loop** is not separate: `membership.*` are ordinary scan jobs.

Metrics/logs: `sync_job_total{kind,state}`, `sync_job_lag_seconds`, `sync_outbox_lag_seconds`; a `tracing` span per job with `job_id, kind, origin, target, attempt`.

---

## 5. Handlers (idempotent, state-convergent)

Trait (`modules/sync/handler.rs`):

```rust
#[async_trait::async_trait]
pub trait SyncHandler: Send + Sync {
    fn kind(&self) -> SyncKind;
    fn max_attempts(&self) -> i32 { 12 }
    async fn targets(&self, cx: &SyncCx, origin: &TenantRef, id: i64) -> Result<TargetPlan, SyncError>;
    async fn apply(&self, cx: &SyncCx, job: &ClaimedJob) -> Result<Outcome, SyncError>;       // upsert/delete/archive/command
    async fn backfill_scan(&self, cx: &SyncCx, scope: BackfillScope, cursor: Option<Cursor>) -> Result<ScanPage, SyncError>;
    async fn detach(&self, cx: &SyncCx, link: &SyncLink, reason: DetachReason) -> Result<(), SyncError>;
    async fn watermark(&self, cx: &SyncCx, origin: &TenantRef, after: Cursor) -> Result<Vec<(i64 /*id*/, DateTime<Utc>)>, SyncError>; // reconcile
}
```
`SyncCx { control, registry, hub, discord, cfg }` is built once. A handler **never trusts the job payload for state**: it reads the origin row at apply time.

Common primitive: `links::ensure_copy(cx, kind, origin, id, target) -> CopyRef` (used by dependency resolution too):
1. `BEGIN` control txn; `INSERT INTO sync_links (...) ON CONFLICT DO NOTHING; SELECT ... FOR UPDATE` (row lock serializes concurrent creators of the same copy; replaces the unprotected create in `copy_alliance_comp_to_tenant`).
2. If `target_id` set and the tenant row exists and `synced_version`/`content_hash` match the origin -> return (no write). If target row missing -> `detach_reason='target_missing'`, treat as new.
3. Else find the copy by `sync_copies(kind, origin_tenant, origin_id)` in the target tenant (crash-safe adoption), else create. Copy row + `sync_copies` row are written in **one tenant transaction**.
4. Update the link (`target_id`, `synced_version`, `content_hash`), `COMMIT`.

### 5.1 `event` (replaces `fanout_worker::process_target` fanout_worker.rs:111, `sync::create_mirror` sync.rs:51, `mirror_retry::attempt` mirror_retry.rs:229, `lifecycle::converge_copy_to_source` lifecycle.rs:56, `sync_owner_change_to_copies` lifecycle.rs:110)

`apply(upsert)` for target T:
1. `ensure_copy` lock on the event link.
2. **Scope/membership re-check under row lock** (the `link_copy_if_membership_active` pattern, fanout_worker.rs:306: `SELECT status FROM alliance_memberships ... FOR UPDATE`). Not active -> `Inactive`, archive existing copy. Guild origin: `ping_alliance` false -> `Inactive(scope_off)` + archive.
3. Origin row missing -> treat as `delete`: archive the copy, `detach_reason='origin_deleted'`, `Done`.
4. **Dependencies**: `comp_id` -> `ensure_copy(Comp)` (which ensures builds), and **every `event_roster_roles.build_id` -> `ensure_copy(Build)` independently of the comp** (alliance-2: roster-role builds outside the comp used to be unmapped and the target retried forever), producing `build_map: origin build -> copy build` from `sync_links`, not from a job. Flash events (`event_kind='flash'`) have no comp and are allowed (create_mirror used to reject them).
5. `content_hash = sha256(canonical{title, description, times, cap, regear, call_to_arms, vod flag, status, archived, comp copy id, roster role copy ids})`; unchanged and `origin_epoch` unchanged -> `Done` without writing.
6. Tenant txn on T: create via `EventService::create_event_with_source_identity` (refactored to an `_in(txn)` variant) or update via `apply_origin_state(txn, copy, origin)`:
   * Replaces `converge_copy_to_source`. Content fields follow origin unconditionally. Roster roles are **diffed** by `build_id` (no delete+recreate: seat keys and participation builds keep stable ids; alliance-1 side effect).
   * **Monotonic lifecycle** (alliance-3): rank `scheduled=0 < live=1 < {stopped,auto_stopped,cancelled}=2`. A copy at rank 2 never moves to rank < 2 unless `origin.lifecycle_epoch > sync_copies.origin_epoch` (the origin explicitly uncancelled/unarchived). A copy at rank 0 moving to 2 passes through the terminal-effects hook below.
   * Tenant-local fields are never overwritten: `discord_voice_channel_id`, Discord message/thread/signup ids, `vod_forum_*` status/thread (except re-queue when VOD enabled and deleted, as today), battle-link columns, `discord_delivery`.
   * `discord_role_ids` are not copied (tenant-local, as today fanout_worker.rs:~232).
   * On first transition to `stopped|auto_stopped` in the copy: call `EventService::finish_copy_session(txn, copy_id)` = the body of `stop_event_with_xp_policy` after the status write (XP snapshot filtered by attribution, 1.4) + `SplitService::sync_event_participants` for local splits (alliance-17). `cancelled` -> existing cancel semantics; archived -> `archived_at`.
   * Upsert `sync_copies(kind='event', local_id, origin..., read_only=true, origin_version, origin_epoch, content_hash)`; keep `events.source_tenant_id/source_event_id` written for the legacy readers.
7. After commit: link update, `hub.publish(T, copy_id, ..)` (alliance-17), enqueue Discord delivery for T (`delivery::enqueue(T, Event(copy_id), reason)` - contract with the delivery outbox subsystem).
8. **Auto-stop/start/mass are origin decisions**: the backend scheduler (other design) runs for guild *and alliance* tenants, skips rows present in `sync_copies` (`event_sessions/auto_stop.rs:34` gets `AND NOT EXISTS (SELECT 1 FROM sync_copies ...)`), and emits `Event` upsert after stopping an origin event. Copies therefore cannot self-stop and cannot be resurrected. Mass/start/1h reminder Discord effects on a copy are scheduled locally by the scheduler *on the copy's own times* (tenant-local effect; the 403 loop of alliance-4 disappears because `start_event` on a copy is no longer a bot action - the scheduler runs in-process and does not call the guarded HTTP route).

`apply(archive/delete)`: converge copy to archived (and `cancelled` if origin cancelled), link `detached(origin_deleted|scope_off)` when applicable. Deleting a copy by hand is forbidden (guard).

### 5.2 `event_roster` + `participation.command` (alliance-5, alliance-6, events-5, events-6, alliance-17, alliance-20)

**Command path (copy tenant -> origin).** All signup entry points (web `POST /events/{id}/participate`, bot, alliance Discord) call the same service function. In a copy tenant it:
1. validates locally (event not terminal; builds exist as copies - the copy build id is translated to the *origin* build id via `sync_copies(kind=build)`; this removes `sync.rs::map_build` sync.rs:500 and its `event_fanout_assets`/`alliance_shares` double lookup);
2. resolves attribution: a guild copy attributes to itself; from the alliance tenant (alliance copy of a guild-origin event) via `resolve_join_attribution` (attribution.rs:99) with explicit pick when ambiguous (existing `participation-guilds` endpoint, parity-1 is a frontend bug);
3. in **one tenant txn**: upsert the participation row with `sync_state='pending'`, `command_seq = outbox id`, `attributed_guild_tenant_id`; `emit(command={op:'join'|'leave', discord_id, username, primary_build_origin_id, secondary_build_origin_id, attributed_guild}, ordering_key='cmd:{origin}:{event}:{discord_id}')`;
4. returns success immediately; `hub.publish` for the local room.

`apply(command)` at the origin (flow `to_origin`, priority 1, max 8 attempts):
* `sync_inbox`: skip when `job.origin_version <= last_seq` for the `ordering_key` (replay/out-of-order after a manual retry).
* `identity::upsert_discord_user` in the origin tenant, then `EventService::participate_with_roster_version` / `cancel_participation` (events/service.rs:4568/4922) with bounded retry on roster-version conflict (3 loops, then `Retryable`).
* Writes `attributed_guild_tenant_id` on the origin participation row **in the same txn** (moves attribution out of control `event_participant_attributions`; removal of the participation removes the attribution - alliance-20; re-join may choose a different eligible guild).
* Business rejections (`event_full`, `closed`, `build_not_in_comp`) -> `Done` with `result.status='rejected'` + notification; never retried.
* On success, `emit(EventRoster upsert)` at the origin -> projection jobs to all copies.

**Officer actions at the origin** (add participant, set participant, remove, seat assign/clear/swap/auto-fill, roster-role CRUD): same service functions, now wrapped in `mutate_origin` -> emit `EventRoster`. `add_member`/`set_participant` take `attributed_guild_tenant_id`: explicit, else the single eligible guild of the user (`user_tenant_memberships` ∩ active members), else `422 {code:'attribution_required', eligible:[...]}` (the unattributed row that blocked split payout, alliance-5, can no longer be created). Officer on a copy: `ReadOnlyCopy` error with the origin reference (clients link to the origin).

**Projection `apply(upsert event_roster)`** per copy target: one tenant txn: map users by `discord_id` (auto-provision via `identity::upsert_discord_user` for absent ones), map builds via links (`ensure_copy(Build)` if a used build has no copy yet), replace `event_participations` for the event except pending rows newer than `command_seq_seen` (payload carries `last_applied_command_seq` per discord_id from `sync_inbox`), replace `event_roster_assignments` (seat_key -> mapped user), diff `event_roster_roles`, set `events.roster_version` of the copy = origin version (so the bot's revision polling and `expected_roster_version` keep working), update `sync_copies(kind='event_roster')`, then `hub.publish(T, copy_id, version, kind, seats)`. Linked splits in the copy are **not** recomputed locally: the `split` projection supplies participants (finance-3, 5.4).

### 5.3 Attribution migration

`event_participant_attributions` (control, m20261102) -> `event_participations.attributed_guild_tenant_id` in the origin tenant, joining on `users.discord_id`; orphans (no participation) dropped. `events/attribution.rs::{stored_attribution, resolve_join_attribution}` read the tenant column; the control table is read-only until slice 9.

### 5.4 `build`, `comp` (replaces `alliance_share/service.rs` copy graphs :610/:756, `ensure_build_published` :700, `alliance_shares`)

* `Build` apply: read origin build + items + spells; `content_hash`; unchanged -> no-op (kills alliance-1: an update job no longer re-copies). Create/update in target in one txn reusing `copy_build_graph` internals (items/spells rewrite in a single txn), `ensure_category` by name, `resolve_created_by` -> `identity` user for the origin creator. `parent_id` mapped through the build link (NULL if parent not synced). Target build gets `sync_copies` + `archived_at` mirrored from origin (archive/delete propagate: alliance-9). Deleting an origin build with local-copy users: copy is archived, not deleted, when referenced by `comp_builds`/`event_participations`/`event_roster_roles` in the target (`delete_or_hide_published_build` logic, service.rs:978, becomes the archive branch).
* `Comp` apply: `ensure_copy(Build)` for every `comp_builds` row, then comp + `comp_builds` diff (not delete/insert, quantities updated), `comp_categories` by name, `parent_id` mapped.
* Manual share endpoints (`alliance_share/router.rs`) remain as API: `POST /api/alliance/shares` = `emit(Build|Comp upsert)` + `sync_links` ensure (idempotent), `DELETE` = `delete` + `detached(scope_off)`, `GET status` reads `sync_links`. For guild origin the default is auto-sync (1.3); the endpoints become "force resync / unshare".
* Alliance -> guilds publication is automatic (1.3) and has no UI action; guild copies are readable/usable in events/comps, not editable (guard).

### 5.5 `split` and `split.payout` (alliance-13, finance-3, finance-5, finance-13)

* `Split` apply (structure): origin split row (value, fee, repair, bags, status, net_value, finalized_at, island tab by name via `ensure_island_tab` service.rs:1145), `split_participants` with weights (users mapped by discord_id), `split_bags`; `event_id` mapped through the event link (NULL if the event is not synced). `sync_copies(kind='split', read_only=true)`; `splits.origin_read_only` kept in sync. **No local `sync_event_participants` on a copy** (guard in `SplitService::sync_event_participants` service.rs:1401: skip copies and skip non-`pending` splits - finance-3).
* `split.payout` replaces the on-demand projection in `alliance_distribution::complete` (alliance_distribution.rs:116):
  * `complete()` keeps the **synchronous preflight** (validation errors still returned to the user, alliance_distribution.rs:150-290: membership, attribution, destination user exists, non-zero share) and `load_or_create_batch` (:327), then instead of looping `project_one` it **enqueues one effect job per guild** (`kind='split.payout'`, `origin=(alliance, split_id)`, `target=guild`, `ordering_key='split.payout:{batch}:{guild}'`, `payload={batch_id}`), returns the batch status, and does not block the request.
  * `apply` = existing `project_one` (alliance_distribution.rs:469) for every `pending` item of that guild. It is already idempotent through `transactions.alliance_distribution_key` (unique, m20261103). Item `last_error` per recipient is kept. Guild left/inactive -> `Blocked{guild_left}`; unregistered participant -> `Blocked{participant_unresolved}` (the human fixes attribution/roster, then `retry`).
  * After marking its items complete, the handler checks `SELECT count(*) FROM alliance_split_distribution_items WHERE batch_id=$1 AND state<>'complete'`; zero -> idempotent `finalize_source_split` (:561) + batch `complete` (and emits `Split` upsert so guild copies show `completed`). This is also the **resume**: a crash or restart leaves jobs `processing`/`retry`, the executor reclaims them (alliance-13). The partial index `idx_alliance_split_distribution_pending` is dropped; status comes from `sync_jobs`.
  * The guild ledger row gets `split_id` NULL today (finance-13); the handler sets `source_alliance_tenant_id/source_alliance_split_id` (already written) and the `Split` copy id in `transactions.split_id` once the copy exists, audit log entry, and a `notifications` row. Exclusion from `outflow_other` belongs to the finance subsystem.
  * `GET /api/splits/{id}/alliance-distribution` stays (reads batch + jobs); `POST /api/splits/{id}/alliance-distribution/retry` = `sync retry` on the batch's jobs.

### 5.6 `warn`, `regear_request`, `progression_summary`

* `Warn`: `user_warns` row incl. revocation, mapped by `discord_id` (target-side user auto-provisioned). Alliance origin -> the user's home guild(s) (reuse `plan_register_fanout`/`home_guild_tenant_id`, alliance_fanout.rs:40/354); guild origin -> alliance. Copy rows are excluded from escalation counting (`WarnService` count query gets `AND NOT EXISTS (SELECT 1 FROM sync_copies WHERE kind='warn' AND local_id=user_warns.id)`); `warn_escalations` and acknowledgement stay tenant-local. Revoke only at the origin; propagates.
* `RegearRequest`: emitted only on `accept/reject` (decided requests) guild -> alliance, with `final_amount`, status, mapped event copy (nullable). No credits/balances synced.
* `ProgressionSummary`: per user `(level, guild_rank)` into alliance `member_standing`; debounced (`not_before`), coalesced per `(guild, discord_id)`. Powers the guild badge in the alliance roster; **no XP ledger replication, no alliance leaderboard**.

### 5.7 `member`, `role.grant`, `role.revoke` (alliance-14, auth-8, auth-9, auth-10)

* `Member` apply (replaces `albion/alliance_fanout.rs::after_successful_link` :111, `after_successful_unlink` :216, `adopt_existing_member_link` :296, `ensure_user_and_link` :526): origin user + Albion links -> target: `identity::upsert_discord_user` (placeholder email `discord-{id}@alliance.local`, real email never copied - auth-12), `AlbionLinkService::create_link` (conflict = compare and update name), `PlatformService::record_membership` (record_membership at platform/service.rs:~1200), `deactivated_at` mirrored. Albion link: declared name, no ownership proof (owner decision). Unlink propagates (target link deleted; target user kept; memberships revoked only by the member-sync subsystem).
* Role effects: `plan_role_effects(user)` (reusing `assign_alliance_roles_on_tenant` :434 and `alliance_hub_role_for_guild` :274) computes the desired set; `role.grant` = Discord REST add (`assign_discord_role`), records `alliance_role_grants` on success; `role.revoke` = REST remove, `404 member not found` = done, `403` = `Blocked{discord_forbidden}`, `5xx/429` = `Retryable` honouring `Retry-After`. This replaces `alliance_role_revocations` rows and the in-request `retry_alliance_role_revocations` (platform/service.rs:1141), now retried by the engine for 20 attempts with backoff.

### 5.8 `membership.backfill`, `membership.detach` -> section 8.

---

## 6. Read-only enforcement and origin info

### 6.1 Guard (`modules/sync/guard.rs`)

```rust
pub async fn assert_writable(db: &impl ConnectionTrait, kind: SyncKind, id: i64) -> Result<(), AppError>; // 1 PK lookup in sync_copies
pub async fn copy_info(db, kind, ids: &[i64]) -> HashMap<i64, CopyInfo>;                                   // batch, 1 query per list
```
* Returns `AppError::ReadOnlyCopy(Box<OriginRef>)` (new variant in `errors.rs`): HTTP **403**, problem `type` `.../sync-copy-read-only`, plus a new optional ProblemDetails field `origin: { tenant_id, tenant_name, tenant_kind, kind, entity_id, path }` (`path` = relative route e.g. `/events/123`; the tenant switch is the client's job). Copies in state `detached` (`read_only=false`) pass.
* Replaces: `lifecycle::assert_manageable_source_event` (lifecycle.rs:28, called ~25 times in events/router.rs: 662, 690, 718, 749, 916, 952, 1235, 1305, 1393, 1425, 1456, 1709, 1761, 1802, 1852, 1897, 1942, 1985, 2030, 2066, 2101, 2137, 2220; the control query per call goes away - it is a tenant-local PK lookup), `SplitService::deny_mutation/assert_mutable` (splits/service.rs:773-796; the `tenant_kind == "alliance"` clause stays only for the alliance-specific rule), the missing checks on builds/comps/warns.
* Exceptions are explicit: a function that changes tenant-local state (voice, Discord ids, thread, XP award, regear on own attributed members, battle link) does not call the guard. A test matrix (12.2) enumerates every mutating route with a copy fixture and asserts 403 + `origin`.
* The roster mutation routes that today return `is_copy` special behavior (router.rs:1897) are unified under the guard.

### 6.2 Origin info in API DTOs

Every entity view gets `sync: SyncInfo` (utoipa schema, optional/`null` for non-synced):

```json
"sync": {
  "role": "origin" | "copy",
  "read_only": true,
  "state": "ok" | "pending" | "failed" | "blocked" | "detached",
  "origin": { "tenant_id": "...", "tenant_name": "Alliance X", "tenant_kind": "alliance", "entity_id": 123, "path": "/events/123" },
  "synced_at": "2026-11-05T12:00:00Z",
  "targets": { "total": 4, "ok": 3, "pending": 0, "failed": 1 }          // origin only
}
```
Applied to `EventView`/`EventSummary` (events/models.rs; replaces the ad-hoc source backfill in router.rs:127-190 `backfill_source_identity`), comps/builds views, `SplitSummary/SplitDetail` (`origin_read_only` kept), warn and regear views. Lists load it with one batched `copy_info(kind, ids)` + one batched aggregate over `sync_jobs` for origin rows (no N+1).

---

## 7. Status and retry API (`modules/sync/router.rs`, mounted under `/api/sync`)

Auth: normal tenant extractor (web cookie or `X-Bot-Secret` for the bot). Permissions: `sync.view` (read), `sync.manage` (retry/resync); entity-scoped routes also accept the entity's own management authority (e.g. event manager). Tenant scoping: only jobs where `origin_tenant_id` or `target_tenant_id` = caller tenant.

| Route | Purpose |
|---|---|
| `GET /api/sync/status?entity=event:123` | per-entity status (below) |
| `GET /api/sync/summary` | `{ outbox_lag_s, counts: {kind: {pending, retry, failed(exhausted), blocked}}, oldest_pending_age_s }` for nav badge / bot `/sync` |
| `GET /api/sync/jobs?state=retry,exhausted,blocked&kind=&entity=&limit=50&cursor=` | attention list (keyset by `seq`) |
| `POST /api/sync/jobs/{id}/retry` | re-arm one job (`exhausted|blocked|retry` -> `pending`, attempts=0) |
| `POST /api/sync/retry` `{ "entity": "event:123", "target_tenant_id": "optional" }` | re-arm all non-done jobs of an entity |
| `POST /api/sync/resync` `{ "entity": "event:123", "target_tenant_id": "optional" }` | enqueue fresh `upsert` (repair after out-of-band divergence) |
| `GET /api/alliances/{id}/sync/members` | per guild: `sync_state`, backfill progress, counts by state/kind |
| `POST /api/alliances/{id}/members/{guild_tenant_id}/expel` | alliance owner (`alliance.manage_members`) |
| `POST /api/alliances/{id}/members/{guild_tenant_id}/backfill` | re-run backfill (idempotent) |

`GET /api/sync/status` response:

```json
{
  "entity": { "kind": "event", "id": 123, "role": "origin" },
  "origin": null,
  "state": "failed",
  "targets": [
    { "tenant_id": "g1", "tenant_name": "Guild One", "tenant_kind": "guild", "target_id": 55,
      "state": "ok", "synced_version": 9012, "last_synced_at": "..." },
    { "tenant_id": "g2", "tenant_name": "Guild Two", "tenant_kind": "guild", "target_id": null,
      "state": "exhausted", "job_id": "uuid", "attempts": 12, "max_attempts": 12,
      "error_class": "permanent", "last_error": "...", "next_attempt_at": null }
  ],
  "inbound": [ { "kind": "participation.command", "discord_id": "...", "state": "retry", "attempts": 2 } ]
}
```
For a copy: `entity.role='copy'`, `origin` filled, `targets=[]`, `inbound` lists pending commands. Aggregation: `ok` = link active and no non-terminal job; `pending` = job pending/processing/retry; `failed` = `exhausted`; `blocked` = `blocked`; `detached` = link detached.

Compatibility adapters for one release (slice 3-8): `GET /api/events/{id}/fanout-status`, `GET /api/events/{id}/mirror-status`, `POST /api/events/{id}/mirror-retry` (events/router.rs:195-197, 1157-1241) map onto the same data/shape; no client calls them today (parity-5), so removal in slice 9 is safe. Bot gets `/sync status|retry` through the same routes (command added by the parity subsystem).

---

## 8. Membership lifecycle (alliance-11, alliance-12, alliance-7, auth-9, auth-10)

### 8.1 Join -> backfill

In `PlatformService::accept_alliance_membership` (platform/service.rs:871) and the activation branches of `register_alliance_tenant` (:294) / `configure_alliance_setup` (:700): in the **same control txn** as the status flip insert one job `kind='membership.backfill', op='scan', flow='to_copy', origin=alliance, target=guild, ordering_key='membership:{alliance}:{guild}', priority=8, payload={phase:0, cursor:null}`, and set `alliance_memberships.sync_state='backfilling'`.

Handler (resumable scan, lease 5 min, heartbeat per page, re-enqueues itself with the new cursor until all phases finish):
1. Phase order (live data first): `Event` (non-terminal alliance events -> guild; non-terminal guild events with `ping_alliance` of *other* guilds -> this guild; this guild's own `ping_alliance` events -> alliance and siblings) -> `Build`/`Comp` (alliance -> guild; guild -> alliance) -> `Split` (non-archived, event-linked) -> `Member` (guild users with links -> alliance; alliance users matching this guild's Albion id -> guild) -> `Warn` (non-revoked) -> role reconcile.
2. Each phase calls `Handler::backfill_scan(scope, cursor)` which returns a page of origin ids; the scan job bulk-inserts child state jobs (`INSERT ... SELECT`, 500 per page, priority 8) and advances the cursor. Child jobs are ordinary jobs, so failures are individually visible and retriable.
3. Done -> `sync_state='ready'`. Idempotent: re-running (`POST .../backfill`) only inserts jobs whose link is missing/stale.

Rejoin of the same alliance reattaches existing detached links (same mapping rows): copies archived by detach are restored when the origin is non-terminal; no duplicates. Joining a *different* alliance never touches old links (target tenant differs), which resolves alliance-7 by construction (the old `find_share` ignored `alliance_tenant_id`).

### 8.2 Leave / expel -> detach

`mark_alliance_left` (platform/service.rs:1046) is rewritten (leave) and a sibling `expel_alliance_member` is added (alliance owner; `status='expelled'`, `left_reason='expelled'`). In **one control txn**:
1. `alliance_memberships.status = 'left'|'expelled'`, `left_at`, `sync_state='detaching'`.
2. `UPDATE sync_links SET state='detached', detach_reason=$reason WHERE state='active' AND ((origin=guild AND target IN (alliance, siblings)) OR (target=guild AND origin IN (alliance, siblings)))` - replaces `UPDATE event_sync_links SET sync_enabled=false` (:1075). From this instant `targets()`/relay stop producing jobs for that pair and the membership re-check in handlers returns `Inactive`.
3. Cancel pending state jobs for the pair (`state='cancelled'`); command jobs from/to the pair become `inactive`.
4. Insert `membership.detach` scan job + one `role.revoke` effect job per `alliance_role_grants` row (replacing `alliance_role_revocations` inserts; untracked roles become `blocked` jobs with the existing "ambiguous" message).

`detach` handler (per kind, "archive future, keep history", mirrors both sides):
* Guild side (copies originating from alliance/siblings): scheduled (not started) events -> `archived_at=now`, `sync_copies.state='archived_by_detach'`; live events -> left running, detached; terminal events -> detached (history kept). Detached rows get `read_only=false` and become ordinary local records (builds/comps stay usable by the guild's local events). Attributed participants of departing guild on *alliance-origin* events keep their rows with `attribution_state` surfaced as `guild_left` in the roster response (officers must re-attribute or remove before payout; the existing preflight message remains).
* Alliance side (copies originating from the guild): future events archived; builds/comps/splits/warns/members copies set `archived_at` (hidden from lists, readable by id, history kept) and detached. Split copies' financial data therefore stops showing in alliance lists (alliance-12 data leak).
* Open split payout batches targeting the guild: remaining items -> `blocked{guild_left}` (visible, explicit).
* Discord: role revoke jobs run through the engine (5.7); the existing grant table remains the source of truth.
* Finally `sync_state='detached'`.

### 8.3 Expel and re-invite

Alliance-side `expel` uses the same transaction; a re-invite later flips `left|expelled -> pending -> active` through `invite_alliance_membership` (:828) / `accept_alliance_membership` and runs the backfill path (reattach).

### 8.4 Ongoing membership drift

`Member` and role reconciliation (6.4) also covers: guild joins the Albion alliance after the Discord membership exists, hub-role changes (`set_alliance_member_discord_role` :910 emits a `role` reconcile), new member-guild role configuration.

---

## 9. Migration and removal of the four mechanisms

One idempotent boot task `sync::legacy_import::run` (advisory lock, markers in `sync_legacy_import`, resumable, logged), executed **before** the engine loops start; each step is a SQL or per-tenant Rust pass.

| Legacy | Imported into | Rule | Removed in |
|---|---|---|---|
| `event_sync_links` (control; m20260918, `sync_enabled` m20261028) | `sync_links` kind `event`, `event_roster` | origin=(source_tenant, source_event_id), target=(mirror_tenant, mirror_event_id); `state = sync_enabled ? 'active' : 'detached'`; tenant side: `sync_copies(kind='event', local_id=mirror_event_id, read_only = sync_enabled)` created per tenant via the registry. | slice 9 |
| `event_fanout_assets` (job-scoped comp/build maps, m20261030) | `sync_links` kind `build`/`comp` | origin=(source tenant of the job, source_id), target=(tenant_id, destination_id); when several jobs map the same `(origin, target)` pick the **latest job** (`ORDER BY j.created_at DESC`) as canonical. Destination builds pointed to only by older jobs (duplicates from alliance-1) and referenced by nothing (`comp_builds`, `event_roster_roles`, `event_participations`, `event_roster_assignments`) are archived by a `legacy_dedupe` pass, never deleted. Referenced duplicates are reported in a `sync_legacy_report` log line for manual merge. | slice 9 |
| `alliance_shares` (build/comp/split; m20260908_000009) | `sync_links` kind `build`/`comp`/`split`, origin=(source_tenant_id, source_id), target=(alliance_tenant_id, published_id) | If `published_id` no longer exists in the alliance schema or `alliance_tenant_id` differs from the guild's current active membership -> row skipped / `detached` (alliance-7 stale rows). Alliance-side `sync_copies(read_only=true)` created for each; `splits.origin_read_only` already marks the split copies. | slice 9 |
| `event_fanout_jobs/targets` in `pending|failed|processing` | `sync_jobs` kind `event`, `op` from `operation`, `attempts` preserved, `max_attempts=12` | `complete|inactive` rows are dropped (state is reflected by links). | slice 9 |
| `event_mirror_requests` `pending|failed|processing` | `sync_jobs` kind `event`, origin guild | `complete`/`inactive` rows dropped (link exists / event no longer shared). | slice 9 |
| `event_participant_attributions` | `event_participations.attributed_guild_tenant_id` (origin tenant) | 5.3 | slice 9 |
| `alliance_role_grants` | kept as-is (source of truth for revokes) | - | kept |
| `alliance_role_revocations` | `sync_jobs` kind `role.revoke` (`pending`->`pending`, `ambiguous`->`blocked`, `verified` dropped) | - | slice 9 |
| `alliance_split_distribution_batches/items` | kept (domain ledger of the payout); `processing|failed` batches get one `split.payout` job per guild | add `sync_job_id` on items | kept |
| `/register` one-shot (`albion/alliance_fanout.rs`: `after_successful_link`, `after_successful_unlink`, `adopt_existing_member_link`, `assign_alliance_roles_on_tenant`, `record_assigned_alliance_roles`) | replaced by `Member` emit in `AlbionLinkService` + `role.*` effect jobs; helper functions (`plan_register_fanout`, `home_guild_tenant_id`, `alliance_hub_role_for_guild`, `shares_albion_alliance`) are **kept and reused** by the handler | one-time backfill via membership backfill for every active member | slice 9 (delete the swallow-all-errors hooks) |

Code deleted in slice 9: `events/fanout_outbox.rs`, `events/fanout_worker.rs`, `events/mirror_retry.rs`, `events/sync.rs` (`create_mirror`, `sync_participation`, `linked_event_peers`, `map_build`, `canonical_event_origin`, `is_mirror_event`; `peer_events` unit tests move to `sync::policy` tests), `events/lifecycle.rs::{assert_manageable_source_event, converge_copy_to_source, sync_owner_change_to_copies, operation_key}`, `alliance_share/service.rs` copy functions (kept as `sync::handlers::{build,comp,split}` internals), control migrations stay (history) with a final `m2026..._drop_legacy_sync_tables` migration, `events.alliance_discord_message_id` column after the bot stops using it (bot-side, other subsystem), the `ping_alliance` direct post in the bot poller (alliance-8; bot subsystem).

Rollout is staged per kind (slices 2-8): each slice moves one kind to the engine, flips its legacy producers off in the same PR, and imports its legacy rows at boot. No dual-write period is required because every slice owns both the producer switch and the import; the kill-switch (`SYNC_KINDS_DISABLED`) pauses a kind without code change.

Cutover note for `alliance-3`: before the first reconcile on events, a one-off `lifecycle_catchup` stops alliance origin events that are `live` past `auto_stop_deadline` (they never auto-stopped because alliances had no worker). Otherwise the first projection would legitimately re-open guild copies that stopped locally.

---

## 10. Known-bug resolution map

| Id | Root cause (today) | Fix in this design |
|---|---|---|
| alliance-1 | build map stored per `job_id` (`event_fanout_assets`, fanout_worker.rs:431-448), every update job re-copies | mapping per entity in `sync_links`; `content_hash` skips no-op; roster roles diffed; test "publish + 2 updates = same build count" |
| alliance-2 | roster-role builds outside comp unmapped (fanout_worker.rs:364-390) | `ensure_copy(Build)` for every roster-role build before roles; link before roles |
| alliance-3 | no alliance worker; converge overwrites terminal status (lifecycle.rs:56-96) | monotonic lifecycle + `lifecycle_epoch`; copies never self-stop; scheduler runs for alliances; origin emits after stop |
| alliance-4 / events-3 | copies call guarded start/voice; 403 loop | copies are never started via API; scheduler acts locally on copy times; guard returns `ReadOnlyCopy` (bot treats it as final, not retryable) |
| alliance-5 / events-6 | officer actions not synced, no attribution | all roster mutations in `mutate_origin` -> `EventRoster` projection; attribution required at add; copy officers get `ReadOnlyCopy` |
| alliance-6 / events-5 | inline cross-tenant sync after commit, error returned | local commit + outbox command; HTTP never waits; pending state visible |
| alliance-7 | `find_share`/`create_mirror` ignore alliance id | link key includes target tenant; detached links never reused across alliances |
| alliance-9 | build/comp/split snapshot, no propagation | `Build`/`Comp`/`Split` emits on every mutation incl. delete/archive; hash refresh |
| alliance-10 | G->A inline converge without retry | same outbox/jobs for both directions |
| alliance-11 / auth-9 | join flips status only | `membership.backfill` scan |
| alliance-12 / auth-10 | leave keeps copies; revokes retried only in request; no expel | `membership.detach`, role jobs in engine, `expel` route |
| alliance-13 / finance-6 | no resume/visibility | per-guild `split.payout` jobs, resume via leases, status in `/api/sync` + existing `GET alliance-distribution` |
| alliance-14 / auth-8 | one-shot, errors swallowed, admin paths skip | `Member` emit in `AlbionLinkService` (all 4 entry points), engine retries, reconcile |
| alliance-16 | unbounded attempts, inline | `max_attempts`, `exhausted`, classification |
| alliance-17 | peers' WebSocket/splits not refreshed | `hub.publish` after every roster/event apply; `finish_copy_session` syncs splits |
| alliance-20 | attribution permanent; slow failure | attribution on participation row; error classes |
| alliance-8 / events-18 | duplicate announcement | one synced alliance event; delivery handled by the delivery outbox (contract) |
| finance-3 | roster sync rewrites closed splits | skip copies/non-pending in `sync_event_participants`; split participants come from projection |
| finance-5 | split snapshot once | `Split` emits on every mutation |
| events-14 | converge skips comp, roles, seats | event + comp + roles + roster all state-converged |
| events-19 | inline fanout + comp recopy | async + hash |

---

## 11. Failure modes

| Failure | Behaviour |
|---|---|
| process crash between domain commit and relay | outbox row survives (same txn); relay resumes |
| crash after control job insert, before `relayed_at` | replay; `dedupe_key` unique makes it a no-op |
| crash in handler after tenant write, before link update | retry: `sync_copies` lookup adopts the existing copy, link repaired; no duplicate |
| lease expiry while still processing | claimant B proceeds; A's finish fails the fence (`Conflict`), result discarded; handlers idempotent |
| target tenant unloadable / pool saturated | `Retryable`; circuit breaker pauses that tenant 60 s |
| origin entity deleted while jobs queued | handler sees missing row -> delete path; or `Superseded` if nothing exists |
| copy deleted manually in target DB | next apply finds `target_id` missing -> `target_missing`, recreate; reconcile also detects |
| membership flips during a job | re-check with `FOR UPDATE` on `alliance_memberships` row; stale job -> `Inactive` |
| two events with same numeric id in different tenants | all keys carry tenant id |
| thundering backfill | priority 8 + 1 scan per alliance + per-tenant semaphore |
| poison job | `exhausted` after cap; visible in `/api/sync/jobs`; does not block other keys |
| roster-version conflict at origin | bounded loop then `Retryable` |
| pending local signup never acknowledged | after `exhausted` the projection keeps the pending row flagged `sync_state='failed'` visible; retry button re-arms |
| Discord REST 429/5xx/403 | honour `Retry-After`; 403 -> `blocked` with actionable message |
| two engines | advisory lock; leases still correct |
| tenant not yet migrated (no `sync_*` tables) | `registry.get_or_load` runs tenant migrations (tenant.rs); relay skips tenants failing load and retries |

---

## 12. Test strategy

### 12.1 Unit (SQLite, in-memory tenant migrator; no Postgres)
* `outbox::emit` coalescing: two emits for one entity in one txn -> one pending row with the higher id; command emits never coalesce; rollback leaves no row; `emit` on a copy entity is a no-op for state kinds.
* `guard::assert_writable`: origin passes, copy (`read_only`) -> `ReadOnlyCopy` carrying origin ref, detached passes; `copy_info` batch.
* Pure functions: `policy::targets` (desired/existing sets; absorbs the `peer_events` tests from events/sync.rs:312), `backoff(attempt)` bounds and jitter, `classify(error)`, `next_state(job, outcome)` transition table (every row of 4.2), `content_hash` canonicalization determinism, `monotonic_status(copy, origin)` truth table (including uncancel with epoch), roster projection merge (`merge_roster(snapshot, local_rows)` keeping newer pending rows), commands ordering (`sync_inbox` skip rule), attribution resolution (move of existing tests from attribution.rs).
* Static check `choke_points_call_emit` (3.2).

### 12.2 Integration (Postgres, `TEST_DATABASE_URL`, `try_admin_db`/`unique_schema` helpers from postgres.rs:176-252; WP0 makes the env var mandatory)
World builder `SyncWorld` generalizing `TestWorld` of events/lifecycle.rs tests and fanout_worker.rs tests: control schema + alliance + 3 guilds (A, G1, G2, G3), memberships, users, Albion links, comps/builds, plus helper `run_until_idle(engine)` (relay + executor to quiescence) and a `failpoint!` macro (cfg(test)) to crash between steps.
* Engine: concurrent claim (two executors, SKIP LOCKED, no double apply), lease expiry + fencing (port `retry_reclaim_fences_the_expired_worker`), per-key ordering (jobs with equal `ordering_key` apply in `seq` order), coalescing (burst of 50 emits -> 1 job, final state converged), relay replay idempotency, crash-matrix via failpoints (after tenant write / before link update; after job insert / before `relayed_at`).
* Convergence property test: random interleavings of origin mutations and executor ticks (seeded) -> after quiescence every copy equals the origin projection (events, roster, build/comp).
* Read-only matrix: for each mutating route of events/roster/build/comp/split/warn on a copy fixture -> 403 with `origin`.
* Migration test: seed legacy tables (`event_sync_links`, `event_fanout_*` with duplicate-build jobs, `alliance_shares`, `event_mirror_requests`, attributions) -> run `legacy_import` twice -> expected `sync_links`, `sync_copies`, jobs, archived duplicates; second run no changes.
* Per-slice acceptance tests in section 13.

### 12.3 Other
* Frontend/bot: no sync logic; specs consume `sync` DTOs (other subsystems). Backend OpenAPI snapshot test includes `SyncInfo`, `ReadOnlyCopy` problem, `/api/sync/*`.
* Load smoke (manual, documented): 500 events x 5 guilds backfill drains in < 5 min with live signups latency p95 < 2 s.

---

## 13. Implementation slices (each one PR, independently mergeable; branch `<type>/<desc>` from `origin/main`)

Order resolves dependencies: foundation -> assets -> events -> roster -> membership -> splits -> secondary domains -> reconciler/UI hooks -> cleanup. Prerequisite for all: WP0 (baseline green, `TEST_DATABASE_URL` mandatory).

**S1 `feat/sync-engine-core`** - tables (2.1/2.2), `modules/sync/{outbox,relay,jobs,engine,error,handler,links,guard,policy}`, `SyncInfo`, `ReadOnlyCopy` error variant, `/api/sync/{status,summary,jobs,retry,resync}`, permissions seed, engine spawn (advisory lock, no handlers registered), kill-switch. No behaviour change.
 Acceptance: unit tests 12.1 (emit, guard, state machine, backoff); Postgres: claim concurrency, lease fencing, ordering, coalescing, relay replay, crash failpoints with a test-only `noop` kind; status API returns targets/errors; `cargo clippy` clean.

**S2 `feat/sync-assets-build-comp`** - `Build`/`Comp` handlers, hash refresh, dependency `ensure_copy`, emits in comps services (3.2), guard in comp/build mutations, `alliance_share` endpoints re-based on the engine, import of `alliance_shares` (build/comp) + `event_fanout_assets` (latest-job rule) + duplicate archiving; `SyncInfo` on build/comp DTOs. Events still use legacy code but its `copy_alliance_comp_to_tenant` calls `ensure_copy` (kills alliance-1 for events before S3).
 Acceptance: edit/archive/delete of an origin build/comp propagates; re-share never duplicates; alliance->guild publish creates read-only copies with parent mapping; copy edits -> 403 + origin ref; migration test with duplicate-build fixture archives only unreferenced duplicates; alliance-7 fixture (guild moves alliance) never writes into the wrong tenant.

**S3 `feat/sync-events`** - `event` handler (5.1), `apply_origin_state` with monotonic lifecycle + `lifecycle_epoch`, scope handling for `ping_alliance` (replaces `create_mirror`), `finish_copy_session` (XP attribution filter), replace `assert_manageable_source_event` everywhere, scheduler skip of copies (`auto_stop.rs`), `lifecycle_catchup`, import of `event_sync_links` and open `event_fanout_*`/`event_mirror_requests` rows, legacy `fanout-status/mirror-status/mirror-retry` adapters, retire `fanout_worker`/`mirror_retry` loops (code deleted in S9).
 Acceptance: publish + 2 updates -> same build/comp count in each guild; roster-role build outside comp copies once and links before roles; auto-stop of an alliance origin event stops all copies and a later update never reopens them; uncancel (epoch) reopens; `ping_alliance` false retires the alliance copy and sibling copies; guild leaves mid-job -> `inactive`, no copy created; failed target visible and retriable via `/api/sync/retry`; flash event shares; legacy rows imported without duplicates.

**S4 `feat/sync-roster-participation`** - participation commands, `EventRoster` projection, officer actions through `mutate_origin`, attribution column + import, `hub.publish` on peers, XP attribution filter, retry of completion XP for alliance tenants, notification on rejection, `PUT /events/{id}/participants/{user_id}/attribution`.
 Acceptance: signup on a guild copy shows immediately (`pending`), peer down -> success returned, later converges; origin reject -> pending row removed + notification; officer add/set/remove/seat swap on origin appear on all copies (WebSocket message observed on the copy room); officer action on a copy -> `ReadOnlyCopy`; leave then re-join with a different eligible guild works; XP only to participants attributed to the guild owning the copy; duplicate/out-of-order commands idempotent (`sync_inbox`).

**S5 `feat/sync-membership-lifecycle`** - `membership.backfill`/`detach`, `expel`, `role.grant/revoke` jobs + removal of in-request retry, `Member` handler and emits in all four `AlbionLinkService` entry points (the `ProgressionSummary`, `Warn`, `RegearRequest`, `Split` scanners are registered by their slices), `alliance_memberships` columns, `GET /api/alliances/{id}/sync/members`, import of `alliance_role_revocations`.
 Acceptance: accept -> upcoming alliance events, shared builds/comps, linked users and roles appear in the guild without any user action; leave/expel -> future copies archived on both sides, history kept, links detached, roles revoked with retry through a failing Discord stub; rejoin reattaches (no duplicates); admin link/unlink propagates; backfill resumable after crash (cursor).

**S6 `feat/sync-splits-payout`** - `Split` handler + emits, `split.payout` jobs replacing the loop in `complete()`, resume, `finalize` on last item, ledger `split_id` link, retry route, `GET alliance-distribution` unchanged, skip copies in `sync_event_participants` and non-pending splits.
 Acceptance: kill the process after 1 of 3 guild credits -> restart completes the other two, exactly one credit per recipient; unregistered participant -> job `blocked` with message, fix + retry completes; guild left mid-batch -> `blocked{guild_left}`; split copy shows `completed` in guild; closed splits are not rewritten by roster sync.

**S7 `feat/sync-warns-regear-progression`** - `Warn`, `RegearRequest`, `ProgressionSummary` handlers, `member_standing`, escalation count exclusion.
 Acceptance: warn issued in guild appears in alliance read-only, revoke propagates, copy warns do not trigger escalation; alliance warn reaches the member's home guild; decided regear requests visible in alliance; rank change appears debounced; no XP leaderboard route exists in alliance tenants.

**S8 `feat/sync-reconciler`** - reconcile loop (watermark scan per kind via `Handler::watermark`, orphan-copy detection, member/role drift, link/copy mismatch repair), maintenance purges, metrics, `/api/sync/summary` outbox lag, bot/web read-only integration points documented (consumers are other subsystems).
 Acceptance: a deliberately dropped job/emit (simulated by deleting the outbox row) is repaired within one reconcile; manually deleted copy recreated; orphan copy with missing origin archived; Albion-alliance change adjusts roles via jobs; purge keeps terminal jobs 30 d.

**S9 `chore/remove-legacy-sync`** - delete `fanout_outbox.rs`, `fanout_worker.rs`, `mirror_retry.rs`, legacy parts of `events/sync.rs`/`lifecycle.rs`/`alliance_share/service.rs`/`albion/alliance_fanout.rs`, drop legacy tables via a final control migration (`event_sync_links`, `event_fanout_*`, `event_mirror_requests`, `alliance_shares`, `event_participant_attributions`, `alliance_role_revocations`), drop `events.source_*` writes/`splits.origin_read_only` writes when no reader remains, remove legacy endpoints.
 Acceptance: `cargo check`, full test suite, grep for removed symbols empty, migration down/up on a snapshot of production-like data keeps all `sync_links` counts.

---

## 14. Integration contracts with other subsystems (not designed here)

* **Backend lifecycle scheduler**: runs for guild and alliance tenants, skips `sync_copies` rows, calls service functions that emit (`start_event`, `stop_event_with_xp_policy`, mass/remind effects). `event_sessions::spawn` (event_sessions/mod.rs:41) must also run `retry_pending_event_completion_xp` for alliance tenants (`starts_sync_workers`, tenant.rs:84, currently excludes alliances).
* **Discord delivery outbox**: engine calls `delivery::enqueue(tenant, EntityRef, reason)` after each event/split copy apply and after terminal transitions; engine passes `via = origin_kind`. Announcement of a guild-origin shared event: exactly once on the alliance Discord (alliance copy uses the alliance delivery settings); sibling guild copies use the guild's `discord_event_delivery` setting. The legacy `ping_alliance` direct post and `alliance_discord_message_id` are removed there.
* **Member sync / onboarding**: `GuildMemberAdd/Remove/Update` -> `POST /api/members/sync` calls the same `identity::upsert_discord_user`, sets `users.deactivated_at`, and emits `Member`; the engine only consumes that.
* **Action descriptors**: `GET .../actions` includes `read_only_copy` + `origin` reason from `guard`; web/bot render a link to `origin.path` in the origin tenant.
* **Finance**: split permission model (creator + manage permission) lives in splits; the engine only emits after those mutations; `outflow_other` exclusion for payout credits.

### Assumptions the design makes where the settled decisions leave room (cheap to change)
1. Guild-origin events that are not `ping_alliance` stay private (never auto-shared); builds/comps/splits/warns/members of guilds sync to the alliance automatically.
2. Warn copies are informational (do not count toward the copy tenant's escalation threshold).
3. On leave/expel, in-progress (`live`) copies are detached rather than archived so attendance/XP are not lost; only not-yet-started copies are archived.
4. Roster visibility: every copy shows the full canonical roster (all guilds), not only its own members.
5. `progression.summary` carries level and guild rank only (no XP totals).
