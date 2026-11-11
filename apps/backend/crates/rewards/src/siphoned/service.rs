//! Siphoned service logic module.
//!
//! Provides the Guild Siphoned Energy ledger: bulk ingest of the Albion export, raw entry listing,
//! per-player balance aggregation, and batch management. Request/response types live in
//! `models.rs`; the source enum lives in `status.rs`.

use std::collections::HashSet;

use chrono::{DateTime, FixedOffset, Utc};
use sea_orm::prelude::Decimal;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait, DatabaseBackend,
    DatabaseConnection, EntityTrait, FromQueryResult, IntoActiveModel, PaginatorTrait, QueryFilter,
    QueryOrder, Statement, TransactionTrait,
};
use uuid::Uuid;

use backend_core::errors::AppError;
use backend_core::pagination::{PaginatedData, PaginationParams, SortOrder, resolve_sort_key};

use super::models::{
    BalanceSort, BatchSummary, DeletedCount, EntryFilters, EntryMutationRequest, EntryView,
    IngestRequest, IngestResponse, IngestRow, PlayerBalance, PlayerBalanceDetail,
    SettlementQuoteView, SettlementResult,
};
use backend_entities::siphoned::{
    ActiveModel, Column, Entity as SiphonedEntryEntity, Model as SiphonedEntryModel,
};
use backend_entities::siphoned_quote::{
    ActiveModel as QuoteActiveModel, Column as QuoteColumn, Entity as QuoteEntity,
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

    /// Creates a persisted quote using the same market valuation rule as the previous UI flow:
    /// sell-price minimum, then buy-price maximum, then the agreed 11,000 silver fallback.
    pub async fn quote_settlement(
        &self,
        db: &DatabaseConnection,
        market: &backend_albion_data::albiondata::service::AlbionDataService,
        player_name: &str,
        actor_user_id: i64,
    ) -> Result<SettlementQuoteView, AppError> {
        let player_name = player_name.trim();
        if player_name.is_empty() || player_name.len() > 64 {
            return Err(AppError::Validation(
                "player_name must be 1..=64 characters".into(),
            ));
        }

        let net = siphoned_net(db, player_name).await?;
        if net >= Decimal::ZERO {
            return Err(AppError::Conflict(
                "player has no siphoned debt to settle".into(),
            ));
        }
        let debt = -net;

        let links = backend_entities::albion::albion_link::Entity::find()
            .filter(
                Expr::expr(sea_orm::sea_query::Func::lower(Expr::col(
                    backend_entities::albion::albion_link::Column::AlbionPlayerName,
                )))
                .eq(player_name.to_lowercase()),
            )
            .all(db)
            .await?;
        if links.len() != 1 {
            return Err(AppError::Conflict(format!(
                "expected exactly one linked guild account for '{player_name}'"
            )));
        }
        let linked_discord_ids = links
            .iter()
            .map(|link| link.discord_id.clone())
            .collect::<Vec<_>>();
        let users = backend_entities::users::Entity::find()
            .filter(backend_entities::users::Column::DiscordId.is_in(linked_discord_ids))
            .all(db)
            .await?;
        if users.len() != 1 {
            return Err(AppError::NotFound(format!(
                "no linked guild account for '{player_name}'"
            )));
        }
        let user = users
            .into_iter()
            .next()
            .expect("exactly one linked account");

        let prices = market.prices(None, "SIPHONED_ENERGY", None, None).await?;
        let unit_price = siphoned_unit_price(&prices);
        let total = debt * unit_price;
        let now = Utc::now();
        let expires_at = now + chrono::Duration::minutes(2);
        let quote_id = Uuid::new_v4().to_string();
        QuoteActiveModel {
            id: Set(quote_id.clone()),
            player_name: Set(player_name.to_string()),
            user_id: Set(user.id),
            actor_user_id: Set(actor_user_id),
            debt: Set(debt),
            unit_price: Set(unit_price),
            total: Set(total),
            expires_at: Set(expires_at.into()),
            created_at: Set(now.into()),
            consumed_at: Set(None),
            siphoned_entry_id: Set(None),
            transaction_id: Set(None),
        }
        .insert(db)
        .await?;

        Ok(SettlementQuoteView {
            quote_id,
            player_name: player_name.to_string(),
            debt,
            unit_price,
            total,
            expires_at: expires_at.to_rfc3339(),
        })
    }

    /// Confirms a server-issued quote. The quote claim, both ledger writes, the audit record, and
    /// the stored idempotent result commit together; failed validation rolls the entire operation
    /// back and the same quote can safely be retried.
    pub async fn confirm_settlement(
        &self,
        db: &DatabaseConnection,
        quote_id: &str,
        actor_user_id: i64,
    ) -> Result<SettlementResult, AppError> {
        let txn = db.begin().await?;
        let quote = QuoteEntity::find_by_id(quote_id)
            .one(&txn)
            .await?
            .ok_or_else(|| AppError::NotFound("settlement quote not found".into()))?;
        if quote.actor_user_id != actor_user_id {
            return Err(AppError::Forbidden(
                "settlement quote belongs to another officer".into(),
            ));
        }
        if let (Some(siphoned_entry_id), Some(transaction_id)) =
            (quote.siphoned_entry_id, quote.transaction_id)
        {
            txn.commit().await?;
            return Ok(settlement_result(
                &quote,
                siphoned_entry_id,
                transaction_id,
                true,
            ));
        }

        let now: chrono::DateTime<chrono::Utc> = Utc::now();
        if quote.expires_at <= now {
            return Err(AppError::Conflict(
                "settlement quote has expired; request a new quote".into(),
            ));
        }
        let claim = QuoteEntity::update_many()
            .col_expr(QuoteColumn::ConsumedAt, Expr::value(now))
            .filter(QuoteColumn::Id.eq(quote_id))
            .filter(QuoteColumn::ConsumedAt.is_null())
            .filter(QuoteColumn::ExpiresAt.gt(now))
            .exec(&txn)
            .await?;
        if claim.rows_affected == 0 {
            // A concurrent retry may have completed while this request waited on the quote row.
            let latest = QuoteEntity::find_by_id(quote_id)
                .one(&txn)
                .await?
                .ok_or_else(|| AppError::NotFound("settlement quote not found".into()))?;
            if let (Some(entry_id), Some(transaction_id)) =
                (latest.siphoned_entry_id, latest.transaction_id)
            {
                txn.commit().await?;
                return Ok(settlement_result(&latest, entry_id, transaction_id, true));
            }
            return Err(AppError::Conflict(
                "settlement quote is expired or already being confirmed".into(),
            ));
        }

        lock_player_names(&txn, std::slice::from_ref(&quote.player_name)).await?;
        let current_net = siphoned_net(&txn, &quote.player_name).await?;
        if current_net != -quote.debt {
            return Err(AppError::Conflict(
                "siphoned debt changed since this quote was issued".into(),
            ));
        }
        let entry = ActiveModel {
            occurred_at: Set(now.into()),
            player_name: Set(quote.player_name.clone()),
            reason: Set("Siphoned debt settlement".to_string()),
            amount: Set(quote.debt),
            source: Set("manual".to_string()),
            ingest_batch: Set(None),
            ingested_at: Set(now.into()),
            ..Default::default()
        }
        .insert(&txn)
        .await?;

        let bank = backend_entities::bank::ActiveModel {
            from_user_id: Set(None),
            to_user_id: Set(quote.user_id),
            to_guild_bank: Set(false),
            amount: Set(quote.total),
            status: Set("donated".to_string()),
            r#type: Set("siphoned_settlement".to_string()),
            split_id: Set(None),
            created_at: Set(now.into()),
            requested_at: Set(None),
            withdrawn_at: Set(None),
            updated_at: Set(now.into()),
            ..Default::default()
        }
        .insert(&txn)
        .await?;

        let audit = backend_entities::audit::ActiveModel {
            action: Set("SIPHONED_SETTLEMENT_CONFIRMED".into()),
            entity_type: Set(Some("SIPHONED_SETTLEMENT".into())),
            entity_id: Set(Some(entry.id)),
            user_id: Set(Some(actor_user_id)),
            details: Set(Some(serde_json::json!({
                "quote_id": quote.id,
                "player_name": quote.player_name,
                "user_id": quote.user_id,
                "debt": quote.debt,
                "unit_price": quote.unit_price,
                "total": quote.total,
                "transaction_id": bank.id,
            }))),
            ..Default::default()
        };
        audit.insert(&txn).await?;

        QuoteEntity::update_many()
            .col_expr(QuoteColumn::SiphonedEntryId, Expr::value(entry.id))
            .col_expr(QuoteColumn::TransactionId, Expr::value(bank.id))
            .filter(QuoteColumn::Id.eq(quote_id))
            .exec(&txn)
            .await?;
        txn.commit().await?;

        Ok(settlement_result(&quote, entry.id, bank.id, false))
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
        lock_player_names(
            &txn,
            &req.rows
                .iter()
                .map(|row| row.player_name.clone())
                .collect::<Vec<_>>(),
        )
        .await?;
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
        let txn = db.begin().await?;
        lock_player_names(&txn, std::slice::from_ref(&req.player_name)).await?;
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
        let model = active.insert(&txn).await?;
        txn.commit().await?;
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
        let txn = db.begin().await?;
        let mut model = SiphonedEntryEntity::find_by_id(entry_id)
            .one(&txn)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("no siphoned entry with id '{entry_id}'")))?;
        loop {
            let observed_name = model.player_name.clone();
            lock_player_names(&txn, &[observed_name.clone(), req.player_name.clone()]).await?;
            model = SiphonedEntryEntity::find_by_id(entry_id)
                .one(&txn)
                .await?
                .ok_or_else(|| {
                    AppError::NotFound(format!("no siphoned entry with id '{entry_id}'"))
                })?;
            if model.player_name == observed_name {
                break;
            }
        }
        ensure_not_settlement_entry(&txn, entry_id, "edited").await?;
        let mut active = model.into_active_model();
        active.occurred_at = Set(req.occurred_at);
        active.player_name = Set(req.player_name.trim().to_string());
        active.reason = Set(req.reason.trim().to_string());
        active.amount = Set(req.amount);
        let updated = active.update(&txn).await?;
        txn.commit().await?;
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
    /// Returns `AppError::NotFound` when the row does not exist, `AppError::Conflict` when the
    /// row is the ledger entry of a confirmed settlement, or `AppError::Database` when the
    /// delete fails.
    pub async fn delete_entry(
        &self,
        db: &DatabaseConnection,
        entry_id: i64,
    ) -> Result<DeletedCount, AppError> {
        let txn = db.begin().await?;
        let mut entry = SiphonedEntryEntity::find_by_id(entry_id).one(&txn).await?;
        while let Some(observed) = entry {
            lock_player_names(&txn, std::slice::from_ref(&observed.player_name)).await?;
            entry = SiphonedEntryEntity::find_by_id(entry_id).one(&txn).await?;
            if entry
                .as_ref()
                .is_some_and(|current| current.player_name == observed.player_name)
            {
                break;
            }
        }
        ensure_not_settlement_entry(&txn, entry_id, "deleted").await?;
        let result = SiphonedEntryEntity::delete_by_id(entry_id)
            .exec(&txn)
            .await?;
        if result.rows_affected == 0 {
            return Err(AppError::NotFound(format!(
                "no siphoned entry with id '{entry_id}'"
            )));
        }
        txn.commit().await?;
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
            r"WHERE LOWER(player_name) LIKE $1"
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
        let txn = db.begin().await?;
        let mut entries = SiphonedEntryEntity::find()
            .filter(Column::IngestBatch.eq(batch_id))
            .all(&txn)
            .await?;
        loop {
            let names = entries
                .iter()
                .map(|entry| entry.player_name.clone())
                .collect::<Vec<_>>();
            lock_player_names(&txn, &names).await?;
            let refreshed = SiphonedEntryEntity::find()
                .filter(Column::IngestBatch.eq(batch_id))
                .all(&txn)
                .await?;
            let locked_names = names
                .iter()
                .map(|name| name.to_lowercase())
                .collect::<HashSet<_>>();
            if refreshed
                .iter()
                .all(|entry| locked_names.contains(&entry.player_name.to_lowercase()))
            {
                break;
            }
            entries = refreshed;
        }
        let result = SiphonedEntryEntity::delete_many()
            .filter(Column::IngestBatch.eq(batch_id))
            .exec(&txn)
            .await?;

        let deleted = result.rows_affected;
        if deleted == 0 {
            return Err(AppError::NotFound(format!("no batch with id '{batch_id}'")));
        }

        txn.commit().await?;
        Ok(DeletedCount {
            deleted_count: deleted,
        })
    }
}

async fn siphoned_net<C: ConnectionTrait>(db: &C, player_name: &str) -> Result<Decimal, AppError> {
    let rows = SiphonedEntryEntity::find()
        .filter(
            Expr::expr(sea_orm::sea_query::Func::lower(Expr::col(
                Column::PlayerName,
            )))
            .eq(player_name.to_lowercase()),
        )
        .all(db)
        .await?;
    let mut seen = HashSet::new();
    Ok(rows
        .into_iter()
        .filter(|row| seen.insert(SiphonedEntryKey::from_model(row)))
        .map(|row| row.amount)
        .sum())
}

async fn lock_player_names<C: ConnectionTrait>(db: &C, names: &[String]) -> Result<(), AppError> {
    if db.get_database_backend() != DatabaseBackend::Postgres {
        return Ok(());
    }
    let mut normalized = names
        .iter()
        .map(|name| name.trim().to_lowercase())
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    for name in normalized {
        db.execute(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':' || $1, 0))",
            [name.into()],
        ))
        .await?;
    }
    Ok(())
}

/// Refuses to change the ledger row that a confirmed settlement created.
///
/// Confirming a settlement writes a balancing ledger entry and, in the same transaction, a bank
/// row for the silver the guild paid out. Deleting or editing that entry would make the player's
/// debt reappear while the payout stays on the books, so the entry is frozen. `action` is the
/// past participle used in the message.
async fn ensure_not_settlement_entry<C: ConnectionTrait>(
    db: &C,
    entry_id: i64,
    action: &str,
) -> Result<(), AppError> {
    let settlements = QuoteEntity::find()
        .filter(QuoteColumn::SiphonedEntryId.eq(entry_id))
        .count(db)
        .await?;
    if settlements > 0 {
        return Err(AppError::Conflict(format!(
            "siphoned entry {entry_id} records a confirmed settlement and cannot be {action}"
        )));
    }
    Ok(())
}

fn settlement_result(
    quote: &backend_entities::siphoned_quote::Model,
    siphoned_entry_id: i64,
    transaction_id: i64,
    replayed: bool,
) -> SettlementResult {
    SettlementResult {
        quote_id: quote.id.clone(),
        siphoned_entry_id,
        transaction_id,
        player_name: quote.player_name.clone(),
        debt: quote.debt,
        unit_price: quote.unit_price,
        total: quote.total,
        replayed,
    }
}

fn siphoned_unit_price(
    prices: &[backend_albion_data::albiondata::client::AlbionDataMarketPrice],
) -> Decimal {
    Decimal::from(
        prices
            .iter()
            .find(|price| price.sell_price_min > 0)
            .map(|price| price.sell_price_min)
            .or_else(|| {
                prices
                    .iter()
                    .find(|price| price.buy_price_max > 0)
                    .map(|price| price.buy_price_max)
            })
            .unwrap_or(11_000),
    )
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
    source: String,
}

impl SiphonedEntryKey {
    /// Creates a comparable identity from a pending import row.
    fn from_row(row: &IngestRow) -> Self {
        Self {
            occurred_at: row.occurred_at,
            player_name_lower: row.player_name.trim().to_lowercase(),
            reason: row.reason.trim().to_string(),
            amount: row.amount,
            source: SOURCE_ALBION_EXPORT.to_string(),
        }
    }

    /// Creates a comparable identity from an already persisted row.
    fn from_model(model: &SiphonedEntryModel) -> Self {
        Self {
            occurred_at: model.occurred_at,
            player_name_lower: model.player_name.trim().to_lowercase(),
            reason: model.reason.trim().to_string(),
            amount: model.amount,
            source: model.source.clone(),
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
    use chrono::TimeZone;

    async fn seed_db() -> DatabaseConnection {
        backend_migration::testkit::migrated_sqlite().await
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

    async fn insert_settlement_user(db: &DatabaseConnection) -> i64 {
        let user = backend_entities::users::ActiveModel {
            username: Set("settlement-user".into()),
            email: Set("settlement@example.test".into()),
            role: Set("User".into()),
            discord_id: Set(Some("discord-123".into())),
            created_at: Set(Utc::now().into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert settlement user");
        user.id
    }

    async fn insert_settlement_quote(
        db: &DatabaseConnection,
        quote_id: &str,
        user_id: i64,
        expires_at: chrono::DateTime<chrono::Utc>,
    ) {
        QuoteActiveModel {
            id: Set(quote_id.into()),
            player_name: Set("Galvdon".into()),
            user_id: Set(user_id),
            actor_user_id: Set(900),
            debt: Set(Decimal::from(10)),
            unit_price: Set(Decimal::from(11_000)),
            total: Set(Decimal::from(110_000)),
            expires_at: Set(expires_at.into()),
            created_at: Set(Utc::now().into()),
            consumed_at: Set(None),
            siphoned_entry_id: Set(None),
            transaction_id: Set(None),
        }
        .insert(db)
        .await
        .expect("insert settlement quote");
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

    fn market_price(
        sell_price_min: i64,
        buy_price_max: i64,
    ) -> backend_albion_data::albiondata::client::AlbionDataMarketPrice {
        backend_albion_data::albiondata::client::AlbionDataMarketPrice {
            item_id: "SIPHONED_ENERGY".into(),
            city: "Bridgewatch".into(),
            quality: 1,
            sell_price_min,
            sell_price_min_date: None,
            sell_price_max: 0,
            sell_price_max_date: None,
            buy_price_min: 0,
            buy_price_min_date: None,
            buy_price_max,
            buy_price_max_date: None,
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

    #[tokio::test]
    async fn settlement_confirmation_is_atomic_and_idempotent() {
        let db = seed_db().await;
        let user_id = insert_settlement_user(&db).await;
        insert_entry(&db, ts(1), "Galvdon", "Withdrawal", "-10", None).await;
        insert_settlement_quote(
            &db,
            "quote-settlement-ok",
            user_id,
            Utc::now() + chrono::Duration::minutes(1),
        )
        .await;

        let service = SiphonedService::new();
        let first = service
            .confirm_settlement(&db, "quote-settlement-ok", 900)
            .await
            .expect("confirm");
        assert!(!first.replayed);
        assert_eq!(first.total, Decimal::from(110_000));
        let replay = service
            .confirm_settlement(&db, "quote-settlement-ok", 900)
            .await
            .expect("retry");
        assert!(replay.replayed);
        assert_eq!(replay.siphoned_entry_id, first.siphoned_entry_id);
        assert_eq!(replay.transaction_id, first.transaction_id);

        let entry_count = SiphonedEntryEntity::find()
            .count(&db)
            .await
            .expect("entry count");
        let bank_count = backend_entities::bank::Entity::find()
            .count(&db)
            .await
            .expect("bank count");
        let audit_count = backend_entities::audit::Entity::find()
            .count(&db)
            .await
            .expect("audit count");
        assert_eq!(entry_count, 2);
        assert_eq!(bank_count, 1);
        assert_eq!(audit_count, 1);
        assert_eq!(
            siphoned_net(&db, "GALVDON").await.expect("net"),
            Decimal::ZERO
        );
    }

    #[tokio::test]
    async fn a_confirmed_settlement_entry_cannot_be_edited_or_deleted() {
        let db = seed_db().await;
        let user_id = insert_settlement_user(&db).await;
        insert_entry(&db, ts(1), "Galvdon", "Withdrawal", "-10", None).await;
        insert_settlement_quote(
            &db,
            "quote-frozen",
            user_id,
            Utc::now() + chrono::Duration::minutes(1),
        )
        .await;
        let service = SiphonedService::new();
        let settled = service
            .confirm_settlement(&db, "quote-frozen", 900)
            .await
            .expect("confirm");
        let entry_id = settled.siphoned_entry_id;

        let delete_error = service
            .delete_entry(&db, entry_id)
            .await
            .err()
            .expect("settlement entry must not be deletable");
        assert!(
            matches!(delete_error, AppError::Conflict(_)),
            "{delete_error:?}"
        );

        let edit_error = service
            .update_entry(
                &db,
                entry_id,
                &EntryMutationRequest {
                    occurred_at: DateTime::parse_from_rfc3339("2026-08-10T20:37:41Z").unwrap(),
                    player_name: "Galvdon".to_string(),
                    reason: "Siphoned debt settlement".to_string(),
                    amount: Decimal::from(5),
                },
            )
            .await
            .err()
            .expect("settlement entry must not be editable");
        assert!(
            matches!(edit_error, AppError::Conflict(_)),
            "{edit_error:?}"
        );

        // Nothing changed: the debt is still settled and the entry is still there.
        assert_eq!(
            siphoned_net(&db, "GALVDON").await.expect("net"),
            Decimal::ZERO
        );
        assert!(
            SiphonedEntryEntity::find_by_id(entry_id)
                .one(&db)
                .await
                .expect("lookup")
                .is_some()
        );
    }

    #[tokio::test]
    async fn ordinary_ledger_entries_stay_deletable() {
        let db = seed_db().await;
        insert_entry(&db, ts(1), "Galvdon", "Withdrawal", "-10", None).await;
        let entry = SiphonedEntryEntity::find()
            .one(&db)
            .await
            .expect("lookup")
            .expect("entry");

        SiphonedService::new()
            .delete_entry(&db, entry.id)
            .await
            .expect("an entry no settlement points at can still be deleted");
        assert_eq!(SiphonedEntryEntity::find().count(&db).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn settlement_confirmation_rejects_expired_or_changed_debt_without_writes() {
        let db = seed_db().await;
        let user_id = insert_settlement_user(&db).await;
        insert_entry(&db, ts(1), "Galvdon", "Withdrawal", "-10", None).await;
        insert_settlement_quote(
            &db,
            "quote-expired",
            user_id,
            Utc::now() - chrono::Duration::seconds(1),
        )
        .await;
        insert_settlement_quote(
            &db,
            "quote-stale",
            user_id,
            Utc::now() + chrono::Duration::minutes(1),
        )
        .await;
        insert_entry(&db, ts(2), "Galvdon", "Withdrawal", "-1", None).await;

        let service = SiphonedService::new();
        assert!(matches!(
            service.confirm_settlement(&db, "quote-expired", 900).await,
            Err(AppError::Conflict(_))
        ));
        assert!(matches!(
            service.confirm_settlement(&db, "quote-stale", 900).await,
            Err(AppError::Conflict(_))
        ));
        assert_eq!(
            backend_entities::bank::Entity::find()
                .count(&db)
                .await
                .expect("bank count"),
            0
        );
        assert_eq!(
            siphoned_net(&db, "Galvdon").await.expect("net"),
            Decimal::from(-11)
        );
    }

    #[test]
    fn settlement_price_uses_sell_then_buy_then_agreed_fallback() {
        assert_eq!(
            siphoned_unit_price(&[market_price(12_000, 15_000)]),
            Decimal::from(12_000)
        );
        assert_eq!(
            siphoned_unit_price(&[market_price(0, 10_500)]),
            Decimal::from(10_500)
        );
        assert_eq!(
            siphoned_unit_price(&[market_price(0, 0)]),
            Decimal::from(11_000)
        );
        assert_eq!(
            siphoned_unit_price(&[market_price(0, 0), market_price(13_000, 1)]),
            Decimal::from(13_000)
        );
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
