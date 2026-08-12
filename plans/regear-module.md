# Plan: `regear` Module (Call-To-Arms Gear Reimbursement)

> Status: **DRAFT — awaiting approval**
> Scope: `apps/backend` (Rust/Axum/SeaORM) **and** `apps/frontend` (Angular) — new top-level
> feature that spans both apps.
> Reference: the storage and lifecycle patterns mirror the [`bank`](../apps/backend/src/modules/bank/)
> module (per-user ledger row → officer approval → settled payout), while the per-death estimate
> logic reuses the Albion Data pricing already implemented in
> [`battles::service::estimate_losses`](../apps/backend/src/modules/battles/service.rs).
> Owner: backend + frontend

---

## 1. Goal & scope

### 1.1 Goal

When an **event** is flagged `call_to_arms = true` (the flag already exists on the `events` table —
see migration `m20260812_000001_add_call_to_arms_to_events`), the guild commits to reimbursing
members who died during the event's linked battles. The `regear` module automates the whole loop:

1. **Detect eligible deaths** — for every battle linked to a `call_to_arms` event, extract guild
   members who died, the loadout they were wearing (from the kill-feed `Equipment` JSON), and the
   build they had signed up with for the event (`event_participations.primary_build_id`).
2. **Estimate the regear value** — query Albion Online Data for the cheapest sell price of every
   gear piece the member was wearing, restricted to the slot categories enabled in Admin Settings
   (`weapon`, `head`, `chest`, `boots`, `cape`, `bag`, `mount`, `consumables`, ...).
3. **Let members request** — each individual death becomes one row in a "Deaths" list (similar in
   UX to `Bank`). The user clicks **Request Regear** on **one death at a time** (no bulk action).
4. **Let officers adjudicate** — an officer reviews the request, can override the auto-estimate
   amounts, can exclude individual gear slots from the payout, and either **accepts** or
   **rejects** it.
5. **Settle on accept** — when accepted, the final estimated silver is written into the user's
   `transactions` row with `type = "regear_credit"` (reusing the existing Guild Bank pipeline, so
   the user can later withdraw it like any other balance).
6. **Refused is forever** — a rejected regear cannot be re-requested. The death row is marked
   `rejected` and the button disappears.

### 1.2 Why this lives apart from `bank`

The `bank` module is a *passive* ledger: rows are written by other flows (split closeout, manual
admin entries). It has no concept of "death", "loadout", "market price snapshot", or "officer edit
per slot". Wrapping all of that into `bank` would force the bank DTOs to carry fields only one
producer cares about. Instead, `regear` owns the rich death/adjudication workflow and emits a plain
bank transaction only at the very end of the happy path (accept). The bank stays a clean sink.

### 1.3 Why this lives apart from `battles`

`battles` is read-only analytics over AlbionBB. It computes loss estimates on the fly and stores
snapshots for caching, but it has no concept of "this death has been processed" or "this user has
already been reimbursed". Regear needs **idempotency** (a death can be reimbursed at most once) and
**state** (pending / approved / rejected), which `battles` has no schema for.

### 1.4 Comparison table

| Concern             | `bank`                              | `battles`                              | `regear` (this plan)                                  |
| ------------------- | ----------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| Source of rows      | Other modules (splits, manual)      | AlbionBB pull                          | Death-extraction job from `event_battles` snapshots   |
| Per-slot pricing    | No                                  | Yes (display only)                     | Yes, editable by officer                              |
| State machine       | `pending`/`requested`/`withdrawn`   | None                                   | `pending`/`approved`/`rejected` (terminal)            |
| Auto-settles bank?  | —                                   | No                                     | Yes — inserts a `transactions` row on accept          |
| Admin-tunable caps? | No                                  | No                                     | Yes — `regear_settings` table (limits + slot mask)    |

---

## 2. Domain model

### 2.1 `regear_deaths`

One row = **one eligible death** of one guild member in one battle linked to one CTA event. Created
by the extraction job (§6.5) and never mutated by the user.

| Field                   | Type                          | Notes                                                                     |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `id`                    | `i64` PK auto-increment       | Surrogate.                                                                |
| `event_id`              | `i64` NOT NULL, FK → `events` | Must point to a `call_to_arms = true` event.                              |
| `event_battle_id`       | `i64` NOT NULL, FK → `event_battles` | The battle in which the death occurred.                            |
| `albionbb_battle_id`    | `VARCHAR` NOT NULL            | Denormalized from `event_battles` for direct AlbionBB drill-down.        |
| `albion_kill_event_id`  | `VARCHAR` NOT NULL            | AlbionBB's kill-event id (the entry in the battle's kill feed).           |
| `killed_at`             | `TIMESTAMPTZ` NOT NULL        | Time of death, taken from the kill event.                                 |
| `user_id`               | `i64` NULL                    | Resolved from `albion_links` if the victim has linked their character.    |
| `player_name`           | `VARCHAR(64)` NOT NULL        | Albion in-game name, stored verbatim.                                     |
| `guild_id`              | `VARCHAR` NOT NULL            | AlbionBB guild id at time of death (always the configured guild).         |
| `primary_build_id`      | `i64` NULL, FK → `builds`     | What the member signed up with for the event. NULL if not registered.     |
| `loadout_json`          | `JSONB` NOT NULL              | The `Equipment` object from the kill event, frozen at extraction time.    |
| `auto_estimate_total`   | `NUMERIC(20)` NOT NULL        | Σ of cheapest-sell prices for included slots, snapshotted at extraction.  |
| `auto_estimate_breakdown_json` | `JSONB` NOT NULL        | Array of `{ slot, item_id, quality, unit_price, quantity, included }`.    |
| `status`                | `VARCHAR(16)` NOT NULL        | `available` / `pending` / `approved` / `rejected`. See §3.1.              |
| `requested_at`          | `TIMESTAMPTZ` NULL            | When the user clicked "Request Regear".                                   |
| `decided_at`            | `TIMESTAMPTZ` NULL            | When an officer accepted or rejected.                                     |
| `decided_by_user_id`    | `i64` NULL, FK → `users`      | Officer who made the decision.                                            |
| `final_amount`          | `NUMERIC(20)` NULL            | The officer's accepted amount (after slot edits/overrides).               |
| `final_breakdown_json`  | `JSONB` NULL                  | Officer's edited breakdown (mirrors `auto_estimate_breakdown_json`).      |
| `officer_note`          | `TEXT` NULL                   | Free-form reason, mandatory when rejecting.                               |
| `bank_transaction_id`   | `i64` NULL, FK → `transactions` | Set when the bank row was created on accept. Audit trail.              |
| `created_at`            | `TIMESTAMPTZ` NOT NULL        | Extraction time.                                                          |
| `updated_at`            | `TIMESTAMPTZ` NOT NULL        | Last mutation time.                                                       |

**Idempotency key:** `UNIQUE(event_battle_id, albion_kill_event_id, player_name)` — the extraction
job can run repeatedly and will not double-insert the same death. (One kill event can in principle
only kill one player once, so this triple is naturally unique.)

**Indexes:**

```sql
CREATE INDEX idx_regear_deaths_user      ON regear_deaths (user_id);
CREATE INDEX idx_regear_deaths_status    ON regear_deaths (status);
CREATE INDEX idx_regear_deaths_event     ON regear_deaths (event_id);
CREATE INDEX idx_regear_deaths_player_lc ON regear_deaths (LOWER(player_name));
```

### 2.2 `regear_settings`

Guild-wide tunables, surfaced in **Admin Settings**. **One row only** (singleton) — enforced at
the application layer; the migration seeds a default.

| Field                       | Type           | Default        | Notes                                                                  |
| --------------------------- | -------------- | -------------- | --------------------------------------------------------------------- |
| `id`                        | `i64` PK       | `1`            | Singleton guard.                                                       |
| `max_regears_per_event`     | `INT` NOT NULL | `2`            | A user can be reimbursed for at most this many deaths per CTA event.   |
| `max_regears_per_month`     | `INT` NOT NULL | `10`           | Rolling 30-day cap (count of `approved` rows where `decided_at` is in window). |
| `enabled_slots_mask`        | `INT` NOT NULL | `0b11111111`   | Bitmask over `BuildSlot` (weapon / head / chest / boots / cape / bag / mount / consumables). Admin toggles per slot. |
| `pricing_location`          | `VARCHAR(64)`  | `'Caerleon'`   | The Albion city whose cheapest sell price is used.                     |
| `pricing_fallback_strategy` | `VARCHAR(16)`  | `'cheapest_any'` | `cheapest_any` falls back to other cities if the configured city has no listing; `strict` returns 0. |
| `updated_at`                | `TIMESTAMPTZ`  | `NOW()`        | Last admin edit.                                                       |
| `updated_by_user_id`        | `i64` NULL`    | `NULL`         | Last admin editor.                                                     |

The `enabled_slots_mask` is the "which pieces are calculated" knob the user asked for. Each bit
maps to a `BuildSlot` from `comps::status::BuildSlot`; the value is interpreted by the
`RegearSlotPolicy` (§6.3).

### 2.3 Bank integration: `regear_credit` transaction type

When a death is accepted, the service inserts **one** row into the existing `transactions` table:

```
type        = "regear_credit"
status      = "pending"      // reuses the existing pending→requested→withdrawn flow
to_user_id  = <death.user_id>  -- MUST be non-null; unlinked players cannot be reimbursed
from_user_id = NULL          // "Guild Bank" until the user withdraws
amount      = <final_amount>
split_id    = NULL
```

We do **not** add a `regear_death_id` column to `transactions`: the back-reference lives on the
death row (`bank_transaction_id`), keeping the bank table untouched.

The reason string shown in the bank UI is composed by the frontend from the death row
(`"Regear — <event title> @ <battle_id>"`) using the new `regear_context_json` field exposed via
the bank view (see §3.3). The bank table itself only carries the opaque `type`.

### 2.4 Lifecycle states

```
                ┌──────────────────────────────────────────────────────┐
                │                                                      │
   [extraction] ▼                                                      │
   available ─────► pending ─────► approved ─────► bank transaction    │
       │  (user clicks        (officer            inserted, terminal   │
       │   "Request")          accepts)                             │
       │                                                           │
       └────────────► rejected   (officer rejects; terminal)         │
                (also: pending → rejected)                          │
                                                                   │
   NOTE: a user can move a death from `available` to `pending` only if they have
   not exceeded the per-event / per-month caps at that moment.
```

**Terminal states** are `approved` and `rejected` — no further transitions are allowed. Once
`rejected`, the death can never be re-requested (the frontend hides the button and the backend
rejects the transition).

---

## 3. API contract

All routes under `/api/regear`. All require an authenticated `UserContext` (same extractor as
`bank`).

### 3.1 Endpoints

| Method | Path                              | Purpose                                                             | Permission                        |
| ------ | --------------------------------- | ------------------------------------------------------------------ | --------------------------------- |
| GET    | `/deaths`                         | Paginated list of deaths visible to the caller.                    | `regear.view` (Member+)           |
| GET    | `/deaths/{id}`                    | Full detail (loadout + breakdown).                                  | `regear.view`                     |
| POST   | `/deaths/{id}/request`            | User requests regear for one death. Single-shot, no bulk.          | `regear.request` (Member+)        |
| GET    | `/requests`                       | Officer queue: all `pending` deaths across the guild.              | `regear.adjudicate` (Officer+)    |
| POST   | `/requests/{id}/accept`           | Officer accepts; can edit breakdown + total in body.               | `regear.adjudicate`               |
| POST   | `/requests/{id}/reject`           | Officer rejects; `note` is mandatory. Terminal.                    | `regear.adjudicate`               |
| GET    | `/events/{event_id}/deaths`       | Per-event breakdown of deaths and regear usage.                    | `regear.view`                     |
| POST   | `/admin/run-extraction`           | Manually trigger extraction for one event.                         | `regear.adjudicate`               |
| GET    | `/settings`                       | Read guild-wide regear settings.                                    | `regear.view`                     |
| PUT    | `/settings`                       | Update settings (caps, slot mask, pricing).                        | `regear.settings.manage` (Admin+) |
| GET    | `/me/summary`                     | The caller's regear budget usage (used by the UI header badge).    | `regear.view`                     |

`{id}` in `/requests/{id}/*` is **the death row id** (same PK), not a separate request id. The
endpoint name just signals "this is the officer's adjudication surface".

### 3.2 Sample payloads

**`POST /deaths/{id}/request`** — empty body. Validation:

- `status == available`. Else `409 "death is not available"`.
- `user_id == caller.id`. Else `403 "not your death"`.
- Per-event count of `pending + approved` rows for the caller < `max_regears_per_event`.
- Rolling 30-day count of `approved` rows for the caller < `max_regears_per_month`.

Both caps are evaluated inside the same transaction that flips the status, so concurrent clicks
cannot overrun them.

**`POST /requests/{id}/accept`:**

```json
{
  "final_amount": "1_840_000",
  "breakdown": [
    { "slot": "weapon", "item_id": "T8_MAIN_NATURESTAFF_KEEPER", "unit_price": "980000", "quantity": 1, "included": true },
    { "slot": "head",   "item_id": "T8_HEAD_LEATHER_SET1",       "unit_price": "210000", "quantity": 1, "included": true },
    { "slot": "chest",  "item_id": "T8_BODY_LEATHER_SET1",       "unit_price": "0",      "quantity": 1, "included": false }
  ],
  "note": "Excluded chest — it was a borrowed guild item."
}
```

- The body is optional. If omitted, the auto-estimate snapshot is used as-is.
- `final_amount` must equal the sum of `unit_price * quantity` for rows where `included = true`
  (server recomputes and rejects mismatches — never trust the client sum).
- Side effects:
  1. `regear_deaths.status = 'approved'`, `decided_at`, `decided_by_user_id`, `final_amount`,
     `final_breakdown_json`, `officer_note` set.
  2. Insert one row into `transactions` (`type='regear_credit'`, `status='pending'`).
  3. Set `regear_deaths.bank_transaction_id` to the new transaction's id.
- All three steps in one DB transaction. Failure rolls back the approval.

**`POST /requests/{id}/reject`:**

```json
{ "note": "Build did not match event signup — see officer chat." }
```

- `note` is required, 1..=500 chars.
- Sets `status = 'rejected'`, `decided_at`, `decided_by_user_id`, `officer_note`. Terminal.

### 3.3 Bank view: `regear_context_json`

To avoid bloating the `transactions` table with a foreign-key column, the bank's `TransactionView`
already supports a free-form `r#type` field. The frontend will detect `r#type == "regear_credit"`
and call `GET /api/regear/deaths?bank_transaction_id={id}` to render the regear-specific reason
chip. **No bank schema change is required.**

---

## 4. Death extraction job (`RegearExtractor`)

This is the part that "checks the battles linked to a CTA event, pulls out all the guild's dead
players, and estimates their loadout". It must be deterministic and idempotent.

### 4.1 Trigger

- **Automatic:** when an event's session transitions to `stopped` (or `auto_stopped`) **and**
  `event.call_to_arms = true` and `event.link_status = 'completed'`, the
  [`event_sessions::auto_stop`](../apps/backend/src/event_sessions/auto_stop.rs) worker enqueues
  one extraction job per event.
- **Manual:** `POST /api/regear/admin/run-extraction?event_id=...` lets an officer re-run it
  (useful when AlbionBB ingested late battles after the first run). Idempotent: existing death
  rows are skipped via the unique key.

### 4.2 Algorithm

```
for each event_battle EB linked to E:
    snapshot = guild_battle_snapshots WHERE battle_id = EB.albionbb_battle_id
    if snapshot is missing: fetch from AlbionBB (battles::service::get_battle_detail_with_losses)
    kills = JSON parse snapshot.kills_json

    for each kill K in kills where Victim.guild_id == configured_guild_id:
        equipment = K.Victim.Equipment   // raw JSON, same shape battles::service already parses
        items    = collect_equipment_items(equipment)   // reuse battles helper
        prices   = albion_data.prices(items.item_ids, location=regear_settings.pricing_location)
        breakdown = items.map(|i| {
            unit_price = pick_price(prices[i.item_id], regear_settings.pricing_fallback_strategy)
            included   = slot_mask_has_bit(BuildSlot::from_slot(i.slot), regear_settings.enabled_slots_mask)
            total      = included ? unit_price * i.quantity : 0
            ...
        })
        auto_estimate_total = sum(breakdown.total where included)

        signup = event_participations WHERE event_id=E AND user_id=resolved_user_of(victim.name)
        primary_build_id = signup?.primary_build_id

        INSERT INTO regear_deaths (
            event_id, event_battle_id, albionbb_battle_id, albion_kill_event_id,
            killed_at, user_id, player_name, guild_id, primary_build_id,
            loadout_json, auto_estimate_total, auto_estimate_breakdown_json,
            status = 'available'
        )
        ON CONFLICT (event_battle_id, albion_kill_event_id, player_name) DO NOTHING
```

`user_id` is resolved by joining `player_name` to `albion_links.albion_player_name`
(case-insensitive). Unlinked players get `user_id = NULL` and **cannot** request (the API requires
the caller to own the death). This matches the existing bank policy and avoids reimbursing
unverifiable characters.

### 4.3 Snapshot reuse

`battles::service::get_battle_detail_with_losses` already writes a snapshot into
`guild_battle_snapshots` (kills/players/losses as JSON). The extractor reads from the snapshot
first — it never hits AlbionBB if a snapshot exists. This keeps the extractor cheap and makes the
estimate deterministic given a fixed snapshot.

If the snapshot is missing (e.g., officer triggers extraction before the auto-stop job has run
the loss-estimate enrichment), the extractor calls `get_battle_detail_with_losses` once to
materialize it. This is also what populates the event's loss analytics, so it has double duty.

---

## 5. Frontend (Angular) — `Regears` tab

### 5.1 Navigation entry

Add a new item to `NAV_SECTIONS` in
[`apps/frontend/src/app/layout/shell/shell.ts`](../apps/frontend/src/app/layout/shell/shell.ts)
under the `nav.section.guild` group, after `siphoned`:

```ts
{ path: '/regears', icon: 'shield', labelKey: 'nav.regears' },
```

Plus a translation entry (`nav.regears = "Regears"`) in
[`apps/frontend/src/app/i18n/en.ts`](../apps/frontend/src/app/i18n/en.ts) (and the other locales).

Plus a new lazy route in
[`apps/frontend/src/app/app.routes.ts`](../apps/frontend/src/app/app.routes.ts):

```ts
{
  path: 'regears',
  loadComponent: () => import('./features/regears/regears').then((m) => m.Regears),
},
```

### 5.2 Feature structure

```
apps/frontend/src/app/features/regears/
├── regears.ts                       (list component — member-facing deaths list)
├── regear-detail.ts                 (per-death modal/dialog with loadout + breakdown)
├── regear-requests.ts               (officer queue component)
├── regear-settings.ts               (admin settings sub-component)
├── components/
│   ├── loadout-grid/                (renders the 8-slot equipment layout from loadout_json)
│   ├── breakdown-table/             (slot / item / unit_price / included checkbox for officers)
│   └── budget-badge/                (header widget: "Regears used: 2 / 2 this event")
├── services/
│   └── regears.service.ts           (HttpClient wrapper for /api/regear/*)
└── models/
    └── regear.models.ts             (TypeScript interfaces mirroring the DTOs)
```

### 5.3 Member view (default route)

The main `Regears` page mirrors the **Bank** UX pattern (see
[`apps/frontend/src/app/features/bank/bank.ts`](../apps/frontend/src/app/features/bank/bank.ts)):

- **List of the caller's deaths**, sorted by `killed_at` desc. Each row shows:
  - Event title + battle hyperlink (`/battles/{albionbb_battle_id}`).
  - Killed-at timestamp.
  - Loadout thumbnail (8-slot mini-grid using the Albion render-service URLs).
  - Auto-estimate total (read-only).
  - Status chip: `available` / `pending` / `approved` / `rejected`.
  - **Request Regear** button (disabled unless `status == 'available'` and `user_id ==
    caller.id` and budget available).
- **No "request all" button.** The user must click per death — confirmed product requirement.
- A `BudgetBadge` at the top: `"Regears used this event: 0 / 2"`, `"Regears used this month:
  3 / 10"`, sourced from `GET /me/summary`.

A toggle switches between **My Deaths** and (for officers) **Officer Queue**.

### 5.4 Officer queue view

Lists every `pending` death across the guild, with:

- Full loadout grid.
- Breakdown table with editable `unit_price` inputs and `included` checkboxes per slot.
- A live recomputed total at the bottom (read-only; the backend re-checks on submit).
- **Accept** and **Reject** buttons. Reject opens a small modal with a mandatory note field.

Already-decided rows (`approved` / `rejected`) appear in a separate "History" tab within the same
component, filtered by event and date.

### 5.5 Admin settings

A new card inside the existing
[`apps/frontend/src/app/features/admin/admin.ts`](../apps/frontend/src/app/features/admin/admin.ts)
page (or a sibling tab):

- **Caps:** numeric inputs for `max_regears_per_event`, `max_regears_per_month`.
- **Slot mask:** 8 toggle switches, one per `BuildSlot`. Each toggle writes a bit into
  `enabled_slots_mask`.
- **Pricing:** a dropdown for `pricing_location` (the six Royal cities + Caerleon + Brecilien) and
  a radio for `pricing_fallback_strategy` (`cheapest_any` / `strict`).
- **Save** triggers `PUT /api/regear/settings`.

Guarded by `roleGuard('Admin', 'SuperAdmin')`.

---

## 6. Backend module layout

New module at `apps/backend/src/modules/regear/`, mirroring the existing module split
(service / models / status / router / entities).

```rust
pub mod regear {
    pub mod entities;   // SeaORM models for regear_deaths + regear_settings
    pub mod status;     // RegearStatus enum (available/pending/approved/rejected)
    pub mod slots;      // BuildSlot ↔ bitmask helpers, slot policy
    pub mod extractor;  // RegearExtractor (the job in §4)
    pub mod pricing;    // Wraps AlbionDataService to produce a BreakdownRow[]
    pub mod models;     // DTOs (DeathView, BreakdownRow, AcceptRequest, ...)
    pub mod service;    // RegearService (the orchestrator)
    pub mod router;     // Axum routes
}
```

### 6.1 `entities.rs`

Two SeaORM entities: `RegearDeath` (table `regear_deaths`) and `RegearSetting` (table
`regear_settings`, singleton). JSON columns use `String` (same as `guild_battle_snapshots`) so the
migration works on both SQLite (tests) and Postgres (prod).

### 6.2 `status.rs`

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumString, AsRefStr, ToSchema)]
pub enum RegearStatus {
    #[strum(serialize = "available")]
    Available,
    #[strum(serialize = "pending")]
    Pending,
    #[strum(serialize = "approved")]
    Approved,
    #[strum(serialize = "rejected")]
    Rejected,
}
```

`Approved` and `Rejected` are terminal — `is_terminal()` helper used by both service and router.

### 6.3 `slots.rs` — `RegearSlotPolicy`

Maps AlbionBB equipment-slot keys (`MainHand`, `OffHand`, `Head`, `Armor`, `Shoes`, `Cape`, `Bag`,
`Mount`, `Food`, `Potion`) to the canonical `BuildSlot` enum from
`comps::status::BuildSlot`, and exposes:

```rust
pub fn is_slot_enabled(mask: u32, slot: BuildSlot) -> bool;
pub fn default_mask() -> u32;     // every bit on
```

This isolates the bitmask logic from both the extractor (which needs to know whether to *include*
a slot in `auto_estimate_total`) and the admin UI (which renders the toggles).

### 6.4 `pricing.rs`

Wraps `AlbionDataService::prices` and produces a `Vec<BreakdownRow>` given a victim's
`Equipment` JSON and a `RegearSettings` snapshot. Reuses the `collect_equipment_items` /
`build_price_index` helpers already in `battles::service` (extracted to a shared module or
re-implemented locally — see §11.2).

The pricing call is batched per battle (single GET against Albion Online Data) to respect the
existing `MAX_ITEM_IDS_PER_PRICE_REQUEST = 120` cap. Battles with more than 120 distinct item ids
are split into chunks.

### 6.5 `extractor.rs` — `RegearExtractor`

```rust
pub struct RegearExtractor {
    db: DatabaseConnection,
    battles: BattlesService,
    albiondata: AlbionDataService,
    guild_id: String,
}

impl RegearExtractor {
    pub async fn extract_for_event(&self, event_id: i64) -> Result<ExtractionReport, AppError>;
}
```

- Reads `regear_settings` once at the start of the run.
- For each `event_battle` row, prefers the `guild_battle_snapshots` row; falls back to
  `battles.get_battle_detail_with_losses` if missing.
- Inserts deaths via `INSERT ... ON CONFLICT DO NOTHING` so re-runs are safe.
- Returns an `ExtractionReport { battles_scanned, deaths_inserted, deaths_skipped }` for logging
  and audit.

### 6.6 `service.rs` — `RegearService`

```rust
pub struct RegearService {
    extractor: RegearExtractor,
}

impl RegearService {
    pub async fn list_deaths(...);
    pub async fn get_death(...);
    pub async fn request_regear(...);              // available → pending
    pub async fn list_pending_requests(...);       // officer queue
    pub async fn accept_request(...);              // pending → approved + bank row
    pub async fn reject_request(...);              // pending → rejected (terminal)
    pub async fn get_event_deaths_summary(...);
    pub async fn get_my_summary(...);              // budget usage
    pub async fn get_settings(...);
    pub async fn update_settings(...);
    pub async fn run_extraction(...);              // wraps extractor.extract_for_event
}
```

**`accept_request` pseudocode** (the critical path):

```rust
let txn = db.begin().await?;

let death = lock_death_for_update(&txn, id).await?;
ensure!(death.status == Pending, Validation("not pending"));
ensure!(death.user_id.is_some(), Validation("victim not linked to a user"));

let total = recompute_total(&req.breakdown)?;
ensure!(total == req.final_amount, Validation("breakdown does not sum to final_amount"));

// Update the death row.
update_death(&txn, id, Approved, req, officer_id, now).await?;

// Insert the bank row.
let tx = transactions::ActiveModel { /* type=regear_credit, status=pending, ... */ };
let inserted = transactions::Entity::insert(tx).exec(&txn).await?;

// Back-link.
update_death_bank_tx_id(&txn, id, inserted.id).await?;

txn.commit().await?;

audit::log("REGEAR_ACCEPTED", "REGEAR_DEATH", id, officer_id, ...).await;
```

The bank row is created in `pending` so the user still has to go through the normal
`request_withdrawal → accept_withdrawal` cycle to receive the silver. This is intentional: the
guild's actual cash-out flow stays in one place (the bank module), and regear only **credits** the
user.

### 6.7 `router.rs`

Standard Axum `Router` mounting all routes from §3.1. Each handler uses
`UserContext::require(&perms, Permission::*)` for RBAC, exactly like the `bank` router.

---

## 7. Permissions

Two new entries in `apps/backend/src/modules/auth/permissions.rs`:

```rust
#[strum(serialize = "regear.view")]
RegearView,
#[strum(serialize = "regear.request")]
RegearRequest,
#[strum(serialize = "regear.adjudicate")]
RegearAdjudicate,
#[strum(serialize = "regear.settings.manage")]
RegearSettingsManage,
```

Seeded by a new migration (§8.2):

| Role    | Permissions                                                                       |
| ------- | --------------------------------------------------------------------------------- |
| Member  | `regear.view`, `regear.request`                                                   |
| Officer | `regear.view`, `regear.request`, `regear.adjudicate`                              |
| Admin   | all of the above + `regear.settings.manage`                                       |

---

## 8. Migrations

Three new migration files under `apps/backend/src/migration/`, following the
`YYYYMMDD_NNNNNN_slug` convention.

### 8.1 `m20260813_000001_create_regear_tables.rs`

Creates `regear_deaths` and `regear_settings`. Uses `String` for JSON columns (portable across
SQLite/PG, matching `guild_battle_snapshots`).

```sql
CREATE TABLE regear_deaths (
    id                            BIGSERIAL PRIMARY KEY,
    event_id                      BIGINT  NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    event_battle_id               BIGINT  NOT NULL REFERENCES event_battles(id) ON DELETE CASCADE,
    albionbb_battle_id            VARCHAR(64) NOT NULL,
    albion_kill_event_id          VARCHAR(64) NOT NULL,
    killed_at                     TIMESTAMPTZ NOT NULL,
    user_id                       BIGINT REFERENCES users(id) ON DELETE SET NULL,
    player_name                   VARCHAR(64) NOT NULL,
    guild_id                      VARCHAR(64) NOT NULL,
    primary_build_id              BIGINT REFERENCES builds(id) ON DELETE SET NULL,
    loadout_json                  TEXT    NOT NULL,
    auto_estimate_total           NUMERIC(20) NOT NULL,
    auto_estimate_breakdown_json  TEXT    NOT NULL,
    status                        VARCHAR(16) NOT NULL DEFAULT 'available',
    requested_at                  TIMESTAMPTZ,
    decided_at                    TIMESTAMPTZ,
    decided_by_user_id            BIGINT REFERENCES users(id) ON DELETE SET NULL,
    final_amount                  NUMERIC(20),
    final_breakdown_json          TEXT,
    officer_note                  TEXT,
    bank_transaction_id           BIGINT REFERENCES transactions(id) ON DELETE SET NULL,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT regear_deaths_unique UNIQUE (event_battle_id, albion_kill_event_id, player_name)
);

CREATE TABLE regear_settings (
    id                            BIGINT PRIMARY KEY DEFAULT 1,
    max_regears_per_event         INTEGER NOT NULL DEFAULT 2,
    max_regears_per_month         INTEGER NOT NULL DEFAULT 10,
    enabled_slots_mask            INTEGER NOT NULL DEFAULT 255,
    pricing_location              VARCHAR(64) NOT NULL DEFAULT 'Caerleon',
    pricing_fallback_strategy     VARCHAR(16) NOT NULL DEFAULT 'cheapest_any',
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by_user_id            BIGINT REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT regear_settings_singleton CHECK (id = 1)
);

INSERT INTO regear_settings (id) VALUES (1);
```

### 8.2 `m20260813_000002_seed_regear_permissions.rs`

Same style as `m20260711_000004_seed_events_permissions.rs`. Inserts the four permissions
from §7 into `role_permissions` for the appropriate roles.

### 8.3 Wire into `Migrator`

Add the two new modules to the `mod` declarations and the `Migrator::migrations()` `vec!` in
`apps/backend/src/migration/mod.rs`.

---

## 9. OpenAPI / `utoipa`

Add `#[utoipa::path(...)]` annotations on every handler (same shape as `bank`). Register the new
DTOs in the existing `OpenApi` builder in
[`apps/backend/src/openapi.rs`](../apps/backend/src/openapi.rs):

```rust
#[derive(ToSchema)]
pub struct PaginatedDeathView { /* ... */ }

#[derive(ToSchema)]
pub struct DeathView { /* ... */ }

#[derive(ToSchema)]
pub struct BreakdownRow { /* slot, item_id, unit_price, quantity, included */ }

#[derive(ToSchema)]
pub struct AcceptRegearRequest { /* final_amount, breakdown, note */ }

#[derive(ToSchema)]
pub struct RejectRegearRequest { /* note */ }

#[derive(ToSchema)]
pub struct RegearSettingsView { /* all settings fields */ }

#[derive(ToSchema)]
pub struct RegearBudgetSummary { /* per_event_used, per_event_max, per_month_used, per_month_max */ }
```

Plus the standard `ApiResponse*` aliases for each, mirroring the pattern used in
`plans/siphoned-module.md` §8.

---

## 10. Audit

Every state transition writes to the existing `audit_logs` table (see migration
`m20260811_000006_create_audit_logs_table` and `audit::service::AuditService::log`):

| Action              | `action`              | `entity_type`  | `entity_id` | `actor_user_id` |
| ------------------- | --------------------- | -------------- | ----------- | --------------- |
| User requests       | `REGEAR_REQUESTED`    | `REGEAR_DEATH` | death.id    | caller          |
| Officer accepts     | `REGEAR_ACCEPTED`     | `REGEAR_DEATH` | death.id    | officer         |
| Officer rejects     | `REGEAR_REJECTED`     | `REGEAR_DEATH` | death.id    | officer         |
| Settings updated    | `REGEAR_SETTINGS_SET` | `REGEAR_SETTINGS` | 1        | admin           |
| Extraction run      | `REGEAR_EXTRACTED`    | `EVENT`        | event.id    | officer/system  |

---

## 11. Risks & decisions

### 11.1 Pricing drift between extraction and acceptance

The `auto_estimate_*` fields are snapshotted at extraction time, so by the time the officer
adjudicates days later, market prices may have moved. Decision: **officers always have the final
say** — the accept endpoint accepts an edited breakdown. If they accept the auto-snapshot as-is,
that's their explicit choice. We never silently refresh prices post-extraction, because that
would make the audit trail ambiguous ("which price did we agree on?").

### 11.2 Code reuse from `battles::service`

The functions `collect_equipment_items`, `collect_loss_items`, `build_price_index`, `read_object`,
`read_string`, `read_i32` are currently `fn`-private inside `battles::service`. Two options:

- **Option A (preferred):** extract them into a new shared module
  `apps/backend/src/modules/albion_loadout.rs` (or `battles::loadout`) and have both `battles` and
  `regear::pricing` depend on it. Keeps the parsing logic in one place.
- **Option B:** re-implement them in `regear::pricing`. Duplicated but isolated.

Recommend Option A. It is a small refactor with clear wins.

### 11.3 What "build was registered" means

The user said: *"see what build was signed up for the event and for each item give the calculation
with AlbionMarketData."* This means `primary_build_id` is **informational** — it tells the officer
"this is what the player was supposed to bring." The estimate is computed from the **actual
loadout at death** (the kill-feed `Equipment`), not from the signed-up build. The signed-up build
is only displayed alongside the loadout for the officer's reference (e.g., to spot "they brought
cheaper gear than signed up"). This avoids reimbursing gear the player never actually lost.

If the officer wants to reimburse the *signed-up* build instead (e.g., the player lost nothing but
the guild compensates the roster slot), they can override the breakdown manually via the accept
endpoint.

### 11.4 Unlinked players

A victim with no `albion_links` row gets `user_id = NULL`. The death is still extracted (so the
officer sees the full picture), but the user cannot request it. If an officer wants to reimburse
an unlinked player manually, the current design does **not** support it — they would need to link
their character first. This is intentional: bank transactions require a `to_user_id`, and we
shouldn't ship a workaround.

### 11.5 Concurrency on caps

`max_regears_per_event` and `max_regears_per_month` are checked-and-set inside the same
transaction that flips `available → pending`. The check uses `SELECT ... FOR UPDATE` on the user's
death rows (or equivalently a `COUNT(*) ... FOR UPDATE` on a covering index) so two concurrent
clicks cannot both succeed.

### 11.6 Battle snapshots may be partial

`guild_battle_snapshots` is populated lazily by `battles::service::get_battle_detail_with_losses`.
If extraction runs before any user has opened a battle's loss panel, the snapshot is missing and
the extractor must call AlbionBB itself. This is acceptable (it's the same call the loss panel
would have made), but it means extraction can be slow for large events. Mitigation: the auto-stop
worker in `event_sessions::auto_stop` will be extended to call `RegearExtractor` after the linker
finishes, so by the time anyone opens the UI the data is already there.

---

## 12. Out of scope (v1)

- **Partial regear within a single slot** (e.g., reimburse 50% of a weapon). v1 only supports
  include/exclude per slot. Partial percentages can be added later via a `multiplier` field on
  `BreakdownRow`.
- **Discord notifications** when a regear is accepted/rejected. The Discord bot integration
  exists but wiring regear events to it is a separate task.
- **Currency other than silver.** All amounts are silver; the bank module has no other currency.
- **Per-event overrides** of `regear_settings`. v1 is guild-wide; per-event tuning can come later
  via a nullable `event.regear_settings_override_json` column.
- **Re-pricing on accept.** As discussed in §11.1, officers use the snapshot or override manually.

---

## 13. Implementation order

A pragmatic, end-to-end-testable sequence. Each step produces a runnable state.

1. **Backend — schema.** Migrations (§8.1, §8.2). Run `cargo test` against `sqlite::memory:`.
2. **Backend — entities + status + slots.** Pure data layer, no I/O. Unit-testable.
3. **Backend — pricing module.** Refactor `battles::service` loadout helpers into the shared
   module (§11.2). Re-run `battles` tests to confirm no regression.
4. **Backend — extractor.** Standalone, testable with a fixture battle snapshot.
5. **Backend — service + router.** Wire RBAC, OpenAPI, audit. Cover the happy and reject paths
   with integration tests against an in-memory DB.
6. **Backend — auto-stop hook.** Modify `event_sessions::auto_stop` to enqueue extraction when
   `call_to_arms && link_status == 'completed'`.
7. **Frontend — services + models + route + nav entry.** Skeleton `Regears` component renders an
   empty list.
8. **Frontend — member list + detail modal.** Death rows, loadout grid, request button.
9. **Frontend — officer queue.** Editable breakdown, accept/reject flows.
10. **Frontend — admin settings card.** Caps, slot mask, pricing location.
11. **Frontend — bank integration.** Detect `r#type == "regear_credit"` in the bank list and
    render the reason chip via `GET /api/regear/deaths?bank_transaction_id=...`.
12. **End-to-end smoke test.** Create a CTA event, link a battle, run extraction, request a
    regear, accept it, verify the bank row appears.

---

## 14. Acceptance criteria

- [ ] A `call_to_arms` event with at least one linked battle produces one `regear_deaths` row per
      guild member death, with a populated `auto_estimate_total` and `auto_estimate_breakdown_json`.
- [ ] A member can request regear on exactly one death at a time; the button is hidden for
      `pending`, `approved`, and `rejected` statuses.
- [ ] Per-event and per-month caps are enforced (verified by a concurrency test).
- [ ] An officer can edit per-slot `unit_price` and `included` flag; the backend recomputes the
      total and rejects mismatches.
- [ ] On accept, exactly one `transactions` row of `type = "regear_credit"` is created for the
      victim's `user_id`, with `status = "pending"`. The death row's `bank_transaction_id` is set.
- [ ] On reject, the death is terminal; the user cannot re-request. The officer note is persisted.
- [ ] The bank UI shows regear credits with a human-readable reason chip.
- [ ] The Admin Settings card updates `regear_settings` and the changes take effect on the next
      extraction (no backend restart required).
- [ ] Unlinked players (`user_id IS NULL`) cannot request regear.
- [ ] All state transitions are recorded in `audit_logs`.
- [ ] `cargo clippy` is clean; `cargo test` passes; the Angular app builds without errors.
