//! Albion guild bank log: import, reconciliation links, explanations and the period summary.
//!
//! The Manager stays the source of truth. A log row never changes a balance by itself; the
//! only write into the bank ledger is an officer creating a transaction from a row, at most
//! once per row.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::str::FromStr;

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, Utc};
use sea_orm::prelude::Decimal;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait, DatabaseBackend, DatabaseConnection,
    EntityTrait, QueryFilter, QueryOrder, Set, Statement, TransactionTrait,
};
use uuid::Uuid;

use backend_core::errors::AppError;
use backend_core::pagination::{PaginatedData, PaginationParams, paginate_vec};
use backend_entities::admin::Entity as GuildSettingsEntity;
use backend_entities::auth::role::{Column as RoleColumn, Entity as RoleEntity};
use backend_entities::bank::{
    ActiveModel as TransactionActiveModel, Column as TransactionColumn,
    Entity as TransactionEntity, Model as TransactionModel,
};
use backend_entities::bank_log::entry::{
    ActiveModel as EntryActiveModel, Column as EntryColumn, Entity as EntryEntity,
    Model as EntryModel,
};
use backend_entities::bank_log::link::{
    ActiveModel as LinkActiveModel, Column as LinkColumn, Entity as LinkEntity,
    Model as LinkModel,
};
use backend_entities::bank_log::link_entry::{
    ActiveModel as LinkEntryActiveModel, Column as LinkEntryColumn, Entity as LinkEntryEntity,
};
use backend_entities::bank_log::link_target::{
    ActiveModel as LinkTargetActiveModel, Column as LinkTargetColumn, Entity as LinkTargetEntity,
    Model as LinkTargetModel,
};
use backend_entities::splits::split::{
    Column as SplitColumn, Entity as SplitEntity, Model as SplitModel,
};
use backend_entities::status::bank::TransactionStatus;
use backend_entities::users::{Column as UserColumn, Entity as UserEntity};
use backend_identity::audit::service::AuditService;

use super::matcher::{
    self, CATEGORIES, CATEGORY_BAGS, CATEGORY_GUILD_EXPENSE, CATEGORY_LOOT_SALE, CATEGORY_PAYOUT,
    KIND_BAGS, KIND_LOOT_SALE, KIND_MANUAL, KIND_PAYOUT, Paid, Proposal, Row, SplitCandidate,
};
use super::models::{
    BankLogBatchView, BankLogBestSuggestionView, BankLogBestSuggestions, BankLogCandidateQuery,
    BankLogCandidateView, BankLogCategoryTotals, BankLogConfirmSuggestionsResult,
    BankLogCreateEntryTransactionRequest, BankLogCreateLinkRequest, BankLogEntryBrief,
    BankLogEntryQuery, BankLogEntryView, BankLogImportResult, BankLogImportRow,
    BankLogImportStatus, BankLogLinkTargetView, BankLogLinkView, BankLogPeriodQuery,
    BankLogSummary, BankLogUpdateEntryRequest,
};
use super::reminder::{GAME_LOG_DAYS, REMINDER_AFTER_DAYS};
use crate::service::{TYPE_MANUAL, TYPE_SIPHONED_SETTLEMENT};

/// Upper bound of lines in one import. A 4-week export of a busy guild is a few hundred lines.
pub const MAX_ROWS_PER_IMPORT: usize = 5_000;

pub const STATUS_UNMATCHED: &str = "unmatched";
pub const STATUS_SUGGESTED: &str = "suggested";
pub const STATUS_MATCHED: &str = "matched";
pub const STATUS_EXPLAINED: &str = "explained";
const STATUSES: [&str; 4] = [
    STATUS_UNMATCHED,
    STATUS_SUGGESTED,
    STATUS_MATCHED,
    STATUS_EXPLAINED,
];

const MAX_NOTE_CHARS: usize = 2_000;
/// Split statuses whose loot never reached the bank.
const DEAD_SPLIT_STATUSES: [&str; 2] = ["lost", "not_completed"];

/// Row identity without the occurrence number.
type BaseKey = (i64, String, String, Decimal);

/// One parsed export line.
#[derive(Debug, Clone)]
struct ParsedRow {
    at: DateTime<Utc>,
    player: String,
    player_key: String,
    reason: String,
    amount: Decimal,
}

impl ParsedRow {
    fn key(&self) -> BaseKey {
        (
            self.at.timestamp(),
            self.player_key.clone(),
            self.reason.clone(),
            self.amount,
        )
    }
}

fn parse_time(raw: &str) -> Option<DateTime<Utc>> {
    let raw = raw.trim();
    if let Ok(parsed) = DateTime::parse_from_rfc3339(raw) {
        return Some(parsed.with_timezone(&Utc));
    }
    for format in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(raw, format) {
            return Some(naive.and_utc());
        }
    }
    None
}

fn parse_amount(raw: &serde_json::Value) -> Option<Decimal> {
    let text = match raw {
        serde_json::Value::String(text) => text.trim().replace([',', ' ', '_'], ""),
        serde_json::Value::Number(number) => number.to_string(),
        _ => return None,
    };
    Decimal::from_str(&text).ok().map(|amount| amount.round_dp(2))
}

fn parse_rows(rows: &[BankLogImportRow]) -> Result<Vec<ParsedRow>, AppError> {
    if rows.is_empty() {
        return Err(AppError::Validation("the export has no rows".to_string()));
    }
    if rows.len() > MAX_ROWS_PER_IMPORT {
        return Err(AppError::Validation(format!(
            "an import holds at most {MAX_ROWS_PER_IMPORT} rows"
        )));
    }
    rows.iter()
        .enumerate()
        .map(|(index, row)| {
            let line = index + 1;
            let at = parse_time(&row.date).ok_or_else(|| {
                AppError::Validation(format!(
                    "row {line}: date must look like 2026-11-16 23:10:00"
                ))
            })?;
            let player = row.player.trim().to_string();
            if player.is_empty() || player.chars().count() > 64 {
                return Err(AppError::Validation(format!(
                    "row {line}: player must be 1-64 characters"
                )));
            }
            let reason = row.reason.trim().to_string();
            if reason.is_empty() || reason.chars().count() > 255 {
                return Err(AppError::Validation(format!(
                    "row {line}: reason must be 1-255 characters"
                )));
            }
            let amount = parse_amount(&row.amount)
                .filter(|amount| *amount != Decimal::ZERO)
                .ok_or_else(|| {
                    AppError::Validation(format!("row {line}: amount must be a non-zero number"))
                })?;
            Ok(ParsedRow {
                at,
                player_key: player.to_lowercase(),
                player,
                reason,
                amount,
            })
        })
        .collect()
}

/// `YYYY-MM-DD` → start of that UTC day.
fn day_start(raw: &str) -> Result<DateTime<Utc>, AppError> {
    NaiveDate::parse_from_str(raw.trim(), "%Y-%m-%d")
        .map(|day| day.and_hms_opt(0, 0, 0).expect("midnight").and_utc())
        .map_err(|_| AppError::Validation(format!("{raw} is not a YYYY-MM-DD day")))
}

/// Seller account names from the guild setting.
pub fn seller_accounts(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect()
}

/// Serializes imports and link changes per tenant schema (no-op on SQLite).
async fn lock_bank_log<C: ConnectionTrait>(db: &C) -> Result<(), AppError> {
    if db.get_database_backend() != DatabaseBackend::Postgres {
        return Ok(());
    }
    db.execute(Statement::from_string(
        DatabaseBackend::Postgres,
        "SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':bank_log', 0))",
    ))
    .await?;
    Ok(())
}

fn ts(value: &sea_orm::prelude::DateTimeWithTimeZone) -> String {
    value.with_timezone(&Utc).to_rfc3339()
}

fn utc(value: &sea_orm::prelude::DateTimeWithTimeZone) -> DateTime<Utc> {
    value.with_timezone(&Utc)
}

/// Service for the Albion bank log.
#[derive(Debug, Clone, Copy, Default)]
pub struct BankLogService;

impl BankLogService {
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Stores the new lines of an export and refreshes the suggestions.
    ///
    /// Identical lines inside the export are numbered; for each identity only the occurrences
    /// beyond those already stored are inserted, so overlapping weekly exports add nothing twice
    /// while a real second identical movement is kept.
    pub async fn import(
        &self,
        db: &DatabaseConnection,
        rows: &[BankLogImportRow],
        actor: i64,
    ) -> Result<BankLogImportResult, AppError> {
        let parsed = parse_rows(rows)?;
        let settings = GuildSettingsEntity::find_by_id(1).one(db).await?;
        let sellers = settings
            .as_ref()
            .map(|settings| seller_accounts(&settings.bank_log_seller_accounts))
            .unwrap_or_default();

        let txn = db.begin().await?;
        lock_bank_log(&txn).await?;

        let first = parsed.iter().map(|row| row.at).min().expect("non-empty");
        let last = parsed.iter().map(|row| row.at).max().expect("non-empty");
        let mut stored: HashMap<BaseKey, i32> = HashMap::new();
        for entry in EntryEntity::find()
            .filter(EntryColumn::OccurredAt.gte(first))
            .filter(EntryColumn::OccurredAt.lte(last))
            .all(&txn)
            .await?
        {
            let key = (
                utc(&entry.occurred_at).timestamp(),
                entry.player_key.clone(),
                entry.reason.clone(),
                entry.amount,
            );
            let count = stored.entry(key).or_insert(0);
            *count = (*count).max(entry.occurrence);
        }

        let batch_id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let mut seen: HashMap<BaseKey, i32> = HashMap::new();
        let (mut inserted, mut already_stored, mut duplicates_kept) = (0u64, 0u64, 0u64);
        for row in &parsed {
            let key = row.key();
            let occurrence = {
                let count = seen.entry(key.clone()).or_insert(0);
                *count += 1;
                *count
            };
            if occurrence <= stored.get(&key).copied().unwrap_or(0) {
                already_stored += 1;
                continue;
            }
            let category = matcher::initial_category(&row.reason, &row.player, &sellers);
            let expense = category == CATEGORY_GUILD_EXPENSE;
            EntryActiveModel {
                occurred_at: Set(row.at.into()),
                player_name: Set(row.player.clone()),
                player_key: Set(row.player_key.clone()),
                reason: Set(row.reason.clone()),
                amount: Set(row.amount),
                occurrence: Set(occurrence),
                category: Set(category.to_string()),
                // Guild expenses have nothing to link to: they are explained by their reason.
                status: Set(if expense { STATUS_EXPLAINED } else { STATUS_UNMATCHED }.to_string()),
                note: Set(None),
                explained_at: Set(expense.then(|| now.into())),
                explained_by: Set(None),
                batch_id: Set(batch_id.clone()),
                imported_at: Set(now.into()),
                imported_by: Set(Some(actor)),
                created_transaction_id: Set(None),
                ..Default::default()
            }
            .insert(&txn)
            .await
            .map_err(|error| {
                if error.to_string().to_lowercase().contains("unique") {
                    AppError::Conflict(
                        "another import stored the same rows at the same time; retry".to_string(),
                    )
                } else {
                    AppError::from(error)
                }
            })?;
            inserted += 1;
            if occurrence > 1 {
                duplicates_kept += 1;
            }
        }

        let suggestions = refresh_suggestions_in(&txn, None).await?;
        AuditService::record_in(
            &txn,
            "BANK_LOG_IMPORTED",
            Some("BANK_LOG"),
            None,
            Some(actor),
            Some(serde_json::json!({
                "batch_id": batch_id,
                "total": parsed.len(),
                "inserted": inserted,
                "already_stored": already_stored,
                "duplicates_kept": duplicates_kept,
                "first_at": first.to_rfc3339(),
                "last_at": last.to_rfc3339(),
            })),
        )
        .await?;
        txn.commit().await?;
        tracing::info!(
            batch_id,
            total = parsed.len(),
            inserted,
            already_stored,
            duplicates_kept,
            suggestions,
            "bank log imported"
        );
        Ok(BankLogImportResult {
            batch_id: if inserted > 0 { batch_id } else { String::new() },
            total: parsed.len() as u64,
            inserted,
            already_stored,
            duplicates_kept,
            suggestions,
        })
    }

    /// Recomputes every suggestion (confirmed links are kept).
    pub async fn refresh_suggestions(
        &self,
        db: &DatabaseConnection,
        actor: i64,
    ) -> Result<u64, AppError> {
        let txn = db.begin().await?;
        lock_bank_log(&txn).await?;
        let count = refresh_suggestions_in(&txn, None).await?;
        AuditService::record_in(
            &txn,
            "BANK_LOG_SUGGESTIONS_REFRESHED",
            Some("BANK_LOG"),
            None,
            Some(actor),
            Some(serde_json::json!({ "suggestions": count })),
        )
        .await?;
        txn.commit().await?;
        Ok(count)
    }

    /// Rows matching the filters, newest first, with their links.
    pub async fn list_entries(
        &self,
        db: &DatabaseConnection,
        query: &BankLogEntryQuery,
    ) -> Result<PaginatedData<BankLogEntryView>, AppError> {
        let mut select = EntryEntity::find();
        if let Some(from) = query.from.as_deref().filter(|v| !v.trim().is_empty()) {
            select = select.filter(EntryColumn::OccurredAt.gte(day_start(from)?));
        }
        if let Some(to) = query.to.as_deref().filter(|v| !v.trim().is_empty()) {
            select = select.filter(EntryColumn::OccurredAt.lt(day_start(to)? + Duration::days(1)));
        }
        if let Some(status) = query.status.as_deref().filter(|v| !v.trim().is_empty()) {
            if !STATUSES.contains(&status) {
                return Err(AppError::Validation(format!("unknown status {status}")));
            }
            select = select.filter(EntryColumn::Status.eq(status));
        }
        if let Some(category) = query.category.as_deref().filter(|v| !v.trim().is_empty()) {
            if !CATEGORIES.contains(&category) {
                return Err(AppError::Validation(format!("unknown category {category}")));
            }
            select = select.filter(EntryColumn::Category.eq(category));
        }
        if let Some(search) = query.search.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            let pattern = format!("%{}%", search.to_lowercase());
            select = select.filter(
                Condition::any()
                    .add(EntryColumn::PlayerKey.like(pattern.clone()))
                    .add(Expr::expr(Func::lower(Expr::col(EntryColumn::Reason))).like(pattern)),
            );
        }
        let entries = select
            .order_by_desc(EntryColumn::OccurredAt)
            .order_by_desc(EntryColumn::Id)
            .all(db)
            .await?;
        let page = paginate_vec(
            entries,
            &PaginationParams {
                page: query.page,
                limit: query.limit.or(Some(50)),
            },
        );
        let items = entry_views(db, page.items).await?;
        Ok(PaginatedData {
            items,
            total_items: page.total_items,
            total_pages: page.total_pages,
            current_page: page.current_page,
            limit: page.limit,
        })
    }

    /// One row with its links.
    pub async fn get_entry(&self, db: &DatabaseConnection, id: i64) -> Result<BankLogEntryView, AppError> {
        let entry = find_entry(db, id).await?;
        entry_views(db, vec![entry])
            .await?
            .pop()
            .ok_or_else(|| AppError::Internal("entry view missing".to_string()))
    }

    /// Changes the category, the note, or the explained flag of a row.
    pub async fn update_entry(
        &self,
        db: &DatabaseConnection,
        id: i64,
        req: &BankLogUpdateEntryRequest,
        actor: i64,
    ) -> Result<BankLogEntryView, AppError> {
        let txn = db.begin().await?;
        lock_bank_log(&txn).await?;
        let entry = find_entry(&txn, id).await?;
        let mut note = entry.note.clone();
        let mut explained_at = entry.explained_at;
        let mut explained_by = entry.explained_by;
        let mut active: EntryActiveModel = entry.clone().into();
        if let Some(category) = req.category.as_deref() {
            if !CATEGORIES.contains(&category) {
                return Err(AppError::Validation(format!("unknown category {category}")));
            }
            active.category = Set(category.to_string());
        }
        if let Some(raw) = req.note.as_deref() {
            let trimmed = raw.trim();
            if trimmed.chars().count() > MAX_NOTE_CHARS {
                return Err(AppError::Validation(format!(
                    "the note is longer than {MAX_NOTE_CHARS} characters"
                )));
            }
            note = (!trimmed.is_empty()).then(|| trimmed.to_string());
        }
        match req.explained {
            Some(true) => {
                if note.is_none() {
                    return Err(AppError::Validation(
                        "explaining a row needs a note".to_string(),
                    ));
                }
                explained_at = Some(Utc::now().into());
                explained_by = Some(actor);
            }
            Some(false) => {
                explained_at = None;
                explained_by = None;
            }
            None => {
                // An officer-written explanation without a note is not an explanation.
                if note.is_none() && explained_by.is_some() {
                    explained_at = None;
                    explained_by = None;
                }
            }
        }
        active.note = Set(note.clone());
        active.explained_at = Set(explained_at);
        active.explained_by = Set(explained_by);
        active.update(&txn).await?;
        recompute_statuses(&txn).await?;
        AuditService::record_in(
            &txn,
            "BANK_LOG_ENTRY_UPDATED",
            Some("BANK_LOG_ENTRY"),
            Some(id),
            Some(actor),
            Some(serde_json::json!({
                "category": req.category,
                "note": note,
                "explained": req.explained,
                "previous_category": entry.category,
                "previous_note": entry.note,
            })),
        )
        .await?;
        txn.commit().await?;
        self.get_entry(db, id).await
    }

    /// Links rows to Manager records by hand (confirmed at once).
    pub async fn create_link(
        &self,
        db: &DatabaseConnection,
        req: &BankLogCreateLinkRequest,
        actor: i64,
    ) -> Result<BankLogLinkView, AppError> {
        let kind = req.kind.as_deref().unwrap_or(KIND_MANUAL);
        if ![KIND_PAYOUT, KIND_BAGS, KIND_LOOT_SALE, KIND_MANUAL].contains(&kind) {
            return Err(AppError::Validation(format!("unknown link kind {kind}")));
        }
        let entry_ids = dedup(&req.entry_ids);
        let transaction_ids = dedup(&req.transaction_ids);
        let split_ids = dedup(&req.split_ids);
        if entry_ids.is_empty() {
            return Err(AppError::Validation("a link needs at least one row".to_string()));
        }
        if transaction_ids.is_empty() && split_ids.is_empty() {
            return Err(AppError::Validation(
                "a link needs a transaction or a split".to_string(),
            ));
        }
        let txn = db.begin().await?;
        lock_bank_log(&txn).await?;
        let found = EntryEntity::find()
            .filter(EntryColumn::Id.is_in(entry_ids.clone()))
            .all(&txn)
            .await?;
        if found.len() != entry_ids.len() {
            return Err(AppError::NotFound("a log row does not exist".to_string()));
        }
        let transactions = TransactionEntity::find()
            .filter(TransactionColumn::Id.is_in(transaction_ids.clone()))
            .all(&txn)
            .await?;
        if transactions.len() != transaction_ids.len() {
            return Err(AppError::NotFound("a transaction does not exist".to_string()));
        }
        let splits = SplitEntity::find()
            .filter(SplitColumn::Id.is_in(split_ids.clone()))
            .all(&txn)
            .await?;
        if splits.len() != split_ids.len() {
            return Err(AppError::NotFound("a split does not exist".to_string()));
        }
        ensure_not_confirmed(&txn, &entry_ids, &transaction_ids, None).await?;
        let link = insert_link(
            &txn,
            kind,
            true,
            Some(actor),
            &entry_ids,
            &transaction_ids,
            &split_ids,
            None,
        )
        .await?;
        drop_competing_suggestions(&txn, &link, &entry_ids, &transaction_ids, &split_ids).await?;
        recompute_statuses(&txn).await?;
        AuditService::record_in(
            &txn,
            "BANK_LOG_LINK_CREATED",
            Some("BANK_LOG_LINK"),
            Some(link.id),
            Some(actor),
            Some(serde_json::json!({
                "kind": kind,
                "entry_ids": entry_ids,
                "transaction_ids": transaction_ids,
                "split_ids": split_ids,
            })),
        )
        .await?;
        txn.commit().await?;
        link_view(db, link.id).await
    }

    /// Confirms a suggestion. Competing suggestions on the same rows or records are dropped.
    pub async fn confirm_link(
        &self,
        db: &DatabaseConnection,
        id: i64,
        actor: i64,
    ) -> Result<BankLogLinkView, AppError> {
        let txn = db.begin().await?;
        lock_bank_log(&txn).await?;
        let link = LinkEntity::find_by_id(id)
            .one(&txn)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("link {id} not found")))?;
        if link.confirmed {
            return Err(AppError::Conflict(format!("link {id} is already confirmed")));
        }
        confirm_in(&txn, link, actor).await?;
        recompute_statuses(&txn).await?;
        txn.commit().await?;
        link_view(db, id).await
    }

    /// Confirms several suggestions in order ("fill all suggested"). One that is gone, already
    /// confirmed, or collides with a link confirmed before it is skipped, not an error.
    pub async fn confirm_suggestions(
        &self,
        db: &DatabaseConnection,
        link_ids: &[i64],
        actor: i64,
    ) -> Result<BankLogConfirmSuggestionsResult, AppError> {
        let ids = dedup(link_ids);
        if ids.is_empty() {
            return Err(AppError::Validation("pick at least one suggestion".to_string()));
        }
        if ids.len() > 2_000 {
            return Err(AppError::Validation("at most 2000 suggestions at once".to_string()));
        }
        let txn = db.begin().await?;
        lock_bank_log(&txn).await?;
        let mut confirmed = 0_u64;
        let mut skipped = 0_u64;
        for id in &ids {
            let Some(link) = LinkEntity::find_by_id(*id).one(&txn).await? else {
                skipped += 1;
                continue;
            };
            if link.confirmed {
                skipped += 1;
                continue;
            }
            match confirm_in(&txn, link, actor).await {
                Ok(()) => confirmed += 1,
                Err(AppError::Conflict(_)) => skipped += 1,
                Err(error) => return Err(error),
            }
        }
        recompute_statuses(&txn).await?;
        AuditService::record_in(
            &txn,
            "BANK_LOG_SUGGESTIONS_CONFIRMED",
            Some("BANK_LOG"),
            None,
            Some(actor),
            Some(serde_json::json!({
                "link_ids": ids,
                "confirmed": confirmed,
                "skipped": skipped,
            })),
        )
        .await?;
        txn.commit().await?;
        Ok(BankLogConfirmSuggestionsResult { confirmed, skipped })
    }

    /// What "fill all suggested" would confirm: for every suggested row its best suggestion,
    /// taken by score, skipping any that shares a row or a transaction with a better one.
    pub async fn best_suggestions(
        &self,
        db: &DatabaseConnection,
    ) -> Result<BankLogBestSuggestions, AppError> {
        let mut suggestions: Vec<LinkModel> = LinkEntity::find()
            .filter(LinkColumn::Confirmed.eq(false))
            .all(db)
            .await?;
        if suggestions.is_empty() {
            return Ok(BankLogBestSuggestions { items: Vec::new(), rows_left_out: 0 });
        }
        let ids: Vec<i64> = suggestions.iter().map(|link| link.id).collect();
        let mut entries_of: HashMap<i64, Vec<i64>> = HashMap::new();
        for row in LinkEntryEntity::find()
            .filter(LinkEntryColumn::MatchId.is_in(ids.clone()))
            .all(db)
            .await?
        {
            entries_of.entry(row.match_id).or_default().push(row.entry_id);
        }
        let mut transactions_of: HashMap<i64, Vec<i64>> = HashMap::new();
        for target in LinkTargetEntity::find()
            .filter(LinkTargetColumn::MatchId.is_in(ids))
            .all(db)
            .await?
        {
            if let Some(id) = target.transaction_id {
                transactions_of.entry(target.match_id).or_default().push(id);
            }
        }
        suggestions.sort_by_key(|link| {
            (
                std::cmp::Reverse(link.score.unwrap_or(0)),
                entries_of.get(&link.id).map_or(0, Vec::len),
                link.id,
            )
        });
        let suggested_rows: HashSet<i64> = entries_of.values().flatten().copied().collect();
        let mut used_rows: HashSet<i64> = HashSet::new();
        let mut used_transactions: HashSet<i64> = HashSet::new();
        let mut chosen = Vec::new();
        for link in suggestions {
            let rows = entries_of.get(&link.id).cloned().unwrap_or_default();
            let transactions = transactions_of.get(&link.id).cloned().unwrap_or_default();
            if rows.is_empty()
                || rows.iter().any(|id| used_rows.contains(id))
                || transactions.iter().any(|id| used_transactions.contains(id))
            {
                continue;
            }
            used_rows.extend(rows);
            used_transactions.extend(transactions);
            chosen.push(link);
        }
        let briefs: HashMap<i64, BankLogEntryBrief> = EntryEntity::find()
            .filter(EntryColumn::Id.is_in(used_rows.iter().copied().collect::<Vec<_>>()))
            .all(db)
            .await?
            .into_iter()
            .map(|entry| {
                (
                    entry.id,
                    BankLogEntryBrief {
                        id: entry.id,
                        occurred_at: ts(&entry.occurred_at),
                        player_name: entry.player_name,
                        reason: entry.reason,
                        amount: entry.amount,
                        category: entry.category,
                    },
                )
            })
            .collect();
        let items = link_views(db, chosen)
            .await?
            .into_iter()
            .map(|link| BankLogBestSuggestionView {
                entries: link
                    .entry_ids
                    .iter()
                    .filter_map(|id| briefs.get(id).cloned())
                    .collect(),
                link,
            })
            .collect();
        Ok(BankLogBestSuggestions {
            items,
            rows_left_out: suggested_rows.difference(&used_rows).count() as u64,
        })
    }

    /// Searches again for one row: drops its suggestions and proposes new ones against
    /// everything still open (rows of other suggestions keep theirs).
    pub async fn refresh_entry_suggestions(
        &self,
        db: &DatabaseConnection,
        id: i64,
        actor: i64,
    ) -> Result<BankLogEntryView, AppError> {
        let txn = db.begin().await?;
        lock_bank_log(&txn).await?;
        let entry = find_entry(&txn, id).await?;
        if entry.explained_at.is_some() {
            return Err(AppError::Conflict(
                "the row is explained; undo the explanation first".to_string(),
            ));
        }
        ensure_not_confirmed(&txn, &[id], &[], None).await?;
        let count = refresh_suggestions_in(&txn, Some(id)).await?;
        AuditService::record_in(
            &txn,
            "BANK_LOG_ROW_SUGGESTIONS_REFRESHED",
            Some("BANK_LOG_ENTRY"),
            Some(id),
            Some(actor),
            Some(serde_json::json!({ "suggestions": count })),
        )
        .await?;
        txn.commit().await?;
        self.get_entry(db, id).await
    }

    /// Removes a link: rejects a suggestion or undoes a confirmed link.
    pub async fn delete_link(
        &self,
        db: &DatabaseConnection,
        id: i64,
        actor: i64,
    ) -> Result<(), AppError> {
        let txn = db.begin().await?;
        lock_bank_log(&txn).await?;
        let link = LinkEntity::find_by_id(id)
            .one(&txn)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("link {id} not found")))?;
        let entry_ids = link_entry_ids(&txn, id).await?;
        delete_links(&txn, &[id]).await?;
        recompute_statuses(&txn).await?;
        AuditService::record_in(
            &txn,
            if link.confirmed {
                "BANK_LOG_LINK_REMOVED"
            } else {
                "BANK_LOG_SUGGESTION_REJECTED"
            },
            Some("BANK_LOG_LINK"),
            Some(id),
            Some(actor),
            Some(serde_json::json!({ "kind": link.kind, "entry_ids": entry_ids })),
        )
        .await?;
        txn.commit().await?;
        Ok(())
    }

    /// Creates the bank transaction a row stands for and links the row to it.
    ///
    /// A withdrawal row becomes a paid-out (`withdrawn`) row for the member; a deposit row
    /// becomes the member's donation to the Guild Bank. A row creates at most one transaction,
    /// ever: the link column is unique and is not cleared when the transaction is deleted.
    pub async fn create_transaction(
        &self,
        db: &DatabaseConnection,
        entry_id: i64,
        req: &BankLogCreateEntryTransactionRequest,
        actor: i64,
    ) -> Result<BankLogEntryView, AppError> {
        let txn = db.begin().await?;
        lock_bank_log(&txn).await?;
        let entry = find_entry(&txn, entry_id).await?;
        if entry.created_transaction_id.is_some() {
            return Err(AppError::Conflict(format!(
                "row {entry_id} already created transaction #{}",
                entry.created_transaction_id.unwrap_or_default()
            )));
        }
        ensure_not_confirmed(&txn, &[entry_id], &[], None).await?;
        if UserEntity::find_by_id(req.to_user_id).one(&txn).await?.is_none() {
            return Err(AppError::NotFound(format!("User {} not found", req.to_user_id)));
        }
        let amount = req.amount.unwrap_or_else(|| entry.amount.abs());
        if amount <= Decimal::ZERO {
            return Err(AppError::Validation("amount must be positive".to_string()));
        }
        let withdrawal = entry.amount < Decimal::ZERO;
        let now = Utc::now();
        let created = TransactionActiveModel {
            from_user_id: Set(Some(if withdrawal { actor } else { req.to_user_id })),
            to_user_id: Set(req.to_user_id),
            to_guild_bank: Set(!withdrawal),
            amount: Set(amount),
            status: Set(if withdrawal {
                TransactionStatus::Withdrawn
            } else {
                TransactionStatus::Donated
            }
            .to_string()),
            r#type: Set(TYPE_MANUAL.to_string()),
            split_id: Set(None),
            created_at: Set(now.into()),
            requested_at: Set(None),
            withdrawn_at: Set(withdrawal.then_some(entry.occurred_at)),
            updated_at: Set(now.into()),
            ..Default::default()
        }
        .insert(&txn)
        .await?;
        let mut active: EntryActiveModel = entry.clone().into();
        active.created_transaction_id = Set(Some(created.id));
        active.update(&txn).await?;
        let link = insert_link(
            &txn,
            KIND_MANUAL,
            true,
            Some(actor),
            &[entry_id],
            &[created.id],
            &[],
            None,
        )
        .await?;
        drop_competing_suggestions(&txn, &link, &[entry_id], &[created.id], &[]).await?;
        recompute_statuses(&txn).await?;
        AuditService::record_in(
            &txn,
            "TRANSACTION_CREATED_FROM_BANK_LOG",
            Some("TRANSACTION"),
            Some(created.id),
            Some(actor),
            Some(serde_json::json!({
                "bank_log_entry_id": entry_id,
                "to_user_id": created.to_user_id,
                "amount": created.amount,
                "status": created.status,
                "occurred_at": ts(&entry.occurred_at),
                "player_name": entry.player_name,
                "reason": entry.reason,
            })),
        )
        .await?;
        txn.commit().await?;
        self.get_entry(db, entry_id).await
    }

    /// Manager records an officer can link a row to by hand, most likely first.
    ///
    /// Withdrawals list members' payouts (rows accepted together, and each row of such a batch on
    /// its own); deposits list splits by bags value or expected loot sale. The score mixes how
    /// close the amount and the time are, like the automatic suggestions.
    pub async fn candidates(
        &self,
        db: &DatabaseConnection,
        entry_id: i64,
        query: &BankLogCandidateQuery,
    ) -> Result<Vec<BankLogCandidateView>, AppError> {
        let entry = find_entry(db, entry_id).await?;
        let at = utc(&entry.occurred_at);
        let withdrawal = entry.amount < Decimal::ZERO;
        let value_kind = match query.value.as_deref() {
            Some(KIND_LOOT_SALE) => KIND_LOOT_SALE,
            Some(KIND_BAGS) => KIND_BAGS,
            Some(other) => {
                return Err(AppError::Validation(format!("unknown value {other}")));
            }
            None if entry.category == CATEGORY_LOOT_SALE => KIND_LOOT_SALE,
            None => KIND_BAGS,
        };
        let default_days = match (withdrawal, value_kind) {
            (true, _) => 7,
            (false, KIND_LOOT_SALE) => 30,
            (false, _) => 7,
        };
        let days = query.days.unwrap_or(default_days).clamp(1, 60);
        let include_linked = query.include_linked.unwrap_or(false);
        let search = query
            .search
            .as_deref()
            .map(|term| term.trim().trim_start_matches('#').to_lowercase())
            .filter(|term| !term.is_empty());
        let target = entry.amount.abs();
        let (linked_transactions, linked_splits) = confirmed_target_ids(db).await?;
        let mut out = Vec::new();

        if withdrawal {
            let rows = paid_withdrawals(db, at - Duration::days(days), at + Duration::days(days)).await?;
            let names = usernames(db, rows.iter().map(|row| row.to_user_id)).await?;
            let source_splits: HashMap<i64, SplitModel> = {
                let ids = dedup(&rows.iter().filter_map(|row| row.split_id).collect::<Vec<_>>());
                if ids.is_empty() {
                    HashMap::new()
                } else {
                    SplitEntity::find()
                        .filter(SplitColumn::Id.is_in(ids))
                        .all(db)
                        .await?
                        .into_iter()
                        .map(|split| (split.id, split))
                        .collect()
                }
            };
            let by_id: HashMap<i64, &TransactionModel> = rows.iter().map(|row| (row.id, row)).collect();
            let paid: Vec<Paid> = rows.iter().filter_map(to_paid).collect();
            let mut by_user: BTreeMap<i64, Vec<&Paid>> = BTreeMap::new();
            for row in &paid {
                by_user.entry(row.user_id).or_default().push(row);
            }
            let mut groups: Vec<Vec<&Paid>> = Vec::new();
            for member_rows in by_user.values() {
                for batch in matcher::payment_batches(member_rows) {
                    if batch.len() > 1 {
                        groups.extend(batch.iter().map(|row| vec![*row]));
                    }
                    groups.push(batch);
                }
            }
            let mut seen: HashSet<Vec<i64>> = HashSet::new();
            for group in groups {
                let mut ids: Vec<i64> = group.iter().map(|row| row.transaction_id).collect();
                ids.sort_unstable();
                if !seen.insert(ids.clone()) {
                    continue;
                }
                let linked = ids.iter().any(|id| linked_transactions.contains(id));
                if linked && !include_linked {
                    continue;
                }
                let user_id = group[0].user_id;
                let member = names.get(&user_id).cloned();
                let split_labels: Vec<String> = dedup(
                    &ids.iter()
                        .filter_map(|id| by_id.get(id).and_then(|row| row.split_id))
                        .collect::<Vec<_>>(),
                )
                .iter()
                .map(|id| source_splits.get(id).map_or_else(|| format!("Split #{id}"), split_label))
                .collect();
                let detail = (!split_labels.is_empty()).then(|| split_labels.join(", "));
                if let Some(term) = &search {
                    let hit = member.as_deref().is_some_and(|name| name.to_lowercase().contains(term))
                        || ids.iter().any(|id| id.to_string() == *term)
                        || detail.as_deref().is_some_and(|text| text.to_lowercase().contains(term));
                    if !hit {
                        continue;
                    }
                }
                let amount: Decimal = group.iter().map(|row| row.amount).sum();
                let nearest = group
                    .iter()
                    .min_by_key(|row| (row.paid_at - at).num_seconds().abs())
                    .expect("non-empty group");
                let apart = nearest.paid_at - at;
                let amount_fit = matcher::amount_score(target, amount, ids.len(), 0.25).unwrap_or(0.0);
                out.push(BankLogCandidateView {
                    key: format!(
                        "p:{}",
                        ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
                    ),
                    kind: "payout".to_string(),
                    label: if ids.len() == 1 {
                        format!("Payout #{}", ids[0])
                    } else {
                        format!("{} payouts accepted together", ids.len())
                    },
                    transaction_ids: ids.clone(),
                    split_id: None,
                    detail,
                    member_username: member,
                    amount,
                    split_bags_value: None,
                    split_expected_sale: None,
                    at: Some(nearest.paid_at.to_rfc3339()),
                    minutes_apart: Some(apart.num_minutes()),
                    score: i32::from(matcher::combine(
                        amount_fit,
                        matcher::time_score(apart),
                        0.6,
                        ids.len() - 1,
                    )),
                    linked,
                });
            }
        } else {
            let default_tax = default_market_tax(db).await?;
            let splits = SplitEntity::find()
                .filter(SplitColumn::CreatedAt.gte(at - Duration::days(days)))
                .filter(SplitColumn::CreatedAt.lte(at + Duration::days(days)))
                .filter(SplitColumn::OriginReadOnly.eq(false))
                .filter(SplitColumn::Status.is_not_in(DEAD_SPLIT_STATUSES))
                .all(db)
                .await?;
            let creators = usernames(db, splits.iter().map(|split| split.created_by)).await?;
            for split in splits {
                let value = split_value(&split, value_kind, default_tax);
                if value <= Decimal::ZERO {
                    continue;
                }
                let linked = linked_splits.contains(&split.id);
                if linked && !include_linked {
                    continue;
                }
                let creator = creators.get(&split.created_by).cloned();
                let note = split
                    .note
                    .as_deref()
                    .map(str::trim)
                    .filter(|note| !note.is_empty())
                    .map(str::to_string);
                if let Some(term) = &search {
                    let hit = split.id.to_string() == *term
                        || note.as_deref().is_some_and(|text| text.to_lowercase().contains(term))
                        || creator.as_deref().is_some_and(|name| name.to_lowercase().contains(term));
                    if !hit {
                        continue;
                    }
                }
                let candidate = SplitCandidate {
                    id: split.id,
                    created_at: utc(&split.created_at),
                    finalized_at: split.finalized_at.as_ref().map(utc),
                    bags_value: split.bags_value,
                    expected_sale: value,
                };
                let apart = candidate.apart(at);
                let signed = if (at - candidate.created_at).abs() <= apart {
                    candidate.created_at - at
                } else {
                    candidate.finalized_at.map_or(candidate.created_at - at, |done| done - at)
                };
                // Bags are often paid in several deposits: a deposit below the bags value still
                // fits in part.
                let amount_fit = matcher::amount_score(target, value, 1, 0.25).unwrap_or_else(|| {
                    if value_kind == KIND_BAGS && target < value {
                        40.0 * matcher_ratio(target, value)
                    } else {
                        0.0
                    }
                });
                let time = if value_kind == KIND_LOOT_SALE {
                    matcher::sale_time_score(apart)
                } else {
                    matcher::time_score(apart)
                };
                out.push(BankLogCandidateView {
                    key: format!("s:{}", split.id),
                    kind: "split".to_string(),
                    transaction_ids: Vec::new(),
                    split_id: Some(split.id),
                    label: format!("Split #{}", split.id),
                    detail: note,
                    member_username: creator,
                    amount: value,
                    split_bags_value: Some(split.bags_value),
                    split_expected_sale: Some(expected_sale(&split, default_tax)),
                    at: Some(ts(&split.created_at)),
                    minutes_apart: Some(signed.num_minutes()),
                    score: i32::from(matcher::combine(amount_fit, time, 0.5, 0)),
                    linked,
                });
            }
        }
        out.sort_by_key(|candidate| {
            (
                std::cmp::Reverse(candidate.score),
                candidate.minutes_apart.map_or(i64::MAX, i64::abs),
                candidate.key.clone(),
            )
        });
        out.truncate(60);
        Ok(out)
    }

    /// Imports, most recent first.
    pub async fn batches(&self, db: &DatabaseConnection) -> Result<Vec<BankLogBatchView>, AppError> {
        let entries = EntryEntity::find().all(db).await?;
        let mut grouped: BTreeMap<String, Vec<EntryModel>> = BTreeMap::new();
        for entry in entries {
            grouped.entry(entry.batch_id.clone()).or_default().push(entry);
        }
        let mut out: Vec<BankLogBatchView> = grouped
            .into_iter()
            .map(|(batch_id, rows)| {
                let first = rows.iter().map(|r| utc(&r.occurred_at)).min().expect("rows");
                let last = rows.iter().map(|r| utc(&r.occurred_at)).max().expect("rows");
                let imported = rows.iter().map(|r| utc(&r.imported_at)).min().expect("rows");
                BankLogBatchView {
                    batch_id,
                    imported_at: imported.to_rfc3339(),
                    imported_by: rows[0].imported_by,
                    rows: rows.len() as u64,
                    first_at: first.to_rfc3339(),
                    last_at: last.to_rfc3339(),
                }
            })
            .collect();
        out.sort_by(|a, b| b.imported_at.cmp(&a.imported_at));
        Ok(out)
    }

    /// Deletes the rows an import stored. Refused when a row of it created a transaction.
    pub async fn delete_batch(
        &self,
        db: &DatabaseConnection,
        batch_id: &str,
        actor: i64,
    ) -> Result<u64, AppError> {
        let txn = db.begin().await?;
        lock_bank_log(&txn).await?;
        let rows = EntryEntity::find()
            .filter(EntryColumn::BatchId.eq(batch_id))
            .all(&txn)
            .await?;
        if rows.is_empty() {
            return Err(AppError::NotFound(format!("import {batch_id} not found")));
        }
        if rows.iter().any(|row| row.created_transaction_id.is_some()) {
            return Err(AppError::Conflict(
                "a row of this import created a transaction; delete that link first".to_string(),
            ));
        }
        let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
        let link_ids: Vec<i64> = LinkEntryEntity::find()
            .filter(LinkEntryColumn::EntryId.is_in(ids.clone()))
            .all(&txn)
            .await?
            .into_iter()
            .map(|row| row.match_id)
            .collect();
        delete_links(&txn, &dedup(&link_ids)).await?;
        EntryEntity::delete_many()
            .filter(EntryColumn::Id.is_in(ids.clone()))
            .exec(&txn)
            .await?;
        recompute_statuses(&txn).await?;
        AuditService::record_in(
            &txn,
            "BANK_LOG_IMPORT_DELETED",
            Some("BANK_LOG"),
            None,
            Some(actor),
            Some(serde_json::json!({ "batch_id": batch_id, "rows": ids.len() })),
        )
        .await?;
        txn.commit().await?;
        Ok(ids.len() as u64)
    }

    /// Period totals per category, the Manager's own payout total and the import status.
    pub async fn summary(
        &self,
        db: &DatabaseConnection,
        query: &BankLogPeriodQuery,
    ) -> Result<BankLogSummary, AppError> {
        let today = Utc::now().date_naive();
        let to = match query.to.as_deref().filter(|v| !v.trim().is_empty()) {
            Some(raw) => day_start(raw)?.date_naive(),
            None => today,
        };
        let from = match query.from.as_deref().filter(|v| !v.trim().is_empty()) {
            Some(raw) => day_start(raw)?.date_naive(),
            None => to - Duration::days(GAME_LOG_DAYS - 1),
        };
        if from > to {
            return Err(AppError::Validation("from must not be after to".to_string()));
        }
        let start = from.and_hms_opt(0, 0, 0).expect("midnight").and_utc();
        let end = (to + Duration::days(1)).and_hms_opt(0, 0, 0).expect("midnight").and_utc();

        let entries = EntryEntity::find()
            .filter(EntryColumn::OccurredAt.gte(start))
            .filter(EntryColumn::OccurredAt.lt(end))
            .all(db)
            .await?;
        let mut categories: BTreeMap<&str, BankLogCategoryTotals> = CATEGORIES
            .iter()
            .map(|category| {
                (
                    *category,
                    BankLogCategoryTotals {
                        category: (*category).to_string(),
                        rows: 0,
                        game_total: Decimal::ZERO,
                        linked_total: Decimal::ZERO,
                        explained_total: Decimal::ZERO,
                        open_total: Decimal::ZERO,
                    },
                )
            })
            .collect();
        let (mut game_in, mut game_out, mut game_payouts) =
            (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
        let mut counts: HashMap<&str, u64> = HashMap::new();
        for entry in &entries {
            if entry.amount > Decimal::ZERO {
                game_in += entry.amount;
            } else {
                game_out += entry.amount;
            }
            if entry.category == CATEGORY_PAYOUT && entry.amount < Decimal::ZERO {
                game_payouts -= entry.amount;
            }
            *counts.entry(status_key(&entry.status)).or_insert(0) += 1;
            let Some(totals) = categories.get_mut(entry.category.as_str()) else {
                continue;
            };
            totals.rows += 1;
            totals.game_total += entry.amount;
            match entry.status.as_str() {
                STATUS_MATCHED => totals.linked_total += entry.amount,
                STATUS_EXPLAINED => totals.explained_total += entry.amount,
                _ => totals.open_total += entry.amount,
            }
        }

        // Compare payouts only over the stretch the imported game rows cover, widened by the
        // payout matching tolerance (a payout is accepted up to 7 days before, or 2 days after,
        // its game withdrawal) and kept inside the period. Without rows there is nothing to
        // compare the Manager total with.
        let covered = entries.iter().map(|entry| utc(&entry.occurred_at)).fold(
            None,
            |range: Option<(DateTime<Utc>, DateTime<Utc>)>, at| match range {
                Some((first, last)) => Some((first.min(at), last.max(at))),
                None => Some((at, at)),
            },
        );
        let manager_payouts: Decimal = match covered {
            Some((first, last)) => paid_withdrawals(
                db,
                (first - Duration::days(7)).max(start),
                (last + Duration::days(2)).min(end - Duration::seconds(1)),
            )
            .await?
                .iter()
                .map(|row| row.amount)
                .sum(),
            None => Decimal::ZERO,
        };

        let settings = GuildSettingsEntity::find_by_id(1).one(db).await?;
        let last_import = EntryEntity::find()
            .order_by_desc(EntryColumn::ImportedAt)
            .one(db)
            .await?
            .map(|entry| utc(&entry.imported_at));
        let days_since_import = last_import.map(|at| (today - at.date_naive()).num_days());
        let staff_role_set = RoleEntity::find()
            .filter(RoleColumn::IsStaff.eq(true))
            .filter(RoleColumn::DiscordRoleId.is_not_null())
            .one(db)
            .await?
            .is_some_and(|role| role.discord_role_id.is_some_and(|id| !id.trim().is_empty()));

        Ok(BankLogSummary {
            from: from.to_string(),
            to: to.to_string(),
            game_in,
            game_out,
            game_net: game_in + game_out,
            manager_payouts,
            game_payouts,
            covered_from: covered.map(|(first, _)| first.to_rfc3339()),
            covered_to: covered.map(|(_, last)| last.to_rfc3339()),
            unmatched: counts.get(STATUS_UNMATCHED).copied().unwrap_or(0),
            suggested: counts.get(STATUS_SUGGESTED).copied().unwrap_or(0),
            matched: counts.get(STATUS_MATCHED).copied().unwrap_or(0),
            explained: counts.get(STATUS_EXPLAINED).copied().unwrap_or(0),
            categories: categories.into_values().collect(),
            import: BankLogImportStatus {
                last_import_at: last_import.map(|at| at.to_rfc3339()),
                days_since_import,
                days_until_loss: days_since_import.map(|days| GAME_LOG_DAYS - days),
                reminder_after_days: REMINDER_AFTER_DAYS,
                reminder_channel_set: settings
                    .as_ref()
                    .and_then(|s| s.discord_bank_log_channel_id.as_deref())
                    .is_some_and(|id| !id.trim().is_empty()),
                staff_role_set,
                last_reminded_on: settings.as_ref().and_then(|s| s.bank_log_reminded_on.clone()),
                reminder_error: settings
                    .as_ref()
                    .and_then(|s| s.bank_log_reminder_error.clone()),
            },
            seller_accounts: settings
                .as_ref()
                .map(|s| seller_accounts(&s.bank_log_seller_accounts))
                .unwrap_or_default(),
        })
    }
}

fn status_key(status: &str) -> &'static str {
    match status {
        STATUS_SUGGESTED => STATUS_SUGGESTED,
        STATUS_MATCHED => STATUS_MATCHED,
        STATUS_EXPLAINED => STATUS_EXPLAINED,
        _ => STATUS_UNMATCHED,
    }
}

fn dedup(ids: &[i64]) -> Vec<i64> {
    let mut seen = HashSet::new();
    ids.iter().copied().filter(|id| seen.insert(*id)).collect()
}

async fn find_entry<C: ConnectionTrait>(db: &C, id: i64) -> Result<EntryModel, AppError> {
    EntryEntity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("log row {id} not found")))
}

async fn default_market_tax<C: ConnectionTrait>(db: &C) -> Result<Decimal, AppError> {
    Ok(GuildSettingsEntity::find_by_id(1)
        .one(db)
        .await?
        .map_or_else(|| Decimal::from(6), |settings| settings.market_tax_percent))
}

/// `loot × (1 − tax)`: the split's own tax, or the guild setting for splits created before the
/// tax existed (the seller paid it anyway).
fn expected_sale(split: &SplitModel, default_tax: Decimal) -> Decimal {
    let tax = if split.market_tax > Decimal::ZERO {
        split.market_tax
    } else {
        default_tax
    };
    (split.estimated_market_value - split.estimated_market_value * tax / Decimal::from(100))
        .round_dp(2)
}

fn split_label(split: &SplitModel) -> String {
    match split.note.as_deref().map(str::trim).filter(|note| !note.is_empty()) {
        Some(note) => format!("Split #{} · {note}", split.id),
        None => format!("Split #{}", split.id),
    }
}

/// Withdrawals the Manager paid out to members between `from` and `to`.
async fn paid_withdrawals<C: ConnectionTrait>(
    db: &C,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<TransactionModel>, AppError> {
    Ok(TransactionEntity::find()
        .filter(TransactionColumn::Status.eq(TransactionStatus::Withdrawn.to_string()))
        .filter(TransactionColumn::Amount.gt(Decimal::ZERO))
        .filter(TransactionColumn::ToGuildBank.eq(false))
        .filter(TransactionColumn::Type.ne(TYPE_SIPHONED_SETTLEMENT))
        .filter(TransactionColumn::WithdrawnAt.gte(from))
        .filter(TransactionColumn::WithdrawnAt.lte(to))
        .all(db)
        .await?)
}

/// `numerator / denominator` as a float, for scores.
fn matcher_ratio(numerator: Decimal, denominator: Decimal) -> f64 {
    if denominator <= Decimal::ZERO {
        return 0.0;
    }
    (numerator / denominator).to_string().parse().unwrap_or(0.0)
}

async fn usernames<C: ConnectionTrait>(
    db: &C,
    ids: impl IntoIterator<Item = i64>,
) -> Result<HashMap<i64, String>, AppError> {
    let ids = dedup(&ids.into_iter().collect::<Vec<_>>());
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(UserEntity::find()
        .filter(UserColumn::Id.is_in(ids))
        .all(db)
        .await?
        .into_iter()
        .map(|user| (user.id, user.username))
        .collect())
}

async fn link_entry_ids<C: ConnectionTrait>(db: &C, link_id: i64) -> Result<Vec<i64>, AppError> {
    Ok(LinkEntryEntity::find()
        .filter(LinkEntryColumn::MatchId.eq(link_id))
        .all(db)
        .await?
        .into_iter()
        .map(|row| row.entry_id)
        .collect())
}

/// Transactions and splits that are part of a confirmed link.
async fn confirmed_target_ids<C: ConnectionTrait>(
    db: &C,
) -> Result<(HashSet<i64>, HashSet<i64>), AppError> {
    let confirmed: Vec<i64> = LinkEntity::find()
        .filter(LinkColumn::Confirmed.eq(true))
        .all(db)
        .await?
        .into_iter()
        .map(|link| link.id)
        .collect();
    if confirmed.is_empty() {
        return Ok((HashSet::new(), HashSet::new()));
    }
    let targets = LinkTargetEntity::find()
        .filter(LinkTargetColumn::MatchId.is_in(confirmed))
        .all(db)
        .await?;
    Ok((
        targets.iter().filter_map(|t| t.transaction_id).collect(),
        targets.iter().filter_map(|t| t.split_id).collect(),
    ))
}

/// Refuses a link when one of its rows or transactions is already in another confirmed link.
async fn ensure_not_confirmed<C: ConnectionTrait>(
    db: &C,
    entry_ids: &[i64],
    transaction_ids: &[i64],
    except: Option<i64>,
) -> Result<(), AppError> {
    let mut confirmed: Vec<i64> = LinkEntity::find()
        .filter(LinkColumn::Confirmed.eq(true))
        .all(db)
        .await?
        .into_iter()
        .map(|link| link.id)
        .collect();
    confirmed.retain(|id| Some(*id) != except);
    if confirmed.is_empty() {
        return Ok(());
    }
    if !entry_ids.is_empty()
        && LinkEntryEntity::find()
            .filter(LinkEntryColumn::MatchId.is_in(confirmed.clone()))
            .filter(LinkEntryColumn::EntryId.is_in(entry_ids.to_vec()))
            .one(db)
            .await?
            .is_some()
    {
        return Err(AppError::Conflict(
            "a log row is already linked; remove that link first".to_string(),
        ));
    }
    if !transaction_ids.is_empty()
        && LinkTargetEntity::find()
            .filter(LinkTargetColumn::MatchId.is_in(confirmed))
            .filter(LinkTargetColumn::TransactionId.is_in(transaction_ids.to_vec()))
            .one(db)
            .await?
            .is_some()
    {
        return Err(AppError::Conflict(
            "a transaction is already linked to another log row".to_string(),
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn insert_link<C: ConnectionTrait>(
    db: &C,
    kind: &str,
    confirmed: bool,
    actor: Option<i64>,
    entry_ids: &[i64],
    transaction_ids: &[i64],
    split_ids: &[i64],
    score: Option<u8>,
) -> Result<LinkModel, AppError> {
    let now = Utc::now();
    let link = LinkActiveModel {
        kind: Set(kind.to_string()),
        score: Set(score.map(i32::from)),
        confirmed: Set(confirmed),
        created_at: Set(now.into()),
        created_by: Set(actor),
        confirmed_at: Set(confirmed.then(|| now.into())),
        confirmed_by: Set(if confirmed { actor } else { None }),
        ..Default::default()
    }
    .insert(db)
    .await?;
    for entry_id in entry_ids {
        LinkEntryActiveModel {
            match_id: Set(link.id),
            entry_id: Set(*entry_id),
            ..Default::default()
        }
        .insert(db)
        .await?;
    }
    for transaction_id in transaction_ids {
        LinkTargetActiveModel {
            match_id: Set(link.id),
            transaction_id: Set(Some(*transaction_id)),
            split_id: Set(None),
            ..Default::default()
        }
        .insert(db)
        .await?;
    }
    for split_id in split_ids {
        LinkTargetActiveModel {
            match_id: Set(link.id),
            transaction_id: Set(None),
            split_id: Set(Some(*split_id)),
            ..Default::default()
        }
        .insert(db)
        .await?;
    }
    Ok(link)
}

/// Deletes links with their rows and targets (explicitly: SQLite may not enforce cascades).
async fn delete_links<C: ConnectionTrait>(db: &C, ids: &[i64]) -> Result<(), AppError> {
    if ids.is_empty() {
        return Ok(());
    }
    LinkEntryEntity::delete_many()
        .filter(LinkEntryColumn::MatchId.is_in(ids.to_vec()))
        .exec(db)
        .await?;
    LinkTargetEntity::delete_many()
        .filter(LinkTargetColumn::MatchId.is_in(ids.to_vec()))
        .exec(db)
        .await?;
    LinkEntity::delete_many()
        .filter(LinkColumn::Id.is_in(ids.to_vec()))
        .exec(db)
        .await?;
    Ok(())
}

/// Confirms `link` (a suggestion) and drops what competes with it.
async fn confirm_in<C: ConnectionTrait>(db: &C, link: LinkModel, actor: i64) -> Result<(), AppError> {
    let id = link.id;
    let entry_ids = link_entry_ids(db, id).await?;
    let targets = LinkTargetEntity::find()
        .filter(LinkTargetColumn::MatchId.eq(id))
        .all(db)
        .await?;
    let transaction_ids: Vec<i64> = targets.iter().filter_map(|t| t.transaction_id).collect();
    let split_ids: Vec<i64> = targets.iter().filter_map(|t| t.split_id).collect();
    ensure_not_confirmed(db, &entry_ids, &transaction_ids, Some(id)).await?;
    let mut active: LinkActiveModel = link.into();
    active.confirmed = Set(true);
    active.confirmed_at = Set(Some(Utc::now().into()));
    active.confirmed_by = Set(Some(actor));
    let link = active.update(db).await?;
    drop_competing_suggestions(db, &link, &entry_ids, &transaction_ids, &split_ids).await?;
    AuditService::record_in(
        db,
        "BANK_LOG_LINK_CONFIRMED",
        Some("BANK_LOG_LINK"),
        Some(id),
        Some(actor),
        Some(serde_json::json!({
            "kind": link.kind,
            "score": link.score,
            "entry_ids": entry_ids,
            "transaction_ids": transaction_ids,
            "split_ids": split_ids,
        })),
    )
    .await?;
    Ok(())
}

/// Silver confirmed links already brought in for each split, per link kind (bags, loot sale).
#[derive(Default)]
struct SplitCoverage {
    amounts: HashMap<(i64, String), Decimal>,
    /// A loot sale link over several splits covers each of them entirely.
    full: HashSet<(i64, String)>,
}

impl SplitCoverage {
    /// What is left of `value` for the split and link kind (never negative).
    fn remaining(&self, split_id: i64, kind: &str, value: Decimal) -> Decimal {
        let key = (split_id, kind.to_string());
        if self.full.contains(&key) {
            return Decimal::ZERO;
        }
        let covered = self.amounts.get(&key).copied().unwrap_or(Decimal::ZERO);
        (value - covered).max(Decimal::ZERO)
    }
}

async fn split_coverage<C: ConnectionTrait>(db: &C) -> Result<SplitCoverage, AppError> {
    let links: Vec<LinkModel> = LinkEntity::find()
        .filter(LinkColumn::Confirmed.eq(true))
        .filter(LinkColumn::Kind.is_in([KIND_BAGS, KIND_LOOT_SALE]))
        .all(db)
        .await?;
    let mut coverage = SplitCoverage::default();
    if links.is_empty() {
        return Ok(coverage);
    }
    let ids: Vec<i64> = links.iter().map(|link| link.id).collect();
    let targets = LinkTargetEntity::find()
        .filter(LinkTargetColumn::MatchId.is_in(ids.clone()))
        .all(db)
        .await?;
    let link_entries = LinkEntryEntity::find()
        .filter(LinkEntryColumn::MatchId.is_in(ids))
        .all(db)
        .await?;
    let amounts: HashMap<i64, Decimal> = EntryEntity::find()
        .filter(EntryColumn::Id.is_in(dedup(
            &link_entries.iter().map(|row| row.entry_id).collect::<Vec<_>>(),
        )))
        .all(db)
        .await?
        .into_iter()
        .map(|entry| (entry.id, entry.amount.abs()))
        .collect();
    for link in links {
        let splits: Vec<i64> = targets
            .iter()
            .filter(|target| target.match_id == link.id)
            .filter_map(|target| target.split_id)
            .collect();
        let total: Decimal = link_entries
            .iter()
            .filter(|row| row.match_id == link.id)
            .filter_map(|row| amounts.get(&row.entry_id))
            .copied()
            .sum();
        match splits.as_slice() {
            [] => {}
            [split] => {
                *coverage
                    .amounts
                    .entry((*split, link.kind.clone()))
                    .or_default() += total;
            }
            many => {
                for split in many {
                    coverage.full.insert((*split, link.kind.clone()));
                }
            }
        }
    }
    Ok(coverage)
}

/// The figure a split stands for in a link of `kind`.
fn split_value(split: &SplitModel, kind: &str, default_tax: Decimal) -> Decimal {
    if kind == KIND_LOOT_SALE {
        expected_sale(split, default_tax)
    } else {
        split.bags_value
    }
}

/// After `link` is confirmed, suggestions sharing one of its rows or one of its transactions can
/// no longer be right, and neither can same-kind suggestions on a split it leaves fully covered
/// (bags are often paid in several deposits, so a split stays open until they add up).
async fn drop_competing_suggestions<C: ConnectionTrait>(
    db: &C,
    link: &LinkModel,
    entry_ids: &[i64],
    transaction_ids: &[i64],
    split_ids: &[i64],
) -> Result<(), AppError> {
    let suggestions: Vec<LinkModel> = LinkEntity::find()
        .filter(LinkColumn::Confirmed.eq(false))
        .filter(LinkColumn::Id.ne(link.id))
        .all(db)
        .await?;
    if suggestions.is_empty() {
        return Ok(());
    }
    let covered_splits: HashSet<i64> = if split_ids.is_empty() {
        HashSet::new()
    } else {
        let coverage = split_coverage(db).await?;
        let default_tax = default_market_tax(db).await?;
        SplitEntity::find()
            .filter(SplitColumn::Id.is_in(split_ids.to_vec()))
            .all(db)
            .await?
            .iter()
            .filter(|split| {
                coverage.remaining(split.id, &link.kind, split_value(split, &link.kind, default_tax))
                    < Decimal::ONE
            })
            .map(|split| split.id)
            .collect()
    };
    let ids: Vec<i64> = suggestions.iter().map(|s| s.id).collect();
    let kind_of: HashMap<i64, String> = suggestions
        .iter()
        .map(|s| (s.id, s.kind.clone()))
        .collect();
    let mut drop: HashSet<i64> = LinkEntryEntity::find()
        .filter(LinkEntryColumn::MatchId.is_in(ids.clone()))
        .filter(LinkEntryColumn::EntryId.is_in(entry_ids.to_vec()))
        .all(db)
        .await?
        .into_iter()
        .map(|row| row.match_id)
        .collect();
    for target in LinkTargetEntity::find()
        .filter(LinkTargetColumn::MatchId.is_in(ids))
        .all(db)
        .await?
    {
        let shares_transaction = target
            .transaction_id
            .is_some_and(|id| transaction_ids.contains(&id));
        let shares_split = target.split_id.is_some_and(|id| covered_splits.contains(&id))
            && kind_of.get(&target.match_id).map(String::as_str) == Some(link.kind.as_str());
        if shares_transaction || shares_split {
            drop.insert(target.match_id);
        }
    }
    delete_links(db, &drop.into_iter().collect::<Vec<_>>()).await
}

/// Brings every row's `status` in line with its links and explanation.
async fn recompute_statuses<C: ConnectionTrait>(db: &C) -> Result<(), AppError> {
    let links: HashMap<i64, bool> = LinkEntity::find()
        .all(db)
        .await?
        .into_iter()
        .map(|link| (link.id, link.confirmed))
        .collect();
    let mut matched = HashSet::new();
    let mut suggested = HashSet::new();
    for row in LinkEntryEntity::find().all(db).await? {
        match links.get(&row.match_id) {
            Some(true) => {
                matched.insert(row.entry_id);
            }
            Some(false) => {
                suggested.insert(row.entry_id);
            }
            None => {}
        }
    }
    for entry in EntryEntity::find().all(db).await? {
        let status = if matched.contains(&entry.id) {
            STATUS_MATCHED
        } else if entry.explained_at.is_some() {
            STATUS_EXPLAINED
        } else if suggested.contains(&entry.id) {
            STATUS_SUGGESTED
        } else {
            STATUS_UNMATCHED
        };
        if entry.status != status {
            let id = entry.id;
            let mut active: EntryActiveModel = entry.into();
            active.status = Set(status.to_string());
            active.update(db).await.map_err(|error| {
                AppError::Internal(format!("could not update status of row {id}: {error}"))
            })?;
        }
    }
    Ok(())
}

/// A paid-out bank row as the matcher sees it.
fn to_paid(row: &TransactionModel) -> Option<Paid> {
    Some(Paid {
        transaction_id: row.id,
        user_id: row.to_user_id,
        amount: row.amount,
        paid_at: row.withdrawn_at.as_ref().map(utc)?,
        requested_at: row.requested_at.as_ref().map(utc),
    })
}

/// Drops suggestions and proposes new ones for the rows that are still open: every row, or with
/// `only`, just that row (its suggestions are replaced; other rows keep theirs).
async fn refresh_suggestions_in<C: ConnectionTrait>(
    db: &C,
    only: Option<i64>,
) -> Result<u64, AppError> {
    let mut stale: Vec<i64> = LinkEntity::find()
        .filter(LinkColumn::Confirmed.eq(false))
        .all(db)
        .await?
        .into_iter()
        .map(|link| link.id)
        .collect();
    if let Some(entry_id) = only {
        let touching: HashSet<i64> = LinkEntryEntity::find()
            .filter(LinkEntryColumn::EntryId.eq(entry_id))
            .all(db)
            .await?
            .into_iter()
            .map(|row| row.match_id)
            .collect();
        stale.retain(|id| touching.contains(id));
    }
    delete_links(db, &stale).await?;

    let confirmed_links: Vec<i64> = LinkEntity::find()
        .filter(LinkColumn::Confirmed.eq(true))
        .all(db)
        .await?
        .into_iter()
        .map(|link| link.id)
        .collect();
    let linked_entries: HashSet<i64> = if confirmed_links.is_empty() {
        HashSet::new()
    } else {
        LinkEntryEntity::find()
            .filter(LinkEntryColumn::MatchId.is_in(confirmed_links.clone()))
            .all(db)
            .await?
            .into_iter()
            .map(|row| row.entry_id)
            .collect()
    };
    let open: Vec<EntryModel> = EntryEntity::find()
        .filter(EntryColumn::ExplainedAt.is_null())
        .filter(EntryColumn::Category.is_in([CATEGORY_PAYOUT, CATEGORY_BAGS, CATEGORY_LOOT_SALE]))
        .all(db)
        .await?
        .into_iter()
        .filter(|entry| !linked_entries.contains(&entry.id))
        .collect();
    if open.is_empty() || only.is_some_and(|id| !open.iter().any(|entry| entry.id == id)) {
        recompute_statuses(db).await?;
        return Ok(0);
    }
    let first = open.iter().map(|e| utc(&e.occurred_at)).min().expect("open");
    let last = open.iter().map(|e| utc(&e.occurred_at)).max().expect("open");

    let linked_transactions: HashSet<i64> = if confirmed_links.is_empty() {
        HashSet::new()
    } else {
        LinkTargetEntity::find()
            .filter(LinkTargetColumn::MatchId.is_in(confirmed_links))
            .all(db)
            .await?
            .into_iter()
            .filter_map(|target| target.transaction_id)
            .collect()
    };
    let paid: Vec<Paid> = paid_withdrawals(
        db,
        first - Duration::days(matcher::PAYOUT_DAYS_BEFORE + 1),
        last + Duration::days(matcher::PAYOUT_DAYS_AFTER + 1),
    )
    .await?
    .iter()
    .filter(|row| !linked_transactions.contains(&row.id))
    .filter_map(to_paid)
    .collect();

    // Partly paid bags (or partly sold loot) keep only what is still missing.
    let coverage = split_coverage(db).await?;
    let default_tax = default_market_tax(db).await?;
    let splits = SplitEntity::find()
        .filter(SplitColumn::CreatedAt.gte(first - Duration::days(matcher::LOOT_SALE_DAYS + 1)))
        .filter(SplitColumn::CreatedAt.lte(last + Duration::days(matcher::BAGS_DAYS)))
        .filter(SplitColumn::OriginReadOnly.eq(false))
        .filter(SplitColumn::Status.is_not_in(DEAD_SPLIT_STATUSES))
        .all(db)
        .await?;
    let candidates: Vec<SplitCandidate> = splits
        .iter()
        .map(|split| SplitCandidate {
            id: split.id,
            created_at: utc(&split.created_at),
            finalized_at: split.finalized_at.as_ref().map(utc),
            bags_value: coverage.remaining(split.id, KIND_BAGS, split.bags_value),
            expected_sale: coverage.remaining(
                split.id,
                KIND_LOOT_SALE,
                expected_sale(split, default_tax),
            ),
        })
        .collect();

    let rows: Vec<Row> = open
        .iter()
        .map(|entry| Row {
            id: entry.id,
            at: utc(&entry.occurred_at),
            amount: entry.amount,
            category: entry.category.clone(),
        })
        .collect();
    let mut proposals: Vec<Proposal> = matcher::propose(&rows, &paid, &candidates);
    if let Some(entry_id) = only {
        proposals.retain(|proposal| proposal.entry_ids.contains(&entry_id));
    }
    for proposal in &proposals {
        insert_link(
            db,
            proposal.kind,
            false,
            None,
            &proposal.entry_ids,
            &proposal.transaction_ids,
            &proposal.split_ids,
            Some(proposal.score),
        )
        .await?;
    }
    recompute_statuses(db).await?;
    Ok(proposals.len() as u64)
}

/// Builds the view of one link.
async fn link_view(db: &DatabaseConnection, id: i64) -> Result<BankLogLinkView, AppError> {
    let link = LinkEntity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("link {id} not found")))?;
    let mut views = link_views(db, vec![link]).await?;
    views
        .pop()
        .ok_or_else(|| AppError::Internal("link view missing".to_string()))
}

async fn link_views<C: ConnectionTrait>(
    db: &C,
    links: Vec<LinkModel>,
) -> Result<Vec<BankLogLinkView>, AppError> {
    if links.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<i64> = links.iter().map(|l| l.id).collect();
    let link_entries = LinkEntryEntity::find()
        .filter(LinkEntryColumn::MatchId.is_in(ids.clone()))
        .all(db)
        .await?;
    let entry_amounts: HashMap<i64, Decimal> = EntryEntity::find()
        .filter(EntryColumn::Id.is_in(dedup(
            &link_entries.iter().map(|r| r.entry_id).collect::<Vec<_>>(),
        )))
        .all(db)
        .await?
        .into_iter()
        .map(|entry| (entry.id, entry.amount))
        .collect();
    let targets = LinkTargetEntity::find()
        .filter(LinkTargetColumn::MatchId.is_in(ids))
        .all(db)
        .await?;
    let transaction_ids: Vec<i64> = targets.iter().filter_map(|t| t.transaction_id).collect();
    let split_ids: Vec<i64> = targets.iter().filter_map(|t| t.split_id).collect();
    let transactions: HashMap<i64, TransactionModel> = if transaction_ids.is_empty() {
        HashMap::new()
    } else {
        TransactionEntity::find()
            .filter(TransactionColumn::Id.is_in(transaction_ids))
            .all(db)
            .await?
            .into_iter()
            .map(|row| (row.id, row))
            .collect()
    };
    let splits: HashMap<i64, SplitModel> = if split_ids.is_empty() {
        HashMap::new()
    } else {
        SplitEntity::find()
            .filter(SplitColumn::Id.is_in(split_ids))
            .all(db)
            .await?
            .into_iter()
            .map(|split| (split.id, split))
            .collect()
    };
    let names = usernames(db, transactions.values().map(|row| row.to_user_id)).await?;
    let default_tax = default_market_tax(db).await?;

    Ok(links
        .into_iter()
        .map(|link| {
            let entry_ids: Vec<i64> = link_entries
                .iter()
                .filter(|row| row.match_id == link.id)
                .map(|row| row.entry_id)
                .collect();
            let entries_total = entry_ids
                .iter()
                .filter_map(|id| entry_amounts.get(id))
                .copied()
                .sum();
            let targets = targets
                .iter()
                .filter(|target| target.match_id == link.id)
                .map(|target| target_view(target, &link.kind, &transactions, &splits, &names, default_tax))
                .collect();
            BankLogLinkView {
                id: link.id,
                kind: link.kind,
                confirmed: link.confirmed,
                score: link.score,
                entry_ids,
                entries_total,
                targets,
            }
        })
        .collect())
}

fn target_view(
    target: &LinkTargetModel,
    kind: &str,
    transactions: &HashMap<i64, TransactionModel>,
    splits: &HashMap<i64, SplitModel>,
    names: &HashMap<i64, String>,
    default_tax: Decimal,
) -> BankLogLinkTargetView {
    if let Some(row) = target.transaction_id.and_then(|id| transactions.get(&id)) {
        let member = names.get(&row.to_user_id).cloned();
        let label = if row.to_guild_bank {
            format!("Donation #{}", row.id)
        } else {
            format!("Payout #{}", row.id)
        };
        return BankLogLinkTargetView {
            transaction_id: Some(row.id),
            split_id: None,
            label,
            member_username: member,
            amount: Some(row.amount),
            at: row.withdrawn_at.as_ref().map(ts).or_else(|| Some(ts(&row.created_at))),
            source_split_id: row.split_id,
        };
    }
    if let Some(split) = target.split_id.and_then(|id| splits.get(&id)) {
        let amount = if kind == KIND_LOOT_SALE {
            expected_sale(split, default_tax)
        } else {
            split.bags_value
        };
        return BankLogLinkTargetView {
            transaction_id: None,
            split_id: Some(split.id),
            label: split_label(split),
            member_username: None,
            amount: Some(amount),
            at: Some(ts(&split.created_at)),
            source_split_id: None,
        };
    }
    BankLogLinkTargetView {
        transaction_id: target.transaction_id,
        split_id: target.split_id,
        label: "Removed".to_string(),
        member_username: None,
        amount: None,
        at: None,
        source_split_id: None,
    }
}

async fn entry_views<C: ConnectionTrait>(
    db: &C,
    entries: Vec<EntryModel>,
) -> Result<Vec<BankLogEntryView>, AppError> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<i64> = entries.iter().map(|e| e.id).collect();
    let rows = LinkEntryEntity::find()
        .filter(LinkEntryColumn::EntryId.is_in(ids))
        .all(db)
        .await?;
    let link_ids = dedup(&rows.iter().map(|r| r.match_id).collect::<Vec<_>>());
    let links = if link_ids.is_empty() {
        Vec::new()
    } else {
        LinkEntity::find()
            .filter(LinkColumn::Id.is_in(link_ids))
            .all(db)
            .await?
    };
    let views = link_views(db, links).await?;
    Ok(entries
        .into_iter()
        .map(|entry| {
            let mut links: Vec<BankLogLinkView> = views
                .iter()
                .filter(|view| view.entry_ids.contains(&entry.id))
                .cloned()
                .collect();
            links.sort_by_key(|link| (!link.confirmed, link.id));
            BankLogEntryView {
                id: entry.id,
                occurred_at: ts(&entry.occurred_at),
                player_name: entry.player_name,
                reason: entry.reason,
                amount: entry.amount,
                occurrence: entry.occurrence,
                category: entry.category,
                status: entry.status,
                note: entry.note,
                explained_at: entry.explained_at.as_ref().map(ts),
                batch_id: entry.batch_id,
                imported_at: ts(&entry.imported_at),
                created_transaction_id: entry.created_transaction_id,
                links,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn seed_db() -> DatabaseConnection {
        backend_migration::testkit::migrated_sqlite().await
    }

    fn row(date: &str, player: &str, reason: &str, amount: &str) -> BankLogImportRow {
        BankLogImportRow {
            date: date.to_string(),
            player: player.to_string(),
            reason: reason.to_string(),
            amount: serde_json::Value::String(amount.to_string()),
        }
    }

    async fn insert_user(db: &DatabaseConnection, name: &str) -> i64 {
        backend_entities::users::ActiveModel {
            username: Set(name.to_string()),
            email: Set(format!("{name}@example.test")),
            role: Set("User".to_string()),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap()
        .id
    }

    #[tokio::test]
    async fn reimporting_an_overlapping_export_keeps_real_duplicates_only_once() {
        let db = seed_db().await;
        let actor = insert_user(&db, "officer").await;
        let service = BankLogService::new();
        let first = vec![
            row("2026-11-14 18:42:00", "LelouchVI", "Withdrawal", "-1036150"),
            row("2026-11-14 18:42:00", "LelouchVI", "Withdrawal", "-1036150"),
            row("2026-11-13 11:17:00", "Stinapse", "Deposit", "64000"),
        ];
        let result = service.import(&db, &first, actor).await.unwrap();
        assert_eq!(result.inserted, 3);
        assert_eq!(result.duplicates_kept, 1);

        let mut second = first.clone();
        second.push(row("2026-11-16 23:10:00", "Galvdon", "Withdrawal", "-7414881"));
        let result = service.import(&db, &second, actor).await.unwrap();
        assert_eq!(result.inserted, 1);
        assert_eq!(result.already_stored, 3);

        let again = service.import(&db, &second, actor).await.unwrap();
        assert_eq!(again.inserted, 0);
        assert_eq!(EntryEntity::find().all(&db).await.unwrap().len(), 4);
    }

    #[tokio::test]
    async fn guild_expenses_are_explained_on_import() {
        let db = seed_db().await;
        let actor = insert_user(&db, "officer").await;
        BankLogService::new()
            .import(
                &db,
                &[row(
                    "2026-11-02 13:06:00",
                    "raikiry",
                    "Purchase of guild vault in Weaklings's Island",
                    "-1875000",
                )],
                actor,
            )
            .await
            .unwrap();
        let entry = EntryEntity::find().one(&db).await.unwrap().unwrap();
        assert_eq!(entry.category, CATEGORY_GUILD_EXPENSE);
        assert_eq!(entry.status, STATUS_EXPLAINED);
    }

    #[tokio::test]
    async fn a_paid_withdrawal_is_suggested_and_confirmed() {
        let db = seed_db().await;
        let actor = insert_user(&db, "officer").await;
        let member = insert_user(&db, "member").await;
        let paid_at: DateTime<Utc> = "2026-11-16T22:00:00Z".parse().unwrap();
        let payout = TransactionActiveModel {
            from_user_id: Set(Some(actor)),
            to_user_id: Set(member),
            to_guild_bank: Set(false),
            amount: Set("7414881.00".parse().unwrap()),
            status: Set(TransactionStatus::Withdrawn.to_string()),
            r#type: Set(crate::service::TYPE_SPLIT_CREDIT.to_string()),
            created_at: Set(paid_at.into()),
            withdrawn_at: Set(Some(paid_at.into())),
            updated_at: Set(paid_at.into()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .unwrap();
        let service = BankLogService::new();
        let result = service
            .import(
                &db,
                &[row("2026-11-16 23:10:00", "Galvdon", "Withdrawal", "-7414881")],
                actor,
            )
            .await
            .unwrap();
        assert_eq!(result.suggestions, 1);
        let listed = service.list_entries(&db, &BankLogEntryQuery::default()).await.unwrap();
        let entry = &listed.items[0];
        assert_eq!(entry.status, STATUS_SUGGESTED);
        let link = &entry.links[0];
        assert_eq!(link.targets[0].transaction_id, Some(payout.id));
        assert_eq!(link.targets[0].member_username.as_deref(), Some("member"));

        service.confirm_link(&db, link.id, actor).await.unwrap();
        let entry = service.get_entry(&db, entry.id).await.unwrap();
        assert_eq!(entry.status, STATUS_MATCHED);
        let summary = service.summary(&db, &BankLogPeriodQuery {
            from: Some("2026-11-01".to_string()),
            to: Some("2026-11-17".to_string()),
        })
        .await
        .unwrap();
        assert_eq!(summary.manager_payouts, "7414881.00".parse::<Decimal>().unwrap());
        assert_eq!(summary.game_payouts, Decimal::from(7_414_881));
        assert_eq!(summary.matched, 1);
        assert!(summary.covered_from.as_deref().is_some_and(|at| at.starts_with("2026-11-16T23:10")));
    }

    async fn insert_payout(db: &DatabaseConnection, member: i64, amount: &str, at: &str) -> i64 {
        let at: DateTime<Utc> = at.parse().unwrap();
        TransactionActiveModel {
            from_user_id: Set(None),
            to_user_id: Set(member),
            to_guild_bank: Set(false),
            amount: Set(amount.parse().unwrap()),
            status: Set(TransactionStatus::Withdrawn.to_string()),
            r#type: Set(crate::service::TYPE_SPLIT_CREDIT.to_string()),
            created_at: Set(at.into()),
            withdrawn_at: Set(Some(at.into())),
            updated_at: Set(at.into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap()
        .id
    }

    async fn insert_split(db: &DatabaseConnection, creator: i64, bags: i64, at: &str) -> i64 {
        use backend_entities::splits::split::ActiveModel as SplitActiveModel;
        let at: DateTime<Utc> = at.parse().unwrap();
        SplitActiveModel {
            created_by: Set(creator),
            status: Set("completed".to_string()),
            estimated_market_value: Set(Decimal::ZERO),
            fee: Set(Decimal::ZERO),
            market_tax: Set(Decimal::ZERO),
            repair_value: Set(Decimal::ZERO),
            bags_value: Set(Decimal::from(bags)),
            net_value: Set(Some(Decimal::ZERO)),
            created_at: Set(at.into()),
            finalized_at: Set(Some(at.into())),
            updated_at: Set(at.into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap()
        .id
    }

    #[tokio::test]
    async fn fill_all_confirms_one_suggestion_per_row_and_never_reuses_a_payout() {
        let db = seed_db().await;
        let actor = insert_user(&db, "officer").await;
        let alice = insert_user(&db, "alice").await;
        let bob = insert_user(&db, "bob").await;
        insert_payout(&db, alice, "1000", "2026-11-14T18:40:00Z").await;
        insert_payout(&db, bob, "2000", "2026-11-14T18:41:00Z").await;
        let service = BankLogService::new();
        service
            .import(
                &db,
                &[
                    row("2026-11-14 18:42:00", "LelouchVI", "Withdrawal", "-1000"),
                    row("2026-11-14 18:42:00", "LelouchVI", "Withdrawal", "-1000"),
                    row("2026-11-14 18:43:00", "LelouchVI", "Withdrawal", "-2000"),
                ],
                actor,
            )
            .await
            .unwrap();

        let best = service.best_suggestions(&db).await.unwrap();
        // Both 1000 rows point at Alice's single payout: only one of them can take it.
        assert_eq!(best.items.len(), 2);
        assert_eq!(best.rows_left_out, 1);
        assert!(best.items.iter().all(|item| item.link.score.unwrap_or(0) >= 75));

        let mut ids: Vec<i64> = best.items.iter().map(|item| item.link.id).collect();
        ids.push(999_999);
        let result = service.confirm_suggestions(&db, &ids, actor).await.unwrap();
        assert_eq!(result.confirmed, 2);
        assert_eq!(result.skipped, 1);
        let summary = service.summary(&db, &BankLogPeriodQuery::default()).await.unwrap();
        assert_eq!(summary.matched, 2);
        assert_eq!(summary.unmatched, 1, "the duplicate withdrawal stays open");
    }

    #[tokio::test]
    async fn bags_paid_in_two_deposits_keep_the_split_open_until_they_add_up() {
        let db = seed_db().await;
        let actor = insert_user(&db, "officer").await;
        let split = insert_split(&db, actor, 1_000, "2026-11-13T10:00:00Z").await;
        let service = BankLogService::new();
        service
            .import(
                &db,
                &[
                    row("2026-11-13 12:00:00", "Stinapse", "Deposit", "400"),
                    row("2026-11-13 15:00:00", "Boozer", "Deposit", "600"),
                ],
                actor,
            )
            .await
            .unwrap();
        let listed = service.list_entries(&db, &BankLogEntryQuery::default()).await.unwrap();
        let first = listed.items.iter().find(|entry| entry.amount == Decimal::from(400)).unwrap();
        let second = listed.items.iter().find(|entry| entry.amount == Decimal::from(600)).unwrap();
        // Neither deposit is the whole bags value: both are partial, low-score suggestions.
        assert_eq!(first.links[0].targets[0].split_id, Some(split));
        assert!(first.links[0].score.unwrap() <= 55);

        service.confirm_link(&db, first.links[0].id, actor).await.unwrap();
        let second = service.get_entry(&db, second.id).await.unwrap();
        assert_eq!(second.status, STATUS_SUGGESTED, "the split still misses 600");

        // Searching again compares the second deposit with what is left: an exact fit.
        let second = service.refresh_entry_suggestions(&db, second.id, actor).await.unwrap();
        let link = &second.links[0];
        assert_eq!(link.targets[0].split_id, Some(split));
        assert!(link.score.unwrap() >= 75, "score {:?}", link.score);
    }

    #[tokio::test]
    async fn searching_again_finds_a_payout_recorded_after_the_import() {
        let db = seed_db().await;
        let actor = insert_user(&db, "officer").await;
        let member = insert_user(&db, "member").await;
        let service = BankLogService::new();
        service
            .import(&db, &[row("2026-11-12 20:08:00", "LelouchVI", "Withdrawal", "-50751000")], actor)
            .await
            .unwrap();
        let entry = service.list_entries(&db, &BankLogEntryQuery::default()).await.unwrap().items[0].clone();
        assert_eq!(entry.status, STATUS_UNMATCHED);

        // Accepted in two steps a few minutes apart; one game withdrawal paid both.
        let a = insert_payout(&db, member, "30000000", "2026-11-12T20:01:00Z").await;
        let b = insert_payout(&db, member, "20751000", "2026-11-12T20:06:30Z").await;
        let entry = service.refresh_entry_suggestions(&db, entry.id, actor).await.unwrap();
        assert_eq!(entry.status, STATUS_SUGGESTED);
        let mut ids: Vec<i64> = entry.links[0].targets.iter().filter_map(|t| t.transaction_id).collect();
        ids.sort_unstable();
        assert_eq!(ids, vec![a, b]);
    }

    #[tokio::test]
    async fn candidates_rank_the_closest_payout_first_and_filter_by_member() {
        let db = seed_db().await;
        let actor = insert_user(&db, "officer").await;
        let alice = insert_user(&db, "alice").await;
        let bob = insert_user(&db, "bob").await;
        insert_payout(&db, alice, "9278388", "2026-11-12T18:00:00Z").await;
        let near = insert_payout(&db, bob, "9278388", "2026-11-14T18:40:00Z").await;
        insert_payout(&db, bob, "1000", "2026-11-14T18:41:00Z").await;
        let service = BankLogService::new();
        service
            .import(&db, &[row("2026-11-14 18:43:00", "LelouchVI", "Withdrawal", "-9278388")], actor)
            .await
            .unwrap();
        let entry = service.list_entries(&db, &BankLogEntryQuery::default()).await.unwrap().items[0].clone();

        let all = service
            .candidates(&db, entry.id, &BankLogCandidateQuery::default())
            .await
            .unwrap();
        assert_eq!(all[0].transaction_ids, vec![near]);
        assert!(all[0].score > all[1].score);
        assert_eq!(all[0].minutes_apart, Some(-3));

        let alice_only = service
            .candidates(
                &db,
                entry.id,
                &BankLogCandidateQuery { search: Some("ALI".to_string()), ..Default::default() },
            )
            .await
            .unwrap();
        assert_eq!(alice_only.len(), 1);
        assert_eq!(alice_only[0].member_username.as_deref(), Some("alice"));
    }

    #[tokio::test]
    async fn without_game_rows_the_manager_payouts_are_not_compared() {
        let db = seed_db().await;
        let actor = insert_user(&db, "officer").await;
        let member = insert_user(&db, "member").await;
        let paid_at: DateTime<Utc> = "2026-11-16T22:00:00Z".parse().unwrap();
        TransactionActiveModel {
            from_user_id: Set(Some(actor)),
            to_user_id: Set(member),
            to_guild_bank: Set(false),
            amount: Set("5000000.00".parse().unwrap()),
            status: Set(TransactionStatus::Withdrawn.to_string()),
            r#type: Set(crate::service::TYPE_SPLIT_CREDIT.to_string()),
            created_at: Set(paid_at.into()),
            withdrawn_at: Set(Some(paid_at.into())),
            updated_at: Set(paid_at.into()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .unwrap();
        let summary = BankLogService::new()
            .summary(&db, &BankLogPeriodQuery {
                from: Some("2026-11-01".to_string()),
                to: Some("2026-11-17".to_string()),
            })
            .await
            .unwrap();
        assert_eq!(summary.manager_payouts, Decimal::ZERO);
        assert_eq!(summary.covered_from, None);
    }

    #[tokio::test]
    async fn a_row_creates_at_most_one_transaction() {
        let db = seed_db().await;
        let actor = insert_user(&db, "officer").await;
        let member = insert_user(&db, "member").await;
        let service = BankLogService::new();
        service
            .import(
                &db,
                &[row("2026-11-12 14:51:00", "Volantibus", "Withdrawal", "-7594141")],
                actor,
            )
            .await
            .unwrap();
        let entry = EntryEntity::find().one(&db).await.unwrap().unwrap();
        let req = BankLogCreateEntryTransactionRequest {
            to_user_id: member,
            amount: None,
        };
        let view = service.create_transaction(&db, entry.id, &req, actor).await.unwrap();
        assert_eq!(view.status, STATUS_MATCHED);
        let transaction_id = view.created_transaction_id.unwrap();
        let created = TransactionEntity::find_by_id(transaction_id)
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(created.amount, Decimal::from(7_594_141));
        assert_eq!(created.status, TransactionStatus::Withdrawn.to_string());

        let again = service.create_transaction(&db, entry.id, &req, actor).await;
        assert!(matches!(again, Err(AppError::Conflict(_))));
        // Deleting the transaction does not re-open the row for a second one.
        TransactionEntity::delete_by_id(transaction_id).exec(&db).await.unwrap();
        let after_delete = service.create_transaction(&db, entry.id, &req, actor).await;
        assert!(matches!(after_delete, Err(AppError::Conflict(_))));
    }

    #[tokio::test]
    async fn explaining_a_row_needs_a_note() {
        let db = seed_db().await;
        let actor = insert_user(&db, "officer").await;
        let service = BankLogService::new();
        service
            .import(&db, &[row("2026-11-12 15:02:00", "Someone", "Deposit", "1000")], actor)
            .await
            .unwrap();
        let entry = EntryEntity::find().one(&db).await.unwrap().unwrap();
        let refused = service
            .update_entry(
                &db,
                entry.id,
                &BankLogUpdateEntryRequest {
                    explained: Some(true),
                    ..Default::default()
                },
                actor,
            )
            .await;
        assert!(matches!(refused, Err(AppError::Validation(_))));
        let explained = service
            .update_entry(
                &db,
                entry.id,
                &BankLogUpdateEntryRequest {
                    note: Some("Donation for the vault".to_string()),
                    explained: Some(true),
                    category: Some("donation".to_string()),
                },
                actor,
            )
            .await
            .unwrap();
        assert_eq!(explained.status, STATUS_EXPLAINED);
        assert_eq!(explained.category, "donation");
    }
}
