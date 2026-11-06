# Design: backend-driven Discord delivery (bindings, outbox, scheduler, stateless bot)

Subsystem owner scope: `discord_bindings`, `discord_outbox` with leases, SSE stream + polling fallback, ack/fail,
backend event scheduler (mass / start / 1h reminder / auto-stop) for guild AND alliance tenants, voice channel
provisioning as an effect, announcements on the alliance Discord, DM consumer, giveaway / battle posting, bot
reduced to a stateless executor, migration off `poller-state-<guild>.json`, removal of `Poller` /
`listSinceCheckpoint`.

Paths are relative to the repo root (`apps/backend/src/...`, `apps/discord-bot/src/...`). Line numbers refer to the
tree at `f7f60e44` (worktree `p5c46fnark18`). Nothing here depends on the `fix/bot-poller-hotfix` branch (section 13.6).

Settled owner decisions this design relies on (not re-opened): origin tenant owns each record, copies are read-only
and follow the origin; alliance owns canonical roster; scheduling is decided by the BACKEND for guild and alliance
tenants, effects reach the bot through a persistent outbox, the bot only executes; web and Discord start/stop produce
identical effects; `ping_alliance` legacy direct post is dropped (a guild event with `ping_alliance` becomes a
synchronized alliance event owned by the guild, announced once on the alliance Discord by the alliance tenant's own
delivery); XP only at guild level; frontend keeps SSR.

---

## 0. Decisions in one page

| # | Decision | Why |
|---|---|---|
| D1 | `discord_outbox` and `discord_bindings` live in the **tenant schema** (one pair per guild/alliance tenant). A small control-plane table tracks bot instances and per-tenant delivery mode. | The effect must commit in the SAME transaction as the domain change (`stop_event_with_xp_policy` already opens a tenant txn, `service.rs:4007`). A control-plane outbox cannot share that txn, and cross-schema writes break SQLite unit tests. Schema-per-tenant isolation is preserved. |
| D2 | Effects are **thin intents** (`kind`, `entity`, small `payload`), never rendered state. The bot fetches current state from `GET /api/bot/render/...` at execution time and converges Discord to it. | Coalescing, out-of-order delivery and long bot downtime all become safe: executing a stale intent renders current state. Also removes the bot `SettingsService` 60 s cache from the delivery path (routes are in the render payload). |
| D3 | Delivery is **at-least-once with fenced leases**. Non-idempotent Discord creates are made safe by (a) binding rows written as `creating` BEFORE the create and checkpointed after each Discord call, (b) a `verify` step on any retry of a lease that already ran (`recovering=true`). | Replaces `pendingAnnounces`/`ambiguous` in the JSON file with backend state. |
| D4 | Transport: bot opens ONE SSE stream (`GET /api/bot/outbox/stream`) for all its guilds; the server claims on the bot's behalf and pushes leased items. Fallback: `POST /api/bot/outbox/claim` every 10 s. Both call the same `claim_due`. `Last-Event-ID` is accepted but NOT needed for correctness (replay is lease-based; section 6.4). | Deviation from the plan text ("resumable with `Last-Event-ID`"): with leases keyed by a stable `instance_id`, reconnect re-sends that instance's still-leased items; an event-id cursor would add a second source of truth. |
| D5 | **One scheduler loop** (`discord_delivery::scheduler`), global, iterating active tenants of kind `guild` and `alliance`, 5 s tick, independent of Albion scope. Safe for multiple replicas by conditional `UPDATE` + `once_key`, no leader election. | Today the lifecycle worker only starts for non-alliance tenants (`tenant.rs:84`) and only when an Albion scope exists (`event_sessions/mod.rs:prepare_cycle`). |
| D6 | **One choke point** for event status transitions: `lifecycle::transition(txn, event_id, Transition, Cause)` returns the emitted effect list. `start_event`, `stop_event_with_xp_policy`, `cancel_event`, `uncancel_event`, `archive/unarchive`, scheduler, and `converge_copy_to_source` all call it. | "Web and Discord start/stop produce identical effects" becomes a property tested on one function. |
| D7 | Copies (rows with `events.source_tenant_id IS NOT NULL`) follow the origin for **status**, but own **local effects** (mass notice, 1h reminder, voice, thread, card). The copy's scheduler never changes copy status. | Fixes alliance-3/4 (copy mass/start 403 loop): no `POST /start` on copies ever happens; start arrives through converge and emits the copy's local `event.start` effect. |
| D8 | The alliance Discord is just another tenant: a synchronized alliance copy emits `event.upsert` in the alliance tenant's outbox. No cross-tenant outbox items, no `alliance_discord_message_id`, no `postAllianceAnnouncement/Lifecycle`. | Single announcement per Discord by construction (alliance-8, events-18). |
| D9 | Rollout is per-tenant gated by `tenants.discord_delivery_mode` = `off \| shadow \| on`. `on` is set by the import step (section 13). Scheduler and claimability are gated by it. | Poller and scheduler must never both transition events (a backend auto-start would hide the event from the poller's `status === "scheduled"` filter and voice would never be created). |
| D10 | Voice-empty auto-stop becomes a backend rule fed by bot **signals** (`POST /api/bot/signals`), evaluated only for origin events and only when the signal is fresh. | The decision moves to the backend; Discord voice state remains Discord-only knowledge. |

---

## 1. Current state this replaces (grounded)

### 1.1 Bot side: everything is `Poller` (`apps/discord-bot/src/services/poller.ts`, 2254 lines)

- One `Poller` per guild created by `PollerManager.ensure` (`poller-manager.ts:105-122`); wired in `index.ts:207-321`.
  `poll()` (`poller.ts:476-513`) runs ~12 sequential steps every `POLL_INTERVAL_MS` (60 s) behind a `polling` flag;
  `pollNow()` (`:472`) silently no-ops when a poll is in flight (used by `commands/event-create.ts:112`,
  `handlers/modal.ts:161`, `handlers/button.ts:503`, `services/event-thread-command.ts:103`).
- State is `PollerState` (`:87-143`) in `poller-state-<guild>.json`, written with a plain `writeFileSync`
  (`:329-336`): `lastEventId`, `lastBattleId`, `lastGiveawayId`, `pinged1hEvents`, `massedEvents`, `eventThreadIds`,
  `eventParentMessageIds`, `eventSignupMessageIds`, `eventSignupRevisions`, `eventCalendarMessageIds`,
  `eventCalendarFingerprints`, `pendingAnnounces`, `archivedEventIds`, `splitUpdatedAt/splitAfterId`,
  `emptyLiveChecks`, `occupiedLiveEvents`, `lastVoiceSweepAt`, `postedGiveawayIds`, `announcedGiveawayDraws`,
  `applicationsOpen`, `initialized`.
- Discovery by list-and-diff: `listSinceCheckpoint` (`:751-782`, up to 50 pages/tick/tenant) feeding
  `checkNewEvents` (`:784`), `checkNewBattles` (`:2022`), `checkNewGiveaways` (`:2064`).
- Lifecycle decided by the bot: `checkEventLifecycle` (`:1715-1786`) reads page 1 of `GET /api/events` (50 rows, newest
  first), decides mass/start (`massedEvents`), voice-empty stop (`nextEmptyLiveVoiceCheck`, `event-lifecycle.ts:36-52`),
  `checkUpcomingEvents` (`:1945-2020`) reads page 1 / 20 rows for the 1h ping. Voice is created in the bot
  (`createAndBindVoice`, `event-lifecycle.ts:121-139`) and bound with `PUT /api/events/{id}/discord-voice-channel`.
- Alliance double path: `postAllianceAnnouncement` (`:2163-2188`) / `postAllianceLifecycle` (`:2190-2205`) post from
  the GUILD's poller into the alliance channel using `ping_alliance`, `alliance_discord_channel_id`,
  `alliance_discord_message_id`, `origin_guild_id` (`models.rs:273,281,691`; `service.rs:323-380`; `embeds/event.embed.ts:61-76`).
- Splits: `checkSplitSync` (`:1907`) + `SplitForumAdapter` (`split-forum.ts`) with backend cursors in
  `split_discord_sync` (`migration/m20260831_000005`, `splits/entities.rs:196-214`, `splits/discord_sync.rs`).
- VOD posts: claim -> create -> record with `attempted` meaning "never retry" (`poller.ts:515-600`,
  `events/router.rs:204-216`).
- Other channels owned by the poller: calendar pages (`:1167-1356`), application panel (`:701-750`), giveaways
  (`:2064-2153`), battles (`:2022-2062`).

### 1.2 Backend side

- Lifecycle functions only mutate rows: `EventService::start_event` (`service.rs:3948`), `stop_event_with_xp_policy`
  (`:4007`), `cancel_event` (`:3873`), `uncancel_event` (`:3909`), `bind_event_voice_channel` (`:3792`),
  `clear_event_voice_channel` (`:3839`). Routes `events/router.rs:225-270`. `remind_event` (`router.rs:1843`) validates
  and audits only; the actual ping is bot-side.
- `event_sessions::spawn` (`event_sessions/mod.rs:40`) per tenant, 30 s: XP retry, `auto_stop_expired_sessions`
  (`auto_stop.rs:25`), `GiveawayService::draw_due` (skipped when the Albion scope is missing, finance-9), battle
  linker. Not started for alliances (`tenant.rs:84`; `lib.rs:119-127`).
- Reusable patterns already in the repo: lease + fence token in `events/fanout_outbox.rs` (`claim_due` at `:138`
  with `FOR UPDATE ... SKIP LOCKED`, `lease_token`), backoff in `events/mirror_retry.rs:223` (`15 * 2^n`, cap 3600),
  global worker `events/fanout_worker.rs:32` spawned from `lib.rs:118`, bot auth by `BotSecret` (`auth/rbac.rs:386`),
  tenant selection by `X-Guild-Id` for bot requests (`tenant.rs:571-633`), `skip_tenant_resolution` (`tenant.rs:435`).
- `notifications.discord_dm_status = 'pending'` is written (`notifications/service.rs:267`) and never consumed (members-1).

---

## 2. Architecture

```
                 web / Discord command / scheduler / sync engine converge
                                  |
                        lifecycle::transition(txn, ...)          (one choke point, D6)
                                  |   same tenant txn
              +-------------------+---------------------+
              | events row        | discord_outbox rows | (+ pg_notify('discord_outbox', schema) on commit)
              +-------------------+---------------------+
                                  |
                      OutboxHub (in-process)  <---- PgListener  (+ 30 s safety sweep)
                                  |  wake(tenant)
                 per bot instance |  claim_due(tenant dbs, instance_id, lease)
                                  v
          SSE  GET /api/bot/outbox/stream   or   POST /api/bot/outbox/claim (fallback)
                                  |
                           +------v-------+
                           |  discord-bot |  Dispatcher -> reducer per kind -> Discord
                           +------+-------+
                 PUT bindings (checkpoints) / POST ack / POST fail / POST signals
                                  |
                       backend applies result in ONE txn:
                       outbox state, bindings, events.discord_voice_channel_id, notifications.discord_dm_status
```

Components (backend, new crate-level module `apps/backend/src/discord_delivery/`, sibling of `event_sessions/`):

| File | Responsibility |
|---|---|
| `mod.rs` | `spawn(control, registry, hub)` for scheduler + reconcile + janitor; re-exports `emit`, `EffectKind`. |
| `kinds.rs` | `EffectKind`, `EntityType`, payload structs, per-kind policy (class, priority, supersedes, coalesce key, expiry, max_attempts). Single table, unit-tested. |
| `outbox.rs` | `emit`, `claim_due`, `ack`, `fail`, `extend`, `reclaim_expired`, `supersede`, `rearm`, `purge`. Raw SQL (portable subset) like `fanout_outbox.rs`. |
| `bindings.rs` | upsert/get/list, state machine (`creating -> active -> closed/deleted`), import. |
| `hub.rs` | `OutboxHub` (instances, dirty set, `pg_notify` listener, SSE fan-out). |
| `router.rs` | `/api/bot/*` (bot) and `/api/discord/*` (web admin) routers. |
| `render.rs` | `render_event`, `render_calendar`, `render_split`, `render_giveaway`, `render_battle`, `render_notification`, `render_application_panel`, fingerprints. |
| `scheduler.rs` | pure `plan(now, snapshot) -> Vec<Action>` + `run_tick` applying actions. |
| `reconcile.rs` | fingerprint drift sweep, settings-change re-arm, cutover seeding. |
| `signals.rs` | voice observations, freshness rules. |

Control-plane stays minimal: `discord_bot_instances` and `tenants.discord_delivery_mode`.

---

## 3. Data model

Conventions: tenant migrations in `apps/backend/src/migration/` use the sea-query builder and must stay SQLite-safe
(**one `alter_table` per column**, the exact defect of `m20261028_000003` in WP0). JSON is stored as `TEXT`
(portable; parsed in Rust). Partial indexes use `execute_unprepared` (both PG and SQLite support `CREATE UNIQUE INDEX
... WHERE`). Control migrations in `apps/backend/src/control_migration/` are Postgres-only like their neighbours.

### 3.1 Tenant schema (new migration `m20261107_000001_create_discord_delivery.rs`, plus `_000002`..`_000004` for the column adds)

```sql
-- binding: where an entity lives on Discord. The ONLY place Discord ids are stored.
CREATE TABLE discord_bindings (
  id                  BIGSERIAL PRIMARY KEY,              -- INTEGER PRIMARY KEY AUTOINCREMENT on SQLite
  entity_type         VARCHAR(24)  NOT NULL,              -- event|split|giveaway|calendar|vod|application_panel|battle
  entity_id           BIGINT       NOT NULL,              -- 0 for tenant singletons (application_panel)
  slot                VARCHAR(32)  NOT NULL DEFAULT '',   -- event: announcement|voice|forum ; calendar: p0,p1.. keyed by channel
  state               VARCHAR(16)  NOT NULL DEFAULT 'active',  -- creating|active|closed|deleted
  channel_id          VARCHAR(32),                        -- parent channel / forum / voice channel
  message_id          VARCHAR(32),                        -- primary message (announcement parent, split summary, giveaway post)
  thread_id           VARCHAR(32),
  card_message_id     VARCHAR(32),                        -- signup card inside the event thread
  extra               TEXT NOT NULL DEFAULT '{}',         -- kind-specific JSON (calendar page ids/fingerprints, forum tag ids)
  applied_fingerprint VARCHAR(80),                        -- fingerprint of the render the bot last applied
  applied_at          TIMESTAMPTZ,
  nonce               VARCHAR(40),                        -- set while state='creating' (verify-before-retry key)
  creating_since      TIMESTAMPTZ,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, slot)
);
CREATE UNIQUE INDEX uq_discord_bindings_thread ON discord_bindings (thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX ix_discord_bindings_state ON discord_bindings (entity_type, state);

CREATE TABLE discord_outbox (
  id            BIGSERIAL PRIMARY KEY,                    -- per-tenant monotonic; also the per-entity ordering key
  kind          VARCHAR(32)  NOT NULL,                    -- see section 4
  entity_type   VARCHAR(24)  NOT NULL,
  entity_id     BIGINT       NOT NULL,
  payload       TEXT         NOT NULL DEFAULT '{}',       -- small JSON; never rendered state
  fingerprint   VARCHAR(80),                              -- entity fingerprint at emit time (diagnostics + drift sweep)
  cause         VARCHAR(32)  NOT NULL,                    -- web|discord|scheduler|sync|settings|reconcile|import|manual
  actor_user_id BIGINT,
  state         VARCHAR(12)  NOT NULL DEFAULT 'pending',  -- pending|leased|done|skipped|failed|ambiguous|superseded
  priority      SMALLINT     NOT NULL DEFAULT 50,
  available_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),      -- not-before (flash undo window, debounce, backoff)
  expires_at    TIMESTAMPTZ,                              -- past this, pending -> skipped('expired')
  coalesce_key  VARCHAR(80),                              -- unique while pending
  once_key      VARCHAR(80),                              -- unique forever (idempotent one-shots)
  attempts      INTEGER      NOT NULL DEFAULT 0,
  max_attempts  INTEGER      NOT NULL DEFAULT 8,
  lease_token   UUID,                                     -- TEXT on SQLite
  lease_until   TIMESTAMPTZ,
  leased_by     VARCHAR(64),                              -- bot instance_id
  recovering    BOOLEAN      NOT NULL DEFAULT FALSE,      -- set when a lease expired after at least one execution
  last_error    TEXT,
  last_error_class VARCHAR(16),                           -- retryable|config|permission|gone|ambiguous|fatal|expired|manual
  last_error_code  VARCHAR(32),                           -- e.g. discord:50013, unconfigured:events_channel
  result        TEXT,                                     -- JSON returned by the reducer on done (ids, flags)
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  done_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_outbox_once     ON discord_outbox (once_key)     WHERE once_key IS NOT NULL;
CREATE UNIQUE INDEX uq_outbox_coalesce ON discord_outbox (coalesce_key) WHERE coalesce_key IS NOT NULL AND state = 'pending';
CREATE INDEX ix_outbox_claim  ON discord_outbox (priority DESC, id) WHERE state IN ('pending','leased');
CREATE INDEX ix_outbox_entity ON discord_outbox (entity_type, entity_id, id);
CREATE INDEX ix_outbox_lease  ON discord_outbox (lease_until) WHERE state = 'leased';

-- singleton per tenant: cutover + import bookkeeping
CREATE TABLE discord_delivery_state (
  id               SMALLINT PRIMARY KEY CHECK (id = 1),
  cutover_at       TIMESTAMPTZ,       -- events created before this are never announced with a role ping
  imported_at      TIMESTAMPTZ,       -- poller-state import completed
  import_source    VARCHAR(64),       -- 'poller-state-<guild>.json sha256:...'
  battle_floor_id  BIGINT NOT NULL DEFAULT 0,  -- battles with id <= floor are never announced (seeded from lastBattleId)
  last_reconcile_at TIMESTAMPTZ
);

-- voice presence as reported by the bot (section 9.3)
CREATE TABLE event_voice_presence (
  event_id         BIGINT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  channel_id       VARCHAR(32) NOT NULL,
  occupants        INTEGER NOT NULL,
  seen_occupied    BOOLEAN NOT NULL DEFAULT FALSE,
  empty_since      TIMESTAMPTZ,
  last_observed_at TIMESTAMPTZ NOT NULL
);
```

Column adds (each its own migration step, SQLite-safe):

- `events.mass_notified_at TIMESTAMPTZ NULL`, `events.reminder_notified_at TIMESTAMPTZ NULL`. These make "due" queries
  indexable and web-visible, replace `massedEvents` / `pinged1hEvents`, and are tenant-local (never overwritten by
  `converge_copy_to_source`, `lifecycle.rs:56-96`, the same way the voice channel is not).
- Partial index `ix_events_sched ON events (status, start_time_utc) WHERE archived_at IS NULL AND status IN ('scheduled','live')`.

Why `once_key` AND the `*_notified_at` columns: the column is the queryable truth for the scheduler; `once_key` is the
belt-and-braces guard when two replicas race and when a transition is replayed by `converge`.

Data migrated inside the same tenant migration (pure SQL, no bot needed):

- `split_discord_sync(thread_id, summary_message_id)` -> `discord_bindings(entity_type='split', entity_id=split_id, slot='', state='active', channel_id=NULL)`. `last_audit_id` / `last_transaction_id` are NOT copied (cursors die, section 11.3). Old table kept read-only until slice 10.
- `giveaways(discord_channel_id, discord_message_id)` -> `discord_bindings(entity_type='giveaway', ...)`.
- `events.vod_forum_thread_id` -> `discord_bindings(entity_type='vod', slot='')`; `vod_forum_post_status IN ('pending')` -> pending outbox row; `'attempted'` -> `ambiguous` outbox row (visible, no auto retry; matches current "attempted" semantics).
- `events.discord_voice_channel_id` (non-null, status scheduled/live) -> `discord_bindings(event, slot='voice', state='active')`. The column itself stays (read path for web) and is written only by the ack handler.
- `discord_delivery_state` row inserted with `cutover_at = now()`.

### 3.2 Control plane (new migration `m20261107_000001_discord_delivery.rs`)

```sql
ALTER TABLE tenants ADD COLUMN discord_delivery_mode TEXT NOT NULL DEFAULT 'off'
  CHECK (discord_delivery_mode IN ('off','shadow','on'));   -- one statement per column

CREATE TABLE discord_bot_instances (
  instance_id  TEXT PRIMARY KEY,           -- stable per bot process lineage (env BOT_INSTANCE_ID or hostname), NOT per connection
  guild_ids    TEXT[] NOT NULL DEFAULT '{}',
  bot_version  TEXT,
  protocol     INTEGER NOT NULL,
  transport    TEXT NOT NULL DEFAULT 'poll' CHECK (transport IN ('sse','poll')),
  connected_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_bot_instances_seen ON discord_bot_instances (last_seen_at);
```

`discord_bot_instances` is used for (a) tenant->instance routing in the hub, (b) the web "bot offline" indicator
(`last_seen_at < now() - 45 s` for the instance that lists the tenant's guild), (c) horizontal bot scaling
(Discord sharding): an item is only claimed by an instance whose `guild_ids` contains the tenant.

---

## 4. Effect catalogue

`EffectKind` (string stored in `discord_outbox.kind`). Class: **C** = converge (idempotent: re-running renders current
state), **O** = once (non-idempotent Discord create; needs `creating` binding + verify on recovery), **R** = retry-later
(the reducer may answer "not yet" without consuming attempts).

| Kind | Entity | Class | Coalesce key (pending) | once_key | available_at | expires_at | Supersedes pending rows of same entity | Reducer does |
|---|---|---|---|---|---|---|---|---|
| `event.upsert` | event | C | `event:{id}` | - | now (flash: `created_at + 30 s`, section 5.4) | - | - | Create or refresh announcement, discussion thread, signup card, thread name; first create pings, later refreshes never ping. |
| `event.close` | event | C | `event-close:{id}` | - | now | - | `event.upsert`, `event.mass`, `event.reminder`, `event.start` | Render final card (status, roster) BEFORE locking/archiving the thread (events-8/9). `payload.reason`: `stopped\|auto_stopped\|cancelled`. |
| `event.remove` | event | C | `event-close:{id}` | - | now | - | everything above | Archive: delete announcement, keep binding as `deleted` (so unarchive recreates silently). |
| `event.mass` | event | O | - | `event:{id}:mass` | now | `start_time_utc` | - | Ensure voice (section 9), post mass message in the thread. |
| `event.reminder` | event | O | - | `event:{id}:remind1h` (manual remind: no once_key, `cause=manual`) | now | `start_time_utc` | - | "starts in less than 1 hour" in the thread. |
| `event.start` | event | O | - | `event:{id}:start:{started_at epoch}` | now | `auto_stop_deadline` | `event.mass`, `event.reminder` | Ensure voice (reuse mass voice), post start notice with live roster mentions, refresh card. |
| `voice.release` | event | R | - | `event:{id}:voice-release` | now | `stopped_at + 6 h` | - | Delete the voice channel only when empty; occupied -> `fail(class=retryable, count_attempt=false, retry_after=120)`; at `expires_at` -> `skipped('voice_occupied')`. |
| `voice.sweep` | tenant (0) | C | `voice-sweep:0` | - | hourly from reconcile | - | - | Payload `{keep: [channel ids], name_prefix: "Event "}`; delete empty `Event <id> -` channels in the voice category older than 30 min that are not in `keep`. Replaces `sweepOrphanEventVoiceChannels` (`poller.ts:1788`). |
| `calendar.sync` | tenant (0) | C | `calendar:0` | - | `now + 5 s` (debounce) | - | - | Rebuild all calendar pages for the configured channels (only when `discord_event_delivery = calendar`, bot-arch-16 fixed by the render returning `mode`). |
| `split.upsert` | split | C | `split:{id}` | - | now | - | - | `SplitForumAdapter.sync` without cursors (section 11.3). |
| `giveaway.post` | giveaway | O | - | `giveaway:{id}:post` | now | `ends_at` | - | Post announcement in the giveaways channel, role mention. |
| `giveaway.update` | giveaway | C | `giveaway:{id}` | - | `now + 10 s` | - | - | Edit embed (entry count), after web or Discord entries. |
| `giveaway.result` | giveaway | O | - | `giveaway:{id}:result:{status}` | now | - | `giveaway.update` | Edit embed with result; winner message if `drawn`. |
| `battle.announce` | battle | O | - | `battle:{battle_id}` | now | `+24 h` | - | Post battle embed in the battles channel. |
| `dm.send` | notification | O | - | `dm:{notification_id}` | now | `+24 h` | - | `users.fetch(discord_id).send(...)`; Discord 50007 (DMs closed) -> ack `skipped('dm_closed')`. |
| `application.panel` | tenant (0) | C | `application-panel:0` | - | `now + 5 s` | - | - | Update panel message / open-closed status line. |
| `vod.create` | event | O | - | `vod:{event_id}:create` | now | - | - | Create the VOD forum post (replaces claim/created callbacks, `events/router.rs:204-216`). |
| `vod.delete` | event | C | `vod:{event_id}` | - | now | - | `vod.create` | Delete post when the event is archived. |

Defaults: `max_attempts = 8` (`C`, `O`), `voice.release` unlimited attempts bounded by `expires_at`. Priority:
lifecycle (`event.start|close|remove|mass|reminder`, `voice.*`) 100, `event.upsert|split.upsert|giveaway.*` 50,
`dm.send|battle.announce|vod.*` 30, `calendar.sync|application.panel|voice.sweep` 10.

Supersession is applied inside `emit` (same txn): `UPDATE discord_outbox SET state='superseded' WHERE entity matches AND
state='pending' AND kind IN (...)`. Leased rows are never superseded (they finish; ordering below handles the rest).

Ordering contract: a row is claimable only if no EARLIER row (`id <`) of the same `(entity_type, entity_id)` is still
`pending` or `leased` (strict head-of-line per entity; deliberately ignores `available_at`). Rows for different entities
never block each other, so one broken event cannot stop calendar, DMs or other events (finance-8 / bot-arch-17 class of bug).

---

## 5. Producing effects

### 5.1 `emit`

```rust
// discord_delivery/outbox.rs
pub struct Effect { kind: EffectKind, entity: (EntityType, i64), payload: serde_json::Value,
                    fingerprint: Option<String>, available_at: Option<DateTime<Utc>>, expires_at: Option<DateTime<Utc>> }
pub async fn emit<C: ConnectionTrait>(conn: &C, cause: Cause, actor: Option<i64>, effect: Effect)
    -> Result<EmitOutcome /* Inserted(id) | Coalesced(id) | AlreadyDone */, AppError>;
```

Takes any `ConnectionTrait` so it composes with the caller's `DatabaseTransaction`. Behaviour:

1. Policy lookup in `kinds.rs` (class, coalesce key, once key, supersedes, expiry).
2. If `once_key`: `INSERT ... ON CONFLICT (once_key) DO NOTHING`; zero rows -> `AlreadyDone`.
3. If `coalesce_key`: `INSERT ... ON CONFLICT (coalesce_key) WHERE state='pending' DO UPDATE SET fingerprint=excluded.fingerprint,
   payload=excluded.payload, available_at=min(existing, excluded), updated_at=now()`. SQLite supports the same upsert
   target; `LEAST` is replaced by `CASE` for portability.
4. Supersede earlier pending rows per the table.
5. Postgres only: `SELECT pg_notify('discord_outbox', current_schema())` (delivered at commit; identical notifications in a txn are deduplicated by PG). SQLite: no-op; unit tests call `hub.wake()` directly.
6. Tenant `discord_delivery_mode` is NOT consulted here (rows are always written; claim and scheduler are gated, section 13). In mode `off` the janitor purges rows older than 24 h so they do not pile up.

Existing mutation sites call `emit` through two helpers, not directly:

- `discord_delivery::touch_event(conn, event_id, Cause, TouchReason)` -> `event.upsert` (+ `calendar.sync`).
- `lifecycle::transition(...)` for status changes (5.2).

Call sites that MUST call `touch_event` (grep-able list, enforced by the reconcile sweep as safety net, 5.5):

| Site | File |
|---|---|
| `create_event` (organized, flash, copies created by `create_mirror`/fanout worker) | `events/service.rs:3368`, `events/sync.rs:51`, `events/fanout_worker.rs` create path |
| `update_event` | `events/service.rs:3556` |
| `advance_roster_version` (every roster/seat/participation mutation) | `events/service.rs:1705` and its callers `:1784,1859,1925,2025`; `participate*`/`set_participant*`/`cancel_participation` (`:4555-4922`) |
| roster roles / comp swap / player cap | `events/service.rs:2156,2205` |
| `converge_copy_to_source` | `events/lifecycle.rs:56` |
| `link_battles_for_event` / `replace_event_battles` (battles section of the card) | `events/service.rs:4243,4398` |
| `archive_event` / `unarchive_event` | `events/service.rs:3681,3721` -> `event.remove` / `event.upsert` |
| `event_discord_roles` edits | wherever `event_discord_role` rows are written |

### 5.2 `lifecycle::transition` - the choke point (D6)

```rust
// events/lifecycle.rs (new fn; start_event/stop_event/cancel/uncancel/archive become thin wrappers)
pub enum Transition { Start, Stop { auto: bool }, Cancel, Uncancel }
pub enum Cause { Web, Discord, Scheduler, Sync }       // Cause only labels outbox rows; it never changes the effect list
pub async fn transition(txn: &DatabaseTransaction, event_id: i64, t: Transition, cause: Cause, actor: Option<i64>)
    -> Result<TransitionOutcome { model, effects: Vec<EffectKind> }, AppError>
```

Effect list per transition (identical for every `Cause`):

| Transition | Row changes (in txn) | Effects emitted (in txn) |
|---|---|---|
| Start (`scheduled -> live`) | `status, started_at, auto_stop_deadline = now + MAX_SESSION_DURATION (3h), link_status=in_progress`; `mass_notified_at = COALESCE(.., now)`, `reminder_notified_at = COALESCE(.., now)` | `event.start`, `event.upsert`, `calendar.sync` |
| Stop (`live -> stopped\|auto_stopped`) | `status, stopped_at`; XP snapshot (existing); `event_voice_presence` row deleted | `event.close{reason}`, `voice.release`, `calendar.sync` |
| Cancel (`scheduled\|live -> cancelled`) | existing | `event.close{cancelled}`, `voice.release`, `calendar.sync` |
| Uncancel | existing | `event.upsert` (reopens the thread silently), `calendar.sync` |
| Archive | existing | `event.remove`, `vod.delete` (if a VOD post exists), `voice.release` (if voice bound), `calendar.sync` |
| Unarchive | existing | `event.upsert`, `calendar.sync` |

Rules:

- Idempotent like today: Start on `live` -> 409 (web contract unchanged); Stop on stopped -> no row change and NO new
  effects (the `once_key` of `event.close` is not used, but `coalesce` + `fingerprint` make a repeat a no-op).
- `event.start` `once_key` includes `started_at` epoch seconds so a legitimate uncancel -> start second run (events can be
  uncancelled to `scheduled`, `service.rs:3909`) is not swallowed.
- Cross-tenant propagation stays outside the txn: after commit the caller invokes `sync_owner_change_to_copies`
  (`lifecycle.rs:110`). The scheduler path ALSO calls it (alliance-3 fix). The copy's own `transition(.., Cause::Sync)` runs
  from `converge_copy_to_source` inside the copy tenant's txn, which is how the copy gets its own `event.start` /
  `event.close` / `voice.release` (D7). Contract with the sync-engine subsystem: converge must call `transition`, must not
  overwrite `mass_notified_at`, `reminder_notified_at`, `discord_voice_channel_id`.
- `remind_event` (`router.rs:1843`) stops being a stub: after `prepare_event_reminder` succeeds it emits `event.reminder`
  (no `once_key`, `cause=manual`, coalesced per minute through `coalesce_key = event-remind:{id}`), so web and Discord
  "remind" are the same effect.

### 5.3 Effect-equivalence (the acceptance property for events-7 / events-8)

For each Transition, a table-driven test runs it with `Cause::{Web, Discord, Scheduler, Sync}` and asserts the set of
`(kind, entity, payload-minus-cause)` is identical; plus a router-level test that `POST /api/events/{id}/start` and the
bot's `POST /api/events/{id}/start` (X-Bot-Secret + X-Discord-Id) enqueue the same rows.

### 5.4 Flash undo window moves to the backend

`FLASH_UNDO_WINDOW_MS = 30_000` is bot-only today (`poller.ts:164`, `handlers/button.ts:493`, `handlers/modal.ts:168`).
`touch_event` on create sets `available_at = created_at + 30 s` for `event_kind = 'flash'`. Cancelling / deleting within
the window supersedes the pending `event.upsert`, so the announcement is never posted (the "Undo" button is just
`POST /cancel`). The web gets the same undo semantics for free. (Verify against `flash.ts` / `flash-time.ts` during slice 3
how mass/start times of flash events are derived; if `mass_time_utc <= created_at + 30 s` the scheduler stamps
`mass_notified_at` at creation so no redundant mass notice is sent.)

### 5.5 Reconcile sweep (safety net, every 60 s per `on` tenant)

`reconcile::drift(tenant)`:

1. Candidates: non-archived events with status `scheduled|live`, plus events stopped/cancelled in the last 48 h whose
   binding `state != 'closed'`, plus archived events with `binding.state != 'deleted'`.
2. Compute `EventFingerprint` in Rust (`render.rs`) as a stable 64-bit FNV-1a hex over: title, description, kind, times,
   comp_id, player_cap, call_to_arms, status, archived_at, roster_version, voice channel id, discord role ids, regear.
   It deliberately EXCLUDES `updated_at` and link progress so the battle linker's per-tick `updated_at = now()`
   (events-11) can never cause re-renders.
3. If `binding.applied_fingerprint != fingerprint` and no pending/leased row exists for the entity -> `emit` the right
   effect with `cause=reconcile` (log at WARN: it means a call site forgot `touch_event`).
4. Terminal events with an `active` binding -> `event.close`.
5. Non-terminal events with NO binding (new tenant, channel configured later, lost state) -> `event.upsert` with
   `payload.ping=false` for events with `created_at < cutover_at`.
6. Hourly: `voice.sweep`.
7. Seeding rows for `skipped(config)` re-arm: see 5.6.

### 5.6 Settings-change re-arm

`AdminService::update_guild_settings` (`admin/service.rs:105`) calls `reconcile::on_settings_changed(db, changed_keys)`:

- channel/forum/tag/role/delivery/timezone keys -> `rearm(kind in [event.*, calendar.sync, split.upsert, ...])`: rows in
  `skipped` with `last_error_class='config'` whose `last_error_code` names a changed key return to `pending`
  (attempts reset), and `calendar.sync` is emitted;
- `discord_applications_*` -> `application.panel`;
- `discord_event_voice_category_id` -> re-arm `event.mass|start` rows skipped for `unconfigured:voice_category` ONLY if the
  event is still scheduled/live.

This removes the 60 s settings cache from delivery (the render payload reads settings fresh) and makes "I configured the
channel, why was nothing announced?" self-healing.

---

## 6. Delivery protocol

### 6.1 Auth and tenant addressing

- All `/api/bot/*` routes require `BotSecret` (`auth/rbac.rs:386`). Cross-tenant routes (`sessions`, `outbox/stream`,
  `outbox/claim`) are added to `skip_tenant_resolution` (`tenant.rs:435`) and take `Extension<TenantRegistry>` +
  `Extension<ControlDb>`. Per-item routes (`ack`, `fail`, `extend`, `bindings`, `render`, `signals`) are tenant-scoped through
  the existing `X-Guild-Id` header (`ApiClient.withGuild`), so no new tenancy mechanism.
- Web/admin routes (`/api/discord/*`) use `UserContext` + permissions like the rest of the app.

### 6.2 Session

`POST /api/bot/sessions`

```json
{ "instance_id": "bot-1", "guild_ids": ["1234..", "5678.."], "bot_version": "2026.11.0", "protocol": 1 }
```
```json
{ "tenants": [ {"tenant_id":"1234..","kind":"guild","mode":"on","name":"Weaklings"},
               {"tenant_id":"5678..","kind":"alliance","mode":"on","name":"Alliance"} ],
  "poll_interval_s": 10, "lease_s": 90, "max_inflight": 32, "heartbeat_s": 15, "server_time": "..." }
```

- Upserts `discord_bot_instances`. Returns only guilds that are `active` registered tenants (replaces `fetchTenantStatus` /
  `isRegisteredTenant` for delivery; `tenant-gate.ts` stays for command gating).
- Called at startup, on `GuildCreate` / `GuildDelete` (`index.ts:209,218`), every 5 min, and whenever the SSE stream
  delivers `event: tenants` (the backend pushes it when a tenant finishes onboarding or its mode changes - removes
  `RECONCILE_INTERVAL_MS` polling for "newly registered tenant", `poller-manager.ts:16`).
- Unknown `instance_id` on stream/claim -> `404 session_required`; the bot re-registers.

### 6.3 Claim

`POST /api/bot/outbox/claim` `{ "instance_id": "bot-1", "limit": 20 }` -> `{ "items": [Item] }`.

`Item` (same JSON is pushed over SSE as `event: item`):

```json
{ "tenant_id": "1234..", "tenant_kind": "guild", "id": 9812, "kind": "event.start",
  "entity": { "type": "event", "id": 412 }, "payload": { "cause": "scheduler" },
  "fingerprint": "7:live:ab12..", "attempt": 1, "recovering": false,
  "lease_token": "5f6c..", "lease_until": "2026-11-07T18:01:30Z", "trace_id": "..." }
```

`claim_due(db, instance_id, limit, lease_s)` per tenant (Postgres; SQLite variant omits `SKIP LOCKED` and the UUID function):

```sql
WITH due AS (
  SELECT o.id FROM discord_outbox o
  WHERE o.state = 'pending' AND o.available_at <= now()
    AND (o.expires_at IS NULL OR o.expires_at > now())
    AND NOT EXISTS (SELECT 1 FROM discord_outbox p
                    WHERE p.entity_type = o.entity_type AND p.entity_id = o.entity_id
                      AND p.id < o.id AND p.state IN ('pending','leased'))
  ORDER BY o.priority DESC, o.id
  LIMIT $1
  FOR UPDATE SKIP LOCKED)
UPDATE discord_outbox SET state='leased', lease_token=gen_random_uuid(), lease_until=now()+($2||' seconds')::interval,
       leased_by=$3, attempts=attempts+1, updated_at=now()
FROM due WHERE discord_outbox.id = due.id
RETURNING discord_outbox.*;
```

Before claiming, `reclaim_expired` runs in the same call: `leased AND lease_until < now()` -> `pending`, `recovering=true`
(or `failed` when `attempts >= max_attempts`; `ambiguous` for class O kinds when the reducer already checkpointed a
`creating` binding and `verify` is unavailable). Expired `pending` rows (`expires_at < now()`) -> `skipped('expired')`.

Fairness / backpressure: the claim fan-in round-robins tenants, at most 5 items per tenant per round, bounded by
`max_inflight - inflight(instance)`. In-flight is tracked in the hub per instance (incremented on send, decremented on
ack/fail), rebuilt from `SELECT count(*) WHERE leased_by = $instance AND state='leased'` on (re)connect.

### 6.4 SSE stream

`GET /api/bot/outbox/stream?instance_id=bot-1` (axum 0.8 `axum::response::sse::Sse`, `KeepAlive` 15 s,
`Cache-Control: no-cache`, `X-Accel-Buffering: no`). Needs `tokio-stream` (`ReceiverStream`) in `Cargo.toml`; verify
whether `sea_orm::sqlx` is re-exported for `PgListener` (otherwise add `sqlx` with the same version/features as sea-orm).

Server loop per connection (`hub.rs`):

1. On connect: if another connection holds the same `instance_id`, close it (newest wins). Reclaim everything that
   `instance_id` still has `leased` (the old process or connection is gone) -> `pending, recovering=true` immediately,
   without waiting for lease expiry. This is the crash-recovery fast path and replaces `Last-Event-ID` (D4).
2. Mark all tenants of the instance dirty; loop: wait for `wake(tenant)` | 15 s ping | 30 s safety sweep (dirty = all).
3. For each dirty tenant (mode `on` only): `claim_due`; push `event: item` for each; if the batch was full, loop again immediately.
4. `event: tenants` when the instance's tenant set or modes changed.
5. Update `discord_bot_instances.last_seen_at` / `transport='sse'` every 30 s.

Wake sources: (a) `PgListener` on channel `discord_outbox` (payload = schema name; hub holds `schema -> tenant_id` from the
registry; `emit` runs in the same commit); (b) in-process `hub.wake(tenant)` after backoff expiry (a `BinaryHeap` of
next `available_at` per tenant, set from the claim query's `min(available_at)`) and after `rearm`; (c) the 30 s sweep
(covers lost NOTIFYs, listener reconnects, `available_at` maturing). PgListener must use a direct Postgres connection (not
a transaction-mode pooler); on listener reconnect the hub marks everything dirty. NOTIFY is only a latency optimisation.

Bot side (`delivery/outbox-client.ts`): `fetch` with `X-Bot-Secret` + small SSE parser (no `EventSource`: it cannot set
headers). 45 s without bytes -> abort and reconnect with exponential backoff (1 s .. 30 s, jitter). While disconnected
the client runs the poll loop (`claim` every `poll_interval_s`) and retries SSE every 30 s; both feed the same
`Dispatcher.enqueue(item)` which dedupes by `(tenant_id, id, lease_token)`.

### 6.5 Ack / fail / extend

Tenant-scoped (`X-Guild-Id`), fenced by `lease_token` (stale token -> `409 lease_lost`; the bot discards its result,
exactly like `fanout_outbox::mark_succeeded` at `fanout_outbox.rs:195`).

`POST /api/bot/outbox/{id}/ack`
```json
{ "lease_token": "..", "outcome": "done",                      // or "skipped" with "reason"
  "bindings": [ { "entity_type":"event","entity_id":412,"slot":"voice","state":"active","channel_id":"..." } ],
  "result":   { "voice_channel_id": "..", "created_voice": true },
  "rendered_fingerprint": "7:live:ab12.." }
```
One txn: outbox -> `done` (or `skipped`), bindings upserted (`applied_fingerprint = rendered_fingerprint`), then
kind-specific side effects:

- voice binding `active` -> `events.discord_voice_channel_id` (if the event already has a DIFFERENT one: 409 `voice_conflict`; the
  reducer deletes the channel it just created, same compensating action as `createAndBindVoice`, `event-lifecycle.ts:134-138`);
  binding `deleted` on a `voice` slot -> column cleared (these two replace `bind_event_voice_channel` / `clear_event_voice_channel` as route handlers; the service functions are kept as internal helpers);
- `dm.send` -> `notifications.discord_dm_status = sent | skipped`;
- `giveaway.post` -> `giveaways.discord_channel_id/message_id` mirrored from the binding (until the columns are dropped);
- `vod.create` -> `events.vod_forum_post_status='created'`, `vod_forum_thread_id`.

`POST /api/bot/outbox/{id}/fail`
```json
{ "lease_token": "..", "class": "retryable|config|permission|gone|ambiguous|fatal",
  "code": "discord:50013", "message": "Missing Permissions", "retry_after_s": 30, "count_attempt": true,
  "field": "events_channel" }
```

| class | Backend transition | Notes |
|---|---|---|
| `retryable` (429, 5xx, network, timeouts) | `pending`, `available_at = now + backoff(attempts)` (or `retry_after_s`); `failed` at `attempts >= max_attempts`; `count_attempt=false` for `voice.release` "occupied" | Backoff `min(10 s * 2^(attempts-1), 15 min)` +/- 20 % jitter. Reuse/extract `mirror_retry::retry_delay_seconds` into a shared `retry::backoff`. Cumulative ~21 min over 8 attempts. |
| `config` (no channel/forum/category configured) | `skipped`, `last_error_code='unconfigured:<field>'` | Terminal but NOT an error: re-armed by `on_settings_changed` (5.6) or the web "Retry" button. Surfaces as "not announced: no events channel configured" (bot-arch-11). |
| `permission` (50013, 50001) | `failed` | Re-armable from the web after the admin fixes permissions. |
| `gone` (10003/10008 on edit and self-heal impossible) | `failed`, binding `deleted` | Converge reducers normally self-heal by recreating (silent, `ping=false`). |
| `ambiguous` (create may have happened, verify inconclusive) | `ambiguous` | Needs a human: web shows "verify then retry"; retry sets `recovering=true` so the reducer runs `verify` first. Never auto-retried (preserves the intent of today's `attempted` / `ambiguous`). |
| `fatal` | `failed` | Programming errors; surfaced in the admin list. |

`POST /api/bot/outbox/{id}/extend` `{ lease_token, seconds }` (cap 300 s, max 5 extensions) - the dispatcher heartbeats
every `lease_s/3` while a reducer is running so a Discord 429 queue wait cannot expire a lease.

### 6.6 Leases and crash recovery summary

- Default lease 90 s. Bot crash or network cut: (a) reconnect with same `instance_id` -> immediate reclaim; (b) otherwise
  lease expiry -> reclaim by any instance serving the tenant. Reclaimed rows carry `recovering=true`.
- `recovering` means "a previous execution may have partially run": class O reducers MUST run `verify()` before any
  create. `verify` is bounded and kind-specific:
  - messages/embeds carry a hidden marker in the embed footer, `wk:o:{outbox_id}` (DMs and channel posts) or `wk:e:{event_id}` (event cards); verify scans the last 25 bot-authored messages of the target channel/thread;
  - threads: look up `binding.thread_id`, else active threads of the parent channel by deterministic name (the logic that exists today at `poller.ts:1964-1972`, moved into `verify`);
  - voice: lookup by deterministic name `Event <id> - <title>` in the voice category (`buildEventVoiceChannelName`, `event-lifecycle.ts:162`);
  - if verify cannot conclude (missing `ReadMessageHistory`) -> `fail(class=ambiguous)`.
- Offline bot, 2 h: rows accumulate; `event.upsert` rows were coalesced (one per event); `event.mass|reminder|start` rows past
  `expires_at` become `skipped('expired')` so no stale pings; claim order is `priority, id` and per-entity head-of-line; batch cap + fairness keep the reconnect burst bounded.

### 6.7 Retention

Janitor (scheduler tick, hourly): delete `done|superseded` older than 14 d, `skipped` older than 30 d, keep `failed|ambiguous`
90 d. Mode `off`: purge all non-terminal rows older than 24 h. `discord_bindings` rows are never deleted (history),
`state='deleted'`.

---

## 7. Render API (what reducers read)

All tenant-scoped (`X-Guild-Id`), `BotSecret`. Every response has `{ "fingerprint": "...", "tenant": {id, kind, name, timezone},
"routes": {...}, "binding": {...}|null, "data": {...} }`. Routes are resolved fresh from `guild_settings` per call
(`admin/entities.rs` columns: `discord_events_channel_id`, `discord_battles_channel_id`, `discord_flash_mass_channel_id`,
`discord_events_forum_channel_id`, `discord_event_delivery`, `discord_event_*_tag_id`, `discord_event_role_id`,
`discord_event_voice_category_id`, `discord_splits_forum_channel_id`, `discord_split_*_tag_id`, `discord_giveaways_*`,
`discord_applications_*`).

| Route | `data` | Notes |
|---|---|---|
| `GET /api/bot/render/event/{id}` | `EventDetailView` (existing `get_event_detail`) + `roster` + `participants` + `splits[]` + `copy: {is_copy, origin_tenant_name}` + `mode: calendar\|message\|forum` + `voice: {category_id, name}` + `skip: null\|"archived"\|"terminal"` | One call replaces `GET /events/{id}` + `/events/revisions` + settings reads. Copies are marked so cards render read-only badges. |
| `GET /api/bot/render/calendar` | events per target channel, already routed (events / call-to-arms / flash), `mode`, `timezone` | Wraps `list_calendar_events` (`service.rs:2597`, unpaginated by design). |
| `GET /api/bot/render/split/{id}` | `SplitDiscordSync` minus cursors, plus backend-computed `net_pool`, `fee`, `net` decimals (finance-2) | Wraps `splits/discord_sync.rs::get_sync`. |
| `GET /api/bot/render/giveaway/{id}` | `GiveawayDetailView` | |
| `GET /api/bot/render/battle/{battle_id}` | battle summary from the persisted snapshot | Source = `guild_battle_snapshots` (see 11.5). |
| `GET /api/bot/render/notification/{id}` | `{ discord_id, title, body, link, kind }` | Text lives in the DB, not the outbox. |
| `GET /api/bot/render/application-panel` | panel copy + open flag + channel/message ids | |

Bindings API (tenant-scoped):

- `PUT /api/bot/bindings` `{ "outbox_id": 9812, "lease_token": "..", "items": [ {entity_type, entity_id, slot, state, channel_id?, message_id?, thread_id?, card_message_id?, extra?, nonce?} ] }`.
  Fenced by the lease; used for CHECKPOINTS between Discord calls (parent message created -> write; thread created -> write;
  card posted -> write). This replaces `eventParentMessageIds` / `eventThreadIds` / `eventSignupMessageIds` in the JSON.
- `GET /api/bot/bindings?thread_id=..` | `?entity_type=event&entity_id=..` | `?entity_type=event&slot=voice&state=active` (rebuild the
  voice watch set at startup). Replaces `Poller.findEventIdForThread`, `eventSignupMessageIdFor`, `rememberEventThread`
  (`poller.ts:1405-1432`; used by `services/event-thread-command.ts:68,247,276,366`, `handlers/button.ts:922,953`).
  The bot keeps a positive-only LRU (5 min) keyed by thread id.

---

## 8. Backend scheduler (mass, start, 1h reminder, auto-stop)

### 8.1 Loop

`discord_delivery::scheduler::spawn(control, registry, hub)` from `lib.rs` next to `fanout_worker::spawn` (`lib.rs:118`).
Tick 5 s (`DISCORD_SCHEDULER_TICK_SECS`). Per tick:

1. `SELECT id, kind, discord_delivery_mode FROM tenants WHERE status='active' AND kind IN ('guild','alliance')`.
2. For each tenant with mode `on` (mode `shadow`: compute and log `would_*` counters only): `registry.get_or_load(id)` ->
   `scheduler::run_tenant(ctx, now)`. Tenants are processed with bounded concurrency (4) so one slow tenant cannot delay the rest.
3. Hourly: janitor + `voice.sweep` seeding. Every 60 s: `reconcile::drift`.

`TenantRegistry` gains `active_tenant_ids()` (control query) because `warmup()` (`tenant.rs:246`) is boot-only. The tenant's
Albion scope is NOT needed. `event_sessions::run_cycle` keeps only the battle linker; `auto_stop.rs` is deleted and
`GiveawayService::draw_due` (`event_sessions/mod.rs:81`) + `retry_pending_event_completion_xp` (`:67`) move into
`run_tenant` for guild tenants (fixes the finance-9 coupling; each step isolated so one error does not skip the rest).

### 8.2 Pure planner (testable with an injected clock)

```rust
pub fn plan(now: DateTime<Utc>, snap: &TenantSnapshot) -> Vec<Action>
// Action = Mass{id} | Reminder{id} | Start{id} | AutoStop{id, cause} | Skip{id, what}
```

`TenantSnapshot` comes from three indexed queries (`scheduled` due candidates ordered by time asc with `LIMIT 200`, `live`
past-deadline, `live` with fresh voice presence) - never from a paginated newest-first list (bot-arch-5, events-12).

Rules (origin = `source_tenant_id IS NULL`; copy = not origin):

| Action | Selection | Applied by | Idempotency |
|---|---|---|---|
| Mass | `status='scheduled' AND archived_at IS NULL AND mass_notified_at IS NULL AND COALESCE(mass_time_utc, event_date_utc) <= now`; **if start is also due in this tick, skip mass** and stamp `mass_notified_at` (start carries the voice). | origin and copy: `UPDATE events SET mass_notified_at=now WHERE id=$1 AND mass_notified_at IS NULL AND status='scheduled'` (rows_affected==1) then `emit(event.mass, once_key)` in the same txn | conditional UPDATE + `once_key` |
| Reminder 1h | `status='scheduled' AND reminder_notified_at IS NULL AND start-1h <= now < start` **and** `created_at < start-1h` (an event created inside the last hour already carries the information; deliberate change from today) | origin and copy, same pattern with `event.reminder` | same |
| Start | `status='scheduled' AND COALESCE(start_time_utc, event_date_utc) <= now` AND **origin only** | `lifecycle::transition(Start, Scheduler)` in the txn; after commit `sync_owner_change_to_copies` | transition guards `status='scheduled'` |
| Auto-stop (deadline) | `status='live' AND auto_stop_deadline <= now` AND origin only | `transition(Stop{auto:true}, Scheduler)` with `award_xp = !is_mirror_event(...)` preserved from `auto_stop.rs:46` | `stop_event_with_xp_policy` is idempotent |
| Auto-stop (voice empty) | origin only; `event_voice_presence.seen_occupied AND empty_since <= now - 120 s AND last_observed_at >= now - 300 s` | same, `payload.cause="voice_empty"` | same |

Notes:

- Copies never transition on their own clock (D7). A copy whose origin start was missed still follows via converge. A copy
  can still mass and remind locally using the converged times.
- Catch-up after backend downtime: Start fires late but fires; the 3 h `auto_stop_deadline` is computed from the actual start
  (`start_event`, `service.rs:3948`), unchanged. Events whose start is older than `MAX_SESSION_DURATION + 1 h` and still
  `scheduled` are NOT auto-started (would immediately auto-stop); they are reported by `Skip{stale}` once (metric + WARN)
  and left for a human. (Today the bot would start them.)
- Voice-empty stop semantics change slightly: 120 s empty after having been occupied, status `auto_stopped` (today the bot used
  `POST /stop`, i.e. `stopped`). Intentional: every scheduler-initiated stop is `auto_stopped`.
- Multi-replica: two schedulers race on the same event -> exactly one conditional UPDATE wins; the loser sees
  `rows_affected = 0` and does nothing. No advisory lock needed (replaces the "advisory lock for workers" mention in plan Q12 for this loop).
- Per-tenant error isolation: errors are logged with `tenant_id`, increment a counter, never abort the tick.
- Latency: start precision 5 s (was 60 s), effects reach Discord within ~1 s of the commit via NOTIFY.

### 8.3 Alliance tenants

`starts_sync_workers("alliance") = false` (`tenant.rs:84`) stays (battle sync / linker need a guild scope) but the scheduler
does not call it. Alliance-owned events (origin = alliance) get mass / reminder / start / auto-stop from the same planner.
Guild copies of them get mass / reminder locally and start / stop through converge.

---

## 9. Voice channel provisioning as an effect

### 9.1 Where

`event.mass` and `event.start` reducers call one shared `ensureVoice(render)`; `voice.release` calls `releaseVoice`. The
`createAndBindVoice` / `massDiscordEvent` / `startDiscordEvent` / `stopDiscordEvent` helpers in `event-lifecycle.ts:60-160`
are deleted; `voiceChannelOccupantCount` and `buildEventVoiceChannelName` stay (pure Discord helpers).

### 9.2 `ensureVoice` algorithm

1. `render.voice.category_id` null -> do NOT fail the effect: the mass/start message is still posted without a voice line and
   the ack `result = { voice: "skipped_unconfigured" }`; the web delivery panel shows a warning chip. (Today
   `createAndBindVoice` throws "No event voice category is configured" and aborts Start from Discord.)
2. `binding(slot=voice)` active and channel exists -> reuse.
3. Else write binding `creating` (nonce = `Event <id>` name) -> `verify` by name in the category (adopt if found) -> create ->
   `PUT bindings` (`active`, `channel_id`) -> ack with the voice binding. Backend ack handler sets
   `events.discord_voice_channel_id` (conflict handling in 6.5).
4. `voice.release` on terminal: channel missing -> ack (binding `deleted`); occupied -> `fail(retryable, count_attempt=false,
   retry_after=120)`; empty -> delete -> ack (binding `deleted`) -> column cleared. `expires_at = stopped_at + 6 h` then
   `skipped('voice_occupied')`.

### 9.3 Voice-empty signal

- Bot handler for `VoiceStateUpdate` (new intent already enabled: `GuildVoiceStates`, `index.ts` Client intents) looks the
  channel up in its in-memory `liveVoiceWatch: Map<channelId, {tenant, eventId}>` (built from
  `GET /api/bot/bindings?entity_type=event&slot=voice&state=active` per tenant at session start, and updated by
  `event.start` / `voice.release` reducers). On change of occupancy for a watched channel: debounce 5 s, then
  `POST /api/bot/signals` `[{ "type":"voice.observation", "event_id":412, "channel_id":"..", "occupants":3, "observed_at":".." }]`.
  A 60 s heartbeat re-sends the current counts for watched channels so freshness is guaranteed.
- Backend (`signals.rs`) upserts `event_voice_presence`: `occupants>0` -> `seen_occupied=true, empty_since=NULL`; `occupants==0 AND seen_occupied`
  -> `empty_since = COALESCE(empty_since, observed_at)`.
- The planner uses the rule in 8.2 and ignores stale rows (`last_observed_at < now-300 s`): a blind bot never stops events.
  Only the origin's own voice channel counts (D7/D10): an alliance event is not stopped because one member guild's copy
  channel emptied.
- Cleared when the event leaves `live`.

---

## 10. Announcements on the alliance Discord (D8) and `ping_alliance` removal

Flow after the change:

1. Guild G creates an event with `ping_alliance=true`. The sync engine (`create_mirror`, `events/sync.rs:51`, retried by
   `mirror_retry.rs`) creates the synchronized copy in alliance tenant A (owner = G). In that copy-creating txn it calls
   `touch_event(conn, copy_id, Cause::Sync, Created)` -> `event.upsert` in A's outbox.
2. A's bot-side delivery (the same bot process, `X-Guild-Id = A`) renders and posts it in A's events channel with A's
   `discord_event_role_id`. `render.copy = { is_copy: true, origin_tenant_name: G }` makes the card read-only (no manage
   buttons; sign-up buttons remain - signups carry guild attribution and flow to the canonical roster per the settled rules).
3. Lifecycle: A's copy receives its own mass / reminder (A's scheduler), start / close / remove via converge (`Cause::Sync`).
   This replaces `postAllianceLifecycle`. Alliance-origin events fan out to guild copies with the identical mechanism.
4. Roles: a copy ignores the origin's `discord_role_ids` (they are snowflakes of another Discord). It uses the target tenant's
   `discord_event_role_id` (render computes `ping_roles`).

Deleted by the cleanup slice: `events.alliance_discord_message_id` (entity `entities.rs:68`, model `models.rs:273,691`, PATCH
branch `service.rs:3596`, tests `:7734-7749`), `AlliancePingTargets`, `apply_alliance_ping_targets`,
`load_alliance_ping_targets` (`service.rs:323-380`), `EventView.alliance_discord_channel_id/alliance_discord_role_ids/origin_guild_id`
(`models.rs:281`), bot `shouldPingAllianceDiscord`, `withAlliancePingRoles`, `buildAllianceLifecycleMessage`
(`embeds/event.embed.ts:61-100`), `Poller.eventApi`, `postAllianceAnnouncement`, `postAllianceLifecycle`. The
`ping_alliance` column stays as the sync-engine flag; its Discord meaning disappears. Data migration: events with
`ping_alliance=true AND alliance_discord_message_id IS NOT NULL` (already posted by the legacy path) get a note in the
sync-engine backfill so the new alliance copy's first `event.upsert` is created with `ping=false` and adopts nothing (the
legacy message stays orphaned; documented, low volume, only future/live events matter).

Dependency on the sync-engine subsystem: until guild->alliance mirroring is the announcement path for every
`ping_alliance` event, this cleanup slice (S9) must not run, otherwise alliance Discord announcements regress.

---

## 11. Other consumers

### 11.1 DMs / notifications (members-1, bot-arch-8)

- `NotificationService::notify` (`notifications/service.rs:158-267`) already sets `discord_dm_status` to `pending` or
  `skipped` per kind. In the same txn it now also `emit(dm.send, entity=(notification, id), once_key=dm:{id})` for `pending`.
  The bot `/warn` self-DM (`commands/warn.ts:80-107`) is removed so web and Discord warns share one path.
- Reducer: `render/notification/{id}` -> `client.users.fetch(discord_id)` -> `send({ embeds, footer marker })`. Discord 50007 ->
  ack `skipped('dm_closed')`; backend sets `discord_dm_status='skipped'`. Success -> `sent`; permanent failure -> `failed`.
- Throttle: dispatcher per-kind concurrency 2 + token bucket 5/s so a 300-member broadcast drains in ~1 min without tripping Discord limits; each recipient is an independent entity (no head-of-line).
- Inbox is unchanged; DM is an additional channel.

### 11.2 Giveaways (finance-20, finance-9)

- Create (`giveaways/service.rs`) emits `giveaway.post` (`once_key`), entries emit `giveaway.update` (10 s debounce, so
  web entries finally refresh the Discord count), draw / cancel / empty-expiry emit `giveaway.result` in the SAME txn as the
  state flip (`draw`, `draw_due` at `service.rs:521`).
- `PUT /api/giveaways/{id}/discord-message` (`giveaways/router.rs:64`) is no longer called by the bot (the binding ack
  replaces it); kept one release, then removed.
- `postedGiveawayIds`, `announcedGiveawayDraws`, `lastGiveawayId` disappear.

### 11.3 Splits (generalizing `split_discord_sync`)

- `discord_bindings(entity_type='split')` replaces `split_discord_sync` thread/summary ids. The cursors
  (`last_audit_id`, `last_transaction_id`) are not needed once the summary is rendered from current state with a fingerprint
  (`splits.updated_at` + transactions `updated_at` + audit rows keyed by `split_id`, all already watermarked by
  `m20260831_000005`).
- Emitters: `SplitService` create / update / complete / lost / close / archive / participant sync
  (`splits/service.rs`, including `sync_event_participants` at `:1353`), bank transactions linked to a split, and the
  alliance distribution status change. The drift sweep covers misses (fingerprint over status, archived_at, pool/fee/net,
  participant shares, linked transaction ids).
- `GET/PUT /api/splits/{id}/discord-sync` and `GET /api/splits/discord-sync` (`splits/discord_sync.rs`) become deprecated
  after the bot cut-over and are deleted in S10. `SplitForumAdapter` (`split-forum.ts`) keeps `createForumPost`,
  `updateSummary`, `updateForumTag`, `closeForumPost`, `deleteForumPost`; `sync()` becomes the `split.upsert` reducer and
  `saveState` becomes `PUT bindings`.
- Read-only copies (`origin_read_only=true`) are NOT posted (current filter at `discord_sync.rs` `discover`
  `OriginReadOnly.eq(false)` is preserved as a render `skip: "copy"`), so there is one Discord thread per split, the origin's.
  Revisit only if the owner wants copies visible on the alliance forum.

### 11.4 Calendar panels

`calendar.sync` (debounced, coalesced per tenant) is emitted by `touch_event` and `transition`. The reducer is the existing
`performEventCalendarSync` body (`poller.ts:1208-1355`) minus state: page message ids and fingerprints go into
`discord_bindings(entity_type='calendar', slot='<channelId>')` with `extra = { "pages": [...], "fingerprints": [...] }`.
`render/calendar` returns `mode`; if `mode != calendar` the reducer acks `skipped('not_calendar_mode')` (bot-arch-16).
`/event-calendar-refresh` calls `POST /api/discord/calendar/refresh` (permission-gated; returns the outbox id) and polls
`GET /api/discord/outbox/{id}` for up to 15 s to show the per-channel result from `result.failed_channels`.

### 11.5 Battles

Hook in `battle_sync.rs` (`run_cycle`, 120 s): when a battle snapshot is first persisted AND `battle_id > battle_floor_id`
AND the battle is settled (settle window / `min_players` are the battles subsystem's rules) -> `emit(battle.announce,
once_key=battle:{id})`. This removes `listSinceCheckpoint` over `/api/battles` and the `lastBattleId` cursor; the
`battle_floor_id` seeded from the imported `lastBattleId` prevents a history flood at cutover. Alliance tenants have no
battle sync (no Albion scope) and therefore emit nothing - which also ends the failing `scoped_battles` call every tick (bot-arch-10).
Dependency: slice S7 uses whatever `battle_sync` snapshots exist at that time; the settle-window refinement lands with WP3/WP14.

### 11.6 VOD forum posts

`vod.create` emitted at event creation when `vod_forum_post_enabled`; `vod.delete` at archive. The claim / created / deleted /
retry-after-verification routes (`events/router.rs:204-216`) are replaced by the lease + `creating` binding + `ambiguous`
state; "retry-after-verification" becomes the generic web retry on an `ambiguous` row.

### 11.7 Application panel

`application.panel` is emitted by `on_settings_changed` (5.6) and by applications open/close actions. The status line
(`checkApplicationStatus` / `updateApplicationPanel`, `poller.ts:701-750`) becomes a reducer; `applicationsOpen` leaves the state file.

---

## 12. The bot as stateless executor

### 12.1 New code (`apps/discord-bot/src/delivery/`)

| File | Role |
|---|---|
| `outbox-client.ts` | session registration, SSE reader with reconnect / polling fallback, `claim`, `ack`, `fail`, `extend`, `bindings`, `render`, `signals`. Uses `ApiClient.withGuild(item.tenant_id)` for tenant-scoped calls. Adds `AbortSignal.timeout(10_000)` to every call (bot-arch-14). |
| `dispatcher.ts` | in-memory work queues: serialize per `(tenant, entity)`, concurrency limits (global 8, per tenant 3, `dm.send` 2), lease heartbeat (`extend` every lease/3), 30 s reducer timeout, error classification (`classifyDiscordError` maps discord.js `DiscordAPIError.code`/HTTP status/AbortError to the fail classes of 6.5), ack/fail posting. |
| `reducers/index.ts` | `Record<EffectKind, Reducer>`; a `Reducer = (ctx: {client, api, item, render, binding, recovering}) => Promise<Ack>`. Unknown kind -> `fail(fatal, "unsupported_kind")` so a newer backend never blocks an older bot silently. |
| `reducers/event-upsert.ts` | the body of `announceEvent` (`poller.ts:906-1078`) + `checkEventRosterSync` card refresh (`:1622-1713`), rewritten as converge-to-render with binding checkpoints (section 12.3). |
| `reducers/event-close.ts` | `finishEventThread`, `closeCancelledEvent`, `deleteEventAnnouncement`, restore (`poller.ts:1379-1620`), always render final card first. |
| `reducers/event-lifecycle.ts` | `event.mass`, `event.start`, `event.reminder`, `voice.release`, `voice.sweep` with `ensureVoice`. Message builders stay in `embeds/event.embed.ts`. |
| `reducers/calendar.ts`, `split.ts`, `giveaway.ts`, `battle.ts`, `dm.ts`, `application-panel.ts`, `vod.ts` | one file per kind, wrapping the existing builders (`embeds/*`, `split-forum.ts`, `split-summary.ts`). |
| `signals.ts` | `VoiceStateUpdate` handler, `liveVoiceWatch`, heartbeat. |
| `import-legacy-state.ts` | one-shot poller-state import (section 13.4). |

### 12.2 Interaction paths that change

| Today | After |
|---|---|
| `getPoller(api.guildId)?.pollNow()` after create (`commands/event-create.ts:112`, `handlers/modal.ts:161`, `handlers/button.ts:503`, `event-thread-command.ts:103`) | Removed. The backend emitted `event.upsert` in the create txn; delivery is ~1 s via SSE. |
| `commands/event-start.ts:29`, `event-stop.ts:26`, `handlers/button.ts:865,985`, `event-thread-command.ts:181,203` call `startDiscordEvent`/`stopDiscordEvent` then `closeEventThread` | Call only `POST /api/events/{id}/start|stop|cancel|uncancel` (`ensureEventManagementAllowed` unchanged) and reply ephemerally from the response (`status`, and the `effects` array the endpoints now return: `[{id, kind}]`). Voice, notices, thread close arrive as effects. No bot-side lifecycle orchestration remains (events-17 four code paths collapse into zero). |
| `getPoller(...).findEventIdForThread` (`event-thread-command.ts:68`) | `bindings.byThread(threadId)` (LRU) |
| `rememberEventThread` after bot-created threads (`button.ts:922,953`, `event-thread-command.ts:247,273`) | Gone: only reducers create threads, and they write bindings. |
| `getPoller(...).addMemberToEventThread` (`handlers/select.ts:54,102,223,339`) | Reads `binding.thread_id`, adds the member (a plain helper in `delivery/thread-members.ts`). |
| `/event-calendar-refresh` -> `poller.refreshEventCalendars` | backend refresh endpoint (11.4) |
| `index.ts:207-321` `PollerManager` | `DeliveryRuntime.start(client, api)`; `GuildCreate` / `GuildDelete` -> `runtime.refreshSession()` |
| `config.POLL_INTERVAL_MS`, `config.POLLER_STATE_DIR` | `BOT_INSTANCE_ID` (default hostname), `DELIVERY_MODE=poller\|outbox` (transition only), `POLLER_STATE_DIR` kept until S10 for the importer |

Voice feedback to the user: the Discord `/event-start` reply can no longer synchronously say "voice channel created". Acceptance:
reply says "started; announcement and voice are being prepared" and the start notice in the thread (posted by the reducer) carries the voice link.

### 12.3 Reducer shape for `event.upsert` (non-idempotent create made safe)

```
render = GET render/event/{id}                       // fingerprint F, routes, binding B, mode, copy
if render.skip -> ack skipped
route = pickChannel(render)                          // calendar|message|forum, flash/CTA/events channel
if !route -> fail(config, field)                     // skipped, re-armed by settings change
if B == null or B.state in (creating, deleted):
   PUT binding {state: creating, nonce}              // checkpoint 0
   if item.recovering or B.state == creating: adopted = verify(...)   // marker / thread name / saved ids
   parent = adopted.parent ?? send(announcement(render, ping = !silent))   ; PUT binding {message_id}
   thread = adopted.thread ?? startThread(parent)    ; PUT binding {thread_id}
   card   = adopted.card   ?? sendSignupCard(thread) ; PUT binding {card_message_id, state: active}
else if B.applied_fingerprint != F:
   edit parent, thread name, signup card (refreshEventSignupCard), self-heal 10008/10003 by recreating silently
ack done {bindings, rendered_fingerprint: F}
```

`silent` (no role ping) when `payload.ping === false` (cutover / reconcile / recreate). Split-forum and giveaway reducers
follow the same skeleton.

### 12.4 Removed

`services/poller.ts` (+ `poller.test.ts` 2416 lines, `vod-forum-poller.test.ts`), `services/poller-manager.ts` (+ test),
`listSinceCheckpoint`, `adoptCheckpointBaseline`, `PollerState`, `loadState/saveState`, `FLASH_UNDO_WINDOW_MS` (button / modal
read it from the render or from `created_at`+backend contract: `GET /events/{id}` exposes `announce_at`), all
`getPoller` call sites, `massedEvents`/`pinged1hEvents`/`emptyLiveChecks`/`occupiedLiveEvents`, `sweepOrphanEventVoiceChannels`,
`event-lifecycle.ts` mass/start/stop orchestration, `services/event-thread-copy.ts` pieces only used by the poller (audit during S10).
`services/split-forum.test.ts`, `event-announcement-thread.ts`, `event-signup.ts`, `discord-thread.ts` stay (pure Discord helpers).

---

## 13. Migration and cutover

### 13.1 Modes (D9)

`tenants.discord_delivery_mode`:

- `off` (default for every existing tenant after migration): outbox rows are written and janitored after 24 h; not claimable;
  scheduler skips the tenant; the legacy poller keeps working exactly as today.
- `shadow`: scheduler runs in dry-run (`tracing` + counters `scheduler_would_start`, `would_mass`, ...) to be compared with
  what the poller actually did; outbox rows are still not claimable.
- `on`: claimable, scheduler active, `event_sessions` auto-stop pass skipped for the tenant (idempotent anyway).

Flip paths: `PUT /api/platform/tenants/{id}/discord-delivery-mode` (platform admin) and the importer (13.4). The bot reads
`mode` from the session response; in `DELIVERY_MODE=outbox` it only runs reducers for tenants with mode `on`, in
`DELIVERY_MODE=poller` it only runs the old poller for tenants with mode `off|shadow` (a few lines in `index.ts` while both
code paths exist, S5-S9). After S10 the mode column is dropped and `on` is hard-wired.

### 13.2 Order of operations (zero downtime)

1. Deploy backend S1-S4 (tables, hooks, routes, scheduler in dry-run). All tenants `off`; behaviour unchanged.
2. Set a canary tenant to `shadow` for 48 h; compare would-be vs real lifecycle (alert on divergence).
3. Deploy bot with the executor (S5) in `DELIVERY_MODE=poller` (no change), then switch the canary: bot `DELIVERY_MODE=outbox`
   runs the importer for the canary tenant, which sets mode `on` as its LAST step. The poller for that tenant is not
   instantiated (the bot decides per tenant from the session `mode`).
4. Roll tenant by tenant. Alliance tenants last (they have no state file).
5. S10 removes the poller after all tenants are `on` for one release.

### 13.3 Data already in the database (no bot involvement)

Done inside the tenant migration (section 3.1): split ids -> bindings, giveaway message ids -> bindings, VOD thread ids,
voice channel ids, VOD pending / attempted -> outbox rows.

### 13.4 Importing `poller-state-<guild>.json`

`delivery/import-legacy-state.ts` runs per tenant, before mode flips to `on`, only if the file exists:

1. Parse with a tolerant zod schema (all fields optional, `.passthrough()`), mirroring `loadState` (`poller.ts:265-327`) so unknown or
   hotfix-added keys are ignored. Ignore `*.tmp`. Compute sha256 for `import_source`.
2. `POST /api/bot/import` (tenant-scoped, idempotent):

```json
{ "source": "poller-state-1234.json sha256:..",
  "events": [ {"event_id": 412, "thread_id": "..", "parent_message_id": "..", "signup_message_id": "..", "signup_revision": "7:scheduled:2026-.."} ],
  "calendar": [ {"channel_id": "..", "message_ids": ["..",".."], "fingerprints": ["..",".."]} ],
  "massed": [412], "pinged_1h": [412], "archived_event_ids": [300],
  "last_battle_id": 118234, "posted_giveaway_ids": [7], "announced_giveaway_draws": [7],
  "applications_open": true,
  "pending_announces": { "431": { "status": "ambiguous", "attempts": 3 } } }
```

3. Backend, in one txn per tenant:
   - each `events[]` row whose event exists and is not archived -> `discord_bindings(event, 'announcement', active, channel_id=NULL, message_id=parent, thread_id, card_message_id, applied_fingerprint=signup_revision)` with `ON CONFLICT DO NOTHING` (backend truth wins; never overwrites);
   - `massed` / `pinged_1h` -> `events.mass_notified_at / reminder_notified_at = now()` where the column is NULL (prevents a duplicate mass after cutover);
   - `archived_event_ids` -> bindings `deleted`;
   - `calendar` -> bindings (calendar, slot=channel);
   - `last_battle_id` -> `discord_delivery_state.battle_floor_id = max(existing, value)`;
   - `pending_announces[*].status = 'ambiguous'` -> outbox `event.upsert` row in `ambiguous` (admin sees it; no auto create);
   - events still `scheduled|live` with NO binding after the import -> `event.upsert` with `ping=false` (silent recovery; the reducer adopts by thread-name before creating, `recovering=true`);
   - `discord_delivery_state.imported_at = now(), cutover_at = COALESCE(cutover_at, now())`;
   - sets `tenants.discord_delivery_mode = 'on'`.
4. On `200` the bot renames the file to `poller-state-<guild>.json.imported` (kept for rollback and audit, deleted in S10 + 1 release).
5. File missing (the bot-arch-1 failure: lost volume, new tenant): the importer posts an EMPTY import. Result: no history spam
   (events older than `cutover_at` never ping, terminal events are never touched, battles below `battle_floor_id` -
   seeded at `max(existing battle id)` by the backend when no `last_battle_id` is supplied - are never announced), and
   scheduled / live events without bindings are recreated silently with name-based adoption. This is the principled
   replacement for `initialized` / `adoptCheckpointBaseline` (`poller.ts:643-699`): the backend never "reseeds" silently,
   and nothing swallows events created in the gap, because delivery is driven by rows, not cursors.
6. Re-running the importer is a no-op (`imported_at` set; bindings `DO NOTHING`).

### 13.5 Rollback

Within the first release, flip a tenant back to `off` (platform endpoint) and run the old bot with `DELIVERY_MODE=poller`.
The `.imported` file is renamed back. Limitation: the old file does not know events announced while in `on`
mode, so the legacy poller would re-announce events created since the flip (bounded by time-in-`on`; accepted, documented in
the runbook). Mitigation: keep `on` windows short for the canary.

### 13.6 Independence from `fix/bot-poller-hotfix`

- Nothing in S1-S4 touches `apps/discord-bot`.
- S5 adds files under `src/delivery/` and edits only `index.ts` wiring + a mode switch; it does not modify `poller.ts`.
- The importer depends only on the persisted JSON shape (tolerant parse above). If the hotfix changes `saveState` to
  tmp+rename (WP5), the importer ignores `*.tmp`; if it adds keys, they are ignored; if it removes the `initialized` gating,
  nothing here reads it.
- S10 deletes `poller.ts`: if the hotfix lands first, its changes are simply dropped with the file; if it lands after, rebase = delete. Conflict surface is limited to one deletion.
- No assumption about `eventThreadIds` retention bug (events-1) being fixed: the importer imports whatever map exists; events missing a mapping are recovered by silent upsert + name adoption (a deliberate property).

### 13.7 The four copy mechanisms

This subsystem does not re-implement them; contract points only:

| Mechanism | Contact point |
|---|---|
| `alliance_shares` | none (artifact copies); builds/comps have no Discord presence. |
| `event_fanout_*` (alliance -> guild) | `process_target` (`fanout_worker.rs`) must create copies via a function that calls `touch_event(Created)` in the target tenant txn, and apply updates via `converge_copy_to_source` -> `transition`. The fanout target `complete` state SHOULD additionally expose "delivered to Discord" by reading the copy's outbox state (`GET /api/discord/outbox?entity=event:{id}`) rather than a new ack path. |
| `event_mirror_requests` (guild -> alliance) | same: `create_mirror` calls `touch_event`. |
| register one-shot copy + split distribution | no Discord interaction beyond split `split.upsert` on distribution status changes (11.3). |

---

## 14. Web exposure (read-only for this subsystem; UI belongs to the frontend subsystem)

- `GET /api/discord/status` -> `{ mode, bot_connected, transport, last_seen_at, pending, oldest_pending_age_s, failed, ambiguous, skipped_config }`.
- `GET /api/discord/outbox?state=failed|ambiguous|skipped&entity_type=&entity_id=&limit=` (permission: the one guarding guild
  settings in `admin/router.rs`).
- `POST /api/discord/outbox/{id}/retry` (re-arm `failed|skipped|ambiguous`; for `ambiguous` sets `recovering=true`),
  `POST /api/discord/outbox/{id}/dismiss` (-> `skipped('manual')`).
- `GET /api/events/{id}` gains `discord: { state: ok|pending|failed|ambiguous|unconfigured, thread_url, items:[{kind,state,attempts,last_error,next_attempt_at}], warnings:["no_voice_category"] }` computed from bindings + latest outbox row per kind. `thread_url = https://discord.com/channels/{guild}/{thread_id}`.
- `POST /api/events/{start|stop|cancel|uncancel|remind}` responses add `effects: [{id, kind}]`.
- Alliance / guild badges in the sync status API (sync-engine subsystem) can join the copy's `discord.state` per guild.

---

## 15. Failure modes

| Failure | Behaviour |
|---|---|
| Bot down 2 h | Rows wait; coalesced upserts; mass/reminder/start rows past `expires_at` skipped; ordered, fairness-bounded drain on reconnect. Web banner "bot offline" from `discord_bot_instances`. Scheduler keeps transitioning events (status/XP/auto-stop are backend truth). |
| Backend restart | Outbox in DB; SSE reconnect; leases expire or are reclaimed by `instance_id`; scheduler resumes (conditional UPDATE, no double fire). |
| Crash after Discord create, before ack | `recovering=true` on reclaim; reducer `verify`s (marker / saved binding ids / name) and adopts; else `ambiguous` visible. Checkpoints narrow the window to a single Discord call. |
| Two bot instances | Items routed by `guild_ids`; leases fence; newest connection of an `instance_id` wins. |
| Duplicate NOTIFY / missed NOTIFY | Idempotent claim; 30 s safety sweep. |
| Channel not configured | `skipped(config)`; auto re-arm on settings change; visible in admin list. No 60 s retry loop (bot-arch-11). |
| Missing permissions | `failed(permission)`; visible; retry button. |
| Stale lease acking | `409 lease_lost`; bot drops result. |
| Event deleted while rows pending | `render` returns 404 -> reducer acks `skipped('entity_gone')`; the binding is closed by `event.remove`. |
| Hot loop on a broken entity | Per-entity head-of-line + attempts cap + backoff; other entities unaffected. |
| Clock skew bot/backend | All times server-side (`now()` in SQL); bot only echoes `lease_until`. |
| Huge broadcast (DMs) | Per-kind concurrency + bucket; independent entities. |
| Settings changed mid-flight | Render reads fresh routes; reducers converge to current routes. Messages already in an old channel are left (documented). |
| Voice occupied at stop | `voice.release` retries 120 s up to 6 h, then skipped. |
| Orphaned voice channels | hourly `voice.sweep` with explicit keep list. |
| Scheduler stale event (>4 h overdue, still scheduled) | `Skip{stale}` + WARN, not auto-started. |
| `LISTEN` connection dropped | Hub reconnects, marks all tenants dirty. |
| Unsupported kind (older bot) | `fail(fatal, unsupported_kind)`; visible; backend `protocol` negotiation lets the server withhold unknown kinds (`session.protocol`). |

---

## 16. Observability

`tracing` fields `tenant_id`, `outbox_id`, `kind`, `entity`, `attempt`, `instance_id`, `cause`. Counters/gauges (exposed via the existing
telemetry module `telemetry.rs`): `discord_outbox_pending{tenant,kind}`, `oldest_pending_age_seconds`, `discord_outbox_claimed_total`,
`ack_total{outcome}`, `fail_total{class}`, `lease_expired_total`, `scheduler_actions_total{action}`, `scheduler_tick_seconds`,
`reconcile_drift_emitted_total` (alert > 0: a call site missed `touch_event`), `sse_connections`, `bot_last_seen_seconds`.

---

## 17. Test strategy

### 17.1 Rust unit tests (SQLite, inline `#[cfg(test)]`, no env)

- `kinds.rs`: policy table completeness (every `EffectKind` has class, priority, supersedes target valid).
- `outbox.rs`: emit once_key idempotency; coalescing keeps one pending row and min `available_at`; supersession matrix; head-of-line
  ordering (a later row for the same entity is not claimable while an earlier is pending/leased; other entities are); lease
  token fencing (stale ack -> `lease_lost`); expiry -> `skipped(expired)`; `fail` class transitions and backoff values (extracted
  `retry::backoff` shared with `mirror_retry`); `reclaim_expired` sets `recovering`; `rearm` after settings change.
- `scheduler::plan` with an injected clock and in-memory snapshots: >50 future events plus a due event still fires (regression bot-arch-5),
  start due skips mass, reminder skipped for events created inside the hour, copies never `Start/AutoStop`, stale events skipped,
  voice-empty rule with fresh/stale/never-occupied presence, deadline stop, flash events.
- `lifecycle::transition`: effect equivalence across `Cause` (5.3); `mass_notified_at` stamped on Start; Stop idempotent without new rows; converge does not overwrite tenant-local columns.
- `reconcile::drift`: fingerprint excludes `updated_at` (linker noise does not emit), roster bump does, terminal-with-active-binding emits close.
- `render.rs`: fingerprint stability (golden hash), routes resolved fresh, copy flag, skip reasons.
- Migration up/down on SQLite and column-by-column alters (guards the WP0 regression class).

### 17.2 Rust integration tests (Postgres, `TEST_DATABASE_URL` only, the `postgres.rs` helper after WP0 removes the `DATABASE_URL` fallback)

- Concurrent `claim_due` from 8 tasks over 200 rows: disjoint sets, none lost, none duplicated (`SKIP LOCKED`).
- Two schedulers ticking the same tenant: exactly one `event.start` row and one status flip.
- NOTIFY wakeup: `emit` in a txn, listener fires only after commit, not on rollback.
- Crash recovery: lease an item, simulate death (`lease_until = now() - 1s`), second instance claims, `recovering=true`, first instance's ack gets 409.
- Reconnect fast path: same `instance_id` reconnect reclaims immediately.
- Cross-tenant fan-in fairness: 3 tenants x 100 rows, claim batch distribution <= 5 per tenant per round.
- SSE end-to-end: spawn the router on an ephemeral port, connect with `reqwest` streaming, assert keepalive, item push latency < 1 s after commit, `event: tenants` on mode flip, duplicate connection kicks the old one.
- Web/bot parity: `POST /api/events/{id}/start` as session user and as bot (X-Bot-Secret + X-Discord-Id) produce equal outbox rows.
- Import endpoint: idempotent, `DO NOTHING` on conflicts, sets mode last, empty import behaves as in 13.4(5).
- Alliance: alliance tenant with a guild-origin copy: the copy's outbox gets `event.upsert`; alliance scheduler fires `event.mass` for it and never changes its status; converge start emits the copy's `event.start`.
- Giveaway draw due without Albion scope still draws (finance-9 regression) and emits `giveaway.result`.

### 17.3 Bot tests (`node --test`, `dist/**/*.test.js`, existing runner)

- `outbox-client`: SSE parser with arbitrary chunk boundaries, comment pings, reconnect backoff, 45 s stall -> fallback poll, dedupe by lease token, `404 session_required` re-register.
- `dispatcher`: per-entity serialization, concurrency caps, lease `extend` cadence (fake timers), timeout -> `retryable`, stale `409` drop, unknown kind -> `fatal`.
- Reducers with a fake discord.js client and fake API: `event.upsert` runs twice -> one Discord create; crash after parent create (fake throws) then recovery run with `recovering=true` adopts via marker and does not re-ping; self-heal on 10008; calendar skip in `message` mode; voice reducer cases (unconfigured, reuse, adopt-by-name, occupied retry, conflict compensation); DM 50007 -> skipped; giveaway update debounce payload.
- `classifyDiscordError` table test.
- `import-legacy-state`: fixtures built from a real `PollerState` JSON (current shape and the hotfix variants), extra keys ignored, `*.tmp` ignored, missing file -> empty import, re-run no-op.
- Contract/golden: Rust integration test writes `claim` / `render/event` / `ack` JSON samples to `apps/discord-bot/test-fixtures/outbox/*.json` (checked in, regenerated with an env flag); bot tests parse them with the same zod schemas used at runtime, so a backend change that breaks the bot fails CI on both sides.
- Scenario "bot off for two hours" as a dispatcher test over a fixture of ~200 mixed rows (expired mass skipped, coalesced upserts, DM bucket respected).

### 17.4 Manual / staging

Canary tenant `shadow` for 48 h, then `on`; checklist: web start produces voice + notice + card refresh; Discord `/event-start` identical;
auto-stop by deadline posts final card before locking; kill -9 the bot mid-announce and verify no duplicate; disable events channel -> `skipped(config)` -> set channel -> auto announced; alliance guild-origin event shows exactly one announcement on the alliance Discord.

---

## 18. Implementation slices (each one PR, independently mergeable, ordered)

Branch names follow `<type>/<desc>` from `origin/main`. Baseline WP0 (green SQLite migrations, `TEST_DATABASE_URL`) is a prerequisite for S1.

**S1 `feat/discord-outbox-core` (backend, inert).**
Scope: tenant migrations (tables 3.1, column adds one per step), control migration (3.2), `discord_delivery::{kinds, outbox, bindings}`, shared `retry::backoff`, split/giveaway/vod/voice data backfill SQL, `CONTROL_MIGRATION_COUNT` update. No producer, no route, no worker.
Acceptance: all 17.1 outbox/kinds/migration tests; Postgres claim concurrency + crash-recovery tests; migration up/down on SQLite and Postgres; `cargo test` and clippy clean for the new module.

**S2 `feat/discord-bot-api` (backend, inert without a client).**
Scope: `hub.rs` (+ `tokio-stream`, `PgListener`), `/api/bot/{sessions,outbox/stream,outbox/claim,outbox/{id}/ack|fail|extend,bindings,signals,import}`, `skip_tenant_resolution` entries, OpenAPI annotations, `/api/discord/{status,outbox,retry,dismiss}`, `PUT /api/platform/tenants/{id}/discord-delivery-mode`, golden fixture writer.
Acceptance: SSE end-to-end tests, ack side effects (voice column, dm status), lease fencing over HTTP, fairness, mode gating (an `off` tenant yields nothing), 17.2 import tests (import logic may land here or S6; endpoint stub returns 501 until S6).

**S3 `feat/event-effects` (backend).**
Scope: `lifecycle::transition` choke point and refactor of `start_event`/`stop_event_with_xp_policy`/`cancel`/`uncancel`/`archive`/`unarchive`, `touch_event` at every site in 5.1, `converge_copy_to_source` via `transition`, `remind_event` real effect, flash `available_at`, `render/event`, `render/calendar`, reconcile drift sweep, `on_settings_changed`, responses with `effects[]`, `GET /api/events/{id}` `discord` block. Rows are written for every tenant (mode `off` janitor).
Acceptance: effect-equivalence tests (5.3), reconcile tests, Postgres parity test (web vs bot start), converge keeps tenant-local columns, existing events/lifecycle tests still green.

**S4 `feat/backend-event-scheduler` (backend).**
Scope: `scheduler.rs` (`plan` + `run_tenant`), `TenantRegistry::active_tenant_ids`, `signals.rs` + `event_voice_presence`, move `auto_stop.rs`, `draw_due`, XP retry into `run_tenant`, shadow mode counters, janitor, `voice.sweep` seeding, alliance tenants included.
Acceptance: `plan` unit matrix (17.1), two-scheduler race on Postgres, alliance-origin and copy behaviour test, giveaway draw without Albion scope, auto-stop moves with no behaviour regression for guild tenants in mode `on`, `off` tenants keep legacy behaviour (event_sessions auto-stop still runs).

**S5 `feat/bot-outbox-executor` (bot).**
Scope: `src/delivery/*` (client, dispatcher, signals, event / calendar / voice reducers), `DELIVERY_MODE`, per-tenant mode switch in `index.ts`, `POST /api/events/*` driven command/button/modal paths (remove `pollNow`, `startDiscordEvent`/`stopDiscordEvent` callers, `findEventIdForThread` -> bindings), `/event-calendar-refresh`. `poller.ts` untouched.
Acceptance: 17.3 client/dispatcher/reducer tests; golden fixtures consumed; with `DELIVERY_MODE=poller` behaviour identical to today (existing tests green).

**S6 `feat/discord-delivery-cutover` (backend + bot).**
Scope: import endpoint + `import-legacy-state.ts`, platform mode flip tooling, runbook (13.2/13.5), canary dashboards (section 16).
Acceptance: importer fixture tests, idempotency, empty-import behaviour, silent recovery events, no duplicate mass after import (`massed` mapping), canary tenant in staging passes the manual checklist (17.4). After this slice production tenants can move to `on`.

**S7 `feat/discord-delivery-kinds` (backend + bot).**
Scope: `split.upsert` (bindings replace `split_discord_sync` reads, no cursors), `giveaway.*`, `vod.*`, `application.panel`, `battle.announce` (hook in `battle_sync`), `voice.sweep` reducer; render endpoints for each.
Acceptance: per-kind emit + reducer idempotency tests; split summary never advances cursors; giveaway web entry refreshes the Discord count; battle floor prevents history flood; VOD `ambiguous` retry flow.

**S8 `feat/discord-dm-delivery` (backend + bot).**
Scope: `dm.send` emission in `NotificationService::notify`, `render/notification`, DM reducer + throttle, remove `/warn` self-DM, `discord_dm_status` lifecycle.
Acceptance: broadcast of 300 recipients drains within throttle limits; 50007 -> `skipped`; web-issued and Discord-issued warns both DM exactly once; statuses leave `pending`.

**S9 `refactor/drop-ping-alliance-legacy` (backend + bot; depends on sync-engine slice making guild->alliance mirror the announcement path).**
Scope: delete `alliance_discord_message_id` and `AlliancePingTargets` plumbing (10), bot alliance helpers and `eventApi`, `postAlliance*`; render `ping_roles` for copies.
Acceptance: Postgres test "guild event with `ping_alliance` produces exactly one announcement on the alliance Discord (one `event.upsert` in the alliance tenant, zero direct posts)"; lifecycle notices on alliance copy come from the alliance scheduler / converge; PATCH no longer accepts the removed field (OpenAPI diff).

**S10 `chore/remove-poller` (bot + backend cleanup).**
Scope: delete `poller.ts`, `poller-manager.ts`, tests, `listSinceCheckpoint`, `POLL_INTERVAL_MS`, `getPoller` shims, `event-lifecycle.ts` orchestration; backend: `GET/PUT /api/splits/*/discord-sync`, `events/vod-forum-posts/*`, `PUT /api/giveaways/{id}/discord-message`, `PUT|DELETE /api/events/{id}/discord-voice-channel` (router `:262`), `split_discord_sync` table, `events.vod_forum_post_status` legacy values; drop `discord_delivery_mode` (`on` hard-wired); delete `.imported` files after one release.
Acceptance: `rg "Poller|listSinceCheckpoint|poller-state"` empty in `apps/discord-bot/src` (except changelog); bot boots with no writable state dir; OpenAPI diff shows only the removals above; full bot and backend suites green.

**S11 `feat/web-discord-delivery-panel` (frontend, depends on S3 + S2 `/api/discord/*`).**
Scope: delivery chip + thread link + retry on `event-detail`, admin Discord settings page with failed / ambiguous / skipped list and bot-offline banner. Owned with the frontend subsystem.
Acceptance: component specs against the real `ApiService` envelope; retry button hits `POST /api/discord/outbox/{id}/retry`.

Dependencies: S1 -> S2 -> {S3, S4} -> S5 -> S6 -> {S7, S8} -> S10; S9 after the sync-engine mirror slice and S6; S11 after S3.
S3 and S4 can proceed in parallel with the sync-engine work provided the contract in 5.2 (converge uses `transition`, tenant-local columns preserved) is respected.

---

## 19. Contracts and open points for other subsystems

1. **Sync engine**: all event writes in tenant schemas (create, converge, archive) go through `touch_event` / `transition`; converge never overwrites `mass_notified_at`, `reminder_notified_at`, `discord_voice_channel_id`; propagation after scheduler transitions calls `sync_owner_change_to_copies`.
2. **Battles**: settle window and `min_players` decide when `battle_sync` calls `emit(battle.announce)`; this subsystem only provides `battle_floor_id` and the effect.
3. **Members subsystem** (`GuildMemberAdd/Remove/Update`, role changes): shares the bot's session and `signals` endpoint style but is a separate route (`POST /api/members/sync`); no outbox involvement.
4. **Splits**: net pool / fee / value fields are computed in the split render (finance-2); permissions for complete / close are the finance subsystem's.
5. Checks to verify during implementation (not verified in this read-only pass): `sea_orm::sqlx` re-export for `PgListener`; whether `tokio-stream` is already a transitive dependency; flash event mass / start derivation (`commands/flash.ts`, `services/flash-time.ts`); exact `event_discord_roles` write sites for `touch_event`; the permission key guarding guild settings for `/api/discord/*`.
6. Small intentional behaviour changes to confirm with the owner when reviewing (none contradict settled decisions): scheduler-initiated stops are `auto_stopped` (including voice-empty); no 1h reminder for events created inside the last hour; stale overdue `scheduled` events are not auto-started; a Start from Discord no longer replies synchronously with the voice channel link.
