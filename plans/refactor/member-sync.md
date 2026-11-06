# Design: Member / Identity Sync and Onboarding

Subsystem owner: WP1 (identity hardening) + WP11 (member sync) + the member/link/role part of WP8 (membership lifecycle).
Repo root for all paths: `apps/backend/src` (BE), `apps/discord-bot/src` (BOT), `apps/frontend/src/app` (FE). Line numbers refer to the current worktree.

Owner decisions applied (not re-opened): everything bidirectional, origin tenant owns its records and copies are read-only, leave/expel keeps history, auto-provision on first Discord interaction, bot forwards member/role gateway events, ex-members soft-deactivated, no ownership proof for Albion links, backend decides scheduling and bot only executes.

---

## 0. Scope and contracts with other subsystems

In scope: `users` lifecycle (provision, deactivate, reactivate), role snapshot and staleness, `POST /api/members/sync`, reconcile worker, `LinkOrchestrator`, link/role/nickname propagation between a guild and its alliance (both Discords), alliance join/leave/expel effects on members, identity hardening (auth-1, 4, 5, 6, 12, 19).

Out of scope (owned by other design docs, only interfaces are fixed here):

| Interface | Provided by me | Consumed by |
|---|---|---|
| `identity::ensure_member(db, MemberSeed)` | S2 | events fanout/mirror/share (replace all ad-hoc `upsert_discord_user` calls and ad-hoc placeholder emails) |
| `identity::member_guilds(control, discord_id, alliance_id)` = guilds where the member is Discord-present (`user_tenant_memberships`) plus the link's home guild | S8 | `events/attribution.rs:30 eligible_participation_guilds` |
| `MemberLifecycleHooks::on_member_left(db, user_id)` (default no-op) | S4 | events slice registers "withdraw from non-terminal events and enqueue participation sync"; progression excludes inactive |
| `identity_jobs` queue helpers (`enqueue`, `claim_due`, `complete`, `fail`) | S5 | sync-engine WP9 may adopt the same helpers for `sync_jobs`; my tables stay separate so the slices are independently mergeable |
| `DiscordRest` typed client (`modules/discord_api`) | S3 | everyone who calls Discord REST |
| Alliance-event backfill on accept (non-terminal events) | not mine | events/alliance slice hooks `alliance_backfill` job completion; I only backfill users, links, roles |

---

## 1. Current state, with the defects this design closes

| Id | Where | Defect |
|---|---|---|
| auth-1 | `auth/router.rs:745` -> `auth/service.rs:475-543` | `finalize_session` calls `AuthService::upsert_user`, which falls back to email and unconditionally sets `discord_id` (`:530`). `DiscordUserProfile` (`service.rs:31`) has no `verified`. The safe `users/identity.rs:54 upsert_discord_user` exists but only fanout code uses it. |
| auth-2 | `BOT services/command-gate.ts:83,125`, `website-account.ts:24`, `handlers/select.ts:40,210,327`, `handlers/button.ts:620`, `services/event-thread-command.ts:298`, `services/event-authority.ts:45`; BE `auth/rbac.rs:320-325` | Bot refuses everything (even `/register`) until a web login created the `users` row. |
| auth-3 / members-16 | `BOT index.ts:209-249` | Only `GuildMemberAdd` is handled, and it calls `api/albion/link/me` as a user who has no row, so it 401s. `users.role` is only rewritten by web paths (`rbac.rs:218`, `auth/router.rs:951`). Ex-members stay in lists forever. |
| auth-4 | `platform/service.rs:1199-1213, 1294-1308`, `auth/router.rs:415-451` | `user_tenant_memberships` is insert-only. `Absent` is mapped to the default role (`auth/service.rs:365-377`), so a removed member still logs in. |
| auth-5 | `auth/service.rs:392-459`, `auth/router.rs:935-942`, `service.rs:629` | `Unavailable` keeps cookie roles forever, cookie slides 7 days on every `/me`, member-lookup cache is unbounded. |
| auth-6 | `platform/service.rs:2103` `guild_owner_matches` requires `kind == "guild"` | Alliance owner has no bypass. |
| auth-8 / parity-16 | `albion/router.rs:295,377` duplicate each other; `:540,:590` and `users/router.rs:427` skip guard, role assignment and fanout | Four entry points, four behaviours. |
| auth-9/10, alliance-11/12/14 | `platform/service.rs:871`, `:995-1044`, `:1141`, `albion/alliance_fanout.rs:111-175` | No backfill on accept, revocation retries only inside the guild's own `/leave`, link fanout is one-shot best-effort, `adopt_existing_member_link` mutates inside a GET. |
| auth-12 / members-17 | `users/service.rs:27-36, 95-102, 576-582`, `users/router.rs:226-310` | Every member sees every email and can filter by exact email. `/users/{id}/roles` is open and calls Discord live per request. |
| auth-19 | `users/router.rs:328-345`, `member_roles.rs:385-401` | Tenant owner without a mapped role fails the priority check. |
| attribution | `events/attribution.rs:30-60` | `eligible_participation_guilds` reads `user_tenant_memberships`, which today means "ever logged in", so alliance signups attribute to guilds the member left. |

---

## 2. Target design

### 2.1 Principles

1. The Discord guild is the source of truth for presence and roles. The backend keeps a snapshot (`users.discord_role_ids`, `active`) fed by gateway events, a periodic REST reconcile, and every bot interaction (which carries the member's role ids).
2. A `users` row is created by the backend on first contact, from any path, through one function (`ensure_member`). Email is contact data, never identity.
3. Every cross-tenant effect (link copy, user copy, Discord role/nickname) is a job whose payload is only a key. The handler recomputes desired state from current truth, so jobs are idempotent, coalescable and replayable. Intent is enqueued before the local commit, truth is checked by the handler; a crash between the two yields an `obsolete` job, never a lost effect.
4. Origin owns: an `albion_links` row has `origin_tenant_id` (NULL = declared here). Copies are written only by the propagation handler. Mutating commands issued in a copy tenant are routed to the origin by `LinkOrchestrator` (permission is checked against the caller in the tenant they called from, the write is applied at the origin, the copy then follows). The data-level rule "only the origin writes" holds.
5. Topology is a star: guild <-> its alliance. Links propagate guild -> alliance, and alliance -> home guild only (the member guild whose `albion_guild_id` equals the player's guild). Never guild -> guild.

### 2.2 Data model

#### Tenant schema (`src/migration`, portable: one `alter_table` per column, SQLite-safe, WP0 rule)

`m20261110_000001_users_member_lifecycle` on `users`:

| Column | Type | Default | Meaning |
|---|---|---|---|
| `active` | bool NOT NULL | `true` | Present in this tenant's Discord (or proven by an interaction). |
| `left_at` | timestamptz NULL | | Set on deactivation, cleared on reactivation. |
| `left_reason` | text NULL | | `left`, `absent_on_check`, `reconcile`, `not_joined` (row created by cross-tenant propagation, member never seen in this Discord). |
| `discord_role_ids` | text NOT NULL | `'[]'` | JSON array of Discord role snowflakes, sorted, unique. Text, not array, so SQLite tests work. |
| `roles_checked_at` | timestamptz NULL | | Last time the snapshot was confirmed against Discord. NULL = unknown = stale. |
| `member_event_at` | timestamptz NULL | | `occurred_at` of the last applied sync event (ordering guard). |
| `provisioned_via` | text NOT NULL | `'web'` | `web`, `bot`, `gateway`, `reconcile`, `admin`, `alliance_sync`, `event_sync`. Data-fix: `UPDATE users SET provisioned_via='sync' WHERE email LIKE '%@discord.invalid' OR email LIKE '%@alliance.local' OR email LIKE '%@event-sync.invalid' OR email LIKE '%@example.invalid'`. |
| `last_link_change_at` | timestamptz NULL | | Self-service link/unlink cooldown. |

Index `idx_users_active_id (active, id)`. `users.role` stays as a denormalized "highest role" cache, now recomputed from `discord_role_ids` whenever the snapshot changes or the role mapping changes (hook in admin role-link PATCH, `admin/service.rs:716-756`).

`m20261110_000002_albion_links_origin` on `albion_links`: `origin_tenant_id text NULL`, `origin_link_id bigint NULL`, `albion_guild_id text NULL` (player's Albion guild at link time; lazily enriched for old rows), `declared_via text NOT NULL DEFAULT 'web'` (`web|bot|admin|provision|sync`), `detached_at timestamptz NULL`. Index `idx_albion_links_origin (origin_tenant_id)`. The existing unique constraints on `discord_id` and `albion_player_id` stay.

`m20261110_000003_guild_settings_member_sync`: `guild_settings.members_provision_all bool NOT NULL DEFAULT true` (reconcile creates rows for every non-bot member; set false to only update existing rows).

#### Control plane (`src/control_migration`, Postgres only)

`m20261110_000001_identity_jobs`:

```sql
CREATE TABLE identity_jobs (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN
    ('tenant_reconcile','member_joined','member_left','link_sync','effects_sync',
     'alliance_backfill','alliance_detach','link_origin_backfill')),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, -- origin / subject tenant
  subject TEXT NOT NULL DEFAULT '',            -- discord_id; '' for tenant-scope kinds
  partner_tenant_id TEXT NOT NULL DEFAULT '',  -- guild for alliance_* kinds
  once_key TEXT UNIQUE,                        -- one-shot jobs (boot reconcile, origin backfill)
  cursor TEXT,                                 -- paging position for backfill/reconcile
  payload JSONB NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','processing','failed','done','blocked','conflict','exhausted','obsolete')),
  error_class TEXT,                            -- transient | blocked | conflict | permanent
  attempts INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL DEFAULT 12,
  dirty BOOLEAN NOT NULL DEFAULT false,        -- enqueued again while processing
  last_error TEXT,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ, lease_token UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_identity_jobs_live
  ON identity_jobs (kind, tenant_id, subject, partner_tenant_id)
  WHERE state IN ('pending','processing','failed');
CREATE INDEX idx_identity_jobs_due ON identity_jobs (run_after)
  WHERE state IN ('pending','failed','processing');

CREATE TABLE member_facet_state (            -- what the status API and the UI read
  discord_id TEXT NOT NULL,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, -- where the facet lives
  facet TEXT NOT NULL,                       -- 'user' | 'link' | 'nick' | 'role:<discord_role_id>'
  origin_tenant_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('ok','pending','not_in_guild','blocked','conflict','detached')),
  detail TEXT, job_id UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (discord_id, tenant_id, facet)
);
CREATE INDEX idx_member_facet_problem ON member_facet_state (tenant_id, state) WHERE state <> 'ok';

CREATE TABLE tenant_member_sync (            -- per-tenant health, shown in admin
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'never'
    CHECK (state IN ('never','running','ok','blocked','suspicious','failed')),
  last_started_at TIMESTAMPTZ, last_completed_at TIMESTAMPTZ, last_error TEXT,
  members_seen INT, approx_member_count INT, would_deactivate INT,
  deactivated INT, provisioned INT, gateway_last_event_at TIMESTAMPTZ
);
```

`m20261110_000002_membership_lifecycle`:
- `alliance_memberships`: `left_reason text` (`left|expelled|reset`), `left_by text`.
- `alliance_role_revocations` (created in `m20261028_000001`): add `attempts int NOT NULL DEFAULT 0`, `next_attempt_at timestamptz NOT NULL DEFAULT now()`, `lease_until timestamptz`; replace check `alliance_role_revocations_status_check` with `('pending','verified','ambiguous','blocked','exhausted')`.
- `user_tenant_memberships`: no column change, but its meaning becomes "Discord-present in that tenant" (maintained by sync). Add `idx_utm_tenant (tenant_id)` for prune.

Existing control tables kept unchanged: `alliance_role_grants` (the ledger of roles this system granted, the only thing it may revoke), `alliance_memberships`.

### 2.3 Identity module (`users/identity.rs`)

```rust
pub enum Presence { Present, Unknown }          // Unknown = cross-tenant copy, no Discord proof
pub enum Via { Web, Bot, Gateway, Reconcile, Admin, AllianceSync, EventSync }
pub struct MemberSeed<'a> {
    pub discord_id: &'a str,
    pub username: Option<&'a str>,
    pub verified_email: Option<&'a str>,        // only login passes this
    pub role_ids: Option<&'a [String]>,         // None = do not touch the snapshot
    pub presence: Presence, pub via: Via, pub event_at: DateTime<Utc>,
}
pub struct Ensured { pub user_id: i64, pub created: bool, pub reactivated: bool }
pub async fn ensure_member(db: &DatabaseConnection, seed: MemberSeed<'_>) -> Result<Ensured, AppError>;
pub async fn deactivate(db, user_id, reason: &str, at: DateTime<Utc>) -> Result<bool, AppError>;
pub async fn find_by_discord_id(db, discord_id) -> Result<Option<users::Model>, AppError>;  // replaces user_id_for_discord_id
pub fn provisional_discord_email(discord_id: &str) -> String;  // single source: "<id>@discord.invalid"
```

Rules:
- Insert is `Entity::insert(..).on_conflict(OnConflict::column(DiscordId)...).exec_with_returning` (works on SQLite and Postgres), so two concurrent first contacts converge on one row. The placeholder email is derived from the snowflake, so the `email` unique index cannot collide.
- `Present` sets `active=true, left_at=NULL, left_reason=NULL`. `Unknown` on a new row sets `active=false, left_reason='not_joined'`; on an existing row it never changes `active`.
- An event older than `member_event_at` changes nothing (`ignored_stale`). Bot interactions use `now()`.
- `verified_email`: only replaces an email that is a placeholder or equal. Claiming a legacy row with `discord_id IS NULL` by verified email is the only email-based identity rule left, and only login may use it.
- `upsert_discord_user` (`identity.rs:54`) becomes a deprecated wrapper; callers migrated in S2: `albion/alliance_fanout.rs:548`, `events/fanout_worker.rs:~206-286`, `alliance_share/service.rs:967`, `events/lifecycle.rs:1252`, `events/sync.rs:354`. The private `fallback_email` (`identity.rs:16`) and the ad-hoc `@alliance.local`, `@event-sync.invalid`, `@example.invalid` patterns are deleted. Real emails are no longer copied across tenants (also stops `mirror_retry` storing `actor_email`, `events/mirror_retry.rs:65-80`; events designer drops that column).

### 2.4 Auto-provisioning (auth-2)

Backend, `auth/rbac.rs:246-380 try_from_bot_headers`. A request "claims membership" when it carries `X-Discord-Role-Ids` (only `ApiClient.withDiscordActor` sets it, i.e. an interaction member in that guild):

```rust
let claims_member = parts.headers.contains_key("X-Discord-Role-Ids");
let row = identity::find_by_discord_id(db, &discord_id).await?;
let user = match (row, claims_member) {
    (Some(u), _) if u.active => u,
    (Some(u), true)          => reactivate(db, u).await?,                      // interaction proves presence
    (None,    true)          => ensure_member(db, seed_from_headers).await?,   // create
    (Some(_), false)         => return Err(AppError::Forbidden("member_inactive".into())),
    (None,    false)         => return Err(AppError::Unauthorized("member_not_provisioned".into())),
};
```
New optional header `X-Discord-Username` (percent-encoded UTF-8, <=100 chars, the Discord `user.username`; absent -> `user-<last6>`; the sync repairs it). On create or reactivate the handler also upserts `user_tenant_memberships` and writes the role snapshot from the header (write-through; this also fixes "the bot path never refreshes users.role").

Non-actor lookups (officer targets a member: `/warn`, `/xp`, `/rank`, `/warns`) cannot use the header trick, because the target is not the caller. New endpoint `POST /api/members/ensure` (bot secret + `X-Guild-Id`), body `{discord_id, username, role_ids?}`, response `{user_id, created, active}`. The bot calls it only after `interaction.options.getMember('user')` is non-null (target really is in the guild; a user option picking someone outside the server must be rejected bot-side). `BOT api/resolve-user.ts:10-47 resolveInternalUserId` shrinks to this one call, dropping the `api/users/me` and `api/auth/me` impersonation attempts and keeping the exact-match directory search only as a fallback for the `!` text commands.

`BotDiscordUser` (`rbac.rs:435`, tickets/applications) stays tolerant of missing rows; it now also benefits from provisioning since the actor header triggers creation in the other extractor.

Bot changes:
- Delete `services/website-account.ts` and its test (also removes the `FRONTEND_URL` dependency of BASE-5), the gate calls listed in section 1, and the "Website Account Required" reply.
- `api/client.ts:37-43,122-137`: `withDiscordActor(discordId, roleIds, username?)` and header `X-Discord-Username`. New helper `actorApiFor(interaction, guildApi)` in `services/actor.ts` used by `index.ts:170,183,196` and `command-gate.ts:79,121`, so no call site assembles it by hand.
- Deploy order: backend first. An old bot against the new backend still works (its `GET users/me` now provisions and returns 200). A new bot against an old backend degrades to a plain 401 message for never-seen users.

### 2.5 Gateway events -> `POST /api/members/sync`

Bot (`services/member-sync.ts`, `MemberSyncForwarder`), registered next to `index.ts:222`:

```ts
client.on(Events.GuildMemberAdd,    m        => fwd.add(m));          // keep assignJoinRole; drop the link/me call at :235-244
client.on(Events.GuildMemberUpdate, (o, n)   => fwd.update(o, n));    // only when role set / username / pending changed, or old is partial
client.on(Events.GuildMemberRemove, m        => fwd.remove(m));
client.on(Events.GuildRoleDelete,   r        => fwd.roleDelete(r));
```
`GuildRoleUpdate` is not forwarded: mapping is by role id and Discord renames are irrelevant. Bots (`user.bot`) and unregistered guilds (`isRegisteredTenant`) are skipped. The forwarder is in memory only (bot stays stateless): 2 s debounce, batches of at most 100 events, retry with backoff up to 60 s, queue cap 2000 (drop oldest, log). Anything lost is repaired by the reconcile (2.6). `GatewayIntentBits.GuildMembers` is already enabled (`index.ts:63`).

Backend contract (`members/router.rs`, extractor `BotSecret`, tenant from `X-Guild-Id`):

```
POST /api/members/sync
{ "events": [
   { "kind": "member_add" | "member_update" | "member_remove" | "role_delete",
     "occurred_at": "2026-11-05T10:00:00Z",
     "discord_id": "123", "username": "kay", "role_ids": ["1","2"], "pending": false,
     "role_id": "999" }                      // role_delete only
] }
-> 200 { "applied": 3, "ignored_stale": 1,
         "results": [ { "discord_id": "123", "user_id": 42, "active": true, "role": "Officer",
                        "changed": ["roles","username"] } ] }
```
Events are state assertions (full role set + timestamp), so replay is harmless. Application, in one tenant transaction per batch (`members/sync.rs::apply_events`):

| kind | effect |
|---|---|
| `member_add` | `ensure_member(Present)`; write snapshot, recompute `users.role` via `resolve_linked_roles` (`auth/service.rs:642`); upsert `user_tenant_memberships`; enqueue `member_joined` job. `pending=true` (membership screening) is stored but does not enqueue. |
| `member_update` | If newer than `member_event_at`: update snapshot, `role`, `username`, `roles_checked_at=now`; invalidate the per-tenant permission snapshot cache; if the highest role changed enqueue `effects_sync` only when the user has a link. |
| `member_remove` | `deactivate(reason='left')`; delete `user_tenant_memberships(discord_id, tenant)` (auth-4); run `MemberLifecycleHooks::on_member_left`; enqueue `member_left`. Link, XP, warns, splits are kept. |
| `role_delete` | strip the role id from every snapshot containing it (`discord_role_ids LIKE '%"<id>"%'`, rewrite in Rust), recompute `role`, reload `Permissions`. The admin role mapping row is left alone so the UI can show "linked role missing". |

Also updates `tenant_member_sync.gateway_last_event_at` (bot health for the admin panel). The same snapshot function `apply_role_snapshot(db, user, ids, at)` is used by every writer: sync events, bot interactions, login, web role editor write-through (`member_roles.rs:288,349 refresh_cached_highest_role` calls it), reconcile.

### 2.6 Reconcile worker (the safety net for lost events)

Job `tenant_reconcile`, self-rescheduling every `member_reconcile_interval_secs` (default 1800), enqueued at boot for every active tenant (`once_key = "boot:<tenant>:<release>"`), at tenant registration (`platform/service.rs:288,344`), and by `POST /api/members/reconcile`.

1. `DiscordRest::guild_with_counts` -> `approx_member_count`; `list_members_page(after, 1000)` until a short page.
2. Integrity gate: pagination ended without error AND `seen >= 0.95 * approx_member_count`. If not, the run records `state='failed'` (or `'blocked'` on 403 = missing intent/permission, `'failed'` and tenant marked unreachable on 404 code 10004 Unknown Guild) and changes nothing destructive. This replaces any percentage-of-DB heuristic, so the first run on legacy data (many ex-members never cleaned) deactivates them automatically but a truncated listing never can.
3. Per page chunk (200) in a transaction: existing users -> snapshot diff, `roles_checked_at=run_start`, `username`; missing users -> `ensure_member(Reconcile)` if `members_provision_all` and bots excluded.
4. After the gate: deactivate users with `active AND member_event_at < run_start` not in the seen set (the guard keeps a newer gateway add from being undone), prune `user_tenant_memberships` rows for the tenant not in the seen set (platform admins excluded), store counts in `tenant_member_sync`.
5. Enqueue `effects_sync` for users whose highest role changed and who have a link; reschedule.

If the integrity gate passes but `would_deactivate` exceeds 50% of active users and at least 20 rows, the run stores `state='suspicious'` with `would_deactivate` and waits for `POST /api/members/reconcile {force:true}` (admin confirms in the UI). This is the seatbelt against a Discord-side outage that returns a plausible but wrong list.

### 2.7 Role snapshot, staleness, sessions (auth-3/4/5)

New `auth/role_resolver.rs`, the single path for the cookie extractor (`rbac.rs:175 apply_live_guild_roles` is deleted), `/auth/me` (`auth/router.rs:885-925`) and `finalize_session` (`router.rs:694`):

```rust
pub enum Freshness { Snapshot, Live, StaleSnapshot, Degraded }
pub struct Resolved { roles: Vec<String>, highest: String, freshness: Freshness }
pub async fn resolve_member_roles(ctx: &RoleCtx, user: &users::Model, lookup: &impl MemberLookup, now) -> Result<Resolved, AppError>;
```

| Condition | Result |
|---|---|
| platform admin | SuperAdmin, no lookup (as today) |
| `!user.active` | `Forbidden("not a member of this server")`, no lookup |
| `now - roles_checked_at <= fresh` (default 45 min) | snapshot, no Discord call |
| older / NULL: lookup `Present(ids)` | write snapshot (`apply_role_snapshot`), `Live` |
| older / NULL: lookup `Absent` | `deactivate(absent_on_check)`, delete membership, `Forbidden` |
| older / NULL: lookup `Unavailable`, age <= `max_stale` (default 6 h) | snapshot, `StaleSnapshot` (response header `X-Roles-Stale: 1`, FE banner) |
| older / NULL: lookup `Unavailable`, age > `max_stale` or no snapshot | default role only, `Degraded` (fail closed) |

Fixes and details:
- `classify_member_status` (`auth/service.rs:565`): 404 is `Absent` only when the Discord error body code is 10007 (Unknown Member). Code 10004 (Unknown Guild, bot removed) and any other 404 are `Unavailable`; otherwise a bot kicked from a server would deactivate everybody.
- The cookie keeps identity only (id, tenant, `issued_at`). Roles and permissions are derived server side on every request from the snapshot; cookie roles are consulted only if the `users` row cannot be loaded at all.
- `finalize_session` and `switch_tenant`: `Absent` -> 403 and delete the membership row, never `record_membership` (`router.rs:746`). `adopt_matching_tenant` (`router.rs:559`) inherits this because it calls `finalize_session`.
- Cookie lifetime: add `issued_at` to `DiscordUserProfile`; `get_me` re-issues the cookie only when the profile changed and keeps the original expiry (`max_age = issued_at + 7d - now`); the extractor rejects a cookie older than 7 days. This ends the sliding session (`router.rs:935-942`).
- `member_lookup_cache` (`service.rs:629`): bounded to 10k entries with TTL purge on insert.
- Config (`config.rs`): `member_roles_fresh_secs=2700`, `member_roles_max_stale_secs=21600`, `member_reconcile_interval_secs=1800`.
- Per-request cost goes down: `find_by_discord_id` returns the whole row (snapshot included), replacing `user_id_for_discord_id` (`rbac.rs:131`) plus the Discord call plus `role::Entity::find().all`. The role table load moves into the existing per-tenant `Permissions` cache (`permission_cache.rs`) as a `discord_role_id -> name/priority` map, reloaded by `Permissions::reload` and by the `role_delete` event.
- Bot path (`rbac.rs:336 resolve_bot_role_ids`, `service.rs:675`): when the header is missing, the fallback becomes the snapshot (if fresh) instead of the stale `users.role` string, else the default role.
- Web role editor (`users/router.rs:328,375` -> `member_roles.rs:254,315`): after the Discord call, write-through of the snapshot (the held list is already fetched there).
- `GET /api/users/{id}/roles` (`users/router.rs:294`): requires `roles.manage`; `list_user_roles` serves the snapshot unless `?live=true`.

### 2.8 Soft-deactivate: where `active` must be honoured

Helper `users::active_only()` returning the `Column::Active.eq(true)` condition and a SQL constant for raw queries, so a site cannot be forgotten silently. Sites (each gets an "inactive never appears" test):

| Site | Change |
|---|---|
| `users/service.rs:536 list_users` | default `status=active`; `status=left|all` needs `users.create`; `UserProfile` gains `active`, `left_at` |
| `progression/service.rs:666 leaderboard` and the rank-position query | `user_id IN (SELECT id FROM users WHERE active)`; accounts and ledger kept; award functions refuse inactive users |
| `notifications/service.rs:182` broadcast | active users only |
| `giveaways/service.rs:676,770` entrants/draw | active only (history lookups at :676 by id are unaffected) |
| `bank/service.rs:125`, `bank/alliance.rs:94` user pickers/search | active only |
| `admin/service.rs:1066 unregistered_discord_members` | rewritten as a DB query: active users without an `albion_links` row (no Discord REST needed) |
| splits/events participant pickers | go through `GET /users`, so covered; existing participations of inactive users are kept (history) |
| dashboards/counters (`attention`, admin overview) | count active only |

Future-event signups of a member who leaves: `on_member_left` hook (events slice) withdraws them from non-terminal, not-yet-started events and lets the participation outbox propagate to the alliance. Past data is untouched.

Link of an inactive user: `LinkOrchestrator` treats `albion_links` rows owned by `active=false` users as releasable (2.9), so an ex-member's character cannot block the real player.

### 2.9 `LinkOrchestrator` (auth-7 policy, auth-8, parity-16)

`albion/link_orchestrator.rs`, the only code allowed to write `albion_links` outside the propagation handler. Replaces the bodies of `albion/router.rs:295 link_player`, `:377 register_by_ign`, `:455 unlink_player`, `:540 admin_link_user_handler`, `:590 admin_unlink_user_handler`, `users/router.rs:427 create_user`, and the bot calls. `AlbionLinkService::{create_link, delete_link, admin_link_user, admin_unlink_user}` (`albion/service.rs:268-430`) become `pub(super)` primitives.

```rust
pub enum PlayerRef { Id(String), Ign(String) }
pub enum LinkSource { SelfWeb, SelfBot, Admin { actor_user_id: i64, replace: bool }, Provision { actor_user_id: i64 } }
pub async fn link(&self, tenant: &TenantCtx, discord_id: &str, player: PlayerRef, source: LinkSource) -> Result<LinkOutcome, AppError>;
pub async fn unlink(&self, tenant: &TenantCtx, discord_id: &str, source: LinkSource) -> Result<(), AppError>;
```

`link` steps (all sources identical except the flagged ones):
1. Resolve the player: `Id` -> `AlbionService::get_player`; `Ign` -> `search` + `pick_exact_player` (`service.rs:130`). Name and guild always come from Albion, never from the client.
2. `assert_register_allowed` (`alliance_fanout.rs:199`, moved to `members::topology`): on an alliance tenant the player's Albion guild must be an active member guild. Now applied to admin and provision paths too (fixes auth-8).
3. Self sources only: cooldown, 429 if `now - users.last_link_change_at < 10 min` and the user already changed once. First link is never throttled.
4. `ensure_member(Present)` for the target.
5. Resolve the origin: if the row to change is a copy (`origin_tenant_id IS NOT NULL`), the write is applied in the origin tenant (via `TenantRegistry::get_or_load`), the local copy follows through the job.
6. Enqueue `link_sync(tenant=origin, subject=discord_id)` and `effects_sync` BEFORE the write, then commit one transaction: conflict policy, then insert.
7. Conflict policy: `albion_player_id` claimed by an `active=false` user, or by a detached copy -> released (deleted) and audited. Claimed by an active user -> 409 for self sources; admin with `replace=true` replaces in one transaction (as `admin_link_user` does today).
8. Audit every link and unlink (`AuditService::log`, source, actor, player id). This is the compensating control for "no ownership proof".
9. Inline fast path: run the `effects_sync` handler for the origin tenant only, bounded to 2 s, so `/register` still grants the guild role immediately. The job stays queued as the guarantee. The response `AlbionLinkStatus` (`albion/service.rs:205`) gains `origin_tenant_id` and `sync: [{tenant_id, facet, state}]`.

`unlink`: self unlink stays allowed ("as today"); admin unlink idempotent. Enqueue first, delete, handler revokes via the ledger and removes copies. New bot command `/unlink` (`DELETE api/albion/link`).

`GET /api/albion/link/me` (`router.rs:235`) becomes a pure read. The mutation `adopt_existing_member_link` (`alliance_fanout.rs:296-352`) is replaced by the `member_joined`/`link_sync` jobs (S8). Until S8, S7 keeps calling the old fanout functions from the orchestrator so the slice is mergeable.

Bot: `/register ign` and `/link player_id` both call the same endpoints (`/link` stops sending the ignored `player_name`, `commands/link.ts:28-33`). `/register` ambiguity (several exact IGN matches) uses a new `GET /api/albion/register/candidates?ign=` returning up to 10 `{id, name, guild_name, alliance_tag}` and shows a select menu; the choice calls `POST /api/albion/link`. `link` and `unlink` are allowed on alliance Discords (the allow-list in `command-gate.ts:22` is replaced by capabilities in WP13; until then add both names).

### 2.10 Alliance propagation (links, users, roles, nickname)

Topology helper `members/topology.rs` (moved from `alliance_fanout.rs:40-77, 272-289`): `neighbors(control, tenant) -> Vec<Neighbor>` from `alliance_memberships` where `status='active'`. Pure functions stay unit-testable.

Handlers (`members/jobs.rs` dispatch, `members/links.rs`, `members/effects.rs`):

**`member_joined(T, D)`**
1. Row already ensured by sync. If `T` is an alliance: for each active member guild `G`, if `G` has a local-origin link for `D` -> `link_sync(origin=G, D)`. If `T` is a guild in an alliance `A`: if `A` has a local-origin link for `D` whose `albion_guild_id` is `G`'s -> `link_sync(origin=A, D)`.
2. Enqueue `effects_sync(T, D)`.

**`link_sync(origin O, D)`** (truth-driven). For each target `T` in `neighbors(O)` (alliance origin: only the home guild):
- sources(T, D) = local-origin links of D in the tenants adjacent to T that are eligible (guild -> alliance: active member; alliance -> guild: `albion_guild_id` equals T's). Best source = earliest `linked_at`, tie -> lowest tenant id.
- sources empty and T holds a copy -> delete it (or `detached_at=now()` when the source tenant is detached, 2.11).
- sources non-empty: `ensure_member(Unknown)` in T; if T has no link -> insert copy with `origin_tenant_id/origin_link_id`; copy differs from best source -> replace; T has a local-origin link for D with the same player -> state `ok`; different player, or the player is linked to another Discord id in T -> facet `link` = `conflict`, nothing overwritten.
- Writes `member_facet_state(D, T, 'user'|'link')` and enqueues `effects_sync`.
Because the handler recomputes from all adjacent sources, two member guilds holding the same link never fight, and unlinking in one guild re-homes the copy to the other instead of deleting it.

**`effects_sync(D)`** desired-state reconciler for Discord roles and nickname. `desired(T, D)` for each Discord guild `T` in the cluster:

| Tenant `T` | Desired managed role | Condition |
|---|---|---|
| alliance hub `A` | `alliance_memberships(A,H).discord_role_id` | D has a link whose home guild `H` is an active member of `A`; D is `active` in `A` |
| member guild `G` of `A` | `guild_settings.discord_alliance_role_id` of `G` ("ally role") | D has a link whose home guild is an active member of `A` (includes `H == G`); replaces the Albion API call in `alliance_fanout.rs:407 player_in_discord_albion_alliance` |
| home guild `G` (not alliance managed) | base role (`discord_applications_accepted_role_id` or `default_role_discord_id`, `discord_guild_role.rs:216`) | D linked and `albion_guild_id == G.albion_guild_id`; assigned/revoked here but NOT in the ledger |
| any | none | no link, or `D` is not `active` in `T` (member left) |

Apply: for roles missing -> `DiscordRest::add_role`, then insert `alliance_role_grants(A, H, T, D, role)`; for ledger rows not desired -> insert/reuse `alliance_role_revocations(pending)` and let the revocation worker delete them (one revoke path for unlink, leave, expel, role remap). Nickname: set to the Albion name only in the origin tenant, as today (`discord_nick.rs`), as facet `nick`. Results: Discord 404 code 10007 -> `not_in_guild` (not an error; `member_joined` re-runs it when the member joins); 403 (hierarchy/permissions) -> `blocked`, class `blocked`, not retried automatically, re-armed by retry endpoint, role-remap, or the 30-min `tenant_reconcile`; 429 -> `transient` with `run_after = retry_after`.

Triggers: orchestrator link/unlink, `member_joined`, `member_left` (member left a guild: roles derived from that guild are revoked), highest-role change, `alliance_memberships.discord_role_id` change (`platform/service.rs:910`), `guild_settings.discord_alliance_role_id` change (`admin/service.rs:167`) -> tenant-scope `alliance_backfill`.

**`member_left(T, D)`**: if `T` is a guild: `effects_sync(D)` (hub role dropped); the home guild link stays (history). If `T` is an alliance: nothing to propagate beyond the events hook. No data is deleted.

**`alliance_backfill(A, G)`** (on accept, on role/setting change, on rejoin, manual `resync`): pages `G`'s users that have a local-origin link (cursor = last user id, batch 200) and `A`'s users with local-origin links whose `albion_guild_id` is `G`'s. Per user it runs the `link_sync` and `effects_sync` logic inline; a per-user failure is recorded in `member_facet_state` as `pending`/`conflict` and the batch continues; the job ends `done` when the cursor is exhausted. Each batch re-reads the membership status and ends `obsolete` if it is no longer `active`.

**Origin backfill of existing data** (`link_origin_backfill`, `once_key = "origin:<alliance>"`, enqueued at boot): the old fanout wrote copies without markers. For every alliance `A`, for each `albion_links` row in `A` that has an identical `(discord_id, albion_player_id)` row in a member guild `G`, set `A`'s row `origin_tenant_id=G, origin_link_id=G.id`; rows in `A` without a match stay local-origin and `link_sync` pushes them to the home guild. Idempotent; fills `albion_guild_id` for rows where it is NULL (Albion lookup, 5 req/s cap).

### 2.11 Membership transitions (platform service)

| Event | Hook (file:line) | Effect |
|---|---|---|
| Guild accepts invite | `platform/service.rs:871 accept_alliance_membership` | same transaction inserts `alliance_backfill(A, G)` (control DB, so the status UPDATE and the job are atomic) |
| Hub role of a guild set/changed | `:910 set_alliance_member_discord_role` | `alliance_backfill(A, G)` |
| Guild leaves | `:1046 mark_alliance_left` (also used by `reset_alliance_setup :648`) | same transaction inserts `alliance_detach(A, G)` and the existing revocation rows; `leave_active_alliance :995` no longer retries inline except one best-effort pass |
| Alliance expels guild | new `PlatformService::expel_alliance_member(control, A, G, actor)`; route `POST /api/alliances/{A}/members/{G}/expel` | actor must be the alliance tenant owner (works after the auth-6 fix) or platform admin; same as leave with `left_reason='expelled'`, `left_by=actor`; the guild is notified through the existing notification channel |
| Guild re-invited and accepts | existing `left -> pending -> active` path | `alliance_backfill` clears `detached_at` and regrants roles |
| Alliance Discord settings changed | `admin/service.rs:167` | `alliance_backfill` for every active member |

**`alliance_detach(A, G)`**: (1) `albion_links` copies in `A` with `origin_tenant_id=G` and copies in `G` with origin `A` get `detached_at=now()` (kept, so display names in history survive; excluded from propagation and release-able by a new claim); (2) `effects_sync` for every user with ledger rows for `(A, G)` revokes hub and ally roles; (3) `member_facet_state` rows -> `detached`. History is never deleted. Event/share archiving is the events/alliance slices' job.

**Revocation worker** (`members/revocations.rs`, same worker process as the queue): claims `alliance_role_revocations` with `status='pending' AND next_attempt_at <= now()` using `FOR UPDATE SKIP LOCKED`, calls `discord_guild_role.rs:revoke_discord_role_verified` (via `DiscordRest`), `verified` on success, backoff `15s * 2^attempts` capped 1 h, `exhausted` after 12 attempts, `blocked` on hierarchy 403. `ambiguous` rows (role configured but no recorded grant, `platform/service.rs:1100-1136`) are resolved from the snapshot: the holders are `users(T).discord_role_ids` containing the role, intersected with the leaving guild's users; only that intersection becomes per-user pending revocations, others stay untouched. `reset_alliance_setup` needs no extra call because it goes through `mark_alliance_left`.

### 2.12 Queue mechanics (`members/jobs.rs`, `members/worker.rs`)

- Wake-up: in-process `tokio::sync::Notify` (extension `IdentityWake`) signalled by `enqueue`, plus a 15 s poll. Single backend replica is the documented deployment; `FOR UPDATE SKIP LOCKED` claiming and leases make a second replica safe. If the sync-engine slice introduces LISTEN/NOTIFY, swap the `Notify` for it without touching handlers.
- Enqueue (coalescing): `INSERT ... ON CONFLICT (kind,tenant_id,subject,partner_tenant_id) WHERE state IN ('pending','processing','failed') DO UPDATE SET dirty = (identity_jobs.state='processing') OR identity_jobs.dirty, run_after = CASE WHEN identity_jobs.state='processing' THEN identity_jobs.run_after ELSE LEAST(identity_jobs.run_after, EXCLUDED.run_after) END`.
- Claim: same pattern as `events/fanout_outbox.rs:138-192 claim_due` (CTE with `FOR UPDATE SKIP LOCKED`, attempts+1, lease 60 s, `lease_token`), plus: skip a job whose `(kind, subject)` is being processed under another tenant lease (so two origins for the same member never run `effects_sync` concurrently).
- Complete: `state = CASE WHEN dirty THEN 'pending' ELSE 'done' END, dirty=false` guarded by `lease_token`; a stale worker cannot overwrite.
- Retry: transient errors `run_after = now + 15s * 2^min(attempts,8)` capped 1 h (formula of `fanout_worker.rs:100`), 429 uses `retry_after`; `max_attempts` 12 -> `exhausted`; `blocked`/`conflict` are terminal until re-armed (`POST /api/members/{user_id}/sync/retry`, admin button, or the periodic reconcile). `obsolete` = truth no longer requires the effect.
- Tick budget: 20 jobs per tick, Discord calls through `DiscordRest` with a per-guild token bucket (4 req/s) so a 300-member backfill cannot trip rate limits.
- `tenant_reconcile` is a job like the others (lease prevents two reconciles of one tenant). Worker spawn lives next to `events::fanout_worker::spawn` in `lib.rs:118`, for ALL tenant kinds (the `starts_sync_workers('alliance') == false` rule in `tenant.rs:84` does not apply: this is a control-plane loop).

### 2.13 API surface

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/members/sync` | bot secret | gateway batch (2.5) |
| `POST /api/members/ensure` | bot secret | provision a verified guild member by id (2.4) |
| `POST /api/members/reconcile` `{force?: bool}` | `users.create` or bot secret | enqueue `tenant_reconcile`; `force` confirms a `suspicious` run |
| `GET /api/members/sync/status` | `users.create` | `{state, last_completed_at, last_error, members_seen, approx_member_count, would_deactivate, gateway_last_event_at, pending_jobs, failed_jobs, problem_facets}` |
| `GET /api/members/{user_id}/sync` | self or `roles.manage` | facets `[{tenant_id, facet, state, detail, origin_tenant_id, updated_at}]` |
| `POST /api/members/{user_id}/sync/retry` | `roles.manage` | re-arm blocked/exhausted jobs and facets |
| `POST /api/alliances/{alliance_id}/members/{guild_id}/resync` | alliance owner or `alliance.manage` | `alliance_backfill` |
| `POST /api/alliances/{alliance_id}/members/{guild_id}/expel` | alliance owner | 2.11 |
| `GET /api/albion/register/candidates?ign=` | session or bot | disambiguation (2.9) |
| `POST/DELETE /api/albion/link`, `POST /api/albion/register`, `POST/DELETE /api/albion/link/users/{id}` | unchanged URLs | all through `LinkOrchestrator` |
| `GET /api/users?status=active\|left\|all` | session (`left\|all` need `users.create`) | 2.8 |

Registered in `modules/mod.rs:49` as `.nest("/members", members::router())`. OpenAPI annotations as the rest of the modules. The planned unified `GET /api/sync/status?entity=member:<discord_id>` of the sync engine can proxy to the facet endpoint.

### 2.14 Identity hardening detail (WP1 subset)

| Id | Change |
|---|---|
| auth-1 | `DiscordUserProfile` (`service.rs:31`) gets `verified: Option<bool>` read in `fetch_profile` (`:294`); an unverified email is dropped to `None`. `finalize_session` (`router.rs:745`) calls `ensure_member(Present, Via::Web, verified_email)`. `AuthService::upsert_user` and `update_existing_user` (`service.rs:475-543`) are deleted; the three tests that pin them (`:985`, `:1029`, `:1066`) move to `identity.rs`. Legacy rows with `discord_id IS NULL` are still claimable, only by a verified email. |
| auth-12 | `UserProfile.email` becomes `Option<String>` and is filled only for the row owner or callers with `users.create` or `roles.manage`; `UserFilters.email` and its WHERE (`service.rs:107-110, 576-578`) removed. `UserContext.email` is no longer set from `users.email` on the bot path (`rbac.rs:372`). FE: `users.ts:261,416`, `user-detail.ts:138,182`, `api.models.ts:294` make email optional and hide the column when absent. |
| auth-19 | `UserContext::bypasses_priority()` = superadmin or tenant owner; `users/router.rs:328-345,375-390` pass it instead of `user.is_superadmin()`. Test: owner with no mapped role can assign a priority-100 role. |
| auth-6 | `guild_owner_matches` (`platform/service.rs:2103`) drops the `kind == "guild"` clause and `is_guild_owner` is renamed `is_tenant_owner`; the pinning unit test is inverted. Leaving an alliance is already guarded separately (`AllianceLeave`, `leave_active_alliance` requires `kind == "guild"`). `finalize_session` then reports `is_tenant_owner=true` on alliances and the cookie permission list includes everything. |
| auth-4 (login part) | `finalize_session`/`switch_tenant`: `Absent` -> 403 (2.7). |
| auth-5 | 2.7. |

---

## 3. Migration of existing data and of the copy mechanisms

| Existing thing | Fate |
|---|---|
| `users` rows | new columns default `active=true`, `roles_checked_at=NULL` (stale -> live lookup on first request, today's behaviour). The first `tenant_reconcile` per tenant after deploy fills snapshots and deactivates ex-members, gated by the integrity check. |
| `user_tenant_memberships` | kept; reconcile prunes rows of members not present in Discord. Behaviour change to flag: web access to a tenant now requires Discord presence there. Guild members who only obtained an alliance membership row through the old `record_membership` fanout (`alliance_fanout.rs:142-145,328`) lose web access to the alliance until they join the alliance Discord (consistent with auth-4). Those calls are removed in S8. |
| Copy mechanism 4 (register one-shot copy: `alliance_fanout::after_successful_link/unlink`, `adopt_existing_member_link`, `plan_register_fanout`) | replaced by `link_sync` / `effects_sync` / `member_joined` (S8). Pure planning fns move to `members::topology` with their tests. File deleted in S8. |
| `alliance_shares`, `event_fanout_*`, `event_mirror_requests` | untouched by this subsystem; they only switch user provisioning to `ensure_member` (S2) and stop copying real emails. |
| `albion_links` copies without markers | `link_origin_backfill` once-job (2.10). |
| `alliance_role_grants` / `alliance_role_revocations` | kept and now actually processed by the revocation worker; old `pending`/`ambiguous` rows start retrying after deploy (expected, bounded by attempts). |
| Bot `website-account.ts`, gate, `resolveInternalUserId` impersonation | removed (S2). |
| `AuthService::upsert_user` | removed (S1). |

Rollback: every migration only adds columns/tables with defaults, so the previous binary keeps working. The previous bot works against the new backend. Turning off the gateway handlers (bot) leaves the reconcile as the only feed; `members_provision_all=false` reverts to "only people who touched the system".

---

## 4. Failure modes

| Failure | Behaviour |
|---|---|
| Bot offline / gateway disconnect | events lost; reconcile (<= 30 min) repairs snapshot and presence; `gateway_last_event_at` shows staleness; requests older than `fresh` do a live lookup. |
| Backend down while bot has events | bot retries with backoff, drops oldest beyond 2000; reconcile repairs. |
| Discord REST 429 | `DiscordRest` honours `retry_after`; job `transient` with `run_after`; reconcile pauses and resumes the same page. |
| Bot lacks Server Members intent / permission (403) | reconcile `blocked`, banner in admin; requests keep working from snapshot until `max_stale`, then default role. |
| Bot removed from guild (404 code 10004) | classified `Unavailable`, never `Absent`; no deactivations. |
| Truncated or inconsistent member list | integrity gate (<95% of approximate count) aborts destructive steps; `suspicious` needs a human `force`. |
| Concurrent first interaction by the same user | `ON CONFLICT (discord_id)` upsert; one row. |
| Out-of-order events (add after remove) | `member_event_at` guard; reconcile only deactivates rows with `member_event_at < run_start`. |
| Crash between intent enqueue and local commit | job finds no link -> `obsolete`. |
| Crash after commit before job runs | job already exists (intent-first); worker picks it up after lease expiry. |
| Enqueue while job running | `dirty` flag re-queues after completion, nothing lost. |
| Role hierarchy 403 | facet `blocked` with Discord's message, visible in the member and admin status; not retried blindly. |
| Member not in a cluster Discord | `not_in_guild`, re-evaluated at `member_joined`. |
| Same character claimed in two guilds | second propagation is `satisfied`/`conflict` per rule; never overwritten; officer sees the facet. Without ownership proof a squatter can still declare first: mitigated only by audit, cooldown and admin replace. |
| Guild leaves mid-backfill | each batch re-reads status; job `obsolete`; `alliance_detach` runs. |
| Tenant suspended or deleted | jobs skip suspended tenants; `ON DELETE CASCADE` removes jobs/facets. |
| Role deleted in Discord | `role_delete` strips snapshots; permissions recomputed; mapping row shows "missing role". |

---

## 5. Test strategy

SQLite unit tests (tenant schema, `Database::connect("sqlite::memory:")`, as `identity.rs:150` does):
- `ensure_member`: idempotent; email collision handled by placeholder; Presence rules; stale event ignored; two simultaneous calls via the same connection pool produce one row (`tokio::join!`); legacy NULL `discord_id` row claimed only with a verified email.
- `apply_events` table-driven: add/update/remove/role_delete, ordering, role recompute with `resolve_linked_roles`.
- `resolve_member_roles` matrix (2.7) with an injected clock and a fake `MemberLookup`; `classify_member_status` with body codes 10007/10004.
- `LinkOrchestrator` with a fake `PlayerDirectory` and a fake effect sink: all five sources produce the same rows; inactive-owner release; cooldown; `Admin{replace}`; alliance outsider rejected for admin/provision; origin routing (copy tenant command writes to origin).
- `topology`, `desired(T, D)` pure functions: every row of the 2.10 table plus left/detached/non-active cases.
- Active filters: one test per site in 2.8.
- Bot (`node --test`, fake `ApiClient`): command gate no longer calls `users/me`; `resolve-user` uses `/members/ensure`; forwarder debounce/batch/retry/cap; handlers skip bots and unregistered guilds; `GuildMemberUpdate` ignored when nothing relevant changed.
- FE specs: email column hidden when absent; 403 on tenant switch shows the picker; stale-roles banner.

Postgres integration (`TEST_DATABASE_URL` only; WP0 removes the `DATABASE_URL` fallback in `postgres.rs:185`; schema per test via `unique_schema`):
- Queue: two workers claim disjoint jobs (`SKIP LOCKED`); lease expiry reclaim; `dirty` re-queue; coalescing; `max_attempts` -> `exhausted`; `(kind, subject)` exclusion across tenants.
- Reconcile against a stub Discord HTTP server (axum on an ephemeral port, base URL from `Config.discord_api_base`): complete listing deactivates and prunes; 95% gate; `suspicious` + `force`; pagination crash resumes; 403 -> `blocked`.
- Two tenant schemas + control: guild->alliance link copy with origin markers; alliance->home guild; unlink re-homes when a second guild still holds the link; leave -> detach -> revocation worker revokes ledger roles (stub Discord), history intact; rejoin reattaches; expel authorization.
- Control transactionality: accept + backfill job commit atomically; rollback leaves neither.
- Boot origin backfill on pre-seeded unmarked copies.
- Auth: login of a second Discord account with the same email creates a second row and leaves the first untouched (S1); removed member -> `/auth/switch-tenant` 403 and membership row deleted; alliance owner without roles passes `require`.

---

## 6. Implementation slices (each one PR from `origin/main`, branch `<type>/<name>`)

Order: S1 -> S2 -> S3 -> S4 -> S5 -> S6 -> S7 -> S8 -> S9 -> S10. WP0 (baseline green) is a precondition for all tests below.

**S1 `fix/auth-identity-hardening`** (auth-1, auth-12, auth-19, auth-6, login half of auth-4)
- Changes: 2.14 table; delete `AuthService::upsert_user`; `verified` flag; `is_tenant_owner` rename; `bypasses_priority`; `finalize_session`/`switch_tenant` 403 on Absent with membership delete; `classify_member_status` body-code refinement.
- Acceptance: two Discord ids with the same email produce two rows and the first keeps its `discord_id`; unverified email never claims or is stored; `GET /api/users` has no email for a plain member and no `email` filter, owner/officer with `users.create` sees it, self sees own; alliance owner with zero roles passes `RolesManage` and can assign a high-priority role; Absent member gets 403 on login and switch and loses the membership row; Unknown Guild (10004) does not deactivate.

**S2 `feat/member-provisioning`** (auth-2)
- Changes: migration `..._000001` (users columns), `ensure_member`, bot-path provisioning in `rbac.rs`, `X-Discord-Username`, `POST /api/members/ensure`, `resolve-user.ts` rewrite, bot gate/`website-account.ts` removal, caller migration off `upsert_discord_user` and ad-hoc emails.
- Acceptance: with no web login, `/register <ign>` succeeds in a guild and in an alliance Discord and a `users` row exists with `provisioned_via='bot'`; `/warn @never-seen-member` works through `/members/ensure`; a user option for someone outside the guild is rejected bot-side; concurrent first requests create one row; old bot against new backend still passes its gate; `command-gate.test.ts` no longer expects the website reply.

**S3 `refactor/discord-rest-client`**
- Changes: `modules/discord_api` (`DiscordRest` trait + live impl, `Config.discord_api_base`, typed errors `MemberNotFound`, `UnknownGuild`, `Forbidden`, `RateLimited{retry_after}`, per-guild token bucket); port `auth/service.rs:392`, `albion/discord_guild_role.rs`, `albion/discord_nick.rs`, `users/member_roles.rs LiveDiscord`, `admin/service.rs fetch_discord_member`; stub server test helper.
- Acceptance: behaviour-preserving (existing tests green); new unit tests map 404/10007, 404/10004, 403, 429 with Retry-After; stub-server test proves base URL override.

**S4 `feat/gateway-member-sync`** (auth-3, members-16, first half)
- Changes: migrations (`discord_role_ids`, etc. already in S2), `members` module with `sync.rs` + router `POST /api/members/sync`, `apply_role_snapshot` (also called from `refresh_cached_highest_role` and bot-path write-through), `MemberLifecycleHooks`, bot `member-sync.ts` + 4 handlers, removal of the `link/me` call in `GuildMemberAdd`, `role_delete`.
- Acceptance: member_remove deactivates and deletes the membership row but keeps XP/warns/splits; member_update changes `users.role`; stale event ignored; role_delete strips snapshots and reloads permissions; bot forwarder batches 100 events per request and survives a 500 with retry; unregistered guild and bots produce no calls.

**S5 `feat/member-reconcile-worker`**
- Changes: control migrations (`identity_jobs`, `tenant_member_sync`, `member_facet_state`), `jobs.rs`, `worker.rs` spawn in `lib.rs`, `tenant_reconcile` with integrity gate, `members_provision_all`, endpoints `reconcile` + `sync/status`, `Config` intervals.
- Acceptance: Postgres queue tests (2.12); reconcile with stub Discord: missing members created, left members deactivated, memberships pruned, `roles_checked_at` set; 90%-listing aborts without deactivations; suspicious path needs `force`; `blocked` on 403; run is single-flight.

**S6 `feat/role-staleness-and-sessions`** (auth-5, rest of auth-4)
- Changes: `auth/role_resolver.rs`, rbac cookie path and `/auth/me` and bot fallback on it, `Permissions` discord-role map, non-sliding session with `issued_at`, bounded lookup cache, `X-Roles-Stale`, `GET /users/{id}/roles` gate, FE banner.
- Acceptance: matrix tests of 2.7; snapshot-fresh request makes zero Discord calls (counting fake); Unavailable beyond `max_stale` yields default role; Absent returns 403 and deactivates; `/me` does not extend cookie expiry; cookie older than 7 days rejected; per-request query count not higher than before (counting test).

**S7 `refactor/link-orchestrator`** (auth-8, parity-16, auth-7 policy)
- Changes: migration `..._000002` (albion_links columns), `link_orchestrator.rs`, all entry points rewired, audit, cooldown, inactive-owner release, `register/candidates`, `/unlink`, bot `/link` and `/register` updates, `create_user` kind-aware (works on alliance). Old fanout functions still called from the orchestrator.
- Acceptance: web link, Discord `/register`, `/link`, admin link, `POST /users` yield identical DB state, audit entry, roles and fanout for the same player; admin link on a guild now assigns the guild role and fans out; alliance outsider rejected on every path; claim of a character held by an inactive user succeeds and audits the release; ambiguous IGN returns candidates and the select menu links the chosen id.

**S8 `feat/alliance-member-propagation`** (alliance-14, members-3, auth-9 core)
- Changes: `link_sync`, `effects_sync`, `member_joined`, `member_left`, `link_origin_backfill`, `topology`, `member_facet_state` writes, status endpoints, `identity::member_guilds`, removal of `alliance_fanout.rs` and of cross-tenant `record_membership`, `link/me` pure read, hooks for role/settings changes.
- Acceptance: link in guild G appears in alliance A with `origin=G`, user row present, hub role granted and ledger row written; link declared in A for a player of G appears in G; a member joining A's Discord adopts their existing link within one job cycle (no `link/me` call needed); unlink re-homes or removes copies and revokes via ledger; 403 hierarchy surfaces as facet `blocked`; unmarked legacy copies get origins after boot job; two guilds with the same link do not conflict.

**S9 `feat/alliance-membership-lifecycle-members`** (alliance-11/12 member part, auth-9, auth-10)
- Changes: `alliance_backfill` and `alliance_detach`, accept/leave/set-role/reset hooks (transactional enqueue), revocation worker with backoff and ambiguous resolution, `expel` + `resync` routes, `left_reason/left_by`, control migration `..._000002`.
- Acceptance: accepting an invite backfills links and roles of the guild's 100 linked members and is resumable after a worker restart mid-cursor; leave revokes hub and ally roles through the worker even with the bot offline at leave time (retries later); expel by alliance owner works, by anyone else 403; rejoin reattaches; `reset_alliance_setup` triggers revocations; history rows and `users` remain.

**S10 `feat/member-sync-visibility-ui`** (FE + bot)
- Changes: users list status chip and `status` filter, member sync facets panel in `user-detail`, tenant "Member sync" health card in admin (state, last run, gateway last event, problem facets, reconcile and force buttons), alliance admin resync/expel buttons, bot `/sync-status` for officers (own facets), stale-roles banner, 403 handling after tenant switch.
- Acceptance: component specs against the real `ApiService` envelope; `suspicious` run shows the would-deactivate count and the force action; retry button calls the retry route; inactive users hidden by default.

---

## 7. Assumptions to confirm in review (not re-opening the decisions)

1. Web access to a tenant requires Discord presence in that tenant (consequence of "ex-members soft-deactivated" and auth-4). Alliance web access for guild members therefore needs the alliance Discord.
2. Self-service unlink and relink stay as today; the only new friction is the 10-minute cooldown after the first link change and the audit trail.
3. Reconcile creates `users` rows for every non-bot member by default (`members_provision_all`), so directories and leaderboards are complete without anyone logging in.
4. `GuildRoleUpdate` is intentionally not consumed; only `GuildRoleDelete` matters because mapping is by role id.
5. Base guild role assignment stays outside the grant ledger (the ledger is alliance-scoped by foreign keys), but is assigned/revoked by the same `effects_sync` handler with retries. Drift of the player's Albion guild after linking (leaves the Albion guild) is not detected here; it needs a periodic Albion refresh and is left as a follow-up.
