//! Siphoned service logic module.
//!
//! Provides the Guild Siphoned Energy ledger: bulk ingest of the Albion export, raw entry listing,
//! per-player balance aggregation, and batch management. Request/response types live in
//! `models.rs`; the source enum lives in `status.rs`.

use std::collections::HashSet;

use chrono::{DateTime, FixedOffset, Utc};
use sea_orm::prelude::Decimal;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait, DatabaseBackend,
    DatabaseConnection, EntityTrait, FromQueryResult, IntoActiveModel, PaginatorTrait, QueryFilter,
    QueryOrder, Statement, TransactionTrait, sea_query::Expr,
};
use uuid::Uuid;

use crate::errors::AppError;
use crate::pagination::{PaginatedData, PaginationParams, SortOrder, resolve_sort_key};

use super::entities::{
    ActiveModel, Column, Entity as SiphonedEntryEntity, Model as SiphonedEntryModel,
};
use super::models::{
    BalanceSort, BatchSummary, DeletedCount, EntryFilters, EntryMutationRequest, EntryView,
    IngestRequest, IngestResponse, IngestRow, PlayerBalance, PlayerBalanceDetail,
};

/// Hard cap on a single ingest payload size. Defends against a giant paste; the Albion export is
/// usually a few hundred rows at most.
pub const MAX_ROWS_PER_INGEST: usize = 1000;

/// Default (and cap) for how many recent entries `get_balance` returns alongside the aggregates.
pub const DEFAULT_RECENT_ENTRIES: u64 = 20;

/// The source tag stamped on every row written by [`SiphonedService::ingest`].
const SOURCE_ALBION_EXPORT: &str = "albion_export";

/// Service for executing business logic operations related to the Guild Siphoned Energy ledger.
pub struct SiphonedService;

impl SiphonedService {
    /// Creates a new instance of the `SiphonedService`.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Bulk-imports an Albion export as immutable ledger rows.
    ///
    /// All newly written rows share a single freshly-generated `ingest_batch` UUID. Rows already
    /// present from a previous export are skipped using Albion's ledger identity fields instead of
    /// forcing officers to manually delete overlapping batches.
    ///
    /// # Example
    /// ```rust,ignore
    /// let response = SiphonedService::new().ingest(&db, &request).await?;
    /// assert!(response.ingested_count <= request.rows.len() as u64);
    /// ```
    ///
    /// # Errors
    ///
    /// * Returns `AppError::Validation` if the payload is empty, too large, or any row has invalid
    ///   `occurred_at` / `player_name` / `reason` / `amount` (the message includes the offending
    ///   row index).
    /// * Returns `AppError::Database` if the transaction fails.
    pub async fn ingest(
        &self,
        db: &DatabaseConnection,
        req: &IngestRequest,
    ) -> Result<IngestResponse, AppError> {
        if req.rows.is_empty() {
            return Err(AppError::Validation("no rows to ingest".to_string()));
        }
        if req.rows.len() > MAX_ROWS_PER_INGEST {
            return Err(AppError::Validation(format!(
                "too many rows in one batch (max {MAX_ROWS_PER_INGEST})"
            )));
        }

        // Validate every row up-front so we never write a partial batch.
        for (idx, row) in req.rows.iter().enumerate() {
            validate_row(idx, row)?;
        }

        let batch_id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let ingested_at: DateTime<FixedOffset> = now.into();

        let txn = db.begin().await?;
        let mut seen_entry_keys = existing_entry_keys(&txn, &req.rows).await?;
        let mut ingested_count = 0;

        for row in &req.rows {
            let entry_key = SiphonedEntryKey::from_row(row);
            if seen_entry_keys.contains(&entry_key) {
                continue;
            }

            let active = ActiveModel {
                occurred_at: Set(row.occurred_at),
                player_name: Set(row.player_name.trim().to_string()),
                reason: Set(row.reason.trim().to_string()),
                amount: Set(row.amount),
                source: Set(SOURCE_ALBION_EXPORT.to_string()),
                ingest_batch: Set(Some(batch_id.clone())),
                ingested_at: Set(ingested_at),
                ..Default::default()
            };
            active.insert(&txn).await?;
            seen_entry_keys.insert(entry_key);
            ingested_count += 1;
        }

        txn.commit().await?;

        Ok(IngestResponse {
            batch_id,
            ingested_count,
            ingested_at: now.to_rfc3339(),
        })
    }

    /// Creates one manual ledger entry.
    ///
    /// Manual rows are stored with no `ingest_batch`, which keeps them separate from bulk imports
    /// while still including them in the same accounting projections.
    ///
    /// # Example
    /// ```rust,ignore
    /// let entry = service.create_entry(&db, &request).await?;
    /// ```
    ///
    /// # Errors
    ///
    /// Returns `AppError::Validation` for invalid fields or `AppError::Database` when the insert
    /// fails.
    pub async fn create_entry(
        &self,
        db: &DatabaseConnection,
        req: &EntryMutationRequest,
    ) -> Result<EntryView, AppError> {
        validate_row(0, req)?;
        let ingested_at: DateTime<FixedOffset> = Utc::now().into();
        let active = ActiveModel {
            occurred_at: Set(req.occurred_at),
            player_name: Set(req.player_name.trim().to_string()),
            reason: Set(req.reason.trim().to_string()),
            amount: Set(req.amount),
            source: Set(SOURCE_ALBION_EXPORT.to_string()),
            ingest_batch: Set(None),
            ingested_at: Set(ingested_at),
            ..Default::default()
        };
        let model = active.insert(db).await?;
        Ok(EntryView::from_model(model))
    }

    /// Updates one existing ledger entry in place.
    ///
    /// Keeps `source`, `ingest_batch`, and `ingested_at` unchanged so batch history remains usable
    /// even when an officer corrects a pasted row.
    ///
    /// # Example
    /// ```rust,ignore
    /// let corrected = service.update_entry(&db, 42, &request).await?;
    /// ```
    ///
    /// # Errors
    ///
    /// Returns `AppError::NotFound` when `entry_id` does not exist, validation errors for invalid
    /// fields, or `AppError::Database` if the update fails.
    pub async fn update_entry(
        &self,
        db: &DatabaseConnection,
        entry_id: i64,
        req: &EntryMutationRequest,
    ) -> Result<EntryView, AppError> {
        validate_row(0, req)?;
        let model = SiphonedEntryEntity::find_by_id(entry_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("no siphoned entry with id '{entry_id}'")))?;
        let mut active = model.into_active_model();
        active.occurred_at = Set(req.occurred_at);
        active.player_name = Set(req.player_name.trim().to_string());
        active.reason = Set(req.reason.trim().to_string());
        active.amount = Set(req.amount);
        let updated = active.update(db).await?;
        Ok(EntryView::from_model(updated))
    }

    /// Deletes one existing ledger entry.
    ///
    /// Single-row deletion is the precise correction path for bad manual entries or isolated paste
    /// mistakes; batch deletion remains available for full duplicated imports.
    ///
    /// # Example
    /// ```rust,ignore
    /// let deleted = service.delete_entry(&db, 42).await?;
    /// ```
    ///
    /// # Errors
    ///
    /// Returns `AppError::NotFound` when the row does not exist or `AppError::Database` when the
    /// delete fails.
    pub async fn delete_entry(
        &self,
        db: &DatabaseConnection,
        entry_id: i64,
    ) -> Result<DeletedCount, AppError> {
        let result = SiphonedEntryEntity::delete_by_id(entry_id).exec(db).await?;
        if result.rows_affected == 0 {
            return Err(AppError::NotFound(format!(
                "no siphoned entry with id '{entry_id}'"
            )));
        }
        Ok(DeletedCount {
            deleted_count: result.rows_affected,
        })
    }

    /// Lists paginated ledger entries with optional filters, newest first by default.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Validation` for an unknown `sort` column or `AppError::Database` if the
    /// query fails.
    pub async fn list_entries(
        &self,
        db: &DatabaseConnection,
        pagination: &PaginationParams,
        filters: &EntryFilters,
    ) -> Result<PaginatedData<EntryView>, AppError> {
        let limit = pagination.limit();
        let page = pagination.offset_page();

        let sort_column = resolve_sort_key(
            filters.sort.as_deref(),
            &[
                ("occurred_at", Column::OccurredAt),
                ("player_name", Column::PlayerName),
                ("amount", Column::Amount),
                ("reason", Column::Reason),
                ("ingested_at", Column::IngestedAt),
            ],
            Column::OccurredAt,
        )?;
        let order = SortOrder::from_query(filters.order.as_deref());
        let query = match order {
            SortOrder::Asc => entries_query(filters)
                .order_by_asc(sort_column)
                .order_by_asc(Column::Id),
            SortOrder::Desc => entries_query(filters)
                .order_by_desc(sort_column)
                .order_by_desc(Column::Id),
        };

        let paginator = query.paginate(db, limit);

        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let models = paginator.fetch_page(page).await?;

        let items: Vec<EntryView> = models.into_iter().map(EntryView::from_model).collect();

        Ok(PaginatedData::new(
            items,
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }

    /// Computes per-player aggregates (deposits, withdrawals, net) across the whole ledger.
    ///
    /// Uses a single `GROUP BY LOWER(player_name)` SQL statement. The query is built and run via
    /// `FromQueryResult` rather than the `SeaORM` query builder because the conditional aggregation
    /// (`SUM(CASE WHEN ...)`) is cleaner in raw SQL and portable across `PostgreSQL` and `SQLite`.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Database` if the query fails.
    pub async fn list_balances(
        &self,
        db: &DatabaseConnection,
        min_debt: Option<Decimal>,
        sort: BalanceSort,
        search: Option<&str>,
    ) -> Result<Vec<PlayerBalance>, AppError> {
        let order_clause = match sort {
            BalanceSort::NetAsc => "net ASC, display_name ASC",
            BalanceSort::NetDesc => "net DESC, display_name ASC",
            BalanceSort::NameAsc => "display_name ASC",
        };

        let having_clause = min_debt
            .map(|threshold| format!("HAVING SUM(amount) < {threshold}"))
            .unwrap_or_default();

        let search_pattern = search
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| format!("%{}%", value.to_lowercase()));
        let search_clause = if search_pattern.is_some() {
            r#"WHERE LOWER(player_name) LIKE $1"#
        } else {
            ""
        };

        let (total_deposited, total_withdrawn, net) = balance_aggregates(db);
        let sql = format!(
            r#"
            WITH unique_entries AS (
                SELECT
                    LOWER("player_name") AS player_key,
                    MAX("player_name") AS player_name,
                    "occurred_at",
                    "reason",
                    "amount",
                    "source"
                FROM siphoned_energy_entries
                GROUP BY LOWER("player_name"), "occurred_at", "reason", "amount", "source"
            )
            SELECT
                MAX(player_name) AS display_name,
                {total_deposited},
                {total_withdrawn},
                {net},
                COUNT(*) AS entry_count,
                MIN("occurred_at") AS first_seen,
                MAX("occurred_at") AS last_seen
            FROM unique_entries
            {search_clause}
            GROUP BY player_key
            {having_clause}
            ORDER BY {order_clause}
            "#
        );

        let params: Vec<sea_orm::Value> = match search_pattern.as_deref() {
            Some(pattern) => vec![text_value(pattern)],
            None => Vec::new(),
        };
        let statement = build_statement(db, &sql, &params);
        let rows = PlayerBalanceRow::find_by_statement(statement)
            .all(db)
            .await?;

        Ok(rows.into_iter().map(PlayerBalance::from).collect())
    }

    /// Returns the aggregate balance for a single player plus their most recent entries.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::NotFound` if no row exists for `player_name` (case-insensitive).
    /// * Returns `AppError::Database` if the query fails.
    pub async fn get_balance(
        &self,
        db: &DatabaseConnection,
        player_name: &str,
        recent: u64,
    ) -> Result<PlayerBalanceDetail, AppError> {
        let recent = recent.clamp(1, 100);

        let (total_deposited, total_withdrawn, net) = balance_aggregates(db);
        let sql = format!(
            r#"
            WITH unique_entries AS (
                SELECT
                    LOWER("player_name") AS player_key,
                    MAX("player_name") AS player_name,
                    "occurred_at",
                    "reason",
                    "amount",
                    "source"
                FROM siphoned_energy_entries
                WHERE LOWER("player_name") = LOWER($1)
                GROUP BY LOWER("player_name"), "occurred_at", "reason", "amount", "source"
            )
            SELECT
                MAX(player_name) AS display_name,
                {total_deposited},
                {total_withdrawn},
                {net},
                COUNT(*) AS entry_count,
                MIN("occurred_at") AS first_seen,
                MAX("occurred_at") AS last_seen
            FROM unique_entries
            GROUP BY player_key
            "#
        );
        let statement = build_statement(db, &sql, &[text_value(player_name)]);
        let mut rows = PlayerBalanceRow::find_by_statement(statement)
            .all(db)
            .await?;
        let Some(aggregate) = rows.pop() else {
            return Err(AppError::NotFound(format!(
                "no siphoned energy entries for player '{player_name}'"
            )));
        };

        // COUNT(*) is 0 only if the player has never been seen.
        if aggregate.entry_count == 0 {
            return Err(AppError::NotFound(format!(
                "no siphoned energy entries for player '{player_name}'"
            )));
        }

        let balance = PlayerBalance {
            player_name: aggregate.display_name,
            total_deposited: aggregate.total_deposited,
            total_withdrawn: aggregate.total_withdrawn,
            net: aggregate.net,
            entry_count: aggregate.entry_count.cast_unsigned(),
            first_seen: aggregate.first_seen.to_rfc3339(),
            last_seen: aggregate.last_seen.to_rfc3339(),
        };

        // Pull recent rows with a raw SQL `LIMIT` so the case-insensitive match is portable
        // across PostgreSQL and SQLite (the query builder would emit a backend-specific LIKE).
        let recent_sql = r#"
            SELECT
                MIN("id") AS id,
                "occurred_at",
                MAX("player_name") AS player_name,
                "reason",
                "amount",
                "source",
                MIN("ingest_batch") AS ingest_batch,
                MIN("ingested_at") AS ingested_at
            FROM siphoned_energy_entries
            WHERE LOWER("player_name") = LOWER($1)
            GROUP BY LOWER("player_name"), "occurred_at", "reason", "amount", "source"
            ORDER BY "occurred_at" DESC, id DESC
            LIMIT $2
        "#;
        let recent_stmt = build_statement(
            db,
            recent_sql,
            &[
                text_value(player_name),
                sea_orm::Value::BigInt(Some(recent as i64)),
            ],
        );
        let recent_models = SiphonedEntryModel::find_by_statement(recent_stmt)
            .all(db)
            .await?;
        let recent_entries: Vec<EntryView> = recent_models
            .into_iter()
            .map(EntryView::from_model)
            .collect();

        Ok(PlayerBalanceDetail {
            balance,
            recent_entries,
        })
    }

    /// Lists every ingestion batch with its row count, newest first.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Database` if the query fails.
    pub async fn list_batches(
        &self,
        db: &DatabaseConnection,
    ) -> Result<Vec<BatchSummary>, AppError> {
        let sql = r#"
            SELECT
                "ingest_batch" AS batch_id,
                MIN("ingested_at") AS ingested_at,
                COUNT(*) AS row_count
            FROM siphoned_energy_entries
            WHERE "ingest_batch" IS NOT NULL
            GROUP BY "ingest_batch"
            ORDER BY ingested_at DESC
        "#;
        let statement = build_statement(db, sql, &[]);
        let rows = BatchRow::find_by_statement(statement).all(db).await?;

        Ok(rows.into_iter().map(BatchSummary::from).collect())
    }

    /// Deletes every row tagged with the given `ingest_batch` UUID.
    ///
    /// Intended as the safety valve for "I pasted the same export twice".
    ///
    /// # Errors
    ///
    /// * Returns `AppError::NotFound` if no row matches (no such batch).
    /// * Returns `AppError::Database` if the delete fails.
    pub async fn delete_batch(
        &self,
        db: &DatabaseConnection,
        batch_id: &str,
    ) -> Result<DeletedCount, AppError> {
        let result = SiphonedEntryEntity::delete_many()
            .filter(Column::IngestBatch.eq(batch_id))
            .exec(db)
            .await?;

        let deleted = result.rows_affected;
        if deleted == 0 {
            return Err(AppError::NotFound(format!("no batch with id '{batch_id}'")));
        }

        Ok(DeletedCount {
            deleted_count: deleted,
        })
    }
}

impl Default for SiphonedService {
    fn default() -> Self {
        Self::new()
    }
}

/// Validates a single ingest row, returning the row index in the error message on failure.
fn validate_row(idx: usize, row: &IngestRow) -> Result<(), AppError> {
    let player = row.player_name.trim();
    if player.is_empty() || player.len() > 64 {
        return Err(AppError::Validation(format!(
            "row {idx}: player_name must be 1..=64 non-whitespace chars"
        )));
    }
    let reason = row.reason.trim();
    if reason.is_empty() || reason.len() > 64 {
        return Err(AppError::Validation(format!(
            "row {idx}: reason must be 1..=64 non-whitespace chars"
        )));
    }
    if row.amount == Decimal::ZERO {
        return Err(AppError::Validation(format!(
            "row {idx}: amount must be non-zero"
        )));
    }
    Ok(())
}

/// Loads the normalized identities that can overlap the pasted export.
///
/// Albion exports are cumulative snapshots rather than append-only deltas. We only query the
/// submitted timestamp window to avoid scanning the full ledger while still catching rows repeated
/// by later overlapping imports.
///
/// # Example
/// ```rust,ignore
/// let known_keys = existing_entry_keys(&txn, &request.rows).await?;
/// ```
///
/// # Errors
///
/// Returns `AppError::Database` if the lookup fails.
async fn existing_entry_keys(
    db: &impl ConnectionTrait,
    rows: &[IngestRow],
) -> Result<HashSet<SiphonedEntryKey>, AppError> {
    let Some((first_row, remaining_rows)) = rows.split_first() else {
        return Ok(HashSet::new());
    };

    let mut earliest = first_row.occurred_at;
    let mut latest = first_row.occurred_at;
    for row in remaining_rows {
        earliest = earliest.min(row.occurred_at);
        latest = latest.max(row.occurred_at);
    }

    let models = SiphonedEntryEntity::find()
        .filter(Column::Source.eq(SOURCE_ALBION_EXPORT))
        .filter(Column::OccurredAt.gte(earliest))
        .filter(Column::OccurredAt.lte(latest))
        .all(db)
        .await?;

    Ok(models
        .iter()
        .map(SiphonedEntryKey::from_model)
        .collect::<HashSet<_>>())
}

/// Stable identity for one Albion ledger row.
///
/// The export has no immutable row id, so the natural identity is the combination shown in the
/// copied table. Player names are lowercased to prevent casing differences from creating duplicate
/// debts.
///
/// # Example
/// ```rust,ignore
/// let key = SiphonedEntryKey::from_row(&row);
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SiphonedEntryKey {
    occurred_at: DateTime<FixedOffset>,
    player_name_lower: String,
    reason: String,
    amount: Decimal,
    source: &'static str,
}

impl SiphonedEntryKey {
    /// Creates a comparable identity from a pending import row.
    fn from_row(row: &IngestRow) -> Self {
        Self {
            occurred_at: row.occurred_at,
            player_name_lower: row.player_name.trim().to_lowercase(),
            reason: row.reason.trim().to_string(),
            amount: row.amount,
            source: SOURCE_ALBION_EXPORT,
        }
    }

    /// Creates a comparable identity from an already persisted row.
    fn from_model(model: &SiphonedEntryModel) -> Self {
        Self {
            occurred_at: model.occurred_at,
            player_name_lower: model.player_name.trim().to_lowercase(),
            reason: model.reason.trim().to_string(),
            amount: model.amount,
            source: SOURCE_ALBION_EXPORT,
        }
    }
}

/// Builds the base `find()` query for entries, applying every supplied filter.
fn entries_query(filters: &EntryFilters) -> sea_orm::Select<SiphonedEntryEntity> {
    let mut q = SiphonedEntryEntity::find();

    if let Some(name) = &filters.player_name {
        let pattern = name.to_lowercase();
        q = q.filter(Expr::cust("LOWER(\"player_name\")").like(format!("%{pattern}%")));
    }
    if let Some(search) = filters
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let pattern = format!("%{}%", search.to_lowercase());
        q = q.filter(
            Condition::any()
                .add(Expr::cust("LOWER(\"player_name\")").like(pattern.clone()))
                .add(Expr::cust("LOWER(\"reason\")").like(pattern)),
        );
    }
    if let Some(reason) = &filters.reason {
        q = q.filter(Column::Reason.eq(reason));
    }
    if let Some(since) = filters.since {
        q = q.filter(Column::OccurredAt.gte(since));
    }
    if let Some(until) = filters.until {
        q = q.filter(Column::OccurredAt.lte(until));
    }
    if let Some(batch) = &filters.batch_id {
        q = q.filter(Column::IngestBatch.eq(batch));
    }

    q
}

/// Builds the three balance aggregate expressions (current positive balance, current debt, net).
///
/// Deposits and withdrawals are movements of the same energy, not independent lifetime totals.
/// Therefore the displayed totals are derived from the net balance: a positive net is the current
/// deposited amount, while a negative net is the current withdrawn/debt amount. This prevents a
/// deposit → withdrawal → redeposit cycle from counting the same energy twice.
///
/// SQLite's `SUM` over integer-valued `numeric` rows yields an `INTEGER` column that sea-orm's
/// `Decimal` decoder cannot read (it expects `REAL`), so the values are cast to `REAL` there.
/// PostgreSQL keeps the exact `numeric` type — the cast is skipped to avoid precision loss.
fn balance_aggregates(db: &DatabaseConnection) -> (String, String, String) {
    let net = "COALESCE(SUM(amount), 0)";
    let deposited = format!("CASE WHEN {net} > 0 THEN {net} ELSE 0 END");
    let withdrawn = format!("CASE WHEN {net} < 0 THEN -({net}) ELSE 0 END");

    if db.get_database_backend() == DatabaseBackend::Sqlite {
        (
            format!("CAST({deposited} AS REAL) AS total_deposited"),
            format!("CAST({withdrawn} AS REAL) AS total_withdrawn"),
            format!("CAST({net} AS REAL) AS net"),
        )
    } else {
        (
            format!("{deposited} AS total_deposited"),
            format!("{withdrawn} AS total_withdrawn"),
            format!("{net} AS net"),
        )
    }
}

/// Builds a parameterized raw SQL statement using the connection's live backend.
///
/// Parameters are passed as typed `sea_orm::Value`s so callers can bind text for
/// string comparisons and integers for `LIMIT`/`OFFSET` — a plain string bind for
/// `LIMIT` breaks on PostgreSQL ("argument of LIMIT must be type bigint").
fn build_statement(db: &DatabaseConnection, sql: &str, params: &[sea_orm::Value]) -> Statement {
    let backend = db.get_database_backend();

    match backend {
        DatabaseBackend::Postgres => {
            // The source sql already uses Postgres-style `$N` placeholders, so no rewrite needed.
            Statement::from_sql_and_values(DatabaseBackend::Postgres, sql, params.to_vec())
        }
        DatabaseBackend::Sqlite => {
            // The source sql uses Postgres-style `$N`. Rewrite to `?` for SQLite.
            let rewritten = rewrite_pg_placeholders_to_sqlite(sql);
            Statement::from_sql_and_values(DatabaseBackend::Sqlite, rewritten, params.to_vec())
        }
        // The only other `SeaORM` backend is `MySql`, which the project doesn't use (see Cargo.toml:
        // only `sqlx-postgres` and `sqlx-sqlite` features are enabled). Pass the SQL through and
        // let the driver figure it out; if a MySql deployment is ever added, the placeholder
        // rewriting should be revisited here.
        DatabaseBackend::MySql => Statement::from_sql_and_values(backend, sql, params.to_vec()),
    }
}

/// Builds a `text` bind value for parameterized SQL.
fn text_value(value: &str) -> sea_orm::Value {
    sea_orm::Value::String(Some(Box::new(value.to_string())))
}

/// Replaces Postgres-style `$1`, `$2`, ... placeholders with SQLite-style `?` in order.
fn rewrite_pg_placeholders_to_sqlite(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut rest = sql;
    while let Some(pos) = rest.find('$') {
        out.push_str(&rest[..pos]);
        rest = &rest[pos + 1..];
        // Consume the digits after `$`.
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() {
            out.push('$');
        } else {
            out.push('?');
            rest = &rest[digits.len()..];
        }
    }
    out.push_str(rest);
    out
}

/// Internal row shape produced by the balance aggregation SQL.
#[derive(FromQueryResult)]
struct PlayerBalanceRow {
    display_name: String,
    total_deposited: Decimal,
    total_withdrawn: Decimal,
    net: Decimal,
    entry_count: i64,
    first_seen: DateTime<FixedOffset>,
    last_seen: DateTime<FixedOffset>,
}

impl From<PlayerBalanceRow> for PlayerBalance {
    fn from(r: PlayerBalanceRow) -> Self {
        Self {
            player_name: r.display_name,
            total_deposited: r.total_deposited,
            total_withdrawn: r.total_withdrawn,
            net: r.net,
            entry_count: u64::try_from(r.entry_count).expect("COUNT(*) is non-negative"),
            first_seen: r.first_seen.to_rfc3339(),
            last_seen: r.last_seen.to_rfc3339(),
        }
    }
}

/// Internal row shape produced by the batch listing SQL.
#[derive(FromQueryResult)]
struct BatchRow {
    batch_id: String,
    ingested_at: DateTime<FixedOffset>,
    row_count: i64,
}

impl From<BatchRow> for BatchSummary {
    fn from(r: BatchRow) -> Self {
        Self {
            batch_id: r.batch_id,
            ingested_at: r.ingested_at.to_rfc3339(),
            row_count: u64::try_from(r.row_count).expect("COUNT(*) is non-negative"),
        }
    }
}

// `Iterable` is needed for `Column` to be usable in `order_by` chains above; ensure it stays in
// scope even if future clippy passes consider it unused.
#[allow(unused_imports)]
use sea_orm::QuerySelect;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use chrono::TimeZone;
    use sea_orm::Database;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("Failed to connect to test database");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("Failed to run database migrations");
        db
    }

    fn ts(minute: u32) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339(&format!("2026-08-10T20:{minute:02}:41Z"))
            .expect("hard-coded timestamp")
    }

    async fn insert_entry(
        db: &DatabaseConnection,
        occurred_at: DateTime<FixedOffset>,
        player_name: &str,
        reason: &str,
        amount: &str,
        batch: Option<&str>,
    ) {
        let active = ActiveModel {
            occurred_at: Set(occurred_at),
            player_name: Set(player_name.to_string()),
            reason: Set(reason.to_string()),
            amount: Set(amount.parse::<Decimal>().expect("amount")),
            source: Set(SOURCE_ALBION_EXPORT.to_string()),
            ingest_batch: Set(batch.map(str::to_string)),
            ..Default::default()
        };
        active
            .insert(db)
            .await
            .expect("Failed to insert siphoned entry");
    }

    fn ingest_row(occurred_at: &str, player_name: &str, reason: &str, amount: &str) -> IngestRow {
        IngestRow {
            occurred_at: DateTime::parse_from_rfc3339(occurred_at).expect("occurred_at"),
            player_name: player_name.to_string(),
            reason: reason.to_string(),
            amount: amount.parse::<Decimal>().expect("amount"),
        }
    }

    fn default_pagination() -> PaginationParams {
        PaginationParams {
            page: None,
            limit: None,
        }
    }

    #[tokio::test]
    async fn ingest_writes_new_rows_with_a_shared_batch_id() {
        let db = seed_db().await;
        let service = SiphonedService::new();
        let res = service
            .ingest(
                &db,
                &IngestRequest {
                    rows: vec![
                        ingest_row("2026-08-10T20:37:41Z", "Galvdon", "Withdrawal", "-10"),
                        ingest_row("2026-08-09T16:01:37Z", "Galvdon", "Deposit", "774"),
                    ],
                },
            )
            .await
            .expect("ingest");

        assert_eq!(res.ingested_count, 2);
        assert!(!res.batch_id.is_empty());

        let entries = service
            .list_entries(&db, &default_pagination(), &EntryFilters::default())
            .await
            .expect("list");
        assert_eq!(entries.items.len(), 2);
        assert!(
            entries
                .items
                .iter()
                .all(|e| e.ingest_batch == Some(res.batch_id.clone()))
        );
    }

    #[tokio::test]
    async fn ingest_skips_rows_already_imported_by_an_overlapping_export() {
        let db = seed_db().await;
        let service = SiphonedService::new();
        let first_export = IngestRequest {
            rows: vec![
                ingest_row("2026-08-11T10:47:58Z", "MrMaranza06", "Withdrawal", "-10"),
                ingest_row("2026-08-10T20:37:41Z", "Galvdon", "Withdrawal", "-10"),
                ingest_row("2026-08-10T19:05:37Z", "Volantibus", "Withdrawal", "-10"),
            ],
        };
        service
            .ingest(&db, &first_export)
            .await
            .expect("first ingest");

        let second_export = IngestRequest {
            rows: vec![
                ingest_row("2026-08-11T17:48:52Z", "Galvdon", "Deposit", "28"),
                ingest_row("2026-08-11T10:47:58Z", "MrMaranza06", "Withdrawal", "-10"),
                ingest_row("2026-08-10T20:37:41Z", "Galvdon", "Withdrawal", "-10"),
                ingest_row("2026-08-10T19:05:37Z", "Volantibus", "Withdrawal", "-10"),
            ],
        };
        let res = service
            .ingest(&db, &second_export)
            .await
            .expect("second ingest");

        assert_eq!(res.ingested_count, 1);

        let entries = service
            .list_entries(&db, &default_pagination(), &EntryFilters::default())
            .await
            .expect("list");
        assert_eq!(entries.items.len(), 4);
    }

    #[tokio::test]
    async fn ingest_rejects_empty_payload() {
        let db = seed_db().await;
        let service = SiphonedService::new();
        let res = service.ingest(&db, &IngestRequest { rows: vec![] }).await;
        assert!(matches!(res, Err(AppError::Validation(_))));
    }

    #[tokio::test]
    async fn ingest_rejects_zero_amount() {
        let db = seed_db().await;
        let service = SiphonedService::new();
        let res = service
            .ingest(
                &db,
                &IngestRequest {
                    rows: vec![ingest_row(
                        "2026-08-10T20:37:41Z",
                        "Galvdon",
                        "Withdrawal",
                        "0",
                    )],
                },
            )
            .await;
        assert!(matches!(res, Err(AppError::Validation(_))));
    }

    #[tokio::test]
    async fn ingest_rejects_whitespace_player_name() {
        let db = seed_db().await;
        let service = SiphonedService::new();
        let mut row = ingest_row("2026-08-10T20:37:41Z", "Galvdon", "Withdrawal", "-10");
        row.player_name = "   ".to_string();
        let res = service
            .ingest(&db, &IngestRequest { rows: vec![row] })
            .await;
        assert!(matches!(res, Err(AppError::Validation(_))));
    }

    #[tokio::test]
    async fn list_balances_aggregates_unique_entries_per_player_case_insensitively() {
        let db = seed_db().await;
        let service = SiphonedService::new();
        // Two ledger movements and one withdrawal, with mixed casing on the name. The duplicated
        // withdrawal mirrors overlapping Albion exports already stored before dedupe existed.
        insert_entry(&db, ts(5), "MrMaranza06", "Deposit", "13", None).await;
        insert_entry(&db, ts(4), "mrmaranza06", "Withdrawal", "-10", None).await;
        insert_entry(
            &db,
            ts(4),
            "MRMARANZA06",
            "Withdrawal",
            "-10",
            Some("duplicate"),
        )
        .await;
        insert_entry(&db, ts(3), "GALVDON", "Withdrawal", "-10", None).await;

        let balances = service
            .list_balances(&db, None, BalanceSort::NetAsc, None)
            .await
            .expect("list_balances");

        // Two distinct players.
        assert_eq!(balances.len(), 2);

        let mr = balances
            .iter()
            .find(|b| b.player_name.to_lowercase() == "mrmaranza06")
            .expect("MrMaranza06");
        assert_eq!(
            mr.total_deposited,
            "3".parse::<Decimal>().expect("decimal literal")
        );
        assert_eq!(mr.total_withdrawn, Decimal::ZERO);
        assert_eq!(mr.net, "3".parse::<Decimal>().expect("decimal literal"));
        assert_eq!(mr.entry_count, 2);
    }

    #[tokio::test]
    async fn list_balances_does_not_double_count_redeposited_energy() {
        let db = seed_db().await;
        let service = SiphonedService::new();
        insert_entry(&db, ts(1), "CyclePlayer", "Deposit", "600", None).await;
        insert_entry(&db, ts(2), "CyclePlayer", "Withdrawal", "-600", None).await;
        insert_entry(&db, ts(3), "CyclePlayer", "Deposit", "600", None).await;

        let balances = service
            .list_balances(&db, None, BalanceSort::NameAsc, None)
            .await
            .expect("list_balances");
        let player = balances
            .iter()
            .find(|balance| balance.player_name == "CyclePlayer")
            .expect("CyclePlayer");

        assert_eq!(player.total_deposited, "600".parse::<Decimal>().unwrap());
        assert_eq!(player.total_withdrawn, Decimal::ZERO);
        assert_eq!(player.net, "600".parse::<Decimal>().unwrap());
    }

    #[tokio::test]
    async fn list_balances_min_debt_filter_excludes_creditors() {
        let db = seed_db().await;
        let service = SiphonedService::new();
        insert_entry(&db, ts(1), "Creditor", "Deposit", "100", None).await;
        insert_entry(&db, ts(2), "Debtor", "Withdrawal", "-50", None).await;

        let debtors = service
            .list_balances(&db, Some(Decimal::ZERO), BalanceSort::NetAsc, None)
            .await
            .expect("list_balances");

        assert_eq!(debtors.len(), 1);
        assert_eq!(debtors[0].player_name, "Debtor");
    }

    #[tokio::test]
    async fn get_balance_returns_recent_entries_and_aggregate() {
        let db = seed_db().await;
        let service = SiphonedService::new();
        for minute in [1, 2, 3, 4, 5] {
            insert_entry(&db, ts(minute), "Volantibus", "Withdrawal", "-10", None).await;
        }
        insert_entry(
            &db,
            ts(5),
            "VOLANTIBUS",
            "Withdrawal",
            "-10",
            Some("duplicate"),
        )
        .await;

        let detail = service
            .get_balance(&db, "volantibus", 3)
            .await
            .expect("get_balance");

        assert_eq!(detail.balance.entry_count, 5);
        assert_eq!(
            detail.balance.total_withdrawn,
            "50".parse::<Decimal>().expect("decimal literal")
        );
        assert_eq!(detail.recent_entries.len(), 3);
    }

    #[tokio::test]
    async fn get_balance_returns_not_found_for_unknown_player() {
        let db = seed_db().await;
        let service = SiphonedService::new();
        let res = service
            .get_balance(&db, "nobody", DEFAULT_RECENT_ENTRIES)
            .await;
        assert!(matches!(res, Err(AppError::NotFound(_))));
    }

    #[tokio::test]
    async fn delete_batch_removes_only_matching_rows() {
        let db = seed_db().await;
        let service = SiphonedService::new();
        insert_entry(&db, ts(1), "Galvdon", "Deposit", "10", Some("batch-a")).await;
        insert_entry(&db, ts(2), "Galvdon", "Deposit", "20", Some("batch-b")).await;

        let deleted = service.delete_batch(&db, "batch-a").await.expect("delete");
        assert_eq!(deleted.deleted_count, 1);

        let remaining = service
            .list_entries(&db, &default_pagination(), &EntryFilters::default())
            .await
            .expect("list");
        assert_eq!(remaining.items.len(), 1);
        assert_eq!(remaining.items[0].ingest_batch.as_deref(), Some("batch-b"));
    }

    #[tokio::test]
    async fn delete_batch_returns_not_found_for_unknown_id() {
        let db = seed_db().await;
        let service = SiphonedService::new();
        let res = service.delete_batch(&db, "nope").await;
        assert!(matches!(res, Err(AppError::NotFound(_))));
    }

    #[tokio::test]
    async fn list_entries_search_matches_player_or_reason_and_sorts() {
        let db = seed_db().await;
        let service = SiphonedService::new();
        insert_entry(&db, ts(1), "Galvdon", "Withdrawal", "-10", None).await;
        insert_entry(&db, ts(2), "Volantibus", "Deposit", "20", None).await;
        insert_entry(&db, ts(3), "MrMaranza06", "Withdrawal", "-5", None).await;

        let by_name = service
            .list_entries(
                &db,
                &default_pagination(),
                &EntryFilters {
                    search: Some("galv".into()),
                    ..EntryFilters::default()
                },
            )
            .await
            .expect("search player");
        assert_eq!(by_name.items.len(), 1);
        assert_eq!(by_name.items[0].player_name, "Galvdon");

        let by_reason = service
            .list_entries(
                &db,
                &default_pagination(),
                &EntryFilters {
                    search: Some("deposit".into()),
                    ..EntryFilters::default()
                },
            )
            .await
            .expect("search reason");
        assert_eq!(by_reason.items.len(), 1);
        assert_eq!(by_reason.items[0].player_name, "Volantibus");

        let sorted = service
            .list_entries(
                &db,
                &default_pagination(),
                &EntryFilters {
                    sort: Some("player_name".into()),
                    order: Some("asc".into()),
                    ..EntryFilters::default()
                },
            )
            .await
            .expect("sort");
        let names: Vec<_> = sorted
            .items
            .iter()
            .map(|entry| entry.player_name.as_str())
            .collect();
        assert_eq!(names, vec!["Galvdon", "MrMaranza06", "Volantibus"]);
    }

    #[tokio::test]
    async fn list_entries_rejects_unknown_sort_column() {
        let db = seed_db().await;
        let error = SiphonedService::new()
            .list_entries(
                &db,
                &default_pagination(),
                &EntryFilters {
                    sort: Some("fame".into()),
                    ..EntryFilters::default()
                },
            )
            .await
            .unwrap_err();
        match error {
            AppError::Validation(message) => assert!(message.contains("fame")),
            other => panic!("expected validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn list_balances_search_filters_player_name() {
        let db = seed_db().await;
        let service = SiphonedService::new();
        insert_entry(&db, ts(1), "Galvdon", "Deposit", "10", None).await;
        insert_entry(&db, ts(2), "Volantibus", "Withdrawal", "-10", None).await;

        let matches = service
            .list_balances(&db, None, BalanceSort::NameAsc, Some("galv"))
            .await
            .expect("search");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].player_name, "Galvdon");
    }

    #[tokio::test]
    async fn list_batches_groups_by_batch_id() {
        let db = seed_db().await;
        let service = SiphonedService::new();
        insert_entry(&db, ts(1), "A", "Deposit", "1", Some("b1")).await;
        insert_entry(&db, ts(2), "B", "Deposit", "1", Some("b1")).await;
        insert_entry(&db, ts(3), "C", "Deposit", "1", Some("b2")).await;

        let batches = service.list_batches(&db).await.expect("list_batches");
        assert_eq!(batches.len(), 2);

        let b1 = batches.iter().find(|b| b.batch_id == "b1").expect("b1");
        assert_eq!(b1.row_count, 2);
    }

    // Suppress unused helper warning in tests where `Utc` is not directly referenced.
    #[test]
    fn _ensure_utc_import_stays_used() {
        let _ = Utc
            .timestamp_opt(0, 0)
            .single()
            .expect("Unix epoch timestamp should be valid");
    }
}
