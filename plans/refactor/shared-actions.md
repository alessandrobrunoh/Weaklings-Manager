# Shared Actions: one rule set for web and Discord

Subsystem design. Scope: capabilities per tenant kind, action descriptors and executor, backend-owned state-transition tables, removal of duplicated client rules, OpenAPI codegen, read-only synced copy presentation, and the parity backlog.

Repo root used for every `path:line` below: `Weaklings-Manager/` (worktree). Line numbers are from commit `f7f60e44`.

---

## 0. Position in the whole program

This subsystem is the contract layer between the backend and its two clients. It does not own the sync engine, the Discord outbox, or member sync. It consumes them through three narrow interfaces (names are those of the sibling design `sync-engine.md` where it exists), so each slice can merge without the sibling designs being finished:

| Interface | Owner (sibling design) | What shared-actions needs | Stand-in until it lands |
|---|---|---|---|
| `EffectSink::enqueue(txn, kind, entity_ref, payload) -> EffectRef` | Discord outbox (plan 4.2, `discord_outbox`) | An action enqueues Discord effects in the same DB transaction as the state change. | `NoopSink`: returns `[]`; the legacy bot poller keeps doing the work. |
| `sync::outbox::emit(txn, SyncEmit)` / `mutate_origin(...)`, `sync::guard::assert_writable`, `sync::guard::copy_info(kind, ids) -> HashMap<id, CopyInfo>`, `GET /api/sync/status`, `POST /api/sync/retry` (sync-engine design sections 3.1, 6.1, 6.2, 7; tables `sync_copies`, `sync_outbox` in the tenant schema, `sync_links`, `sync_jobs` in control) | Sync engine | Which copies exist, who is the origin, per-target sync state, retry. The services' `_in_txn` cores call `emit`; the action engine never emits sync itself. | `LegacyOrigin` implements `copy_info` from `event_sync_links` (`events/sync.rs`, `lifecycle.rs:28`) and `splits.origin_read_only`; the services keep calling today's `sync_source_change` (`events/router.rs:1341`). |
| `MemberDirectory` (users/links/roles auto-provisioned) | Member sync (WP11) | Bot actor resolves without a prior web login (`command-gate.ts:64-80`). | Today's `X-Discord-Id` path (`auth/rbac.rs:329`). |

Owner decisions applied here without re-opening them: origin tenant owns and is the only editor of every synced record; copies are read-only and link back; the alliance owns the canonical event roster; split complete/close/archive/fee/value are allowed to the split creator and to holders of the general manage permission; XP exists only at guild level (no alliance leaderboard); the backend schedules events and the bot only executes effects; `ping_alliance` becomes "share with alliance".

---

## 1. Principles and deletion list

1. **One decision function per action.** `evaluate(action, entity_state, actor, tenant) -> Verdict` is the only place that says "allowed or not, and why". The descriptor endpoint, the executor, and legacy route shims all call it. A button can never be shown that the executor would refuse.
2. **State machines live in Rust only.** Tables below; clients never test `status === 'live'` to decide a button.
3. **Clients render and call.** The web renders descriptors into an `ActionBar`; the bot renders them into button rows. Both post to the same URL and get the same response shape.
4. **Money and rules are computed once.** Pool, fee, shares, withdrawable selection come from the backend as strings (`Decimal`), never recomputed from floats.
5. **Types are generated.** OpenAPI is emitted by the backend, checked in, and compiled into TS types for both clients; a contract test fails when a client calls a path or method that does not exist.

### 1.1 What is replaced or deleted (per slice, see section 13)

| Duplicated rule today | Location | Replaced by |
|---|---|---|
| `ALLIANCE_ALLOWED_COMMANDS`, `isCommandAllowedOnTenant`, the two gate call sites | `discord-bot/src/services/command-gate.ts:22-45`, `:60-70`, `:100-117` | `commands[]` from `GET /api/tenants/{id}/capabilities` |
| `ALLIANCE_GUILD_ONLY_MESSAGE` replies | `command-gate.ts:47`, `:68-77`, `:104-116` | generic `module_unavailable` reply built from `reason_code` |
| `hiddenForAlliance` on nav items and admin panels | `frontend/src/app/layout/nav.ts:18`, `:37`, `:95`, `:122-190`, `:295-347`; `features/admin/admin-hub.ts:458-466` | `nav[].visible` from `GET /api/me/capabilities` |
| `guildOnlyGuard` on 12 routes | `core/guards/auth.guard.ts:111-118`; `app.routes.ts:34,104,109,131,162,172,177,201,267,273,279,291` | `moduleGuard('<module>')` reading capabilities |
| `featureKey` special case for alliance bank/splits.paid | `nav.ts:98-108` | module catalogue row (`feature: NotRequiredFor(alliance)`) |
| `FEATURE_GATES` prefix table (backend) | `backend/src/tenant.rs:467-519`, test at `:774` | `capabilities::MODULES` (same table drives middleware, capabilities, command list) |
| Event manage predicates `canEdit`/`canDelete` | `event-detail.ts:3229-3248` | `actions` descriptor (`edit`, `archive`) |
| Bot management authority round trip | `discord-bot/src/services/event-authority.ts` (whole file) | generic `act:` handler; descriptor `allowed` |
| `GET /events/{id}/management-authority` | `events/router.rs:1888-1912` | deprecated shim over `evaluate(event.edit)`, deleted in SA-14 |
| Four event lifecycle orchestrations (button, slash, thread command, poller) | `handlers/button.ts`, `services/event-lifecycle.ts:62-164`, `commands/event-start.ts`, `services/event-thread-command.ts` | `POST /api/events/{id}/actions/{start,stop,...}`; voice/notice work becomes outbox effects |
| Split ownership rule copy | `frontend/.../splits/split-access.ts` (whole), `splits.ts:~417,514` (`canActOn`), `split-detail.ts` `canAct` | split descriptors |
| Split net/fee/share math | `split-detail.ts:1148-1157` (`netOf`), `splits.ts:1196-1225` (`draft*`, `perParticipantShare`), `discord-bot/src/services/split-summary.ts:46-62` (`pendingSplitPool`) | `POST /api/splits/preview` and `SplitDetail.projected` |
| Withdrawal row selection and guild resolution | `bank.ts:880-960` (`executeWithdrawal`, `loadRequestableCredits`, `loadTransactionsByStatus`), `bot commands/balance-request.ts:17-22`, `handlers/button.ts:1113-1197` | `GET /api/bank/withdrawable`, `POST /api/bank/withdraw {amount}` |
| Event create payload builders (two different contracts) | `frontend/.../events/events.ts:898-925`, `bot commands/event-create.ts:7-84` | one `event.create` action (section 3.7) |
| Hand-written API types | `frontend/src/app/core/models/api.models.ts` (3191 lines), `discord-bot/src/api/types.ts` (703 lines) | generated `api.gen.ts` plus thin aliases |

---

## 2. Capabilities

### 2.1 Module catalogue (backend source of truth)

New file `apps/backend/src/modules/capabilities/catalogue.rs`. One const table; it replaces `FEATURE_GATES` and is also the source for nav visibility and the bot command list.

```rust
pub struct ModuleDef {
    pub key: &'static str,                    // "events", "splits", "warns", ...
    pub kinds: KindRule,                      // per-kind availability, see below
    pub feature: FeatureRule,                 // Required("regears") | NotRequiredFor(Kind::Alliance) | None
    pub api_prefixes: &'static [&'static str],// same longest-prefix semantics as tenant.rs required_feature
    pub view: Permission,                     // the permission that makes it "accessible"
    pub grants: &'static [(Grant, Permission)],// Create/Edit/Delete/Manage -> permission key, for UI toggles
    pub commands: &'static [&'static str],    // Discord slash/context command names
    pub nav: &'static [NavDef],               // {key, group} entries this module contributes
}
pub enum KindRule { Both { alliance_scope: Scope, alliance_read_only: bool }, GuildOnly, AllianceOnly }
pub enum Scope { Own, Aggregate }            // alliance sees an aggregate of member-guild data or only its own
```

Proposed default matrix (a single-line edit per cell; it follows the owner decisions and plan section 2). Cells marked `agg/ro` are aggregates of member-guild copies, read-only at the alliance:

| module | guild | alliance | notes |
|---|---|---|---|
| dashboard, users (directory), albion_link, notifications, audit, admin | yes | yes (alliance-specific admin panels) | users directory at alliance shows guild attribution |
| events | yes own | yes own + copies | alliance owns canonical roster for alliance-origin events |
| comps (comps + builds) | yes | yes | origin owns, copies read-only |
| splits | yes | yes own + copies | `splits.paid` (islands) not required for alliance (today `nav.ts:98-108`) |
| bank | yes | yes agg/ro | read-through, withdraw resolves guild server-side |
| regears | yes | agg/ro | request and review happen in the origin guild |
| warns | yes | agg/ro | |
| progression (XP, rank, leaderboard, season) | yes | **no** | owner decision: XP guild-level only |
| battles (battles, fights, economy, fight-analytics) | yes | agg/ro | friendly set = member guilds (plan 4.4) |
| intel (intel, enemies, fingerprints, attention), tests (combat tests), siphoned | yes | no | |
| giveaways, applications (applications, tickets, trials), vods | yes | no | community flows of one Discord |
| alliance (membership, sync health, expel) | n/a | yes | also visible to guild admins as "my alliance" |
| platform | platform admins only | | |

### 2.2 Endpoints

```
GET /api/me/capabilities                       session or bot actor (X-Discord-Id); ETag + If-None-Match -> 304
GET /api/tenants/{guild_id}/capabilities       BotSecret only, no user part; used for command registration
```

`GET /api/me/capabilities` (`ApiResponse<Capabilities>`):

```jsonc
{
  "version": "9c1e7a",                     // hash(catalogue, tenant features, user permissions); also the ETag
  "tenant": { "id": "123", "name": "Weaklings", "kind": "guild", "status": "active",
              "timezone": "Europe/Rome",   // discord_event_timezone, used by every date input
              "alliance": { "id": "a-1", "name": "Alliance X", "role": "member" } },  // role: member | hub
  "user":   { "user_id": 7, "is_owner": false, "is_platform_admin": false,
              "permissions": ["events.view", "events.create", "splits.create"] },
  "modules": [
    { "key": "events", "enabled": true, "accessible": true, "scope": "own", "read_only": false,
      "grants": ["view", "create", "edit"], "reason_code": null },
    { "key": "progression", "enabled": false, "accessible": false, "reason_code": "kind_unsupported" }
  ],
  "commands": [
    { "name": "event-create", "module": "events", "enabled": true, "accessible": true,
      "required_permission": "events.create" }
  ],
  "nav":          [ { "key": "events", "module": "events", "group": "operations", "visible": true } ],
  "admin_panels": [ { "key": "admin.settings", "module": "admin", "visible": true } ]
}
```

`enabled` = tenant kind + feature flag allow the module. `accessible` = enabled and the actor holds the view permission. `reason_code` is one of `kind_unsupported`, `feature_disabled`, `permission_missing`, `tenant_suspended`. `user.permissions` is the current `profile.permissions` (`auth/router.rs:926-931`), so `/auth/me` stays as is and `hasPermission` keeps working during migration. Nav and admin panel presentation (icon, label key, path) stays in the clients, keyed by `key`; only visibility moves.

`GET /api/tenants/{id}/capabilities` returns the same minus `user` and `accessible`, plus `commands_hash`. The bot keeps its 60s status cache (`tenant-gate.ts:47-65`) for it and re-runs `registerCommands(guildId)` when `commands_hash` changes. `services/registry.ts:9-25` then registers only the enabled commands for that tenant, so an alliance Discord no longer shows warns or XP commands at all.

### 2.3 Enforcement in the backend

`resolve_tenant` (`tenant.rs`, the `required_feature(path)` call) switches to `capabilities::gate(path, kind, features)`. Behaviour change: kind exclusion is now enforced server-side (today it exists only in the clients, members-15). Response: `403` ProblemDetails with `code: "module_unavailable"`, `reason_code`, `module`. Rollout is staged by config `MODULE_KIND_ENFORCEMENT=log|enforce` (default `log` for one release, emitting a `would_block` counter and warn log with path and caller), because the alliance poller and other bot calls may still touch guild-only paths (`poller.ts:476-504`).

Equivalence test (SA-2, before `FEATURE_GATES` is deleted): for every `(prefix, feature)` in the old table, `catalogue::feature_for_path(prefix)` returns the same feature. After that the old table and its test (`tenant.rs:774`) are removed.

### 2.4 Client consumption

Web:
- `core/data/capabilities.store.ts` (root service, keyed by tenant id, cleared by the tenant-switch signal; refetch on `version` mismatch carried in an `X-Capabilities-Version` response header set by the backend on every API response, so the cache is invalidated without polling).
- `moduleGuard(key)` replaces `guildOnlyGuard`, `permissionGuard` on module routes, and `featureKey`. It redirects to `/dashboard` with a toast built from `reason_code`.
- `nav.ts` keeps `{path, icon, labelKey, navKey}`; `filterNavSections` filters by `capabilities.nav[navKey].visible`. `hasFeature`, `tenantKind` params and `hiddenForAlliance` are deleted.

Bot:
- `executeSlashCommand` / `executeMessageContextCommand` look up `commands[name]` in the tenant capabilities. Not enabled: reply from `reason_code`. Not accessible for the user: the first backend call would 403 anyway, but the pre-check gives a clear ephemeral message before any work.
- Contract test: every key of `commands` (`commands/index.ts:36-68`) exists in `apps/contracts/capabilities.json`, and every catalogue command is either implemented or listed in `parity.json` as `todo`.

---

## 3. Action descriptors and executor

### 3.1 Module layout

```
apps/backend/src/modules/actions/
  mod.rs          router fn `entity_routes::<E>()`, shared types
  model.rs        ActionDef, Verdict, Denial, ActionDescriptor, ActionRequest, ActionResult (ToSchema)
  engine.rs       evaluate(), describe(), execute()  (the only place that locks, audits, logs, enqueues)
  effects.rs      EffectSink trait, EffectKind enum, NoopSink, OutboxSink (after outbox slice)
  origin.rs       OriginRule (OwnerOnly | CopyAllowed), thin adapter over sync::guard::copy_info / assert_writable, LegacyOrigin
  schema.rs       schema_of::<T>() -> JSON Schema with $ref inlined, x-options helper
  catalog.rs      GET /api/actions/catalog + snapshot for contracts
  entities/{event,split,comp,build,bank,regear,warn,application,trial,giveaway,vod,albion_link,alliance}.rs
  README.md
```

Each entity module registers a `const DEFS: &[ActionDef]` and implements:

```rust
pub trait ActionEntity {
    const KIND: &'static str;                                  // "event"
    type Snapshot: Send;                                       // status, archived, creator_id, origin, flags
    async fn snapshot(cx: &ActionCx, id: Option<i64>) -> Result<Self::Snapshot, AppError>;
    async fn snapshot_batch(cx: &ActionCx, ids: &[i64]) -> Result<HashMap<i64, Self::Snapshot>, AppError>;
    fn defs() -> &'static [ActionDef];
    async fn apply(tx: &mut ActionTx, def: &ActionDef, snap: &Self::Snapshot, params: Value)
        -> Result<ApplyOutcome, AppError>;                     // runs inside the txn, returns new state + effects
    async fn view(cx: &ActionCx, id: i64) -> Result<Value, AppError>; // the same view GET /api/<entity>/{id} returns
}

pub struct ActionDef {
    pub id: &'static str,              // "start"; fully qualified "event.start" in logs and the catalog
    pub label_key: &'static str,       // "action.event.start" (i18n key; bot ships English strings for the same keys)
    pub style: Style,                  // Primary | Neutral | Danger
    pub group: &'static str,           // "lifecycle" | "roster" | "sync" | "finance" | ...
    pub module: &'static str,          // catalogue module that must be accessible
    pub authority: Authority,          // Anyone | Permission(P) | CreatorOr(P) | SelfOnly
    pub origin: OriginRule,            // OwnerOnly | CopyAllowed (tenant-local actions, join/leave)
    pub from: &'static [&'static str], // allowed source states (empty = any)
    pub to: Option<&'static str>,      // target state (None = no state change)
    pub archived_ok: bool,
    pub confirm: Option<ConfirmSpec>,  // { title_key, body_key, typed: Option<&'static str> }
    pub params: Option<ParamsSpec>,    // typed struct + optional dynamic enum provider
    pub effects: &'static [EffectKind],// declared kinds, shown as effects_preview
    pub sync_kind: Option<SyncKind>,   // informational: which SyncKind/op the service core emits (sync-engine 3.2); the engine never emits itself
    pub transport: Transport,          // Action (POST /actions/{id}) | Direct { method, path_template }
}
```

`Transport::Direct` covers high-cardinality officer operations that stay plain REST routes (roster seat assign, swap, auto-fill, roster-role add/remove, link battles, split participants add/remove). They appear in the descriptor list as `{id:"roster_edit", transport:"direct", endpoints:[...]}` with `allowed` computed by the same `evaluate`, so the client does not re-derive authority, but they are not executed through `/actions/{id}`. They can migrate later without changing any client rule.

### 3.2 Evaluation order (deterministic reason)

`evaluate()` returns the first failing check; `visible=false` verdicts are the ones a client should hide instead of show disabled:

| # | Check | reason_code | visible | HTTP on execute |
|---|---|---|---|---|
| 1 | module accessible for tenant kind, feature, view permission | `module_unavailable` | no | 403 |
| 2 | origin rule: tenant is not the origin and action is `OwnerOnly` | `copy_read_only` (params: `origin`) | yes (disabled, shows origin) | 403 |
| 3 | authority (permission, creator, or self) | `permission_missing` (params: `permission`) or `not_creator_or_manager` | no | 403 |
| 4 | archived and `!archived_ok` | `archived` | yes | 409 |
| 5 | state not in `from` | `wrong_state` (params: `state`, `allowed`) | yes | 409 |
| 6 | entity preconditions (per entity function) | e.g. `event_not_ended`, `split_no_participants`, `split_net_not_positive`, `alliance_membership_required`, `guild_choice_required` | yes | 409 |

Authority for events keeps today's rule (`require_event_management_authority`, `events/router.rs:1657-1676`: permission **or** creator), expressed as `CreatorOr(Permission::EventsEdit)` for start/stop/cancel/uncancel/remind/edit and `CreatorOr(Permission::EventsDelete)` for archive/unarchive (today's archive uses `EventsDelete`, which `management-authority` never reported). Legacy `events.manage` keeps implying view/create/edit/delete via `PermissionCache::role_has` (`auth/permission_cache.rs:27-37`).

### 3.3 Routes

```
GET  /api/{entity}/{id}/actions                 -> ApiResponse<ActionList>
GET  /api/{entity}/actions                      -> collection-level actions (create, preview, complete_batch)
POST /api/{entity}/{id}/actions/{action}        -> ApiResponse<ActionResult>
POST /api/{entity}/actions/{action}             -> collection-level (create)
GET  /api/bank/actions, POST /api/bank/actions/{action}   singleton entity: no id
GET  /api/actions/catalog                       static catalogue (ids, params schema refs, effects); also snapshotted to apps/contracts/actions.json
```

Entities mounted: `events`, `splits`, `comps`, `comps/builds`, `bank`, `regear` (keyed by `death_id`), `warns`, `applications`, `trials`, `giveaways`, `vods`, `albion/link`, `alliances` (membership), `alliance/shares*` (manual snapshot verbs) is not mounted as actions; it goes away with the sync engine's build/comp/split copies. Each module router adds `.merge(actions::entity_routes::<Entity>())`. utoipa paths are generated by a small macro per entity so ApiDoc lists them with typed bodies.

`ActionList`:

```jsonc
{
  "entity": { "type": "event", "id": 123, "state": "scheduled", "archived": false,
              "sync": { /* SyncInfo, section 7 */ } },
  "etag": "e-123-17",                       // revision of the entity; send back as expected_etag
  "actions": [
    { "id": "start", "label_key": "action.event.start", "style": "primary", "group": "lifecycle",
      "allowed": true, "visible": true, "reason_code": null, "reason": null,
      "requires_confirm": false, "confirm": null, "params_schema": null,
      "effects_preview": ["event.start_notice", "voice.provision"], "transport": "action" },
    { "id": "cancel", "allowed": true, "visible": true, "requires_confirm": true,
      "confirm": { "title_key": "action.event.cancel.confirm.title", "body_key": "action.event.cancel.confirm.body", "typed": null } },
    { "id": "edit", "allowed": false, "visible": true, "reason_code": "copy_read_only",
      "reason": "This event is owned by Guild A. Edit it there.",
      "reason_params": { "origin": { "tenant_id": "999", "tenant_name": "Guild A", "openable": true } } },
    { "id": "join", "allowed": true, "params_schema": { /* JSON Schema with x-options */ } }
  ]
}
```

`reason` is English default text; clients translate by `reason_code` + `reason_params`. `params_schema` is a JSON Schema (draft 2020-12 subset: object, string, integer, number, boolean, enum, date-time, array of those) with two extensions: `x-options: [{value, label, disabled?, reason?}]` for dynamic choices, and `x-widget: "datetime-local" | "comp-picker" | "user-picker" | "guild-picker"` as a hint. Example for `event.join` on an alliance-owned event (replaces `GET /participation-guilds` + `GET /signup-options`, whose double unwrap breaks the web, `event-detail.ts:5515-5521`):

```jsonc
{ "type": "object",
  "required": ["guild_tenant_id"],
  "properties": {
    "guild_tenant_id": { "type": "string", "x-widget": "guild-picker",
      "x-options": [ { "value": "111", "label": "Guild A" }, { "value": "222", "label": "Guild B" } ] },
    "build_id": { "type": "integer", "x-options": [ { "value": 5, "label": "Tank / Mace" } ] },
    "roster_role_id": { "type": ["integer", "null"] } } }
```

When the member belongs to exactly one eligible guild the schema omits `guild_tenant_id` and the executor fills it (replaces the `none/resolved/choice` resolution in `bot services/event-join-guild.ts:24-46`).

`POST .../actions/{action}` body:

```jsonc
{ "params": { },                         // validated against the same Rust struct that generated params_schema
  "expected_etag": "e-123-17",           // optional optimistic guard; mismatch -> 409 stale_entity with fresh descriptor
  "idempotency_key": "01J8..." }         // optional; also accepted as Idempotency-Key header
```

Response `ActionResult`:

```jsonc
{
  "action": "start",
  "outcome": "applied",                  // applied | noop (already in target state)
  "state": { "from": "scheduled", "to": "live" },
  "entity": { /* identical to GET /api/events/{id} (EventDetailView) */ },
  "actions": [ /* fresh ActionList.actions, so the UI re-renders without a second request */ ],
  "effects": [ { "id": 9912, "kind": "voice.provision", "tenant_id": "123", "state": "queued" },
               { "id": 9913, "kind": "event.start_notice", "tenant_id": "123", "state": "queued" } ],
  "sync": { "queued": true, "outbox_id": 5521 }      // null when the action emits nothing; per-target state via GET /api/sync/status?entity=event:123
}
```

Errors are ProblemDetails (`errors.rs:34-50`) extended with two optional fields, `code` (machine reason code from section 3.2 or `stale_entity`, `idempotency_conflict`, `amount_not_exact`, ...) and `details` (object). The 403/409 body for a denied execute is exactly the denied descriptor entry, so a client that ignored `allowed` still renders the same message.

### 3.4 Execution contract (`engine::execute`)

1. Resolve entity snapshot, `evaluate()` (fast fail, no locks).
2. Open one transaction. Lock the entity row (`FOR UPDATE`, as `stop_event_with_xp_policy` already does at `events/service.rs:4012-4018`; SQLite ignores it in tests). Re-load the snapshot and **re-evaluate under the lock** (TOCTOU).
3. If `idempotency_key` matches a row in `action_log` for the same actor and action: return `outcome: applied` replay with a fresh view, no side effects.
4. If current state already equals `def.to` and the action is declared idempotent (`start` on live, `stop` on stopped, `cancel` on cancelled, `archive` on archived): `outcome: noop`, no effects, no sync emit. This removes the "already live" branches in `bot event-lifecycle.ts:101-106` and the 409 on duplicate Start.
5. `apply()` mutates through `*_in_txn` variants of the existing service functions. Required refactor, the real work of SA-4/SA-5: `EventService::{start,cancel,uncancel,stop_with_xp_policy,archive,unarchive}` and `SplitService::{complete,close,archive}` today open their own transaction or none (`events/service.rs:3873,3909,3948,4007`; `splits/service.rs:1105,2139`). Each gets a `_in_txn(&DatabaseTransaction, ...)` core that also calls `sync::outbox::emit` (sync-engine 3.2 lists the same functions as choke points, so both refactors are one change per function); the old signatures become wrappers so existing tests keep compiling.
6. Same transaction: insert `action_log` row, enqueue `effects` through `EffectSink`; the sync outbox row was already written by the service core in step 5; write the existing audit event. Commit.
7. After commit (best effort, never part of the verdict): `AuditService::log` Discord echo, `hub.publish` of the changed entity key (`events/roster_hub.rs`) for realtime refresh.
8. Return `ActionResult`; `effects` and `sync` in the response describe the rows just created, not delivery results.

Failure of step 6 aborts the whole action: there is no state change without its effects and sync outbox row (replaces the current "commit locally, then fail the request on sync" pattern, `events/router.rs:1334`, `:2043`, `:2075`).

### 3.5 Tenant table `action_log`

Tenant schema (`apps/backend/src/migration/m20261107_000002_create_action_log.rs`; one `create_table` plus separate `create_index` statements so SQLite accepts it, per BASE-1):

```
action_log(
  id               BIGINT PK AUTO,
  entity_type      TEXT NOT NULL,          -- 'event' | 'split' | 'comp' | 'bank' | ...
  entity_id        BIGINT NULL,            -- NULL for collection actions
  action           TEXT NOT NULL,
  actor_user_id    BIGINT NOT NULL,
  channel          TEXT NOT NULL,          -- 'web' | 'discord' | 'system' | 'api'
  idempotency_key  TEXT NULL,
  from_state       TEXT NULL,
  to_state         TEXT NULL,
  outcome          TEXT NOT NULL,          -- 'applied' | 'noop'
  params           TEXT NULL,              -- JSON, secrets/free text truncated to 2 KB
  effect_ids       TEXT NULL,              -- JSON array of discord_outbox ids
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
)
INDEX action_log_entity_idx   (entity_type, entity_id, created_at DESC)
UNIQUE INDEX action_log_idem  (actor_user_id, action, idempotency_key) WHERE idempotency_key IS NOT NULL
```

Uses: idempotency, the "activity" timeline on event/split detail (who did what from web or Discord), the missing split audit (finance-16), and metrics `actions_total{entity,action,channel,outcome}`. Retention: pruned at 90 days by the existing hourly maintenance in `event_sessions`. No control-plane table is added by this subsystem.

### 3.6 Action registry (what exists, with authority and effects)

| entity.action | from -> to | authority | origin rule | params | effects | sync emit (by the service core) |
|---|---|---|---|---|---|---|
| event.create (collection) | - -> scheduled | `events.create` | n/a | section 3.7 | `event.announce`, `alliance.announce` if shared, `split.forum.upsert` if split | Update (copies, if shared) |
| event.edit | any non-archived | CreatorOr `events.edit` | OwnerOnly | partial of create | `event.card.upsert` | Update |
| event.start | scheduled -> live | CreatorOr `events.edit` | OwnerOnly | - | `event.card.upsert`, `event.start_notice`, `voice.provision` | Update |
| event.stop | live -> stopped | CreatorOr `events.edit` | OwnerOnly | - | `event.card.upsert`, `event.stop_notice`, `voice.teardown`, `event.thread.close` | Update; XP per section 3.8 |
| event.cancel | scheduled, live -> cancelled | CreatorOr `events.edit` | OwnerOnly | - (confirm) | `event.card.upsert`, `voice.teardown`, `event.thread.close` | Archive |
| event.uncancel | cancelled -> scheduled | CreatorOr `events.edit` | OwnerOnly | - | `event.card.upsert` | Update |
| event.archive / unarchive | any <-> archived | CreatorOr `events.delete` | OwnerOnly | - (confirm) | `event.card.retire` / `event.card.upsert` | Archive / Update |
| event.remind | scheduled | CreatorOr `events.edit` | CopyAllowed (local notice only) | - | `event.reminder` | none |
| event.share_alliance / unshare_alliance | scheduled, live | CreatorOr `events.edit` | OwnerOnly | - | `alliance.announce` once (on share only) | Event upsert; target set changes with `ping_alliance` (sync-engine 3.3 retires copies on unshare) |
| event.join | scheduled, live | `events.view` + self | CopyAllowed | `guild_tenant_id?`, `build_id`, `roster_role_id?` | `event.card.upsert` | participation intent to origin roster |
| event.leave | scheduled, live | self | CopyAllowed | - | `event.card.upsert` | participation intent |
| event.retry_sync | any | CreatorOr `events.edit` or `sync.manage` | OwnerOnly | `target_tenant_id?` | none | wraps `POST /api/sync/retry` |
| event.link_split / unlink_split / create_split | scheduled, live, stopped | CreatorOr `events.edit` + split owner rule | OwnerOnly | `split_id` | `split.forum.upsert` | Update |
| event.roster_edit (direct) | scheduled, live | CreatorOr `events.edit` | OwnerOnly (alliance owns canonical roster) | seat ops | roster hub | roster intents |
| split.create (collection) | - -> pending or awaiting_event | `splits.create` | n/a | values, fee?, participants | `split.forum.upsert` | Update |
| split.update | pending, awaiting_event | CreatorOr `splits.edit` | OwnerOnly | fee, values, participants, location, event_id | `split.forum.upsert` | Update |
| split.complete | pending -> completed | CreatorOr `splits.edit` | OwnerOnly | - (confirm) | `split.forum.upsert`, `dm.send` per credit | Update, then distribution (alliance-origin) |
| split.not_completed / lost | pending, awaiting_event -> terminal | CreatorOr `splits.edit` | OwnerOnly | reason? (confirm) | `split.forum.upsert` | Update |
| split.archive / unarchive | any <-> archived | CreatorOr `splits.delete` | OwnerOnly | - | `split.forum.retire` | Archive |
| split.donate_share | completed | self (credit owner) | CopyAllowed (credit lives where it was paid) | `participant_id` | none | none |
| split.retry_distribution | completed, alliance-origin | CreatorOr `splits.edit` or `sync.manage` | OwnerOnly | `guild_tenant_id?` | none | wraps `POST /api/sync/retry` for the `split.payout` jobs |
| bank.withdraw / withdraw_preview | - | self + `bank` accessible | n/a | `amount` / `all` / `transaction_ids`, `guild_tenant_id?` | `bank.audit_post` | none |
| bank.accept / reject | requested -> withdrawn / rejected | `bank.withdraw.accept` | n/a | `transaction_ids` | `bank.audit_post`, `dm.send` | none |
| comp.edit / archive / unarchive / new_version, build.* same | per comps service guards | `comps.comps.*`, `comps.builds.*` | OwnerOnly | | none | Comp / Build upsert (always synced; no per-record share switch, sync-engine 1.3) |
| regear.request | - | `regear.request` | n/a | `death_id` | `regear.audit_post` | none |
| regear.accept / reject | pending -> approved / rejected | `regear.adjudicate` | n/a | `note?` | `regear.audit_post`, `dm.send` | none |
| warn.issue / revoke / ack_escalation | | `warns.issue` / `warns.view` | n/a | `user_ref` (discord id or user id), `reason`, `multiplier_days?` | `dm.send` | none |
| application.accept / decline / reopen / close | | `applications.manage` | n/a | `as_trial?` | `discord.role.assign`, `ticket.update` | none |
| trial.end / extend | | `applications.manage` | n/a | `days?` | `discord.role.remove` | none |
| giveaway.enter / leave | | self | n/a | | `giveaway.post.update` | none |
| giveaway.create / draw / cancel | | `giveaways.create` / `giveaways.manage` | n/a | | `giveaway.post.upsert`, `dm.send` | none |
| vod.submit | | `vod.submit` | n/a | `event_id`, `url` | none | none |
| albion_link.link / unlink | | self | n/a | `player_id` or `ign` | `discord.role.sync` | member intents |
| alliance.invite / accept / decline / leave / expel | | `alliance.*` + tenant owner | n/a | `guild_tenant_id` | `discord.role.revoke` | detach / backfill (membership slice) |

Effect kinds are the closed enum owned by the outbox design; this table only declares which action emits which. Until the outbox exists the executor returns `effects: []` and the legacy poller continues; that is the only behavioural difference between SA-4 and SA-7.

### 3.7 Event creation contract (single, tenant-timezone aware)

`POST /api/events/actions/create`. Both clients send the same body; the backend converts local times with `tenant.timezone`.

```jsonc
{ "params": {
    "kind": "organized",                       // organized | flash   (flash: no comp, binary participation)
    "title": "ZvZ Castle Fight",
    "description": "…",
    "comp_id": 12,                             // required for organized
    "start_local": "2026-11-08T21:00",         // wall time in tenant.timezone; legacy start_time_utc still accepted
    "mass_offset_minutes": 30,                 // default from tenant settings; mass_local may be given instead
    "player_cap": null,
    "call_to_arms": false,
    "regear": true,
    "share_alliance": true,                    // replaces ping_alliance (no direct post, section 0)
    "discord_role_ids": ["…"],
    "vod_forum_post_enabled": true,
    "discord_delivery": "message",
    "create_split": { "island_tab_id": 10 }    // optional
  } }
```

`models.rs:580-634 CreateEventRequest` stays as the internal struct; the action's `params` is a thin adapter (`start_local` -> `start_time_utc`, `share_alliance` -> `ping_alliance`). `ping_alliance` remains accepted on `POST /api/events` for one release and is mapped to `share_alliance`. The descriptor for the collection (`GET /api/events/actions`) returns `params_schema` with `x-options` for comps (top 25 by recent use; the bot additionally gets an autocomplete endpoint `GET /api/comps?search=&limit=25`), island tabs, delivery modes, Discord roles, plus the tenant timezone, so neither client hard-codes defaults.

### 3.8 Guild-level XP for alliance events

`stop` on an event whose participants carry guild attribution awards XP only inside each attributed guild. Implementation point: `snapshot_event_completion_xp` (`events/service.rs:4060`) already snapshots recipients; the `award_xp` flag (`stop_event_with_xp_policy`, `:4007`, currently false for mirrors via `is_mirror_event`, `events/router.rs:2139`) becomes "award for participants attributed to *this* tenant". That belongs to the sync-engine/events designs; the action layer only guarantees `event.stop` is the single entry point (web, Discord, scheduler `auto_stop` all call `Transition::stop`).

---

## 4. State-transition tables (backend only)

### 4.1 Events

New `events/status.rs`, mirroring `splits/status.rs`. Today statuses are string literals compared in `events/service.rs:3881-3893,3925,3957-3961,4020-4043`.

```rust
pub enum EventStatus { Scheduled, Live, Stopped, AutoStopped, Cancelled }   // archived_at stays orthogonal

pub const EVENT_TRANSITIONS: &[Transition] = &[
    // action      from                       to              guard                       who
    T("start",     &[Scheduled],              Live,           not_archived,               User),
    T("stop",      &[Live],                   Stopped,        not_archived,               User),
    T("auto_stop", &[Live],                   AutoStopped,    deadline_passed,            Scheduler),
    T("cancel",    &[Scheduled, Live],        Cancelled,      not_archived,               User),
    T("uncancel",  &[Cancelled],              Scheduled,      not_archived,               User),
];
// Same-state requests are `noop`, except start on Stopped/AutoStopped, which is wrong_state
// ("re-opening a stopped session is not supported", service.rs:3957).
```

Archive/unarchive are flags, allowed in every status, and cascade to linked splits in the same transaction (`service.rs:3681-3760` today, kept). Terminal-state rule shared with sync: copies follow the origin state and never regress (a copy in `Stopped` is not moved back to `Live` by a late `converge`; this is the sync design's invariant, expressed here as "`Transition::apply_remote` only accepts forward edges in this table, plus `uncancel`").

Scheduler (`mass_due`, `start_due`, `reminder_1h`, `auto_stop`) is a caller of `engine::execute_system(Action, channel="system")`, so its effects are produced by exactly the same code path as a web click (owner decision on scheduling; section 3.4). `remind` on a copy is the one local-effect action allowed on copies.

### 4.2 Splits

`splits/status.rs` already has the enum; the table moves next to it and replaces the guards scattered over `service.rs:1198-1205` (`load_editable`), `:1086-1125` (`load_with_status`, `close_split`), `:2139-2200` (`complete_split`).

```rust
pub const SPLIT_TRANSITIONS: &[Transition] = &[
    T("update",        &[Pending, AwaitingEvent], same,         editable,                      User),
    T("complete",      &[Pending],                Completed,    event_ended & participants>0 & net>0, User),
    T("not_completed", &[Pending, AwaitingEvent], NotCompleted, -,                             User),  // AwaitingEvent newly allowed (finance-4)
    T("lost",          &[Pending, AwaitingEvent], Lost,         -,                             User),
    T("recompute",     &[AwaitingEvent],          Pending,      linked_event_ended_or_cancelled_or_unlinked, System),
];
// Completed, NotCompleted, Lost are terminal for money. Archive is a flag allowed everywhere.
// `recompute` runs on event stop/cancel/uncancel/unlink via the same executor, so a cancelled event can no longer strand a split.
```

`complete` from `AwaitingEvent` stays refused with `event_not_ended` (today `service.rs:2146-2155`), but the descriptor says so up front and offers `not_completed` and `lost` instead.

**Authority (owner decision, section 0).** Complete, not_completed, lost, archive, unarchive, fee and value changes: split creator **or** holder of the general manage permission.
- "General manage permission" = `splits.manage` (`auth/permissions.rs`, key exists today but is a dead legacy grant). Extend `PermissionCache::role_has` (`permission_cache.rs:27-37`) so `SplitsManage` implies `SplitsView|SplitsCreate|SplitsEdit|SplitsDelete`, exactly as `EventsManage` already does. Existing roles that hold `splits.edit` / `splits.delete` keep working unchanged.
- Rule in the registry: `CreatorOr(SplitsEdit)` for update/complete/not_completed/lost/participants, `CreatorOr(SplitsDelete)` for archive/unarchive. This is today's `authorize_split_owner_or_global` (`splits/router.rs:32-65`) moved into `evaluate`; the only behavioural change is `update_split` (`router.rs:310`), which today requires `SplitsEdit` even from the creator, and now also accepts the creator, so fee/value edits match the rest of the owner rule.
- Fee and value on create: the creator sets them (no restriction; plan question 7 default "force default fee" is overridden by the owner decision).
- `deny_mutation` (`service.rs:760-765`) currently blocks every mutation on an alliance tenant (`tenant_kind == "alliance"`) and on `origin_read_only`. It is replaced by sync-engine's `guard::assert_writable` (sync-engine 6.1: read-only exactly when `sync_copies` says the split is an attached copy), so an alliance can own splits for alliance events and only copies are read-only. The `tenant_kind == "alliance"` blanket is removed in SA-5; until the sync engine's guard lands, the stand-in is `splits.origin_read_only` alone.

### 4.3 Other entities (compact)

| Entity | States | Transitions (only these) |
|---|---|---|
| bank transaction | pending, requested, withdrawn, rejected, donated | withdraw: pending, rejected -> requested; accept: requested -> withdrawn; reject: requested -> rejected; donate: pending, rejected -> donated (`bank/service.rs:766,894,1031`) |
| regear request | none, pending, approved, rejected | request: none -> pending; accept/reject: pending -> approved/rejected; request again after reject |
| application | open, accepted, declined, closed | accept/decline: open -> terminal; reopen: closed, declined -> open; close: open -> closed |
| trial | active, ended, expired | end/extend: active; expire: scheduler, active -> expired (new worker, parity-7) |
| giveaway | open, drawn, cancelled | enter/leave: open; draw: open -> drawn; cancel: open -> cancelled |
| alliance membership | invited, active, left, expelled | accept: invited -> active; decline: invited -> declined; leave: active -> left; expel: active -> expelled |

Each lives in its entity module as a `const` table with the same `Transition` type. No client keeps a status list.

---

## 5. Removing duplicated client rules

### 5.1 Bank: `withdrawable` and `withdraw {amount}`

```
GET  /api/bank/withdrawable              -> Withdrawable
POST /api/bank/withdraw/preview          body WithdrawRequest        -> WithdrawPlan
POST /api/bank/actions/withdraw          body { params: WithdrawRequest }   -> ActionResult (+ plan)
```

`Withdrawable` (alliance tenants group by member guild; guild tenants return a single group with `guild_tenant_id: null`):

```jsonc
{ "currency": "silver", "total": "128.75", "count": 3,
  "requires_guild_choice": true, "default_guild_tenant_id": null,
  "groups": [ { "guild_tenant_id": "111", "guild_name": "Guild A", "total": "80.00", "count": 2,
                "transactions": [ { "id": 12, "amount": "50.00", "split_id": 9, "status": "pending", "created_at": "…" } ] } ] }
```

`WithdrawRequest` (extends `bank/models.rs:296`): `{ "amount": "50.00" | "all": true | "transaction_ids": [..], "guild_tenant_id"?: "…" }`; exactly one of the three selectors.
- Selection for `amount` is deterministic: eligible rows are `pending` or `rejected` with `amount > 0 or split_id is not null` (the filter the web applies at `bank.ts:918-924`), ordered by `created_at, id`, taken while the running sum is `<= amount`.
- If the running sum cannot reach `amount` exactly, the plan is the largest prefix `<= amount` and `shortfall` is reported; if even the first row exceeds `amount`: 400 `code: "amount_below_smallest"`, `details.smallest`.
- `WithdrawPlan`: `{ "requested_total": "48.20", "requested_amount": "50.00", "shortfall": "1.80", "transaction_ids": [12, 14], "guild_tenant_id": "111" }`. The web confirm dialog and the bot confirm embed both print this plan; neither sums rows.
- Alliance with rows in several member guilds and no `guild_tenant_id`: 409 `guild_choice_required` with `details.choices` (the groups). One guild only: resolved automatically (today's `alliance.rs:205` rule, kept).
- Accept and reject resolve the guild per transaction id on the server (`alliance.rs:140-206`), so `guild_tenant_id` disappears from the officer calls and the bot buttons (`handlers/button.ts:1155-1197`) work unchanged.

Deleted: `bank.ts` `loadRequestableCredits`, `loadTransactionsByStatus` (1000-row pagination loop), `selectedWithdrawalIds`, `pendingGuilds`, `executeWithdrawal`'s guild resolution; `admin-withdrawals.ts:667-691` guild passing; bot `balance-request.ts:17-22` `{all:true}` special case.

### 5.2 Splits: preview and projected values

```
POST /api/splits/preview   body { estimated_market_value, repair_value, bags_value, fee?, participants:[{user_id, weight}] }
```
Response (all money as strings; computed by `calculate_net_value` and `participant_shares` in `splits/service.rs`, the same functions `complete_split` uses, so the preview cannot drift from the payout):

```jsonc
{ "value_before_fee": "1000.00", "fee_pct": "20", "fee_amount": "200.00", "net": "800.00",
  "shares": [ { "user_id": 7, "weight": "50", "amount": "400.00" }, { "user_id": 8, "weight": "50", "amount": "400.00" } ],
  "remainder": "0.00", "remainder_to_user_id": 7,        // deterministic order by user_id (finance-12)
  "warnings": [ "net_not_positive" ] }
```
`SplitDetail` and `SplitSummary` gain `projected` (same object, present while `net_value` is null). The bot embed and the web list read `projected.net` / `net_value`; `pendingSplitPool` (`split-summary.ts:46-62`), `netOf`, `draftNetPreview`, `perParticipantShare` and `split-access.ts` are deleted. This also fixes finance-2 (string concatenation of decimals) structurally rather than by patching the bot.

### 5.3 Event management authority

`canEdit` / `canDelete` / `canManageParticipants` (`event-detail.ts:3229-3248`) become `actions().has('edit')`, `.has('archive')`, `.has('roster_edit')` from the descriptor embedded in the event detail response (`EventDetailView.actions`, same `ActionList.actions` shape, computed with `snapshot_batch` for lists so lists do not N+1). `GET /events/{id}/management-authority` is kept as a shim that returns `{is_organizer, can_manage, required_permission}` derived from `evaluate(event.edit)` until SA-14; the bot no longer calls it after SA-4.

### 5.4 List endpoints

List responses include compact `allowed_actions: ["start","cancel"]` per row (ids of allowed, visible actions) so tables render bulk buttons without per-row calls. Same `snapshot_batch` path; batching origin resolution reuses the pattern at `events/router.rs:~100-150` (one control-plane query for all rows of a page).

---

## 6. OpenAPI and codegen

Today the spec exists only inside the Scalar HTML (`lib.rs:172`) and the hand-written `ApiDoc` (`openapi.rs`, 986 lines of paths), so clients cannot consume it.

1. **Serve it.** `GET /api/openapi.json` returning `ApiDoc::openapi()` (no auth, cacheable). Add the action paths, `Capabilities`, `ActionList`, `ActionResult`, `Withdrawable`, `WithdrawPlan`, `SplitPreview` to `ApiDoc`.
2. **Snapshot.** `apps/contracts/openapi.json`, `apps/contracts/capabilities.json` (catalogue), `apps/contracts/actions.json` (catalog). Rust test `contracts_are_current` serialises the live values and compares with the files; `UPDATE_CONTRACTS=1 cargo test contracts_are_current` rewrites them. CI fails on drift.
3. **Coverage lint.** Rust test scans `modules/*/router.rs` for `.route("…", method(...))` and asserts each is in `ApiDoc` paths or in `contracts/undocumented.allowlist` (the allowlist may only shrink). Also lints that every ToSchema response uses `ApiResponse*` envelope types.
4. **Generate.** `openapi-typescript` (types only, no runtime) in both apps:
   - `apps/frontend/src/app/core/models/api.gen.ts` and `apps/discord-bot/src/api/gen.ts` from `apps/contracts/openapi.json`;
   - `actions.gen.ts` from `actions.json`: `type ActionParams<'event.join'>` and `runAction('event.join', id, params)` typed through the catalog;
   - `api.models.ts` becomes aliases (`export type EventView = components['schemas']['EventView']`) migrated file by file; money fields are already `String` in the schema (`#[schema(value_type = String)]`), which is what removes float math in the bot.
   - scripts: `npm run gen:api` in each app; CI step `gen:api && git diff --exit-code`.
5. **Client path contract test.** Frontend and bot tests extract literal `api/...` paths and HTTP methods from source (the audit's regex approach, `areas.json` parity) and assert each `(method, path)` exists in `openapi.json`. This would have caught `PUT /api/splits/{id}` (`event-detail.ts:5153,5167`). Starts with an allowlist of the two known violations, fixed by WP4.
6. **Parity test.** `apps/contracts/parity.json` (section 12) is machine-read: bot test asserts each `discord` target exists (command name in `commands` map or action id handled by the generic `act:` handler); frontend test asserts each `web` target exists in `app.routes.ts` or as an `ActionBar` usage for that action id.

---

## 7. Read-only synced copies: origin badge and link

### 7.1 Data on every synced view

The shape is the sync engine's `SyncInfo` (sync-engine 6.2), unchanged, plus two additive fields (`origin.openable`, `origin.open_path`) computed by this layer. It replaces `is_synchronized_copy`, `source_tenant_id`, `source_event_id` (`events/models.rs:286-291`), `origin_read_only` (`splits/models.rs:116`) and the ad-hoc source backfill in `events/router.rs:~100-150`; the old fields stay for one release as deprecated aliases.

```jsonc
"sync": {
  "role": "copy",                                  // origin | copy
  "read_only": true,
  "state": "ok",                                   // ok | pending | failed | blocked | detached
  "origin": { "tenant_id": "999", "tenant_name": "Guild A", "tenant_kind": "guild",
              "entity_id": 42, "path": "/events/42",                       // from sync-engine
              "openable": true,                                            // added here
              "open_path": "/switch-tenant?tenant=999&next=%2Fevents%2F42" },  // added here, null when not openable
  "synced_at": "2026-11-05T19:01:00Z",
  "targets": { "total": 4, "ok": 3, "pending": 0, "failed": 1 }            // origin role only
}
```

- Per-target detail (names, `last_error`, attempts, next attempt) is not in list/detail payloads. The panel loads it lazily from `GET /api/sync/status?entity=event:123` (sync-engine 7), which already restricts rows to the caller tenant; error text is shown only to holders of the entity's manage authority or `sync.view`.
- `openable` is true when the actor is an active member of the origin tenant (control-plane membership), otherwise `open_path` is null and clients show text only. New frontend route `/switch-tenant` calls `POST /api/auth/switch-tenant` then navigates to `next`; this is the only way to deep-link across tenants because a session binds one tenant.
- Denied mutations on a copy come back as sync-engine's `AppError::ReadOnlyCopy` (403, `origin` field in the ProblemDetails); the action layer maps it to `reason_code = copy_read_only` with the same `origin` object in `reason_params`. This design adds the optional `code` and `details` members to `ProblemDetails`; sync-engine adds `origin`; both are additive.
- Present on `EventView`/`EventDetailView`, `SplitSummary`/`SplitDetail`, comp and build views, and warn and regear aggregates (sync-engine 6.2). Lists use `sync::guard::copy_info(kind, ids)`, one query per page.

### 7.2 Web

- `OriginBadge` (shared component): chip with the origin tenant icon and "Synced from {name}", tooltip with `last_synced_at`; a link when `openable`. Placed in event/comp/build/split list rows and detail headers. A `lock` glyph plus text "Read-only copy" replaces the current silent hiding of buttons.
- `SyncStatusPanel` (origin side, managers only, lazy `GET /api/sync/status`): one row per target with state pill (`ok/pending/failed/blocked/detached`), `last_error`, attempts, and a **Retry** button wired to `event.retry_sync` / `split.retry_distribution`. Replaces the missing UI for `fanout-status`, `mirror-status`, `mirror-retry`, `distribution-status` (parity-5, frontend-1); those four routes are sync-engine compatibility adapters and are not called by this layer.
- `ActionBar` disables copy-forbidden actions and shows `reason` from the descriptor on hover/focus (touch: tap shows reason in a popover), so the user always sees why and where to go.
- List filter "Origin": all / mine / from alliance / from {guild}, using `sync.origin.tenant_id`; copies sort with a subtle badge, never hidden.
- Alliance scope bar (plan 4.5 `AllianceScopeBar`) uses `sync.origin.tenant_id` for the guild filter.

### 7.3 Discord

- Embed footer on every card that is a copy: `Synced from {origin_name} · read-only`, and a Link button "Open original" when `openable` (`open_path` joined with `FRONTEND_URL`). Stale, failed or blocked copies (`state` not `ok`) add a warning field "Update pending/failed".
- Origin card for managers: button "Sync status" opening an ephemeral embed listing targets with state emoji and, for failed targets, a Retry button (`act:event:<id>:retry_sync`).
- Because copy-forbidden actions are not `visible=false`, the button row for a copy shows only `join`/`leave`/`remind`/`Details`; an officer who clicks a stale cached Edit gets the descriptor reason, ephemeral.
- Alliance announcement posted once (owner decision) carries the origin guild name in the author line; guild copies show the same card via their own outbox item.

---

## 8. Client architecture for actions

### 8.1 Web

```
core/actions/
  action.service.ts        run(entity, id, action, params, opts) -> POST; updates the entity store from `entity` and `actions` in the response
  action-bar.component.ts  renders ActionList.actions: groups, style, disabled+reason, ConfirmDialog from `confirm`
  params-form.component.ts schema -> form for the JSON Schema subset; custom forms keyed by action id can override
  origin-badge.component.ts, sync-status-panel.component.ts
```
Pages stop owning permission logic: event-detail, split-detail, comp-detail, bank, warns, regears pass `actions` to `ActionBar` and handle only presentation. The `ConfirmDialog` replaces `confirm()` and `pendingConfirm` signals. After `run()`, the response's fresh `entity` and `actions` replace local state, removing the `loadGeneration` bookkeeping in `event-detail.ts` for action-driven refreshes.

### 8.2 Bot

```
handlers/action.ts                  single handler for customId `act:{entity}:{id}:{action}[:{token}]`
services/action-render.ts           ActionList -> ActionRow[] (max 5 buttons per row, overflow into a StringSelect "More…")
services/action-params.ts           params_schema -> Modal (<= 5 text inputs) or StringSelect step; stateless via customId token
```
- Flow: `deferReply(ephemeral)` -> `POST …/actions/{action}` as the Discord actor -> render `ActionResult` with the existing embeds (`event.embed.ts`, `split-summary.ts`) -> if `requires_confirm`, the first click returns an ephemeral confirm with Yes/Cancel (`act:confirm:…`) whose Yes carries the same idempotency key (the interaction id), so Discord retries cannot double-apply.
- Rendering rule: show only `allowed` actions; non-allowed visible ones are not rendered as buttons in public cards (they would be dead), but appear in the ephemeral "Details" view with the reason.
- Voice channels, notices, DMs and thread archival are no longer done inside the handler: they are consumer reducers of the outbox stream (`voice.provision`, `event.start_notice`, ...). `services/event-lifecycle.ts:62-164` is rewritten as the reducers for those kinds, and `event-authority.ts` is deleted.
- Legacy `event:*`, `bank:*`, `application:*` customIds (`handlers/button.ts:90-110`) keep working for one release by mapping onto the new handler (messages already posted in channels contain old ids).

---

## 9. Failure modes

| Failure | Behaviour |
|---|---|
| Two clients act simultaneously (web Stop and Discord Stop) | Row lock plus re-evaluation under lock; second gets `noop` (same target) or `wrong_state` with the current state and fresh descriptor. No double XP snapshot (already guarded by `service.rs:4021-4025`). |
| Client descriptor stale (button visible, state changed) | Execute re-evaluates; 409 includes fresh `actions`; web re-renders, bot edits the ephemeral. `expected_etag` makes the guard strict when the client opts in. |
| Discord interaction retried / double click | `idempotency_key` replay returns the stored outcome without effects. |
| `EffectSink` or sync enqueue fails | Whole action rolls back (same transaction). Client sees 5xx and can retry the same idempotency key. |
| Outbox delivery fails later | Not an action failure. State stays applied; the effect row carries `failed`/`ambiguous`; web shows the effect chip and the retry control (outbox design); `ActionResult.effects[].state` is a snapshot, not a promise. |
| Capabilities cache stale (kind/feature changed) | `X-Capabilities-Version` header mismatch triggers refetch on web; bot re-reads at the 60 s TTL. Worst case an action is refused by the backend gate with `module_unavailable`; never a wrong success. |
| Enforcement flip breaks an internal caller (alliance poller hits a guild-only prefix) | `MODULE_KIND_ENFORCEMENT=log` first; `would_block` metrics list offenders before switching to `enforce`. |
| Unknown action id | 404 `unknown_action` listing the catalog ids for that entity. |
| Params invalid | 400 with `invalid_params` per field (existing `ProblemDetails.invalid_params`), and for dynamic enums the current `x-options` in `details`. |
| Bank amount not reachable | 400 `amount_below_smallest`, or a plan with `shortfall`; never a silent partial. |
| Origin tenant offline or membership ended | Copy actions that need the origin (join) return `409 origin_unavailable` with `retry_after` when the sync design cannot queue them; join normally succeeds locally and syncs later (owner decision on durable signups). |
| Legacy route still called by an old cached web bundle | Shim routes call the executor, so behaviour is identical; removal only in SA-14 after metrics show zero calls for 14 days. |

---

## 10. Test strategy

SQLite unit tests (default `cargo test`, no external DB):
- `actions::engine`: table-driven evaluate tests, one case per `(action, state, actor, origin)` for events and splits. Includes the creator/manage matrix for splits, `splits.manage` implication, `awaiting_event -> not_completed`, `complete` blocked until event ended, copy read-only reasons, archived reasons, reason ordering.
- Transition tables: property test that every `from` state of every transition appears in the enum and that no transition leaves a terminal state.
- Idempotency: replay returns identical outcome and no second `action_log` row or effect; `noop` on same-state requests.
- `EffectSink` with an in-memory test sink asserts effects are enqueued only when the txn commits (inject failure after `apply`, assert no state change).
- Bank: `WithdrawPlan` for exact, shortfall, below-smallest, alliance single-guild auto-resolve and multi-guild `guild_choice_required` (uses existing alliance bank fixtures).
- Split preview equals `complete_split` payout for random weights (reuse `participant_shares`), remainder deterministic by `user_id`.
- Capabilities: catalogue snapshot test; equivalence with old `FEATURE_GATES` before deletion; each `commands` name unique; each nav key unique; alliance matrix has no progression module.
- OpenAPI: `contracts_are_current`, route coverage lint, envelope lint.

Postgres integration (`TEST_DATABASE_URL` required; WP0 removes the `DATABASE_URL` fallback in `postgres.rs:182-205`):
- Concurrent `start`/`stop`/`cancel` from two tasks: exactly one `applied`, others `noop` or `wrong_state`, one XP snapshot.
- `action_log` unique idempotency index under concurrent identical requests.
- Cross-tenant: alliance-origin event, guild copy: copy `edit` is `copy_read_only`, `join` allowed, `sync.origin.openable` true only for members of the origin tenant (control-plane membership fixture).
- Row-lock behaviour on real `FOR UPDATE` (SQLite cannot prove this).
- `MODULE_KIND_ENFORCEMENT=enforce` returns 403 `module_unavailable` for `/api/warns` on an alliance tenant, 200 on a guild.

Frontend (vitest): `ActionBar` renders from fixtures including disabled-with-reason and confirm; `moduleGuard`; nav filtering by capabilities; a spec that goes through the real `ApiService` envelope (not hand-mocked `{data:[…]}`) for `action.service`; contract test (paths/methods vs `openapi.json`); no `hasPermission`/`tenant_kind` string remains in the migrated feature (grep test per slice).

Bot (`node --test`): `act:` handler with a fake `ApiClient` (replay, 403 reason, 409 stale, confirm flow); `action-render` row packing; params schema -> modal mapping; command registration from capabilities (alliance gets no `warn`); parity test against `parity.json`; decimal fixtures proving no `Number()` summing of money.

---

## 11. Migration of existing data and behaviour

- **Data**: only `action_log` (new, empty). No backfill of history. No control-plane change.
- **Permissions**: `PermissionCache::role_has` gains the `SplitsManage` implication; no role data is rewritten, no one loses an ability (superset). Roles that should hold the "general manage" can be granted `splits.manage` from the existing admin matrix.
- **Routes**: old lifecycle and split routes (`/events/{id}/start|stop|cancel|uncancel|archive|remind`, `/splits/{id}/complete|lost|not-completed|archive|unarchive`, `/bank/transactions/withdraw*`, `management-authority`) become shims calling `engine::execute` so web, bot and any stale bundle produce identical effects from day one. Deprecation header `Deprecation: true` plus `Link: rel="successor-version"`. Removal in SA-14 after a clean 14-day usage window (metric `legacy_route_total`).
- **Fields**: `is_synchronized_copy`, `source_tenant_id`, `source_event_id`, `origin_read_only`, `ping_alliance` stay one release next to `sync` / `share_alliance`.
- **Bot customIds**: dual-parse old and new (section 8.2).
- **Alliance kind enforcement**: staged `log` -> `enforce`.
- **The four copy mechanisms** (`alliance_shares`, `event_fanout_*`, `event_mirror_requests`, register one-shot + split distribution) are not touched here; the action layer reaches them only through the services' `sync::outbox::emit` calls. There is no `comp.share` / `unshare` action: the sync engine syncs comps and builds unconditionally (owner decision, sync-engine 1.3), so the user-facing `POST /api/alliance/shares*` verbs (`alliance_share/router.rs`) and the web `ShareWithAllianceButton` simply disappear when the sync engine owns build/comp/split copies. The one remaining user switch is `event.share_alliance`.

---

## 12. PARITY BACKLOG

Goal: every daily operation is reachable from both clients through the same backend action. "Exists" = already works in that client; **ADD** = to build; "by design" = deliberately one-sided (listed in 12.2). `P1`..`P4` is delivery order; slice ids refer to section 13.

### 12.1 Operations

| # | Operation | Backend action / endpoint | Discord | Web | Prio / slice |
|---|---|---|---|---|---|
| 1 | Create organized event | `event.create` | `/event-create`: **ADD** modal (title, local date/time, description) with comp autocomplete, then an ephemeral options step (regear, share with alliance, call to arms, create split + island tab, roles, cap, delivery) | Exists, switch to action contract (tenant timezone shown next to inputs) | P1 / SA-9 |
| 2 | Create flash mass | `event.create {kind:flash}` | Exists (`/flash`, context menu) | **ADD** Organized/Flash toggle in create dialog | P1 / SA-9 |
| 3 | Edit event | `event.edit` | **ADD** `/event-edit event:<autocomplete>` and Edit button on the card (modal for title/description/times, select for toggles) | Exists | P1 / SA-9 |
| 4 | Start / Stop / Cancel / Uncancel | `event.start|stop|cancel|uncancel` | Exists (buttons, `/event-start`, `/event-stop`, thread commands) -> repoint to generic `act:` handler | Exists -> `ActionBar`; effects now identical on both | P1 / SA-4, SA-7 |
| 5 | Remind | `event.remind` | Exists (`/ping`) | **ADD** "Remind" button | P1 / SA-4 |
| 6 | Archive / unarchive | `event.archive|unarchive` | **ADD** button on closed event cards (officers) | Exists | P3 / SA-9 |
| 7 | Join / leave / change build | `event.join|leave` | Exists (buttons, `/event-join`, `/event-leave`, guild select for alliance) -> params from schema | Exists; **fix** alliance guild list (double unwrap, `event-detail.ts:5515-5521`) by using the descriptor | P1 / SA-4 |
| 8 | Share event with alliance / unshare | `event.share_alliance|unshare_alliance` | **ADD** option in create + officer button "Share with alliance" on card | Exists as checkbox at create; **ADD** toggle on detail | P2 / SA-9 |
| 9 | Sync status and retry | `event.retry_sync`, `sync` block | **ADD** officer button "Sync status" -> ephemeral per-guild states + Retry | **ADD** `SyncStatusPanel` | P2 / SA-8 |
| 10 | Roster: seats, swaps, auto-fill, roster roles | `event.roster_edit` (direct routes) | **ADD** `/event-roster` view with select menus "Assign seat", "Clear seat", button "Auto-fill" (read exists) | Exists | P3 / SA-9 |
| 11 | Officer add/remove participant | `POST/DELETE /events/{id}/participants` via `event.roster_edit` | **ADD** `/event-add user build` and `/event-remove user` (target by Discord user, resolved server-side via `user_ref`) | Exists | P2 / SA-9 |
| 12 | Link battles to event | `event.roster_edit`-group `link_battles` | **ADD** `/event-battles` (list + select to link) | Exists | P4 / SA-9 |
| 13 | VODs: submit, list | `vod.submit`, `GET /vods/me`, event VOD list | Exists (`/vod`) | **ADD** page `/vods` (submit form, my VODs) and per-event VOD list | P3 / SA-11 |
| 14 | Create split | `split.create` + `splits/preview` | **ADD** `/split-create` modal (event autocomplete or none, values, fee, island tab); confirm shows `preview` | Exists; switch math to `preview` | P1 / SA-5 |
| 15 | Edit split values, participants, location | `split.update` + participants routes | **ADD** "Edit values" button and modal on the split forum post; `/split-add user weight`, `/split-remove user` | Exists; **fix** event link/unlink to `PATCH /api/splits/{id}` (`event-detail.ts:5153,5167`) | P1 / SA-5 |
| 16 | Complete / not completed / lost | `split.complete|not_completed|lost` | **ADD** buttons on the split forum post for creator and manage holders (descriptor-driven) | Exists | P1 / SA-5 |
| 17 | Archive / unarchive split | `split.archive|unarchive` | **ADD** button on closed split posts | Exists | P3 / SA-5 |
| 18 | Donate share to guild bank | `split.donate_share` | **ADD** button on the member's credit message | **ADD** button in bank credit rows and split detail | P3 / SA-6 |
| 19 | Alliance split distribution status / retry | `split.retry_distribution`, `distribution-status` | **ADD** officer button "Distribution status" | **ADD** panel in split detail | P2 / SA-8 |
| 20 | My splits / credits | `GET /splits?mine`, `bank/withdrawable` | **ADD** `/splits` (mine, open) | Exists | P3 / SA-5 |
| 21 | Bank balance | `GET /bank/balance`, `/bank/withdrawable` | Exists (`/balance`); **ADD** per-guild breakdown for alliance | Exists | P1 / SA-6 |
| 22 | Withdraw | `bank.withdraw {amount|all}` + `withdraw/preview` | **ADD** `/withdraw [amount]` replacing `/balance-request` (kept as alias); guild select when `guild_choice_required` | **ADD** amount input with plan preview (replaces row selection) | P1 / SA-6 |
| 23 | Accept / reject withdrawal | `bank.accept|reject` | Exists (buttons; stop sending/needing `guild_tenant_id`); **ADD** `/withdrawals` queue | Exists | P1 / SA-6 |
| 24 | Manual deposit / transaction (officer) | `POST /bank/transactions` (`bank.transactions.create`) | **ADD** `/deposit user amount note` | Exists | P3 / SA-6 |
| 25 | Regear: request | `regear.request` | **ADD** `/regear` (my recent deaths via autocomplete) and self-service event flow | Exists | P2 / SA-11 |
| 26 | Regear: accept / reject | `regear.accept|reject` | **ADD** buttons on the backend-posted request message; `/regear-queue` | Exists | P2 / SA-11 |
| 27 | Regear credits summary | `GET /regear/me/summary` | **ADD** `/regear-credits` | Exists | P4 / SA-11 |
| 28 | Warn issue / revoke | `warn.issue|revoke` (target by `user_ref`) | Exists (`/warn`, `/unwarn`), drop the 3-call user resolution (`api/resolve-user.ts:10-48`) | Exists | P2 / SA-11 |
| 29 | Escalation acknowledge | `warn.ack_escalation` | **ADD** "Acknowledge" button on `/warns` escalations | Exists | P2 / SA-11 |
| 30 | My own warns | `GET /warns/me` | **ADD** `/mywarns` | **ADD** profile section "My warns" | P2 / SA-11 |
| 31 | Rank, XP, leaderboard | existing progression routes | Exists (`/rank`, `/xp`, `/leaderboard`); add `guild_rank` to `/rank` | Exists | P4 / SA-11 |
| 32 | Applications: review | `application.accept|decline|reopen|close` (+ new `GET /applications?status=`) | Exists (ticket buttons), role assignment moves to the backend | **ADD** `/admin/applications` review queue | P2 / SA-11 |
| 33 | Application panel publish | `application.publish_panel` (effect `applications.panel.upsert`) | `/applications-panel` gated by backend permission, not Discord ManageGuild | **ADD** "Publish panel" button | P3 / SA-11 |
| 34 | Trials: list / end / extend | `trial.end|extend` + `GET /trials`, expiry worker | **ADD** `/trial list|end|extend` | **ADD** `/admin/trials` | P3 / SA-11 |
| 35 | Giveaways: enter / leave | `giveaway.enter|leave` | Exists (button) | **ADD** member page `/giveaways` | P2 / SA-11 |
| 36 | Giveaways: create / draw / cancel | `giveaway.create|draw|cancel` | **ADD** manager buttons on the giveaway message; `/giveaway-create` modal | Exists | P4 / SA-11 |
| 37 | Albion link / unlink / register | `albion_link.link|unlink` (one orchestrator) | Exists (`/link`, `/register`); **ADD** `/unlink` | Exists | P2 / SA-12 |
| 38 | Officer link/unlink another member | `POST/DELETE /albion/link/users/{id}` | **ADD** `/link-user user player` | Exists | P4 / SA-12 |
| 39 | Comps and builds: browse, show | `GET /comps`, `/comps/builds` with `search` | **ADD** `/comp` (autocomplete, embed with price and readiness); `/build` gains autocomplete by name | Exists | P2 / SA-10 |
| 40 | Comp/build: archive, new version | `comp.*`, `build.*` | **ADD** officer buttons on `/comp show` (Archive, New version); item editing is web-only by design (deep-link button). Copies show the origin badge instead of buttons | Exists; origin badge on copies; remove the manual "share to alliance" buttons | P3 / SA-10 |
| 41 | Battles / fights | `GET /battles`, `/fights/{id}` | `/battles` on the same endpoint; **ADD** `/fight id` summary (outcome from backend) | Exists | P4 / SA-11 |
| 42 | Alliance membership: invite, accept, decline, leave, expel | `alliance.*` | **ADD** `/alliance members|invite|expel` (owner-gated) | Exists; **ADD** Decline, Expel (`admin-alliance.ts:331,354,450`) | P3 / SA-13 |
| 43 | Alliance sync overview | `GET /api/sync/status?scope=tenant` (sync engine) | **ADD** `/alliance sync` | **ADD** panel in admin-alliance | P3 / SA-13 |
| 44 | Roles for members | `POST/DELETE /users/{id}/roles` | **ADD** `/role add|remove user role` (hierarchy checked server-side) | Exists | P4 / SA-13 |
| 45 | Notifications | `GET /notifications`, DM effect | DMs via outbox (`dm.send`); **ADD** `/notifications` | Exists | P4 / SA-11 |
| 46 | Switch to origin tenant from a copy | `/switch-tenant?next=` | "Open original" link button | **ADD** route and badge link | P2 / SA-8 |
| 47 | Capability-driven command and nav sets | `capabilities` | Exists as static allowlist -> **replace** | Exists as static flags -> **replace** | P1 / SA-2, SA-3 |

### 12.2 By design one-sided (explicit, enforced by `parity.json`)

Web only: admin configuration (roles matrix, branding, autorole, features, settings, island/tab catalog, progression settings and seasons), platform console, combat tests and calibration, intel scouts/reports, fight merge/split, siphoned ingest and settlement, comp item/slot editor (Discord gets a deep-link button), audit log browsing, tenant registration wizard, Albion OAuth login.
Discord only: voice channel provisioning and teardown, message XP award, ticket channels, thread-local join/leave shortcuts, poller-style posts (they are outbox effects now).

---

## 13. Implementation slices

Ordered. Each is one PR from `origin/main` (branch `<type>/<desc>`), independently mergeable, and leaves the product working. "Dep" lists slices of this document or of sibling designs; none depends on a later slice. Baseline WP0 (green SQLite migrations, `TEST_DATABASE_URL` hygiene) is assumed done before SA-1.

**SA-1 `feat/contracts-openapi`** (backend + both clients, no behaviour change)
- Add `GET /api/openapi.json`; add missing existing paths to `ApiDoc`; `apps/contracts/` snapshots; `openapi-typescript` generation scripts; client path/method contract tests with the two known violations allowlisted.
- Acceptance: `cargo test contracts_are_current` green and fails when a handler's schema is changed without regenerating; `npm run gen:api` is idempotent in frontend and bot; contract tests fail if a new test fixture calls `PUT /api/splits/{id}`; the route coverage lint passes with an allowlist file that is committed.

**SA-2 `feat/capabilities-backend`** (backend)
- `modules/capabilities` catalogue, `GET /api/me/capabilities`, `GET /api/tenants/{id}/capabilities`, `X-Capabilities-Version` header, `MODULE_KIND_ENFORCEMENT=log`; `FEATURE_GATES` kept and checked for equivalence.
- Acceptance: for each old `(prefix, feature)` the catalogue returns the same feature; alliance response contains no `progression` module and has `bank` without feature requirement; guild without the `regears` feature gets `modules.regears.reason_code = "feature_disabled"`; ETag/304 works; in `log` mode a request to `/api/warns` on an alliance tenant succeeds and increments `would_block`; Postgres test flips to `enforce` and gets 403 `module_unavailable`.

**SA-3 `refactor/capabilities-clients`** (frontend + bot, deletes duplicates)
- Web `CapabilitiesStore`, `moduleGuard`, nav filtering; remove `hiddenForAlliance`, `guildOnlyGuard`, `featureKey` special case. Bot gate and `registerCommands` read capabilities; remove `ALLIANCE_ALLOWED_COMMANDS`. Delete `FEATURE_GATES` and switch middleware to the catalogue (flip `MODULE_KIND_ENFORCEMENT=enforce` in this slice's config after SA-2 logs are clean).
- Acceptance: grep finds no `hiddenForAlliance`, `guildOnlyGuard`, `ALLIANCE_ALLOWED_COMMANDS`, `FEATURE_GATES`; alliance Discord registers exactly the catalogue's alliance commands (bot test); tenant switch re-fetches capabilities and nav changes without reload (vitest); bot command-gate test: `/warn` on alliance gets the `kind_unsupported` reply; owner-decision matrix: `/xp` and `/leaderboard` absent on alliance.

**SA-4 `feat/action-engine-events`** (backend + web + bot; Dep SA-1)
- `modules/actions` engine, `action_log` migration, `events/status.rs` and `EVENT_TRANSITIONS`, `*_in_txn` service cores, event descriptors and executor, `NoopSink`/`LegacyOrigin`, legacy route shims, management-authority shim. Web event-detail on `ActionBar`; bot generic `act:` handler for start/stop/cancel/uncancel/remind/join/leave; delete `event-authority.ts` and `canEdit`/`canDelete`.
- Acceptance: descriptor matrix test (creator, `events.edit` holder, `events.manage` holder, member, copy, archived, each status); POST denied body equals descriptor entry; concurrent start/stop on Postgres yields one applied; replay with the same idempotency key creates one `action_log` row; legacy `/start` returns the same result as `/actions/start`; copy shows `edit` disabled with `copy_read_only` and `join` allowed (this fixes the alliance join path on web because params come from the schema); no event predicate remains in `event-detail.ts`.

**SA-5 `feat/split-actions`** (backend + web + bot; Dep SA-4)
- `SPLIT_TRANSITIONS`, `splits.manage` implication, `update_split` creator rule, `awaiting_event -> not_completed/lost`, `recompute` on event stop/cancel/unlink, `POST /api/splits/preview`, `projected` on split views, `deny_mutation` becomes origin-based, split descriptors; delete `split-access.ts`, `netOf`, `draft*`, `pendingSplitPool`; Discord `/split-create`, split post buttons (complete, not completed, lost, archive, edit values); fix web event link/unlink to PATCH.
- Acceptance: creator completes own split; unrelated member gets `not_creator_or_manager`; `splits.manage` role completes anyone's; cancelled event moves `awaiting_event` split to `pending` and it can be closed; preview equals payout for random weights including remainder; bot embed shows backend `projected.net` (decimal-string fixture that previously summed as strings); event page link/unlink returns 200 (HTTP method test).

**SA-6 `feat/bank-withdraw-plan`** (backend + web + bot; Dep SA-4)
- `GET /bank/withdrawable`, `withdraw/preview`, `withdraw {amount|all|transaction_ids}`, server-side guild resolution for accept/reject, `donate_share` action; web bank page uses amount + plan; bot `/withdraw`, `/withdrawals`, per-guild balance; delete row-selection code.
- Acceptance: exact, shortfall, and below-smallest cases; alliance user with rows in two guilds gets `guild_choice_required` and succeeds with a choice; accept/reject buttons work without `guild_tenant_id` on a multi-guild alliance (previously 400); bot `/balance` shows per-guild lines; Postgres test for concurrent withdraw on the same rows (second gets conflict, no double request).

**SA-7 `feat/action-effects-outbox`** (backend + bot; Dep SA-4 and the Discord outbox slices 12b/12c)
- `OutboxSink`; every event/split action emits its declared effects in the same transaction; `ActionResult.effects`; effect status chip on web; bot reducers replace `services/event-lifecycle.ts` mass/start/stop code; scheduler uses `execute_system`.
- Acceptance: starting from web and from Discord produce identical `discord_outbox` kinds and payload shape (snapshot test); failure injected after `apply` leaves no state change and no outbox rows; web start now provisions voice and posts the start notice (closes events-7); the bot with the outbox consumer stopped for two hours catches up on restart (outbox design's test, reused here for `event.start`).

**SA-8 `feat/sync-origin-ui`** (backend + web + bot; Dep SA-4 and the sync-engine `copy_info` / `SyncInfo` slice)
- `sync` block on event, split, comp, build views; `/switch-tenant` route; `OriginBadge`, `SyncStatusPanel`, list origin filter; Discord copy footer, "Open original", "Sync status" and Retry buttons; `event.retry_sync`, `split.retry_distribution` actions.
- Acceptance: copy view has `sync.role = copy`, `read_only = true`, origin name and `openable` true only for members of the origin tenant; origin view lists targets only to managers; failed target shows error and Retry re-arms it (Postgres two-tenant test); deprecated alias fields still present; bot copy card test shows footer and link.

**SA-9 `feat/event-create-edit-parity`** (backend + web + bot; Dep SA-4)
- `event.create` collection action with tenant timezone and `share_alliance`; `ping_alliance` alias; Discord `/event-create` modal with comp autocomplete and options step, `/event-edit`, share toggle, `/event-add`, `/event-remove`, `/event-battles`, roster select flow; web flash toggle, share toggle, remind.
- Acceptance: the same JSON creates identical events from both clients (shared fixture asserted in backend integration test, bot and web specs build their payload from the schema); `start_local` in `Europe/Rome` across a DST change converts correctly; flash created from web has no comp and binary participation; Discord-created event can enable regear and share; `/event-edit` of a copy returns the copy_read_only reason.

**SA-10 `feat/comp-actions`** (backend + web + bot; Dep SA-4, SA-8)
- Comp/build descriptors (edit, archive, unarchive, new_version), `search` and `limit` on comp/build lists for autocomplete, Discord `/comp`, `/build` autocomplete, officer buttons; remove the web manual-share buttons once the sync engine owns build/comp copies.
- Acceptance: archive on the origin emits a `Comp`/`Build` archive through the service core (the copy-side effect is the sync engine's test); copies expose no edit actions (descriptor `copy_read_only`); `/comp` autocomplete returns <= 25 results in one query (query-count assertion); unique-name resolution no longer needs a numeric id.

**SA-11 `feat/member-ops-parity`** (several PRs: 11a regear, 11b warns, 11c applications/trials, 11d giveaways/VOD, 11e misc)
- Actions and clients per backlog rows 13, 25-36, 41, 45; new endpoints `GET /applications`, `GET/POST /trials`, `GET /warns/me`, `user_ref` on officer endpoints (`warns`, `progression/adjust`) so the bot drops `resolve-user.ts`; backend assigns roles on application accept (effect `discord.role.assign`); trial expiry worker.
- Acceptance (each PR): the backlog row's Discord command and web page exist and both call the same action id (`parity.json` test turns `todo` into `done`); warn issued with a Discord id of a never-logged-in member works (needs member sync) or returns the explicit `member_not_provisioned` code; application accept via web assigns the role through the outbox (no bot-side `roles.add`); trial ends at `ends_at` in a worker test with a fake clock.

**SA-12 `refactor/link-orchestrator`** (backend + bot + web)
- Single `LinkOrchestrator` behind `albion_link.link|unlink` and `/albion/register`; `/unlink`, `/link-user`.
- Acceptance: `link_player` and `register_by_ign` share one code path (unit test counts side-effect calls); alliance fan-out and role sync run for link from web, bot and admin (closes auth-8); unlink on Discord works.

**SA-13 `feat/alliance-actions-parity`** (backend + web + bot; Dep SA-8 and membership-lifecycle design)
- `alliance.*` actions (decline, expel), `GET /alliances/{id}/members` consumed, Discord `/alliance`, `/role`; web Decline/Expel and sync overview.
- Acceptance: decline removes the invited membership; expel archives future copies via the membership design's detach job; only the alliance owner sees Expel; Discord and web offer the same set from the descriptor.

**SA-14 `chore/remove-legacy-shims`** (all; Dep SA-4..SA-13 and 14 clean days of `legacy_route_total` = 0)
- Remove shim routes, `management-authority`, deprecated alias fields, old bot customId parsing, `ping_alliance` field; make `parity.json` strict (no `todo`); shrink `undocumented.allowlist` to empty; finish migrating `api.models.ts` to generated aliases.
- Acceptance: contract tests green with empty allowlists; grep for every symbol in section 1.1 returns nothing; OpenAPI diff shows only removals of the listed routes.

---

## 14. Decisions this design makes that the owner may want to veto

1. Withdraw by `amount` uses an oldest-first exact-prefix selection and reports a shortfall; it never splits a ledger row. If partial rows are wanted, that is a ledger change (split a credit into requested and remaining) and belongs to the finance work.
2. Alliance module matrix (section 2.1) is my reading of "everything bidirectional" plus "no alliance XP": warns, regears and battles appear at the alliance as aggregate read-only; intel, tests, siphoned, giveaways, applications, vods do not exist at the alliance. One-line edits in the catalogue change it.
3. `splits.manage` is made the implied superset of edit/delete rather than introducing a new key; roles holding only `splits.edit` keep today's abilities.
4. Cross-tenant deep links go through `/switch-tenant?next=` because a session is bound to one tenant; users who are not members of the origin tenant see text without a link.
5. `X-Capabilities-Version` response header is used for cache invalidation instead of a push channel; the later `/api/live` channel (plan 4.5) can replace it without changing the payload.
