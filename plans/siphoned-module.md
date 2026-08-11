# Plan: `siphoned` Module (Guild Siphoned Energy Ledger)

> Status: **DRAFT — awaiting approval**
> Scope: `apps/backend` only. The frontend will format the Albion export into the JSON in §3.
> Reference: mirrors the [`bank`](../apps/backend/src/modules/bank/) module in structure (service /
> models / status / router split, `ApiResponse<T>` envelope, `PaginatedData<T>` pagination,
> `utoipa::path` annotations, RBAC via `Permission`). The big conceptual difference is spelled out
> in §1.2.
> Owner: backend

---

## 1. Goal & scope

### 1.1 Goal

Track the guild's **Siphoned Energy** ledger in Albion Online.

An officer pastes the in-game export (Date / Player / Reason / Amount) — already normalized to JSON
by the frontend — into a single ingestion endpoint. The backend persists every row as an immutable
ledger entry and exposes queries to:

1. Browse the raw ledger (paginated, filterable).
2. Compute **per-player balances** ("who is in debt and by how much").

A player is **in debt** when they have withdrawn more siphoned energy than they have deposited
(net balance < 0). A positive net balance means they have a surplus credit with the guild.

### 1.2 How it differs from the `bank` module (and why)

The `bank` module tracks a **two-step withdrawal workflow** (`pending` → `requested` →
`withdrawn`) on transactions owed to a **registered user** (`to_user_id` FK). It exists to record
credits the guild owes its Discord-linked members.

The `siphoned` module tracks a **fully-settled in-game fact** that has **already happened** in
Albion, attributed to an **in-game player name** (no Discord user, no link table). There is no
state machine, no officer approval step, no FK to `users`. Every row in the Albion export is
imported verbatim and is immutable.

| Concern                | `bank`                                  | `siphoned`                                          |
| ---------------------- | --------------------------------------- | --------------------------------------------------- |
| Subject                | `to_user_id: i64` (FK → `users`)        | `player_name: String` (Albion in-game name)         |
| Amount direction       | Always positive; encoded by from/to     | Signed: deposits `+`, withdrawals `-` (verbatim)    |
| Lifecycle              | `pending` / `requested` / `withdrawn`   | None — settled at ingest time                       |
| Officer action         | Accept & pay out (`accept_withdrawal`)  | None beyond the import itself                       |
| Balance derivation     | `SUM(amount) WHERE status = …`          | `SUM(amount)` over all rows for `LOWER(name)`       |
| Write path             | Created by `splits` closeout, mutated   | Bulk-import only, never mutated (delete by batch)   |

Everything **else** — folder layout, service struct pattern, view DTOs, `ApiResponse<T>` /
`PaginatedData<T>` envelopes, `utoipa::path` docs, RBAC via `Permission`, `sqlite::memory:` tests
— is identical to `bank`.

---

## 2. Domain model

### 2.1 Ledger entry

Each row of the Albion export becomes one immutable ledger row.

| Field          | Type                    | Source    | Notes                                                                 |
| -------------- | ----------------------- | --------- | --------------------------------------------------------------------- |
| `id`           | `i64` PK auto-increment | DB        | Surrogate key.                                                        |
| `occurred_at`  | `DateTimeWithTimeZone`  | `Date`    | The **in-game** timestamp (UTC, normalized by frontend). Ordering key. |
| `player_name`  | `String` (not null)     | `Player`  | Albion in-game name, e.g. `"MrMaranza06"`. Stored verbatim.           |
| `reason`       | `String` (not null)     | `Reason`  | Raw Albion reason string (`"Withdrawal"`, `"Deposit"`, …). Verbatim.  |
| `amount`       | `Decimal` (not null)    | `Amount`  | Signed, preserved exactly as Albion reports it.                       |
| `source`       | `String` (not null)     | server    | `"albion_export"` for rows ingested via `/ingest`. Future-proofing.   |
| `ingest_batch` | `Option<String>`        | server    | UUID (string) of the bulk batch this row belongs to.                  |
| `ingested_at`  | `DateTimeWithTimeZone`  | server    | When the row was written. `default NOW()`.                            |

### 2.2 Player identity

There is **no `players` table** and **no FK to `albion_links`** in v1. A "player" is identified
purely by their Albion in-game name. Reasons:

- The export only gives the display name — resolving it to an `albion_player_id` would require an
  extra API call per row and can fail for renamed / unlinked players.
- `albion_links` is the Discord → Albion OAuth link table; not every export row will have a
  matching Discord user.
- Albion names are unique and stable enough for ledger grouping.

**Normalization rule:** store the name exactly as Albion reports it; group / filter
case-insensitively at query time using `LOWER(player_name)`. Documented on the entity.

A future v2 can add a nullable `player_id` column + a resolver job. The schema leaves room for it
but no code resolves it in v1.

### 2.3 Balance semantics

For a player `P` with rows `R` (matched case-insensitively):

```
total_deposited(P) = SUM(amount) WHERE amount > 0
total_withdrawn(P) = SUM(-amount) WHERE amount < 0     // reported as a positive number
net(P)             = total_deposited(P) - total_withdrawn(P)
```

- `net < 0` → in **debt** to the guild (default sort: most-negative first).
- `net > 0` → surplus.
- `net == 0` → settled.

### 2.4 Idempotency

The Albion export has **no row-level stable id** and legitimate rows can be content-identical (see
the export: Galvdon has a `676` / `-666` round-trip). v1 strategy:

- **Append-only** with a per-batch UUID (`ingest_batch`).
- Each `POST /ingest` generates a new UUID.
- An officer can `DELETE /batches/{batch_id}` to undo a double-paste.

v2 can add a content-hash column with a unique constraint for true idempotency. Out of scope here.

---

## 3. Ingestion API contract

The frontend converts the Albion clipboard export (TSV) into JSON and POSTs it. Each TSV row maps
1:1 to a payload object.

### 3.1 Bulk ingest

`POST /api/siphoned/ingest`

```json
{
  "rows": [
    {
      "occurred_at": "2026-08-10T20:37:41Z",
      "player_name": "Galvdon",
      "reason": "Withdrawal",
      "amount": "-10"
    },
    {
      "occurred_at": "2026-08-09T16:01:37Z",
      "player_name": "Galvdon",
      "reason": "Deposit",
      "amount": "774"
    }
  ]
}
```

`amount` is a string (not a JSON number) to preserve exact decimal semantics — same convention the
`bank` module uses in its `TransactionView` (`#[schema(value_type = String)]`).

**Validation (all-or-nothing; first failure short-circuits with `400 Validation`):**

- `rows` non-empty. Empty → `"no rows to ingest"`.
- `rows.len() <= 1000`. Over → `"too many rows in one batch (max 1000)"`.
- `occurred_at` parses as RFC3339. Unparseable → `"row N: invalid occurred_at"`.
- `player_name` 1..=64 chars after `trim()`. Empty → `"row N: empty player_name"`.
- `reason` 1..=64 chars after `trim()`. Empty → `"row N: empty reason"`.
- `amount` parses as `Decimal`. Unparseable → `"row N: invalid amount"`.
- `amount != 0`. Zero → `"row N: amount must be non-zero"`.

**Response 200:**

```json
{
  "status": "success",
  "data": {
    "batch_id": "0191abc4-...-...",
    "ingested_count": 32,
    "ingested_at": "2026-08-11T14:22:01Z"
  }
}
```

### 3.2 Frontend responsibilities (not backend code)

1. Parse `Date` from the local timezone Albion printed and emit as **UTC ISO8601**.
2. Strip the surrounding quotes Albion puts around each field.
3. Keep `Amount` as a string (sign + exact digits). No float coercion.

The backend trusts the timestamp it receives — no locale reinterpretation.

---

## 4. Endpoints

All under `/api/siphoned`. All require an authenticated `UserContext` (same extractor as `bank`).

| Method | Path                      | Purpose                                                                | Permission                   |
| ------ | ------------------------- | ---------------------------------------------------------------------- | ---------------------------- |
| POST   | `/ingest`                 | Bulk-import an Albion export as ledger rows.                           | `siphoned.ingest` (Officer+) |
| GET    | `/entries`                | Paginated, filterable list of raw ledger rows.                         | `siphoned.view` (Member+)    |
| GET    | `/balances`               | Per-player totals: deposited, withdrawn, net.                          | `siphoned.view`              |
| GET    | `/balances/{player_name}` | Single player balance + their most recent entries.                     | `siphoned.view`              |
| GET    | `/batches`                | List ingestion batches (`batch_id`, `ingested_at`, `row_count`).       | `siphoned.view`              |
| DELETE | `/batches/{batch_id}`     | Delete an entire batch (officer safety valve for double-pastes).       | `siphoned.ingest`            |

`player_name` is URL-encoded in the path; matched case-insensitively.

### 4.1 Query params

`GET /entries` (mirrors `bank`'s `ListTransactionsQuery` shape — `page` / `limit` declared inline
because `serde_html_form` cannot flatten `u64` through a `#[serde(flatten)]`):

- `page` (default 1), `limit` (default 50, capped at 200).
- `player_name` (optional) — case-insensitive match on `LOWER(player_name)`.
- `reason` (optional) — exact match.
- `since` / `until` (optional, ISO8601) — `occurred_at` range, inclusive.
- `batch_id` (optional) — restrict to one ingestion batch.

`GET /balances`:

- `min_debt` (optional Decimal) — only return players with `net < min_debt`. Default: no filter.
- `sort` (optional) — `net_asc` (default, biggest debtors first) | `net_desc` | `name_asc`.

---

## 5. Migration & schema

Two new migrations, following the `YYYYMMDD_NNNNNN_slug` convention already in the repo.

### 5.1 `m20260811_000001_create_siphoned_energy_entries_table.rs`

```sql
CREATE TABLE siphoned_energy_entries (
    id              BIGSERIAL    PRIMARY KEY,
    occurred_at     TIMESTAMPTZ  NOT NULL,
    player_name     VARCHAR(64)  NOT NULL,
    reason          VARCHAR(64)  NOT NULL,
    amount          NUMERIC(20)  NOT NULL,
    source          VARCHAR(32)  NOT NULL DEFAULT 'albion_export',
    ingest_batch    VARCHAR(36),            -- UUID stored as string (portable across SQLite/PG)
    ingested_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_siphoned_player_lower ON siphoned_energy_entries (LOWER(player_name));
CREATE INDEX idx_siphoned_occurred_at  ON siphoned_energy_entries (occurred_at DESC);
CREATE INDEX idx_siphoned_ingest_batch
    ON siphoned_energy_entries (ingest_batch)
    WHERE ingest_batch IS NOT NULL;
```

Notes:

- `amount` is `NUMERIC(20)` — signed. Siphoned-energy amounts are tiny, but `NUMERIC(20)` matches
  the headroom the `bank` module's `Decimal` column assumes and leaves room for a future
  denomination change.
- `ingest_batch` stored as `VARCHAR(36)` (UUID string) rather than a native `UUID` type, because
  the test suite runs against `sqlite::memory:` (see `bank::service::tests`), and SQLite has no
  native UUID type. The migration must be portable across both backends — same reason the existing
  migrations all use `String` for `discord_id` / `albion_player_id`.
- Registered in `apps/backend/src/migration/mod.rs` `Migrator::migrations()`.

### 5.2 `m20260811_000002_seed_siphoned_permissions.rs`

Same style as `m20260710_000002_seed_comps_permissions.rs` and
`m20260711_000004_seed_events_permissions.rs`. Seeds:

| Role    | Permissions                                    |
| ------- | ---------------------------------------------- |
| Member  | `siphoned.view`                                |
| Officer | `siphoned.view`, `siphoned.ingest`             |
| Admin   | (inherits all via `Permission::all()` seeding) |

---

## 6. Module layout

Mirror of `bank`'s folder shape.

```
apps/backend/src/modules/siphoned/
├── mod.rs         // `pub mod …; pub use router::router;`  (same as bank::mod)
├── entities.rs    // SeaORM entity `siphoned_energy_entries`
├── models.rs      // DTOs + `EntryView::from_model` (same pattern as TransactionView)
├── status.rs      // `SiphonedEntrySource` enum (AlbionExport | Manual), FromStr/Display
├── service.rs     // `SiphonedService` struct with `new()` + async methods
└── router.rs      // axum Router + `#[utoipa::path]` handlers
```

Wired into `apps/backend/src/modules/mod.rs`:

```rust
pub mod siphoned;
// …in router():
.nest("/siphoned", siphoned::router())
```

### 6.1 `entities.rs`

Follows `bank::entities` line-by-line:

- `#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]`
- `#[sea_orm(table_name = "siphoned_energy_entries")]`
- Fields per §2.1. `amount: Decimal` (from `sea_orm::prelude::*`).
- `#[derive(Copy, Clone, Debug, EnumIter)] pub enum Relation {}` — empty for v1 (no FKs).
- `impl ActiveModelBehavior for ActiveModel {}`.

### 6.2 `status.rs`

Mirror of `bank::status`. Defines `SiphonedEntrySource` (`AlbionExport`, `Manual`) with
`as_str`, `Display`, `FromStr`, `Serialize`/`Deserialize`/`ToSchema`. Even though only
`AlbionExport` is used in v1, having the enum means future manual entries are a new variant, not a
magic string. Default serialization `rename_all = "snake_case"`.

> **Note on `reason`:** we deliberately do **not** make `reason` an enum. The Albion export may
> introduce new reasons (e.g. `"Tax"`, `"GuildCut"`) and we want to ingest them without a
> migration. `reason` stays a free-form `String` and the `GET /entries?reason=…` filter is an exact
> match.

### 6.3 `models.rs`

Mirror of `bank::models`. View structs with `from_model` constructors, `ToSchema` derives.
Proposed types:

```rust
/// One ledger row, as returned to a client. Built from the entity via `from_model`.
pub struct EntryView {
    pub id: i64,
    pub occurred_at: String,           // RFC3339, like TransactionView.created_at
    pub player_name: String,
    pub reason: String,
    #[schema(value_type = String, example = "-10")]
    pub amount: Decimal,
    pub source: SiphonedEntrySource,
    pub ingest_batch: Option<String>,
    pub ingested_at: String,
}

impl EntryView {
    pub(super) fn from_model(model: Model) -> Self { … }
}

/// Per-player aggregates returned by `GET /balances`.
pub struct PlayerBalance {
    pub player_name: String,           // the casing of the most recent row for that player
    #[schema(value_type = String, example = "774")]
    pub total_deposited: Decimal,
    #[schema(value_type = String, example = "10")]
    pub total_withdrawn: Decimal,
    #[schema(value_type = String, example = "-10")]
    pub net: Decimal,
    pub entry_count: u64,
    pub first_seen: String,
    pub last_seen: String,
}

/// Single-player detail returned by `GET /balances/{player_name}`.
pub struct PlayerBalanceDetail {
    pub balance: PlayerBalance,
    pub recent_entries: Vec<EntryView>,    // default 20, configurable via ?recent=N
}

/// `GET /balances` query filters.
pub struct BalanceQuery {                  // serializes from query string
    pub min_debt: Option<Decimal>,
    pub sort: Option<BalanceSort>,
}

pub enum BalanceSort { NetAsc, NetDesc, NameAsc }

/// Ingest request body.
pub struct IngestRow {
    pub occurred_at: DateTimeWithTimeZone,
    pub player_name: String,
    pub reason: String,
    #[schema(value_type = String, example = "-10")]
    pub amount: Decimal,                   // accepts "-10" or -10; backend parses leniently
}

pub struct IngestRequest {
    pub rows: Vec<IngestRow>,
}

pub struct IngestResponse {
    pub batch_id: String,
    pub ingested_count: u64,
    pub ingested_at: String,
}

/// `GET /entries` filters, same shape as bank's `TransactionFilters`.
pub struct EntryFilters {
    pub player_name: Option<String>,
    pub reason: Option<String>,
    pub since: Option<DateTimeWithTimeZone>,
    pub until: Option<DateTimeWithTimeZone>,
    pub batch_id: Option<String>,
}

/// One row of `GET /batches`.
pub struct BatchSummary {
    pub batch_id: String,
    pub ingested_at: String,
    pub row_count: u64,
}
```

### 6.4 `service.rs` — `SiphonedService`

Same shape as `BankService`:

```rust
pub struct SiphonedService;
impl SiphonedService {
    pub fn new() -> Self { Self }
    pub async fn ingest(&self, db: &DatabaseConnection, req: &IngestRequest)
        -> Result<IngestResponse, AppError> { … }
    pub async fn list_entries(&self, db: &DatabaseConnection, pagination: &PaginationParams,
        filters: &EntryFilters) -> Result<PaginatedData<EntryView>, AppError> { … }
    pub async fn list_balances(&self, db: &DatabaseConnection, opts: &BalanceQuery)
        -> Result<Vec<PlayerBalance>, AppError> { … }
    pub async fn get_balance(&self, db: &DatabaseConnection, player_name: &str,
        recent: u64) -> Result<PlayerBalanceDetail, AppError> { … }
    pub async fn list_batches(&self, db: &DatabaseConnection)
        -> Result<Vec<BatchSummary>, AppError> { … }
    pub async fn delete_batch(&self, db: &DatabaseConnection, batch_id: &str)
        -> Result<u64, AppError> { … }
}
impl Default for SiphonedService { fn default() -> Self { Self::new() } }
```

Behavior notes:

- `ingest` — generates a `Uuid` (via `uuid::Uuid::new_v4().to_string()`), validates the entire
  batch up-front per §3.1 (first failure → `AppError::Validation` with the offending index), then
  inserts all rows inside `db.begin()` / `txn.commit()`. Uses `Set` on every `ActiveModel` field
  exactly like `bank::service::request_withdrawal`.
- `list_entries` — same paginator pattern as `BankService::list_transactions`:
  `Entity::find()` → conditional `.filter(...)` → `.paginate(db, limit)` → `num_items` /
  `num_pages` / `fetch_page`. Then `models.into_iter().map(EntryView::from_model).collect()`.
  No username resolution needed (unlike `bank`), so no `to_views_with_usernames` helper.
- `list_balances` — one raw `Statement` via `db.execute()` or
  `Entity::find().from_raw_sql(...)`. The aggregation query uses `SUM(CASE WHEN amount > 0 THEN
  amount ELSE 0 END)` instead of `FILTER (WHERE …)` for SQLite portability (SQLite supports
  `FILTER` since 3.30 but `CASE` is universal). Implementation example:

  ```sql
  SELECT
      LOWER(player_name)           AS player_name_key,
      MAX(player_name)             AS display_name,
      SUM(amount)                  AS net,
      SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS total_deposited,
      SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS total_withdrawn,
      COUNT(*)                     AS entry_count,
      MIN(occurred_at)             AS first_seen,
      MAX(occurred_at)             AS last_seen
  FROM siphoned_energy_entries
  GROUP BY LOWER(player_name)
  ORDER BY net ASC | net DESC | display_name ASC
  ```

- `get_balance` — same aggregation restricted to `LOWER(player_name) = LOWER($1)`; returns
  `AppError::NotFound` if zero rows; otherwise also fetches `recent` most-recent entries ordered
  by `occurred_at DESC, id DESC`.
- `list_batches` — `GROUP BY ingest_batch` query.
- `delete_batch` — `Entity::delete_many().filter(Column::IngestBatch.eq(batch_id)).exec(db)`;
  return the deleted count; `AppError::NotFound` if zero.

Tests: same `sqlite::memory:` + `Migrator::up` setup as `bank::service::tests`. Seed a few rows,
assert `ingest` is all-or-nothing on bad input, assert `list_balances` aggregates correctly, assert
`delete_batch` removes exactly one batch.

### 6.5 `router.rs`

Mirror of `bank::router`:

- One `pub fn router() -> Router` returning a `Router::new().route(...)` chain.
- A `ListEntriesQuery` struct mirroring `bank::router::ListTransactionsQuery` — declares `page` /
  `limit` inline plus `#[serde(flatten)] filters: EntryFilters`.
- `BalanceQuery` is reused directly as a `Query<BalanceQuery>` extractor.
- Each handler has a `#[utoipa::path(...)]` annotation with `tag = "siphoned"`, `security(("session_cookie" = []))`,
  and `responses(...)` listing success + `ProblemDetails` error variants. The `tag` is new — add it
  to the `#[derive(OpenApi)]` `tags(...)` list in `apps/backend/src/openapi.rs` (see §8).
- Auth pattern: `user: UserContext` extractor + `Extension(perms): Extension<Permissions>` +
  `user.require(&perms, Permission::SiphonedIngest).await?` (same as
  `bank::router::accept_withdrawal`).
- `DELETE /batches/{batch_id}` uses `axum::extract::Path<String>`.

---

## 7. Permissions

Add two variants to `Permission` in
`apps/backend/src/modules/auth/permissions.rs`, exactly the same way the existing ones are
declared:

```rust
/// Import siphoned energy ledger rows from the Albion export. Officer-or-above.
#[strum(serialize = "siphoned.ingest")]
SiphonedIngest,
/// View the siphoned energy ledger / per-player balances. Member-or-above.
#[strum(serialize = "siphoned.view")]
SiphonedView,
```

Because `Permission::all()` is backed by `strum::VariantArray`, the Admin role automatically
receives them once seeded. The new seed migration (§5.2) grants them to Member / Officer.

**Tests to update:** the `all_contains_every_variant` test in `permissions.rs` hard-codes the
variant count (currently `10`). After adding the two new variants it must become `12`.

Route enforcement reuses `user.require(&perms, Permission::SiphonedIngest).await?` — no new
abstractions.

---

## 8. OpenAPI / `utoipa`

In `apps/backend/src/openapi.rs`:

- Add a `siphoned` tag to the `tags(...)` list, mirroring how `bank` is declared.
- Add `components(schemas(...))` entries for every DTO in `siphoned::models` plus
  `SiphonedEntrySource`.
- Add concrete paginated + response wrappers in `apps/backend/src/pagination.rs` and
  `apps/backend/src/responses.rs`, matching the existing boilerplate:

  ```rust
  // pagination.rs
  pub struct PaginatedEntryView { … }
  impl From<PaginatedData<EntryView>> for PaginatedEntryView { … }

  // responses.rs
  pub struct ApiResponseIngestResponse { … }
  pub struct ApiResponseEntryViewList { … }       // GET /entries (paginated) reuses PaginatedEntryView
  pub struct ApiResponsePlayerBalanceList { … }   // GET /balances
  pub struct ApiResponsePlayerBalanceDetail { … } // GET /balances/{name}
  pub struct ApiResponseBatchSummaryList { … }    // GET /batches
  pub struct ApiResponseDeletedCount { … }        // DELETE /batches/{id}
  ```

  Yes, this is verbose — but it's the established pattern in the codebase. We follow it rather
  than introducing a new generic mechanism in this PR.

No new security schemes — reuse the existing `session_cookie`.

---

## 9. Explicitly out of scope (v1)

Kept out to honor "è molto semplice":

- **Deterministic idempotency** (content-hash unique constraint). v1 uses batch UUIDs + `DELETE
  /batches/{id}`.
- **Player ↔ `albion_links` resolution** (`player_id` FK). v1 groups by name only.
- **Manual single-row entries** (officer records an out-of-game correction). The `source` column
  is ready for this, but no endpoint is exposed.
- **Editing / deleting individual rows.** Only batch-level delete in v1; single-row deletes should
  come with an audit log.
- **Frontend.** This plan is backend-only.

---

## 10. Implementation order

Each step compiles on its own; reviewable one at a time.

1. **Migration** — `m20260811_000001_create_siphoned_energy_entries_table.rs`, register in
   `migration/mod.rs`. `cargo build` to confirm.
2. **Permission seed** — add `SiphonedIngest` / `SiphonedView` to `Permission`; write
   `m20260811_000002_seed_siphoned_permissions.rs`; bump `all_contains_every_variant` count to 12.
3. **Module skeleton** — `modules/siphoned/{mod.rs, entities.rs, models.rs, status.rs, service.rs,
   router.rs}` with stubs; register `pub mod siphoned;` + nested router in `modules/mod.rs`.
   `cargo build` to confirm wiring.
4. **Entity** — fill in `entities.rs` mirroring `bank::entities`.
5. **Models** — fill in `models.rs` with `EntryView::from_model` and the rest per §6.3.
6. **Status** — fill in `status.rs` with `SiphonedEntrySource`.
7. **Service** — implement `SiphonedService` methods with `sqlite::memory:` unit tests mirroring
   `bank::service::tests`.
8. **Router + handlers** — wire the six endpoints with full `utoipa::path` annotations.
9. **OpenAPI registration** — add tag + schemas to `openapi.rs`; add paginated/response wrappers
   to `pagination.rs` and `responses.rs`.
10. **Green** — `cargo clippy -- -D warnings` and `cargo test` clean.

---

## 11. Risks & decisions

- **No `players` table.** Trade-off: simpler schema, but Albion renames fragment history. Accepted
  for v1; revisit if it bites.
- **Balances computed on read.** A guild's lifetime of siphoned rows is in the thousands, so
  `GROUP BY LOWER(player_name)` per request is cheap. If it ever stops being true, add a
  materialized `siphoned_player_balances` table refreshed on ingest.
- **Locale of `Date`.** Frontend normalizes to UTC before calling `/ingest`. Backend trusts the
  timestamp.
- **`NUMERIC(20)` precision.** Overkill for siphoned integers, leaves room for future
  denomination changes.
- **`UUID` stored as `VARCHAR(36)`.** Forced by SQLite-portable migrations (the test suite uses
  `sqlite::memory:`). PostgreSQL stores it as a string but indexed identically.
- **`source` enum + free-form `reason` string.** `source` is our own vocabulary (small, stable
  set — enum). `reason` is Albion's vocabulary (open-ended — string). Asymmetric on purpose.
