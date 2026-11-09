//! Bank service logic module.
//!
//! Provides the Guild Bank ledger: derived balances, transaction listing, and the two-step
//! withdrawal workflow (a user requests withdrawal of their requestable transactions, then an
//! officer accepts and pays them out — becoming the recorded payer via `from_user_id`).
//! Request/response types live in `models.rs`; the status enum lives in `status.rs`.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    str::FromStr,
};

use sea_orm::prelude::Decimal;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait,
    DatabaseConnection, DatabaseTransaction, DbBackend, EntityTrait, JoinType, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, RelationTrait, Statement, TransactionTrait,
};

use crate::errors::AppError;
use crate::modules::albion::entities::albion_link::{
    Column as AlbionLinkColumn, Entity as AlbionLinkEntity,
};
use crate::modules::splits::entities::split::{Column as SplitColumn, Entity as SplitEntity};
use crate::modules::splits::status::SplitStatus;
use crate::modules::users::entities::{Column as UserColumn, Entity as UserEntity};
use crate::pagination::{
    PaginatedData, PaginationParams, SortOrder, paginate_vec, resolve_sort_key,
};

use super::entities::{ActiveModel, Column, Entity as TransactionEntity, Model};
use super::models::{
    AcceptWithdrawalRequest, BalanceSummary, CreateTransactionRequest, GuildBankSummary,
    RejectWithdrawalRequest, TransactionFilters, TransactionView, UpdateTransactionRequest,
    WithdrawRequest,
};
use super::status::TransactionStatus;

/// The transaction type generated when a split is completed.
pub const TYPE_SPLIT_CREDIT: &str = "split_credit";
/// The transaction type recorded when a member donates their split share back to the guild.
pub const TYPE_SPLIT_DONATION: &str = "split_donation";
/// The transaction type recorded when an administrator manually creates a transaction.
pub const TYPE_MANUAL: &str = "manual_adjustment";

fn parse_status(model: &Model) -> Result<TransactionStatus, AppError> {
    TransactionStatus::from_str(&model.status)
        .map_err(|_| AppError::Internal(format!("Unknown transaction status: {}", model.status)))
}

/// Shared predicate for positive balances and withdrawal requests.
///
/// A rejected withdrawal should behave like available balance, but keeping this predicate in one
/// place prevents the acceptance path from accidentally treating rejected rows as payable.
///
/// # Example
/// ```rust,ignore
/// let query = TransactionEntity::find().filter(requestable_transaction_condition());
/// ```
fn requestable_transaction_condition() -> Condition {
    Condition::all()
        .add(
            Condition::any()
                .add(Column::Status.eq(TransactionStatus::Pending.to_string()))
                .add(Column::Status.eq(TransactionStatus::Rejected.to_string())),
        )
        .add(Column::Amount.gt(Decimal::ZERO))
}

/// Serializes balance checks for one member inside the current transaction.
///
/// Withdrawal requests on different rows otherwise each observe the same net
/// requestable total and can both pass. The lock is transaction-scoped and
/// includes the schema name so tenant pools that share a database do not block
/// each other. SQLite unit tests have no equivalent; the invariant is covered
/// by the Postgres integration test.
async fn serialize_user_requestable_balance<C>(db: &C, user_id: i64) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    if db.get_database_backend() != DbBackend::Postgres {
        return Ok(());
    }
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT pg_advisory_xact_lock(hashtextextended(current_schema(), $1))",
        [user_id.into()],
    ))
    .await?;
    Ok(())
}

/// Settled split clawbacks: already confirmed, still reduce what the member can withdraw.
fn confirmed_clawback_condition() -> Condition {
    Condition::all()
        .add(Column::Status.eq(TransactionStatus::Withdrawn.to_string()))
        .add(Column::Amount.lt(Decimal::ZERO))
        .add(Column::Type.eq(TYPE_SPLIT_CREDIT))
}

/// Resolves recipient ids using the same names that transaction views display.
///
/// Linked recipients are shown with their Albion character name, not their
/// Discord username. Searching only `users.username` would therefore make a
/// visible recipient impossible to find after linking an Albion character.
async fn recipient_ids_matching_search(
    db: &DatabaseConnection,
    term: &str,
) -> Result<Vec<i64>, AppError> {
    let pattern = format!("%{}%", term.to_lowercase());
    let linked_discord_ids = AlbionLinkEntity::find()
        .filter(
            Expr::expr(Func::lower(Expr::col(AlbionLinkColumn::AlbionPlayerName)))
                .like(pattern.clone()),
        )
        .all(db)
        .await?
        .into_iter()
        .map(|link| link.discord_id)
        .collect::<Vec<_>>();

    let username_match = Expr::expr(Func::lower(Expr::col(UserColumn::Username))).like(pattern);
    let query = if linked_discord_ids.is_empty() {
        UserEntity::find().filter(username_match)
    } else {
        UserEntity::find().filter(
            Condition::any()
                .add(username_match)
                .add(UserColumn::DiscordId.is_in(linked_discord_ids)),
        )
    };

    Ok(query
        .all(db)
        .await?
        .into_iter()
        .map(|user| user.id)
        .collect())
}

/// Statuses of ledger rows that are still unsettled (the only rows consolidation may touch).
fn open_credit_statuses() -> [String; 2] {
    [
        TransactionStatus::Pending.to_string(),
        TransactionStatus::Rejected.to_string(),
    ]
}

/// `true` for a split-linked `split_credit` row: the only kind consolidation folds. Manual
/// adjustments that merely reference a split are never merged, absorbed or deleted.
fn is_split_credit_row(row: &Model) -> bool {
    row.r#type == TYPE_SPLIT_CREDIT && row.split_id.is_some()
}

/// What [`plan_open_credit_consolidation`] decided to change. Ids only reference rows the planner
/// was given, so a caller can apply it with status guards and detect concurrent edits.
#[derive(Debug, Default, PartialEq)]
struct OpenCreditPlan {
    /// Open rows whose amount changes (merged duplicates, or reduced by absorbed clawbacks).
    open_updates: Vec<(i64, Decimal)>,
    /// Open rows that disappear (merged into a sibling, or fully absorbed).
    open_deletes: Vec<i64>,
    /// Confirmed clawback rows that were fully absorbed or merged.
    clawback_deletes: Vec<i64>,
    /// The surviving clawback row and its remaining (negative) amount.
    clawback_update: Option<(i64, Decimal)>,
}

impl OpenCreditPlan {
    fn is_noop(&self) -> bool {
        self.open_updates.is_empty()
            && self.open_deletes.is_empty()
            && self.clawback_deletes.is_empty()
            && self.clawback_update.is_none()
    }

    /// Returns the open rows and clawbacks as they will look once the plan is applied. Reads use
    /// this to report the consolidated balance without writing anything.
    fn apply_in_memory(&self, open: &[Model], clawbacks: &[Model]) -> (Vec<Model>, Vec<Model>) {
        let amounts: HashMap<i64, Decimal> = self.open_updates.iter().copied().collect();
        let deleted: HashSet<i64> = self.open_deletes.iter().copied().collect();
        let open = open
            .iter()
            .filter(|row| !deleted.contains(&row.id))
            .map(|row| {
                let mut row = row.clone();
                if let Some(amount) = amounts.get(&row.id) {
                    row.amount = *amount;
                }
                row
            })
            .collect();
        let deleted: HashSet<i64> = self.clawback_deletes.iter().copied().collect();
        let clawbacks = clawbacks
            .iter()
            .filter(|row| !deleted.contains(&row.id))
            .map(|row| {
                let mut row = row.clone();
                if let Some((id, amount)) = self.clawback_update
                    && id == row.id
                {
                    row.amount = amount;
                }
                row
            })
            .collect();
        (open, clawbacks)
    }
}

/// Pure planner behind consolidation. Given a member's open (`Pending`/`Rejected`) rows and
/// confirmed clawbacks, it decides how to:
/// 1. merge multiple open `split_credit` rows of the same split into one row with their sum,
/// 2. absorb confirmed clawbacks (and non-positive open split rows) into the open credits, split
///    credits first and oldest first, so that the open rows add up to what the member can really
///    withdraw (every positive open row is requestable, whatever its type).
///
/// Debt is never dropped: whatever the open credits cannot absorb stays on a surviving clawback
/// (or, with no clawback, on the first non-positive open split row).
fn plan_open_credit_consolidation(open_rows: &[Model], clawbacks: &[Model]) -> OpenCreditPlan {
    let mut plan = OpenCreditPlan::default();

    let non_positive: Vec<&Model> = open_rows
        .iter()
        .filter(|row| is_split_credit_row(row) && row.amount <= Decimal::ZERO)
        .collect();
    let mut debt: Decimal = clawbacks.iter().map(|c| -c.amount).sum::<Decimal>()
        + non_positive.iter().map(|row| -row.amount).sum::<Decimal>();

    // 1. Merge positive open rows per split; other positive open rows pass through.
    let mut by_split: BTreeMap<i64, Vec<&Model>> = BTreeMap::new();
    let mut candidates: Vec<(i64, Decimal)> = Vec::new();
    let mut original: HashMap<i64, Decimal> = HashMap::new();
    for row in open_rows.iter().filter(|row| row.amount > Decimal::ZERO) {
        original.insert(row.id, row.amount);
        match row.split_id {
            Some(split_id) if row.r#type == TYPE_SPLIT_CREDIT => {
                by_split.entry(split_id).or_default().push(row);
            }
            _ => candidates.push((row.id, row.amount)),
        }
    }
    for rows in by_split.values() {
        let Some(first) = rows.first() else { continue };
        candidates.push((first.id, rows.iter().map(|row| row.amount).sum()));
        plan.open_deletes
            .extend(rows.iter().skip(1).map(|row| row.id));
    }
    // Split credits absorb first (oldest first), so other open credits (giveaway, regear,
    // manual) are only reduced once the split credits cannot cover the debt.
    let split_ids: HashSet<i64> = open_rows
        .iter()
        .filter(|row| is_split_credit_row(row))
        .map(|row| row.id)
        .collect();
    candidates.sort_by_key(|(id, _)| (!split_ids.contains(id), *id));

    // 2. Absorb the debt oldest-first.
    let mut survivors: Vec<(i64, Decimal)> = Vec::with_capacity(candidates.len());
    for (id, amount) in candidates {
        if debt <= Decimal::ZERO {
            survivors.push((id, amount));
        } else if amount <= debt {
            debt = (debt - amount).round_dp(2);
            plan.open_deletes.push(id);
        } else {
            survivors.push((id, (amount - debt).round_dp(2)));
            debt = Decimal::ZERO;
        }
    }
    for (id, amount) in survivors {
        if original.get(&id) != Some(&amount) {
            plan.open_updates.push((id, amount));
        }
    }

    // 3. Settle the debt bookkeeping.
    if debt <= Decimal::ZERO {
        plan.clawback_deletes.extend(clawbacks.iter().map(|c| c.id));
        plan.open_deletes.extend(non_positive.iter().map(|r| r.id));
    } else if let Some(first) = clawbacks.first() {
        plan.clawback_deletes
            .extend(clawbacks.iter().skip(1).map(|c| c.id));
        if first.amount != -debt {
            plan.clawback_update = Some((first.id, -debt));
        }
        plan.open_deletes.extend(non_positive.iter().map(|r| r.id));
    } else if let Some(first) = non_positive.first() {
        plan.open_deletes
            .extend(non_positive.iter().skip(1).map(|r| r.id));
        if first.amount != -debt {
            plan.open_updates.push((first.id, -debt));
        }
    }
    plan.open_deletes.sort_unstable();
    plan.open_deletes.dedup();
    plan
}

/// Loads a member's open rows and confirmed clawbacks. Inside a Postgres transaction the rows are
/// locked (`FOR UPDATE`) so the plan cannot be computed from rows another writer is changing.
async fn load_open_credit_state<C>(
    db: &C,
    user_id: i64,
    lock: bool,
) -> Result<(Vec<Model>, Vec<Model>), AppError>
where
    C: ConnectionTrait,
{
    let lock = lock && db.get_database_backend() == DbBackend::Postgres;
    let mut open = TransactionEntity::find()
        .filter(Column::ToUserId.eq(user_id))
        .filter(Column::Status.is_in(open_credit_statuses()))
        .order_by_asc(Column::Id);
    let mut claw = TransactionEntity::find()
        .filter(Column::ToUserId.eq(user_id))
        .filter(confirmed_clawback_condition())
        .order_by_asc(Column::Id);
    if lock {
        open = open.lock_exclusive();
        claw = claw.lock_exclusive();
    }
    Ok((open.all(db).await?, claw.all(db).await?))
}

/// Starts a transaction for multi-statement reads: a read-only `REPEATABLE READ` snapshot on
/// Postgres, a plain transaction on SQLite (whose in-memory pool already serialises).
async fn begin_read_snapshot(db: &DatabaseConnection) -> Result<DatabaseTransaction, AppError> {
    if db.get_database_backend() == DbBackend::Postgres {
        Ok(db
            .begin_with_config(
                Some(sea_orm::IsolationLevel::RepeatableRead),
                Some(sea_orm::AccessMode::ReadOnly),
            )
            .await?)
    } else {
        Ok(db.begin().await?)
    }
}

fn concurrent_ledger_edit() -> AppError {
    AppError::Conflict("the member's ledger changed while it was being consolidated".to_string())
}

/// Applies a consolidation to the ledger. Explicit mutation paths only (never reads): the caller
/// owns the transaction and has taken [`serialize_user_requestable_balance`].
///
/// Every write is guarded by `status`/`type` in its own predicate and must hit exactly the rows
/// planned. A row that was withdrawn, requested or edited in the meantime makes the whole
/// consolidation fail with a conflict (and roll back) instead of overwriting or deleting it.
/// Amounts are updated before rows are deleted.
async fn consolidate_user_open_credits(
    txn: &DatabaseTransaction,
    user_id: i64,
) -> Result<(), AppError> {
    let (open_rows, clawbacks) = load_open_credit_state(txn, user_id, true).await?;
    let plan = plan_open_credit_consolidation(&open_rows, &clawbacks);
    if plan.is_noop() {
        return Ok(());
    }
    let now: sea_orm::prelude::DateTimeWithTimeZone = chrono::Utc::now().into();

    // Rows are guarded by the type they had when planned: absorption may reduce or delete any
    // open credit (as before), but never a row that changed kind in the meantime.
    let open_types: HashMap<i64, String> = open_rows
        .iter()
        .map(|row| (row.id, row.r#type.clone()))
        .collect();
    let open_guard = |id: i64| -> Result<Condition, AppError> {
        let row_type = open_types.get(&id).ok_or_else(concurrent_ledger_edit)?;
        Ok(Condition::all()
            .add(Column::Id.eq(id))
            .add(Column::Status.is_in(open_credit_statuses()))
            .add(Column::Type.eq(row_type.as_str()))
            .add(Column::ToUserId.eq(user_id)))
    };
    let clawback_guard = || {
        Condition::all()
            .add(confirmed_clawback_condition())
            .add(Column::ToUserId.eq(user_id))
    };

    for (id, amount) in &plan.open_updates {
        let updated = TransactionEntity::update_many()
            .col_expr(Column::Amount, Expr::value(*amount))
            .col_expr(Column::UpdatedAt, Expr::value(now))
            .filter(open_guard(*id)?)
            .exec(txn)
            .await?;
        if updated.rows_affected != 1 {
            return Err(concurrent_ledger_edit());
        }
    }
    if let Some((id, amount)) = plan.clawback_update {
        let updated = TransactionEntity::update_many()
            .col_expr(Column::Amount, Expr::value(amount))
            .col_expr(Column::UpdatedAt, Expr::value(now))
            .filter(Column::Id.eq(id))
            .filter(clawback_guard())
            .exec(txn)
            .await?;
        if updated.rows_affected != 1 {
            return Err(concurrent_ledger_edit());
        }
    }
    for id in &plan.open_deletes {
        let deleted = TransactionEntity::delete_many()
            .filter(open_guard(*id)?)
            .exec(txn)
            .await?;
        if deleted.rows_affected != 1 {
            return Err(concurrent_ledger_edit());
        }
    }
    if !plan.clawback_deletes.is_empty() {
        let deleted = TransactionEntity::delete_many()
            .filter(Column::Id.is_in(plan.clawback_deletes.clone()))
            .filter(clawback_guard())
            .exec(txn)
            .await?;
        if deleted.rows_affected != plan.clawback_deletes.len() as u64 {
            return Err(concurrent_ledger_edit());
        }
    }
    Ok(())
}

/// Net amount a member can still request, given their open rows and confirmed clawbacks
/// (non-positive open split rows that could not be absorbed count as debt too).
fn net_of_open_state(open_rows: &[Model], clawbacks: &[Model]) -> Decimal {
    open_rows
        .iter()
        .filter(|row| row.amount > Decimal::ZERO || is_split_credit_row(row))
        .chain(clawbacks.iter())
        .fold(Decimal::ZERO, |acc, row| acc + row.amount)
}

async fn net_requestable_total(
    db: &impl ConnectionTrait,
    user_id: i64,
) -> Result<Decimal, AppError> {
    let (open_rows, clawbacks) = load_open_credit_state(db, user_id, false).await?;
    Ok(net_of_open_state(&open_rows, &clawbacks))
}

async fn touch_linked_splits<C>(db: &C, transactions: &[Model]) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let split_ids: Vec<i64> = transactions
        .iter()
        .filter_map(|transaction| transaction.split_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if split_ids.is_empty() {
        return Ok(());
    }

    SplitEntity::update_many()
        .col_expr(SplitColumn::UpdatedAt, Expr::value(chrono::Utc::now()))
        .filter(SplitColumn::Id.is_in(split_ids))
        .exec(db)
        .await?;
    Ok(())
}

/// Bumps `updated_at` on the given splits directly, for callers that already have the split ids
/// (rather than a batch of `Model`s to extract them from, like [`touch_linked_splits`] does).
async fn touch_split_ids<C>(db: &C, split_ids: &[i64]) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    if split_ids.is_empty() {
        return Ok(());
    }
    SplitEntity::update_many()
        .col_expr(SplitColumn::UpdatedAt, Expr::value(chrono::Utc::now()))
        .filter(SplitColumn::Id.is_in(split_ids.to_vec()))
        .exec(db)
        .await?;
    Ok(())
}

pub(crate) async fn to_views_with_usernames(
    db: &DatabaseConnection,
    models: Vec<Model>,
) -> Result<Vec<TransactionView>, AppError> {
    let from_user_ids: Vec<i64> = models.iter().filter_map(|m| m.from_user_id).collect();
    let to_user_ids: Vec<i64> = models.iter().map(|m| m.to_user_id).collect();

    let all_user_ids: Vec<i64> = from_user_ids
        .iter()
        .chain(to_user_ids.iter())
        .copied()
        .collect();
    let user_map = crate::modules::users::display_name::resolve_by_ids(db, &all_user_ids).await?;

    let mut views = Vec::with_capacity(models.len());
    for model in models {
        let status = parse_status(&model)?;
        let from_username = model.from_user_id.and_then(|id| user_map.get(&id).cloned());
        let to_username = user_map
            .get(&model.to_user_id)
            .cloned()
            .unwrap_or_else(|| "Unknown".to_string());
        views.push(TransactionView::from_model(
            model,
            status,
            from_username,
            to_username,
        ));
    }

    Ok(views)
}

/// Service for executing business logic operations related to the Guild Bank ledger.
pub struct BankService;

impl BankService {
    /// Creates a new instance of the `BankService`.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Computes the derived balance for a user: what's requestable and what's requested.
    ///
    /// Rejected withdrawals are included in the requestable side because they must be explicitly
    /// requested again before an officer can accept them. Confirmed split clawbacks (negative
    /// withdrawn credits) reduce `pending_total` immediately so they cannot be cashed out.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Database` if the query fails.
    pub async fn get_balance(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
    ) -> Result<BalanceSummary, AppError> {
        // Read-only: report the balance as consolidation would leave it, without writing.
        // Consolidation itself only runs inside `request_withdrawal`.
        // All reads share one snapshot so a withdrawal request landing in between cannot make
        // a row count as both open and requested.
        let snapshot = begin_read_snapshot(db).await?;
        let (open_rows, clawbacks) = load_open_credit_state(&snapshot, user_id, false).await?;
        let requested = TransactionEntity::find()
            .filter(Column::ToUserId.eq(user_id))
            .filter(Column::Status.eq(TransactionStatus::Requested.to_string()))
            .all(&snapshot)
            .await?;
        snapshot.commit().await?;
        let plan = plan_open_credit_consolidation(&open_rows, &clawbacks);
        let (open_rows, clawbacks) = plan.apply_in_memory(&open_rows, &clawbacks);
        let pending_total = net_of_open_state(&open_rows, &clawbacks);
        let pending_count = open_rows
            .iter()
            .filter(|row| row.amount > Decimal::ZERO)
            .count() as u64;

        let requested_total = requested
            .iter()
            .fold(Decimal::ZERO, |acc, tx| acc + tx.amount);

        Ok(BalanceSummary {
            user_id,
            pending_total,
            pending_count,
            requested_total,
            requested_count: requested.len() as u64,
            guilds: Vec::new(),
            unavailable_guilds: Vec::new(),
        })
    }

    /// Computes the guild-wide aggregate of settled (`withdrawn`) payouts.
    ///
    /// Unlike `get_balance`, this is intentionally global: the dashboard surfaces it as
    /// a single "how much the guild has paid out" metric, with no per-member breakdown
    /// leaking through (only the aggregate total and count are returned).
    ///
    /// # Errors
    ///
    /// Returns `AppError::Database` if the query fails.
    pub async fn get_guild_summary(
        &self,
        db: &DatabaseConnection,
    ) -> Result<GuildBankSummary, AppError> {
        let withdrawn = TransactionEntity::find()
            .filter(Column::Status.eq(TransactionStatus::Withdrawn.to_string()))
            .all(db)
            .await?;

        let paid_total = withdrawn
            .iter()
            .fold(Decimal::ZERO, |acc, tx| acc + tx.amount);

        Ok(GuildBankSummary {
            paid_total,
            paid_count: withdrawn.len() as u64,
            unavailable_guilds: Vec::new(),
        })
    }

    /// Computes the guild-wide money-flow report used by the administrator bank panel.
    ///
    /// The report intentionally aggregates the immutable ledger rows rather than deriving
    /// balances from the current page of a paginated list. Donation rows use their explicit
    /// virtual destination flag, while withdrawn rows keep the officer who paid them as source.
    pub async fn get_analytics_summary(
        &self,
        db: &DatabaseConnection,
    ) -> Result<super::models::BankAnalyticsSummary, AppError> {
        let models = TransactionEntity::find().all(db).await?;
        let user_ids: Vec<i64> = models
            .iter()
            .flat_map(|model| [model.from_user_id, Some(model.to_user_id)])
            .flatten()
            .collect();
        let user_map = crate::modules::users::display_name::resolve_by_ids(db, &user_ids).await?;

        let mut summary = super::models::BankAnalyticsSummary {
            transaction_count: models.len() as u64,
            ledger_volume: Decimal::ZERO,
            outstanding_total: Decimal::ZERO,
            outstanding_count: 0,
            requested_total: Decimal::ZERO,
            requested_count: 0,
            paid_out_total: Decimal::ZERO,
            paid_out_count: 0,
            donated_total: Decimal::ZERO,
            donated_count: 0,
            sources: Vec::new(),
            destinations: Vec::new(),
            transaction_types: Vec::new(),
            unavailable_guilds: Vec::new(),
        };
        let mut sources = HashMap::new();
        let mut destinations = HashMap::new();
        let mut transaction_types = HashMap::new();

        for model in models {
            let status = parse_status(&model)?;
            summary.ledger_volume += model.amount;
            add_breakdown(
                &mut sources,
                model
                    .from_user_id
                    .and_then(|id| user_map.get(&id).cloned())
                    .unwrap_or_else(|| "Guild Bank".to_string()),
                model.amount,
            );
            add_breakdown(
                &mut destinations,
                if model.to_guild_bank {
                    "Guild Bank".to_string()
                } else {
                    user_map
                        .get(&model.to_user_id)
                        .cloned()
                        .unwrap_or_else(|| "Unknown".to_string())
                },
                model.amount,
            );
            add_breakdown(&mut transaction_types, model.r#type.clone(), model.amount);

            match status {
                TransactionStatus::Pending | TransactionStatus::Rejected => {
                    summary.outstanding_total += model.amount;
                    summary.outstanding_count += 1;
                }
                TransactionStatus::Requested => {
                    summary.outstanding_total += model.amount;
                    summary.outstanding_count += 1;
                    summary.requested_total += model.amount;
                    summary.requested_count += 1;
                }
                TransactionStatus::Withdrawn => {
                    summary.paid_out_total += model.amount;
                    summary.paid_out_count += 1;
                }
                TransactionStatus::Donated => {
                    summary.donated_total += model.amount;
                    summary.donated_count += 1;
                }
            }
        }

        summary.sources = finish_breakdown(sources);
        summary.destinations = finish_breakdown(destinations);
        summary.transaction_types = finish_breakdown(transaction_types);
        Ok(summary)
    }

    /// Donates the caller's own requestable split credit to the virtual Guild Bank.
    ///
    /// The update is guarded by ownership, split linkage, transaction type, and current status
    /// in the same database transaction as the read-back. This makes a repeated or racing request
    /// fail instead of creating a second donation or reviving a withdrawal.
    pub async fn donate_split_share(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
        user_id: i64,
    ) -> Result<TransactionView, AppError> {
        let txn = db.begin().await?;
        let split = SplitEntity::find_by_id(split_id)
            .one(&txn)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Split {split_id} not found")))?;
        if split.status != SplitStatus::Completed.to_string() {
            return Err(AppError::Validation(
                "only a completed split can be donated".to_string(),
            ));
        }
        let candidates = TransactionEntity::find()
            .filter(Column::SplitId.eq(split_id))
            .filter(Column::ToUserId.eq(user_id))
            .filter(Column::Type.eq(TYPE_SPLIT_CREDIT))
            .filter(requestable_transaction_condition())
            .all(&txn)
            .await?;

        let Some(candidate) = candidates.into_iter().next() else {
            return Err(AppError::Conflict(
                "no requestable split share is available for this user".to_string(),
            ));
        };
        let net = net_requestable_total(&txn, user_id).await?;
        if candidate.amount > net {
            return Err(AppError::Conflict(
                "no requestable split share is available for this user".to_string(),
            ));
        }

        let updated = TransactionEntity::update_many()
            .filter(Column::Id.eq(candidate.id))
            .filter(requestable_transaction_condition())
            .set(ActiveModel {
                from_user_id: Set(Some(user_id)),
                to_guild_bank: Set(true),
                status: Set(TransactionStatus::Donated.to_string()),
                r#type: Set(TYPE_SPLIT_DONATION.to_string()),
                requested_at: Set(None),
                withdrawn_at: Set(None),
                ..Default::default()
            })
            .exec(&txn)
            .await?;

        if updated.rows_affected != 1 {
            return Err(AppError::Conflict(
                "the split share is no longer available for donation".to_string(),
            ));
        }

        let updated_model = TransactionEntity::find_by_id(candidate.id)
            .one(&txn)
            .await?
            .ok_or_else(|| AppError::Internal("donated transaction disappeared".to_string()))?;
        touch_linked_splits(&txn, std::slice::from_ref(&updated_model)).await?;
        txn.commit().await?;

        crate::modules::audit::service::AuditService::log(
            db,
            "SPLIT_SHARE_DONATED",
            Some("TRANSACTION"),
            Some(updated_model.id),
            Some(user_id),
            Some(serde_json::json!({
                "split_id": split_id,
                "amount": updated_model.amount,
                "from_user_id": user_id,
                "destination": "Guild Bank",
                "type": TYPE_SPLIT_DONATION
            })),
        )
        .await?;

        let mut views = to_views_with_usernames(db, vec![updated_model]).await?;
        views
            .pop()
            .ok_or_else(|| AppError::Internal("donated transaction view missing".to_string()))
    }

    /// Lists paginated transactions owed to a user, optionally filtered by status.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Validation` for an unknown `sort` column or `AppError::Database` if the
    /// query fails.
    pub async fn list_transactions(
        &self,
        db: &DatabaseConnection,
        user_id: Option<i64>,
        pagination: &PaginationParams,
        filters: &TransactionFilters,
    ) -> Result<PaginatedData<TransactionView>, AppError> {
        let mut query = TransactionEntity::find();

        if let Some(uid) = user_id {
            query = query.filter(Column::ToUserId.eq(uid));
        }

        if let Some(status) = filters.status {
            query = query.filter(Column::Status.eq(status.to_string()));
        }

        if let Some(split_id) = filters.split_id {
            query = query.filter(Column::SplitId.eq(split_id));
        }

        let search = filters
            .search
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let sort_key = resolve_sort_key(
            filters.sort.as_deref(),
            &[
                ("created_at", "created_at"),
                ("amount", "amount"),
                ("status", "status"),
                ("to_username", "to_username"),
            ],
            "created_at",
        )?;
        if let Some(term) = search {
            let matching_user_ids = recipient_ids_matching_search(db, term).await?;
            if matching_user_ids.is_empty() {
                return Ok(paginate_vec(Vec::<TransactionView>::new(), pagination));
            }
            query = query.filter(Column::ToUserId.is_in(matching_user_ids));
        }
        let needs_user_join = sort_key == "to_username";
        if needs_user_join {
            query = query.join(JoinType::InnerJoin, super::entities::Relation::ToUser.def());
        }

        let order = SortOrder::from_query(filters.order.as_deref());
        query = match sort_key {
            "amount" => match order {
                SortOrder::Asc => query.order_by_asc(Column::Amount),
                SortOrder::Desc => query.order_by_desc(Column::Amount),
            },
            "status" => match order {
                SortOrder::Asc => query.order_by_asc(Column::Status),
                SortOrder::Desc => query.order_by_desc(Column::Status),
            },
            "to_username" => match order {
                SortOrder::Asc => query.order_by_asc(UserColumn::Username),
                SortOrder::Desc => query.order_by_desc(UserColumn::Username),
            },
            _ => match order {
                SortOrder::Asc => query.order_by_asc(Column::CreatedAt),
                SortOrder::Desc => query.order_by_desc(Column::CreatedAt),
            },
        };
        query = match order {
            SortOrder::Asc => query.order_by_asc(Column::Id),
            SortOrder::Desc => query.order_by_desc(Column::Id),
        };

        let limit = pagination.limit();
        let page = pagination.offset_page();

        let paginator = query.paginate(db, limit);
        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let models = paginator.fetch_page(page).await?;

        let items = to_views_with_usernames(db, models).await?;

        Ok(PaginatedData::new(
            items,
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }

    /// Requests withdrawal of one, several, or all of a user's requestable transactions, moving
    /// them to `"requested"` status. Does not pay them out — an officer must accept via
    /// [`Self::accept_withdrawal`].
    ///
    /// A transaction can only have its withdrawal requested if it belongs to the caller and is
    /// pending or rejected — this is enforced directly by the update predicate.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::Validation` if neither `transaction_ids` nor `all` is provided, or if
    ///   one or more requested transaction ids are not the caller's or are not requestable.
    /// * Returns `AppError::Database` if the query fails.
    pub async fn request_withdrawal(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
        req: &WithdrawRequest,
    ) -> Result<Vec<TransactionView>, AppError> {
        let withdraw_all = req.all.unwrap_or(false);
        let requested_ids = if withdraw_all {
            None
        } else {
            match &req.transaction_ids {
                Some(ids) if !ids.is_empty() => Some(ids.clone()),
                _ => {
                    return Err(AppError::Validation(
                        "must provide transaction_ids or all=true".to_string(),
                    ));
                }
            }
        };

        let txn = db.begin().await?;
        serialize_user_requestable_balance(&txn, user_id).await?;
        if withdraw_all {
            consolidate_user_open_credits(&txn, user_id).await?;
        }

        let ids = match requested_ids {
            Some(ids) => ids,
            None => TransactionEntity::find()
                .filter(Column::ToUserId.eq(user_id))
                .filter(requestable_transaction_condition())
                .all(&txn)
                .await?
                .into_iter()
                .map(|tx| tx.id)
                .collect(),
        };

        if ids.is_empty() {
            txn.commit().await?;
            return Ok(Vec::new());
        }

        let targets = TransactionEntity::find()
            .filter(Column::Id.is_in(ids.clone()))
            .filter(Column::ToUserId.eq(user_id))
            .filter(requestable_transaction_condition())
            .all(&txn)
            .await?;

        if targets.len() != ids.len() {
            return Err(AppError::Validation(
                "one or more transactions are not yours or are not requestable".to_string(),
            ));
        }

        let pending_total = net_requestable_total(&txn, user_id).await?;
        let selected_sum = targets
            .iter()
            .fold(Decimal::ZERO, |acc, tx| acc + tx.amount);
        if selected_sum > pending_total {
            return Err(AppError::Validation(
                "cannot request more than the net requestable balance".to_string(),
            ));
        }

        let mut updated_models = Vec::with_capacity(targets.len());
        let now = chrono::Utc::now().into();
        for model in targets {
            // Re-check the status as part of the write itself: a concurrent request could have
            // moved this row out of the requestable statuses between the `SELECT` above and here.
            // A losing request is skipped rather than silently re-requesting a stale row.
            let update = TransactionEntity::update_many()
                .filter(Column::Id.eq(model.id))
                .filter(requestable_transaction_condition())
                .set(ActiveModel {
                    status: Set(TransactionStatus::Requested.to_string()),
                    requested_at: Set(Some(now)),
                    updated_at: Set(now),
                    ..Default::default()
                })
                .exec(&txn)
                .await?;

            if update.rows_affected != 1 {
                continue;
            }

            let updated = TransactionEntity::find_by_id(model.id)
                .one(&txn)
                .await?
                .ok_or_else(|| {
                    AppError::Internal("requested transaction disappeared".to_string())
                })?;
            updated_models.push(updated);
        }

        touch_linked_splits(&txn, &updated_models).await?;
        txn.commit().await?;

        for updated in &updated_models {
            let _ = crate::modules::audit::service::AuditService::log(
                db,
                "WITHDRAW_REQUESTED",
                Some("TRANSACTION"),
                Some(updated.id),
                Some(user_id),
                Some(serde_json::json!({
                    "status": "requested",
                    "split_id": updated.split_id
                })),
            )
            .await;
        }

        let updated_views = to_views_with_usernames(db, updated_models).await?;

        Ok(updated_views)
    }

    /// Accepts (and pays out) one, several, or all currently-requested withdrawals. The accepting
    /// officer is recorded as `from_user_id` — the payer.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::Validation` if neither `transaction_ids` nor `all` is provided, or if
    ///   one or more requested transaction ids are not currently in `"requested"` status.
    /// * Returns `AppError::Database` if the query fails.
    pub async fn accept_withdrawal(
        &self,
        db: &DatabaseConnection,
        officer_user_id: i64,
        req: &AcceptWithdrawalRequest,
    ) -> Result<Vec<TransactionView>, AppError> {
        let ids: Vec<i64> = if req.all.unwrap_or(false) {
            let mut query = TransactionEntity::find()
                .filter(Column::Status.eq(TransactionStatus::Requested.to_string()));
            if let Some(user_id) = req.user_id {
                query = query.filter(Column::ToUserId.eq(user_id));
            }
            query.all(db).await?.into_iter().map(|tx| tx.id).collect()
        } else {
            match &req.transaction_ids {
                Some(ids) if !ids.is_empty() => ids.clone(),
                _ => {
                    return Err(AppError::Validation(
                        "must provide transaction_ids or all=true".to_string(),
                    ));
                }
            }
        };

        if ids.is_empty() {
            return Ok(Vec::new());
        }

        let txn = db.begin().await?;

        let targets = TransactionEntity::find()
            .filter(Column::Id.is_in(ids.clone()))
            .filter(Column::Status.eq(TransactionStatus::Requested.to_string()))
            .all(&txn)
            .await?;

        if targets.len() != ids.len() {
            return Err(AppError::Validation(
                "one or more transactions are not currently requested".to_string(),
            ));
        }

        let mut updated_models = Vec::with_capacity(targets.len());
        let now = chrono::Utc::now().into();
        for model in targets {
            // Re-check the status as part of the write itself: a concurrent accept/reject could
            // have moved this row out of `requested` between the `SELECT` above and here. A
            // losing request is skipped rather than double-paying it or overwriting the payer.
            let update = TransactionEntity::update_many()
                .filter(Column::Id.eq(model.id))
                .filter(Column::Status.eq(TransactionStatus::Requested.to_string()))
                .set(ActiveModel {
                    status: Set(TransactionStatus::Withdrawn.to_string()),
                    from_user_id: Set(Some(officer_user_id)),
                    withdrawn_at: Set(Some(now)),
                    updated_at: Set(now),
                    ..Default::default()
                })
                .exec(&txn)
                .await?;

            if update.rows_affected != 1 {
                continue;
            }

            let updated = TransactionEntity::find_by_id(model.id)
                .one(&txn)
                .await?
                .ok_or_else(|| {
                    AppError::Internal("accepted transaction disappeared".to_string())
                })?;
            updated_models.push(updated);
        }

        touch_linked_splits(&txn, &updated_models).await?;
        txn.commit().await?;

        for updated in &updated_models {
            // The payout is already durable. An audit failure must not turn that success into
            // an error the officer would retry against rows that are no longer `requested`.
            if let Err(error) = crate::modules::audit::service::AuditService::log(
                db,
                "WITHDRAW_ACCEPTED",
                Some("TRANSACTION"),
                Some(updated.id),
                Some(officer_user_id),
                Some(serde_json::json!({
                    "status": "withdrawn",
                    "from_user_id": officer_user_id,
                    "target_user_id": updated.to_user_id,
                    "split_id": updated.split_id
                })),
            )
            .await
            {
                tracing::warn!(
                    %error,
                    transaction_id = updated.id,
                    "withdrawal accepted but audit log failed"
                );
            }
            if updated.to_user_id != officer_user_id {
                crate::modules::notifications::notify_best_effort(
                    db,
                    crate::modules::notifications::NotifySpec {
                        kind: crate::modules::notifications::NotificationKind::BankWithdrawAccepted,
                        user_ids: &[updated.to_user_id],
                        title: "Withdrawal paid".into(),
                        body: format!(
                            "Your withdrawal of {amount} silver was paid out.",
                            amount = updated.amount
                        ),
                        link_path: Some("/bank".into()),
                        source_type: "transaction",
                        source_id: updated.id,
                        created_by_user_id: Some(officer_user_id),
                    },
                )
                .await;
            }
        }

        let updated_views = to_views_with_usernames(db, updated_models).await?;

        Ok(updated_views)
    }

    /// Rejects one, several, or all currently-requested withdrawals, marking them as `"rejected"`.
    ///
    /// Rejected transactions stay part of the requestable balance but cannot be accepted until the
    /// recipient submits a fresh withdrawal request, which moves them back to `"requested"`.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::Validation` if neither `transaction_ids` nor `all` is provided, or if
    ///   one or more requested transaction ids are not currently in `"requested"` status.
    /// * Returns `AppError::Database` if the query fails.
    pub async fn reject_withdrawal(
        &self,
        db: &DatabaseConnection,
        officer_user_id: i64,
        req: &RejectWithdrawalRequest,
    ) -> Result<Vec<TransactionView>, AppError> {
        let ids: Vec<i64> = if req.all.unwrap_or(false) {
            let mut query = TransactionEntity::find()
                .filter(Column::Status.eq(TransactionStatus::Requested.to_string()));
            if let Some(user_id) = req.user_id {
                query = query.filter(Column::ToUserId.eq(user_id));
            }
            query.all(db).await?.into_iter().map(|tx| tx.id).collect()
        } else {
            match &req.transaction_ids {
                Some(ids) if !ids.is_empty() => ids.clone(),
                _ => {
                    return Err(AppError::Validation(
                        "must provide transaction_ids or all=true".to_string(),
                    ));
                }
            }
        };

        if ids.is_empty() {
            return Ok(Vec::new());
        }

        let txn = db.begin().await?;

        let targets = TransactionEntity::find()
            .filter(Column::Id.is_in(ids.clone()))
            .filter(Column::Status.eq(TransactionStatus::Requested.to_string()))
            .all(&txn)
            .await?;

        if targets.len() != ids.len() {
            return Err(AppError::Validation(
                "one or more transactions are not currently requested".to_string(),
            ));
        }

        let mut updated_models = Vec::with_capacity(targets.len());
        let now = chrono::Utc::now().into();
        for model in targets {
            // Re-check the status as part of the write itself: a concurrent accept/reject could
            // have moved this row out of `requested` between the `SELECT` above and here. A
            // losing request is skipped rather than silently overwriting a settled transaction.
            let update = TransactionEntity::update_many()
                .filter(Column::Id.eq(model.id))
                .filter(Column::Status.eq(TransactionStatus::Requested.to_string()))
                .set(ActiveModel {
                    status: Set(TransactionStatus::Rejected.to_string()),
                    requested_at: Set(None),
                    updated_at: Set(now),
                    ..Default::default()
                })
                .exec(&txn)
                .await?;

            if update.rows_affected != 1 {
                continue;
            }

            let updated = TransactionEntity::find_by_id(model.id)
                .one(&txn)
                .await?
                .ok_or_else(|| {
                    AppError::Internal("rejected transaction disappeared".to_string())
                })?;
            updated_models.push(updated);
        }

        touch_linked_splits(&txn, &updated_models).await?;
        txn.commit().await?;

        for updated in &updated_models {
            if let Err(error) = crate::modules::audit::service::AuditService::log(
                db,
                "WITHDRAW_REJECTED",
                Some("TRANSACTION"),
                Some(updated.id),
                Some(officer_user_id),
                Some(serde_json::json!({
                    "status": "rejected",
                    "from_user_id": officer_user_id,
                    "target_user_id": updated.to_user_id,
                    "split_id": updated.split_id
                })),
            )
            .await
            {
                tracing::warn!(
                    %error,
                    transaction_id = updated.id,
                    "withdrawal rejected but audit log failed"
                );
            }
            if updated.to_user_id != officer_user_id {
                crate::modules::notifications::notify_best_effort(
                    db,
                    crate::modules::notifications::NotifySpec {
                        kind: crate::modules::notifications::NotificationKind::BankWithdrawRejected,
                        user_ids: &[updated.to_user_id],
                        title: "Withdrawal rejected".into(),
                        body: format!(
                            "Your withdrawal of {amount} silver was rejected.",
                            amount = updated.amount
                        ),
                        link_path: Some("/bank".into()),
                        source_type: "transaction",
                        source_id: updated.id,
                        created_by_user_id: Some(officer_user_id),
                    },
                )
                .await;
            }
        }

        let updated_views = to_views_with_usernames(db, updated_models).await?;

        Ok(updated_views)
    }

    /// Manually creates a bank transaction (e.g. a one-off bonus or correction). Normal
    /// transactions are created as a side effect of `SplitService::complete_split`; this is the
    /// administrator override for everything else.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::Validation` if `amount` is zero. Negative input is
    ///   normalized as a donation to the Guild Bank.
    /// * Returns `AppError::NotFound` if `to_user_id`, `from_user_id`, or `split_id` don't exist.
    /// * Returns `AppError::Database` if the query fails.
    pub async fn create_transaction(
        &self,
        db: &DatabaseConnection,
        req: &CreateTransactionRequest,
        actor_user_id: i64,
    ) -> Result<TransactionView, AppError> {
        if req.amount == Decimal::ZERO {
            return Err(AppError::Validation("amount must be non-zero".to_string()));
        }
        let debit = req.amount < Decimal::ZERO;
        if UserEntity::find_by_id(req.to_user_id)
            .one(db)
            .await?
            .is_none()
        {
            return Err(AppError::NotFound(format!(
                "User {} not found",
                req.to_user_id
            )));
        }
        if let Some(from_user_id) = req.from_user_id
            && UserEntity::find_by_id(from_user_id)
                .one(db)
                .await?
                .is_none()
        {
            return Err(AppError::NotFound(format!("User {from_user_id} not found")));
        }
        if let Some(split_id) = req.split_id
            && SplitEntity::find_by_id(split_id).one(db).await?.is_none()
        {
            return Err(AppError::NotFound(format!("Split {split_id} not found")));
        }

        let status = if debit {
            TransactionStatus::Donated
        } else {
            req.status.unwrap_or(TransactionStatus::Pending)
        };
        let from_user_id = if debit {
            Some(req.from_user_id.unwrap_or(req.to_user_id))
        } else {
            req.from_user_id
        };
        let now = chrono::Utc::now().into();
        let active = ActiveModel {
            from_user_id: Set(from_user_id),
            to_user_id: Set(req.to_user_id),
            to_guild_bank: Set(debit || req.to_guild_bank.unwrap_or(false)),
            amount: Set(req.amount.abs()),
            status: Set(status.to_string()),
            r#type: Set(req
                .r#type
                .clone()
                .unwrap_or_else(|| TYPE_MANUAL.to_string())),
            split_id: Set(req.split_id),
            created_at: Set(now),
            requested_at: Set(None),
            withdrawn_at: Set(None),
            updated_at: Set(now),
            ..Default::default()
        };
        let created = active.insert(db).await?;

        if let Some(split_id) = created.split_id {
            touch_split_ids(db, &[split_id]).await?;
        }

        crate::modules::audit::service::AuditService::log(
            db,
            "TRANSACTION_CREATED_MANUAL",
            Some("TRANSACTION"),
            Some(created.id),
            Some(actor_user_id),
            Some(serde_json::json!({
                "to_user_id": created.to_user_id,
                "from_user_id": created.from_user_id,
                "amount": created.amount,
                "status": created.status,
                "type": created.r#type,
                "split_id": created.split_id
            })),
        )
        .await?;

        let mut views = to_views_with_usernames(db, vec![created]).await?;
        views
            .pop()
            .ok_or_else(|| AppError::Internal("created transaction view missing".to_string()))
    }

    /// Updates fields on an existing bank transaction. Only fields present in `req` are changed;
    /// `from_user_id`/`split_id` use an explicit `Some(None)` to clear vs. omitted to leave alone.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::NotFound` if the transaction, or a newly-referenced
    ///   `to_user_id`/`from_user_id`/`split_id`, don't exist.
    /// * Returns `AppError::Validation` if a provided `amount` is zero. Negative
    ///   input is normalized as a donation to the Guild Bank.
    /// * Returns `AppError::Conflict` if the transaction is already settled (`withdrawn` or
    ///   `donated`): those rows record money that has left the Guild Bank, so they are not
    ///   editable. Record a new manual transaction to correct them.
    /// * Returns `AppError::Database` if the query fails.
    pub async fn update_transaction(
        &self,
        db: &DatabaseConnection,
        id: i64,
        req: &UpdateTransactionRequest,
        actor_user_id: i64,
    ) -> Result<TransactionView, AppError> {
        // One transaction with the row locked: the status check below must still hold when the
        // update lands, so a concurrent accept/donate cannot slip in between the two.
        let txn = db.begin().await?;
        let existing = TransactionEntity::find_by_id(id)
            .lock_exclusive()
            .one(&txn)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Transaction {id} not found")))?;
        ensure_not_settled(&existing, "edited")?;

        let debit = req.amount.is_some_and(|amount| amount < Decimal::ZERO);
        if req.amount == Some(Decimal::ZERO) {
            return Err(AppError::Validation("amount must be non-zero".to_string()));
        }
        if let Some(to_user_id) = req.to_user_id
            && UserEntity::find_by_id(to_user_id)
                .one(&txn)
                .await?
                .is_none()
        {
            return Err(AppError::NotFound(format!("User {to_user_id} not found")));
        }
        if let Some(Some(from_user_id)) = req.from_user_id
            && UserEntity::find_by_id(from_user_id)
                .one(&txn)
                .await?
                .is_none()
        {
            return Err(AppError::NotFound(format!("User {from_user_id} not found")));
        }
        if let Some(Some(split_id)) = req.split_id
            && SplitEntity::find_by_id(split_id).one(&txn).await?.is_none()
        {
            return Err(AppError::NotFound(format!("Split {split_id} not found")));
        }

        let old_split_id = existing.split_id;
        let existing_to_user_id = existing.to_user_id;
        let before = serde_json::json!({
            "amount": existing.amount,
            "status": existing.status,
            "type": existing.r#type
        });

        let mut active: ActiveModel = existing.into();
        if let Some(to_user_id) = req.to_user_id {
            active.to_user_id = Set(to_user_id);
        }
        if let Some(from_user_id) = req.from_user_id {
            active.from_user_id = Set(from_user_id);
        }
        if let Some(amount) = req.amount {
            active.amount = Set(amount.abs());
        }
        if let Some(status) = req.status {
            active.status = Set(status.to_string());
        }
        if let Some(ref transaction_type) = req.r#type {
            active.r#type = Set(transaction_type.clone());
        }
        if let Some(split_id) = req.split_id {
            active.split_id = Set(split_id);
        }
        if let Some(to_guild_bank) = req.to_guild_bank {
            active.to_guild_bank = Set(to_guild_bank);
        }
        if debit {
            active.from_user_id = Set(Some(
                req.from_user_id.flatten().unwrap_or(existing_to_user_id),
            ));
            active.to_guild_bank = Set(true);
            active.status = Set(TransactionStatus::Donated.to_string());
        }
        active.updated_at = Set(chrono::Utc::now().into());

        let updated = active.update(&txn).await?;

        let mut touched_splits: Vec<i64> = old_split_id.into_iter().collect();
        touched_splits.extend(updated.split_id);
        touched_splits.sort_unstable();
        touched_splits.dedup();
        touch_split_ids(&txn, &touched_splits).await?;
        txn.commit().await?;

        crate::modules::audit::service::AuditService::log(
            db,
            "TRANSACTION_UPDATED",
            Some("TRANSACTION"),
            Some(updated.id),
            Some(actor_user_id),
            Some(serde_json::json!({
                "before": before,
                "after": {
                    "amount": updated.amount,
                    "status": updated.status,
                    "type": updated.r#type
                }
            })),
        )
        .await?;

        let mut views = to_views_with_usernames(db, vec![updated]).await?;
        views
            .pop()
            .ok_or_else(|| AppError::Internal("updated transaction view missing".to_string()))
    }

    /// Permanently deletes a bank transaction. Nothing else references `transactions.id`, so this
    /// is a plain hard delete — no blocking-reference check needed.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::NotFound` if the transaction doesn't exist.
    /// * Returns `AppError::Conflict` if the transaction is already settled (`withdrawn` or
    ///   `donated`): deleting it would erase the record of money that has already left the
    ///   Guild Bank.
    /// * Returns `AppError::Database` if the query fails.
    pub async fn delete_transaction(
        &self,
        db: &DatabaseConnection,
        id: i64,
        actor_user_id: i64,
    ) -> Result<(), AppError> {
        // Lock the row for the whole check-then-delete so a concurrent accept cannot settle it
        // between the status check and the delete.
        let txn = db.begin().await?;
        let existing = TransactionEntity::find_by_id(id)
            .lock_exclusive()
            .one(&txn)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Transaction {id} not found")))?;
        ensure_not_settled(&existing, "deleted")?;

        TransactionEntity::delete_by_id(id).exec(&txn).await?;

        if let Some(split_id) = existing.split_id {
            touch_split_ids(&txn, &[split_id]).await?;
        }
        txn.commit().await?;

        crate::modules::audit::service::AuditService::log(
            db,
            "TRANSACTION_DELETED",
            Some("TRANSACTION"),
            Some(id),
            Some(actor_user_id),
            Some(serde_json::json!({
                "to_user_id": existing.to_user_id,
                "amount": existing.amount,
                "type": existing.r#type,
                "status": existing.status,
                "split_id": existing.split_id
            })),
        )
        .await?;

        Ok(())
    }
}

/// Refuses to touch a settled transaction (`withdrawn` or `donated`).
///
/// Those rows are the record of silver that already left the Guild Bank (or was given back to
/// it). Editing or deleting one silently rewrites that history, so it is rejected; a correction
/// is a new manual transaction instead. `action` is the past participle used in the message.
fn ensure_not_settled(existing: &Model, action: &str) -> Result<(), AppError> {
    let settled = matches!(
        existing.status.parse::<TransactionStatus>(),
        Ok(TransactionStatus::Withdrawn | TransactionStatus::Donated)
    );
    if settled {
        return Err(AppError::Conflict(format!(
            "transaction {} is already {} and cannot be {action}; record a new manual \
             transaction to correct it",
            existing.id, existing.status
        )));
    }
    Ok(())
}

fn add_breakdown(groups: &mut HashMap<String, (u64, Decimal)>, label: String, amount: Decimal) {
    let entry = groups.entry(label).or_insert((0, Decimal::ZERO));
    entry.0 += 1;
    entry.1 += amount;
}

fn finish_breakdown(groups: HashMap<String, (u64, Decimal)>) -> Vec<super::models::BankBreakdown> {
    let mut rows: Vec<_> = groups
        .into_iter()
        .map(
            |(label, (transaction_count, total_amount))| super::models::BankBreakdown {
                label,
                transaction_count,
                total_amount,
            },
        )
        .collect();
    rows.sort_by(|a, b| {
        b.total_amount
            .cmp(&a.total_amount)
            .then_with(|| a.label.cmp(&b.label))
    });
    rows
}

impl Default for BankService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
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

    async fn insert_user(db: &DatabaseConnection, username: &str, email: &str) -> i64 {
        use crate::modules::users::entities::ActiveModel as UserActiveModel;
        let user = UserActiveModel {
            username: Set(username.to_string()),
            email: Set(email.to_string()),
            role: Set("User".to_string()),
            ..Default::default()
        };
        user.insert(db).await.expect("Failed to insert user").id
    }

    async fn insert_transaction(
        db: &DatabaseConnection,
        to_user_id: i64,
        amount: &str,
        status: TransactionStatus,
    ) -> i64 {
        insert_split_transaction(db, to_user_id, amount, status, None).await
    }

    async fn insert_split_transaction(
        db: &DatabaseConnection,
        to_user_id: i64,
        amount: &str,
        status: TransactionStatus,
        split_id: Option<i64>,
    ) -> i64 {
        let active = ActiveModel {
            from_user_id: Set(None),
            to_user_id: Set(to_user_id),
            amount: Set(amount.parse().unwrap()),
            status: Set(status.to_string()),
            r#type: Set(TYPE_SPLIT_CREDIT.to_string()),
            split_id: Set(split_id),
            ..Default::default()
        };
        active
            .insert(db)
            .await
            .expect("Failed to insert transaction")
            .id
    }

    async fn insert_completed_split(
        db: &DatabaseConnection,
        created_by: i64,
        updated_at: chrono::DateTime<chrono::Utc>,
    ) -> i64 {
        use crate::modules::splits::entities::split::ActiveModel as SplitActiveModel;

        SplitActiveModel {
            created_by: Set(created_by),
            status: Set(SplitStatus::Completed.to_string()),
            estimated_market_value: Set("10.00".parse().unwrap()),
            fee: Set(Decimal::ZERO),
            repair_value: Set(Decimal::ZERO),
            bags_value: Set(Decimal::ZERO),
            net_value: Set(Some("10.00".parse().unwrap())),
            created_at: Set(updated_at.into()),
            finalized_at: Set(Some(updated_at.into())),
            updated_at: Set(updated_at.into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("Failed to insert split")
        .id
    }

    async fn assert_split_was_touched(
        db: &DatabaseConnection,
        split_id: i64,
        previous_updated_at: chrono::DateTime<chrono::Utc>,
    ) {
        let split = SplitEntity::find_by_id(split_id)
            .one(db)
            .await
            .expect("Failed to load split")
            .expect("Split missing");
        assert!(split.updated_at.timestamp_micros() > previous_updated_at.timestamp_micros());
    }

    #[tokio::test]
    async fn split_transaction_mutations_touch_splits_and_link_audits() {
        use crate::modules::audit::entities::{Column as AuditColumn, Entity as AuditEntity};

        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let officer = insert_user(&db, "officer", "officer@example.com").await;
        let old = chrono::Utc::now() - chrono::Duration::days(1);
        let withdrawal_split = insert_completed_split(&db, officer, old).await;
        let donation_split = insert_completed_split(&db, officer, old).await;
        let withdrawal_tx = insert_split_transaction(
            &db,
            alice,
            "10.00",
            TransactionStatus::Pending,
            Some(withdrawal_split),
        )
        .await;
        let second_withdrawal_tx = insert_split_transaction(
            &db,
            alice,
            "5.00",
            TransactionStatus::Pending,
            Some(withdrawal_split),
        )
        .await;
        let donation_tx = insert_split_transaction(
            &db,
            alice,
            "3.00",
            TransactionStatus::Pending,
            Some(donation_split),
        )
        .await;
        let service = BankService::new();

        service
            .request_withdrawal(
                &db,
                alice,
                &WithdrawRequest {
                    transaction_ids: Some(vec![withdrawal_tx, second_withdrawal_tx]),
                    all: None,
                    guild_tenant_id: None,
                },
            )
            .await
            .expect("Failed to request withdrawal");
        assert_split_was_touched(&db, withdrawal_split, old).await;

        service
            .reject_withdrawal(
                &db,
                officer,
                &RejectWithdrawalRequest {
                    user_id: None,
                    transaction_ids: Some(vec![withdrawal_tx]),
                    all: None,
                    guild_tenant_id: None,
                },
            )
            .await
            .expect("Failed to reject withdrawal");
        service
            .request_withdrawal(
                &db,
                alice,
                &WithdrawRequest {
                    transaction_ids: Some(vec![withdrawal_tx]),
                    all: None,
                    guild_tenant_id: None,
                },
            )
            .await
            .expect("Failed to request withdrawal again");
        service
            .accept_withdrawal(
                &db,
                officer,
                &AcceptWithdrawalRequest {
                    user_id: None,
                    transaction_ids: Some(vec![withdrawal_tx]),
                    all: None,
                    guild_tenant_id: None,
                },
            )
            .await
            .expect("Failed to accept withdrawal");
        service
            .donate_split_share(&db, donation_split, alice)
            .await
            .expect("Failed to donate split share");
        assert_split_was_touched(&db, donation_split, old).await;

        let audits = AuditEntity::find()
            .filter(AuditColumn::EntityId.is_in([withdrawal_tx, second_withdrawal_tx, donation_tx]))
            .all(&db)
            .await
            .expect("Failed to load audits");
        assert_eq!(audits.len(), 6);
        assert!(audits.iter().all(|audit| {
            audit.split_id
                == if audit.entity_id == Some(donation_tx) {
                    Some(donation_split)
                } else {
                    Some(withdrawal_split)
                }
        }));
    }

    #[tokio::test]
    async fn test_get_balance_sums_pending_and_requested_separately() {
        let db = seed_db().await;
        let user_id = insert_user(&db, "alice", "alice@example.com").await;
        insert_transaction(&db, user_id, "10.00", TransactionStatus::Pending).await;
        insert_transaction(&db, user_id, "5.25", TransactionStatus::Pending).await;
        insert_transaction(&db, user_id, "20.00", TransactionStatus::Requested).await;
        insert_transaction(&db, user_id, "7.50", TransactionStatus::Rejected).await;
        // Legacy ledgers can contain a negative adjustment; it must not make the
        // requestable credit total disagree with the rows that can be withdrawn.
        insert_transaction(&db, user_id, "-2.00", TransactionStatus::Pending).await;
        insert_transaction(&db, user_id, "99.00", TransactionStatus::Withdrawn).await;

        let service = BankService::new();
        let balance = service.get_balance(&db, user_id).await.unwrap();

        assert_eq!(balance.pending_count, 3);
        assert_eq!(balance.pending_total, "22.75".parse::<Decimal>().unwrap());
        assert_eq!(balance.requested_count, 1);
        assert_eq!(balance.requested_total, "20.00".parse::<Decimal>().unwrap());
    }

    #[tokio::test]
    async fn test_request_withdrawal_rejects_others_transactions() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let bob = insert_user(&db, "bob", "bob@example.com").await;
        let tx_id = insert_transaction(&db, alice, "10.00", TransactionStatus::Pending).await;

        let service = BankService::new();
        let result = service
            .request_withdrawal(
                &db,
                bob,
                &WithdrawRequest {
                    transaction_ids: Some(vec![tx_id]),
                    all: None,
                    guild_tenant_id: None,
                },
            )
            .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_request_withdrawal_all_marks_pending_as_requested() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        insert_transaction(&db, alice, "10.00", TransactionStatus::Pending).await;
        insert_transaction(&db, alice, "5.00", TransactionStatus::Pending).await;
        insert_transaction(&db, alice, "3.00", TransactionStatus::Rejected).await;

        let service = BankService::new();
        let requested = service
            .request_withdrawal(
                &db,
                alice,
                &WithdrawRequest {
                    transaction_ids: None,
                    all: Some(true),
                    guild_tenant_id: None,
                },
            )
            .await
            .unwrap();

        assert_eq!(requested.len(), 3);
        assert!(
            requested
                .iter()
                .all(|tx| tx.status == TransactionStatus::Requested)
        );

        let balance = service.get_balance(&db, alice).await.unwrap();
        assert_eq!(balance.pending_count, 0);
        assert_eq!(balance.requested_count, 3);
    }

    #[tokio::test]
    async fn test_accept_withdrawal_sets_payer_and_marks_withdrawn() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let officer = insert_user(&db, "officer", "officer@example.com").await;
        let tx_id = insert_transaction(&db, alice, "10.00", TransactionStatus::Requested).await;

        let service = BankService::new();
        let accepted = service
            .accept_withdrawal(
                &db,
                officer,
                &AcceptWithdrawalRequest {
                    user_id: None,
                    transaction_ids: Some(vec![tx_id]),
                    all: None,
                    guild_tenant_id: None,
                },
            )
            .await
            .unwrap();

        assert_eq!(accepted.len(), 1);
        assert_eq!(accepted[0].status, TransactionStatus::Withdrawn);
        assert_eq!(accepted[0].from_user_id, Some(officer));

        let inbox = crate::modules::notifications::entities::NotificationEntity::find()
            .filter(crate::modules::notifications::entities::NotificationColumn::UserId.eq(alice))
            .all(&db)
            .await
            .unwrap();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].kind, "bank_withdraw_accepted");
        let officer_inbox = crate::modules::notifications::entities::NotificationEntity::find()
            .filter(crate::modules::notifications::entities::NotificationColumn::UserId.eq(officer))
            .all(&db)
            .await
            .unwrap();
        assert!(officer_inbox.is_empty());
    }

    #[tokio::test]
    async fn test_accept_withdrawal_rejects_non_requested_transactions() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let officer = insert_user(&db, "officer", "officer@example.com").await;
        let tx_id = insert_transaction(&db, alice, "10.00", TransactionStatus::Pending).await;

        let service = BankService::new();
        let result = service
            .accept_withdrawal(
                &db,
                officer,
                &AcceptWithdrawalRequest {
                    user_id: None,
                    transaction_ids: Some(vec![tx_id]),
                    all: None,
                    guild_tenant_id: None,
                },
            )
            .await;

        assert!(result.is_err());
    }

    /// Protects the withdrawal lifecycle from bypassing the member after an officer rejection.
    ///
    /// A rejected request returns to `pending`, so stale officer actions cannot pay it out until
    /// the recipient explicitly asks again. This preserves the user's intent while still allowing
    /// the same ledger row to be paid after a fresh request.
    ///
    /// # Example
    /// ```rust,ignore
    /// request_withdrawal(transaction_id);
    /// reject_withdrawal(transaction_id);
    /// request_withdrawal(transaction_id);
    /// accept_withdrawal(transaction_id);
    /// ```
    #[tokio::test]
    async fn test_rejected_withdrawal_requires_fresh_request_before_acceptance() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let officer = insert_user(&db, "officer", "officer@example.com").await;
        let tx_id = insert_transaction(&db, alice, "10.00", TransactionStatus::Pending).await;

        let service = BankService::new();
        service
            .request_withdrawal(
                &db,
                alice,
                &WithdrawRequest {
                    transaction_ids: Some(vec![tx_id]),
                    all: None,
                    guild_tenant_id: None,
                },
            )
            .await
            .expect("Failed to request withdrawal before rejection");

        let rejected = service
            .reject_withdrawal(
                &db,
                officer,
                &RejectWithdrawalRequest {
                    user_id: None,
                    transaction_ids: Some(vec![tx_id]),
                    all: None,
                    guild_tenant_id: None,
                },
            )
            .await
            .expect("Failed to reject requested withdrawal");

        assert_eq!(rejected.len(), 1);
        assert_eq!(rejected[0].status, TransactionStatus::Rejected);
        assert_eq!(rejected[0].requested_at, None);

        let stale_acceptance = service
            .accept_withdrawal(
                &db,
                officer,
                &AcceptWithdrawalRequest {
                    user_id: None,
                    transaction_ids: Some(vec![tx_id]),
                    all: None,
                    guild_tenant_id: None,
                },
            )
            .await;

        assert!(stale_acceptance.is_err());

        service
            .request_withdrawal(
                &db,
                alice,
                &WithdrawRequest {
                    transaction_ids: Some(vec![tx_id]),
                    all: None,
                    guild_tenant_id: None,
                },
            )
            .await
            .expect("Failed to request withdrawal again after rejection");

        let accepted = service
            .accept_withdrawal(
                &db,
                officer,
                &AcceptWithdrawalRequest {
                    user_id: None,
                    transaction_ids: Some(vec![tx_id]),
                    all: None,
                    guild_tenant_id: None,
                },
            )
            .await
            .expect("Failed to accept freshly requested withdrawal");

        assert_eq!(accepted.len(), 1);
        assert_eq!(accepted[0].status, TransactionStatus::Withdrawn);
        assert_eq!(accepted[0].from_user_id, Some(officer));
    }

    #[tokio::test]
    async fn list_transactions_searches_username_and_sorts_by_amount() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let bob = insert_user(&db, "bob", "bob@example.com").await;
        insert_transaction(&db, alice, "30.00", TransactionStatus::Pending).await;
        insert_transaction(&db, bob, "10.00", TransactionStatus::Pending).await;
        insert_transaction(&db, bob, "20.00", TransactionStatus::Requested).await;

        let service = BankService::new();
        let pagination = PaginationParams {
            page: Some(1),
            limit: Some(10),
        };

        let searched = service
            .list_transactions(
                &db,
                None,
                &pagination,
                &TransactionFilters {
                    search: Some("bob".into()),
                    ..TransactionFilters::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(searched.total_items, 2);
        assert!(searched.items.iter().all(|tx| tx.to_username == "bob"));

        let sorted = service
            .list_transactions(
                &db,
                None,
                &pagination,
                &TransactionFilters {
                    sort: Some("amount".into()),
                    order: Some("asc".into()),
                    ..TransactionFilters::default()
                },
            )
            .await
            .unwrap();
        let amounts: Vec<_> = sorted.items.iter().map(|tx| tx.amount).collect();
        assert_eq!(
            amounts,
            vec![
                "10".parse().unwrap(),
                "20".parse().unwrap(),
                "30".parse().unwrap()
            ]
        );
    }

    #[tokio::test]
    async fn list_transactions_searches_linked_albion_display_name() {
        let db = seed_db().await;
        use crate::modules::albion::entities::albion_link::ActiveModel as AlbionLinkActiveModel;
        use crate::modules::users::entities::ActiveModel as UserActiveModel;

        let user = UserActiveModel {
            username: Set("discord-user".to_string()),
            email: Set("discord-user@example.com".to_string()),
            role: Set("User".to_string()),
            discord_id: Set(Some("discord-user-id".to_string())),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("Failed to insert linked user")
        .id;
        AlbionLinkActiveModel {
            discord_id: Set("discord-user-id".to_string()),
            albion_player_id: Set("albion-player-id".to_string()),
            albion_player_name: Set("Albion User".to_string()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("Failed to insert Albion link");
        insert_transaction(&db, user, "30.00", TransactionStatus::Pending).await;
        insert_transaction(&db, user, "20.00", TransactionStatus::Requested).await;

        let searched = BankService::new()
            .list_transactions(
                &db,
                None,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(10),
                },
                &TransactionFilters {
                    search: Some("albion user".into()),
                    ..TransactionFilters::default()
                },
            )
            .await
            .unwrap();

        assert_eq!(searched.total_items, 2);
        assert!(
            searched
                .items
                .iter()
                .all(|tx| tx.to_username == "Albion User")
        );
    }

    #[tokio::test]
    async fn list_transactions_rejects_unknown_sort_column() {
        let db = seed_db().await;
        let error = BankService::new()
            .list_transactions(
                &db,
                None,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(10),
                },
                &TransactionFilters {
                    sort: Some("fame".into()),
                    ..TransactionFilters::default()
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
    async fn list_transactions_filters_by_split_id() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let officer = insert_user(&db, "officer", "officer@example.com").await;
        let old = chrono::Utc::now() - chrono::Duration::days(1);
        let split_a = insert_completed_split(&db, officer, old).await;
        let split_b = insert_completed_split(&db, officer, old).await;
        insert_split_transaction(
            &db,
            alice,
            "10.00",
            TransactionStatus::Pending,
            Some(split_a),
        )
        .await;
        insert_split_transaction(
            &db,
            alice,
            "5.00",
            TransactionStatus::Pending,
            Some(split_b),
        )
        .await;

        let filtered = BankService::new()
            .list_transactions(
                &db,
                None,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(10),
                },
                &TransactionFilters {
                    split_id: Some(split_a),
                    ..TransactionFilters::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(filtered.total_items, 1);
        assert_eq!(filtered.items[0].split_id, Some(split_a));
    }

    #[tokio::test]
    async fn create_transaction_rejects_zero_amount() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let error = BankService::new()
            .create_transaction(
                &db,
                &CreateTransactionRequest {
                    to_user_id: alice,
                    amount: Decimal::ZERO,
                    status: None,
                    r#type: None,
                    split_id: None,
                    to_guild_bank: None,
                    from_user_id: None,
                    guild_tenant_id: None,
                },
                alice,
            )
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn create_transaction_normalizes_negative_input_as_guild_donation() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let created = BankService::new()
            .create_transaction(
                &db,
                &CreateTransactionRequest {
                    to_user_id: alice,
                    amount: "-10.00".parse().unwrap(),
                    status: None,
                    r#type: None,
                    split_id: None,
                    to_guild_bank: None,
                    from_user_id: None,
                    guild_tenant_id: None,
                },
                alice,
            )
            .await
            .unwrap();
        assert_eq!(created.amount, "10.00".parse().unwrap());
        assert_eq!(created.from_user_id, Some(alice));
        assert!(created.to_guild_bank);
        assert_eq!(created.status, TransactionStatus::Donated);
    }

    #[tokio::test]
    async fn create_transaction_rejects_unknown_recipient() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let error = BankService::new()
            .create_transaction(
                &db,
                &CreateTransactionRequest {
                    to_user_id: 999_999,
                    amount: "10.00".parse().unwrap(),
                    status: None,
                    r#type: None,
                    split_id: None,
                    to_guild_bank: None,
                    from_user_id: None,
                    guild_tenant_id: None,
                },
                admin,
            )
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn create_transaction_defaults_status_and_type_and_touches_split() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let old = chrono::Utc::now() - chrono::Duration::days(1);
        let split_id = insert_completed_split(&db, admin, old).await;

        let created = BankService::new()
            .create_transaction(
                &db,
                &CreateTransactionRequest {
                    to_user_id: alice,
                    amount: "42.50".parse().unwrap(),
                    status: None,
                    r#type: None,
                    split_id: Some(split_id),
                    to_guild_bank: None,
                    from_user_id: None,
                    guild_tenant_id: None,
                },
                admin,
            )
            .await
            .unwrap();

        assert_eq!(created.status, TransactionStatus::Pending);
        assert_eq!(created.r#type, TYPE_MANUAL);
        assert_eq!(created.split_id, Some(split_id));
        assert_split_was_touched(&db, split_id, old).await;
    }

    #[tokio::test]
    async fn update_transaction_changes_only_provided_fields() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let id = insert_transaction(&db, alice, "10.00", TransactionStatus::Pending).await;

        let updated = BankService::new()
            .update_transaction(
                &db,
                id,
                &UpdateTransactionRequest {
                    to_user_id: None,
                    from_user_id: None,
                    amount: Some("15.00".parse().unwrap()),
                    status: None,
                    r#type: None,
                    split_id: None,
                    to_guild_bank: None,
                    guild_tenant_id: None,
                },
                admin,
            )
            .await
            .unwrap();

        assert_eq!(updated.amount, "15.00".parse().unwrap());
        assert_eq!(updated.status, TransactionStatus::Pending);
    }

    #[tokio::test]
    async fn update_transaction_can_explicitly_clear_split_link() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let old = chrono::Utc::now() - chrono::Duration::days(1);
        let split_id = insert_completed_split(&db, admin, old).await;
        let id = insert_split_transaction(
            &db,
            alice,
            "10.00",
            TransactionStatus::Pending,
            Some(split_id),
        )
        .await;

        let updated = BankService::new()
            .update_transaction(
                &db,
                id,
                &UpdateTransactionRequest {
                    to_user_id: None,
                    from_user_id: None,
                    amount: None,
                    status: None,
                    r#type: None,
                    split_id: Some(None),
                    to_guild_bank: None,
                    guild_tenant_id: None,
                },
                admin,
            )
            .await
            .unwrap();

        assert_eq!(updated.split_id, None);
        assert_split_was_touched(&db, split_id, old).await;
    }

    #[tokio::test]
    async fn update_transaction_rejects_non_positive_amount() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let id = insert_transaction(&db, alice, "10.00", TransactionStatus::Pending).await;

        let error = BankService::new()
            .update_transaction(
                &db,
                id,
                &UpdateTransactionRequest {
                    to_user_id: None,
                    from_user_id: None,
                    amount: Some(Decimal::ZERO),
                    status: None,
                    r#type: None,
                    split_id: None,
                    to_guild_bank: None,
                    guild_tenant_id: None,
                },
                alice,
            )
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn update_transaction_returns_not_found_for_unknown_id() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;

        let error = BankService::new()
            .update_transaction(
                &db,
                999_999,
                &UpdateTransactionRequest {
                    to_user_id: None,
                    from_user_id: None,
                    amount: Some("1.00".parse().unwrap()),
                    status: None,
                    r#type: None,
                    split_id: None,
                    to_guild_bank: None,
                    guild_tenant_id: None,
                },
                alice,
            )
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn delete_transaction_removes_the_row_and_touches_its_split() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let old = chrono::Utc::now() - chrono::Duration::days(1);
        let split_id = insert_completed_split(&db, admin, old).await;
        let id = insert_split_transaction(
            &db,
            alice,
            "10.00",
            TransactionStatus::Pending,
            Some(split_id),
        )
        .await;

        BankService::new()
            .delete_transaction(&db, id, admin)
            .await
            .unwrap();

        assert!(
            TransactionEntity::find_by_id(id)
                .one(&db)
                .await
                .unwrap()
                .is_none()
        );
        assert_split_was_touched(&db, split_id, old).await;
    }

    fn status_only_update(status: TransactionStatus) -> UpdateTransactionRequest {
        UpdateTransactionRequest {
            to_user_id: None,
            from_user_id: None,
            amount: Some("99.00".parse().unwrap()),
            status: Some(status),
            r#type: None,
            split_id: None,
            to_guild_bank: None,
            guild_tenant_id: None,
        }
    }

    #[tokio::test]
    async fn settled_transactions_cannot_be_edited_or_deleted() {
        let service = BankService::new();
        for settled in [TransactionStatus::Withdrawn, TransactionStatus::Donated] {
            let db = seed_db().await;
            let alice = insert_user(&db, "alice", "alice@example.com").await;
            let admin = insert_user(&db, "admin", "admin@example.com").await;
            let id = insert_transaction(&db, alice, "10.00", settled).await;

            let edit_error = service
                .update_transaction(
                    &db,
                    id,
                    &status_only_update(TransactionStatus::Pending),
                    admin,
                )
                .await
                .unwrap_err();
            assert!(
                matches!(edit_error, AppError::Conflict(_)),
                "{settled}: edit must be a conflict, got {edit_error:?}"
            );

            let delete_error = service
                .delete_transaction(&db, id, admin)
                .await
                .unwrap_err();
            assert!(
                matches!(delete_error, AppError::Conflict(_)),
                "{settled}: delete must be a conflict, got {delete_error:?}"
            );

            // The refused calls changed nothing: same row, same amount, same status.
            let row = TransactionEntity::find_by_id(id)
                .one(&db)
                .await
                .unwrap()
                .expect("row must survive a refused delete");
            assert_eq!(row.amount, "10.00".parse().unwrap());
            assert_eq!(row.status, settled.to_string());
        }
    }

    #[tokio::test]
    async fn unsettled_transactions_stay_editable_and_deletable() {
        let service = BankService::new();
        for open in [
            TransactionStatus::Pending,
            TransactionStatus::Requested,
            TransactionStatus::Rejected,
        ] {
            let db = seed_db().await;
            let alice = insert_user(&db, "alice", "alice@example.com").await;
            let admin = insert_user(&db, "admin", "admin@example.com").await;
            let id = insert_transaction(&db, alice, "10.00", open).await;

            let updated = service
                .update_transaction(&db, id, &status_only_update(open), admin)
                .await
                .unwrap();
            assert_eq!(updated.amount, "99.00".parse().unwrap());

            service.delete_transaction(&db, id, admin).await.unwrap();
            assert!(
                TransactionEntity::find_by_id(id)
                    .one(&db)
                    .await
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[tokio::test]
    async fn delete_transaction_returns_not_found_for_unknown_id() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;

        let error = BankService::new()
            .delete_transaction(&db, 999_999, alice)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::NotFound(_)));
    }

    type LedgerSnapshot = Vec<(i64, String, String, String, Option<i64>, String)>;

    async fn ledger_snapshot(db: &DatabaseConnection) -> LedgerSnapshot {
        TransactionEntity::find()
            .order_by_asc(Column::Id)
            .all(db)
            .await
            .unwrap()
            .into_iter()
            .map(|tx| {
                (
                    tx.id,
                    tx.amount.to_string(),
                    tx.status,
                    tx.r#type,
                    tx.split_id,
                    tx.updated_at.to_rfc3339(),
                )
            })
            .collect()
    }

    /// Alice: 50 + 20 - 10 open on split A, plus a confirmed -15 clawback on split B.
    async fn seed_legacy_ledger(db: &DatabaseConnection) -> (i64, i64) {
        let alice = insert_user(db, "alice", "alice@example.com").await;
        let officer = insert_user(db, "officer", "officer@example.com").await;
        let old = chrono::Utc::now() - chrono::Duration::days(1);
        let split_a = insert_completed_split(db, officer, old).await;
        let split_b = insert_completed_split(db, officer, old).await;
        for amount in ["50.00", "20.00", "-10.00"] {
            insert_split_transaction(db, alice, amount, TransactionStatus::Pending, Some(split_a))
                .await;
        }
        insert_split_transaction(
            db,
            alice,
            "-15.00",
            TransactionStatus::Withdrawn,
            Some(split_b),
        )
        .await;
        (alice, split_a)
    }

    #[tokio::test]
    async fn get_balance_reports_the_consolidated_balance_without_writing() {
        let db = seed_db().await;
        let (alice, _) = seed_legacy_ledger(&db).await;
        let before = ledger_snapshot(&db).await;

        let balance = BankService::new().get_balance(&db, alice).await.unwrap();

        // Net open credit is 60.00 - 15.00 = 45.00, reported as the single row it will become.
        assert_eq!(balance.pending_count, 1);
        assert_eq!(balance.pending_total, "45.00".parse::<Decimal>().unwrap());
        assert_eq!(
            ledger_snapshot(&db).await,
            before,
            "GET must not touch the ledger"
        );
    }

    #[tokio::test]
    async fn list_transactions_is_side_effect_free() {
        let db = seed_db().await;
        let (alice, _) = seed_legacy_ledger(&db).await;
        let before = ledger_snapshot(&db).await;

        let listed = BankService::new()
            .list_transactions(
                &db,
                Some(alice),
                &PaginationParams {
                    page: Some(1),
                    limit: Some(10),
                },
                &TransactionFilters::default(),
            )
            .await
            .unwrap();

        assert_eq!(listed.items.len(), 4, "the ledger is shown as stored");
        assert_eq!(ledger_snapshot(&db).await, before);
    }

    #[tokio::test]
    async fn withdraw_all_consolidates_legacy_rows_and_absorbs_clawbacks_atomically() {
        let db = seed_db().await;
        let (alice, split_a) = seed_legacy_ledger(&db).await;
        let service = BankService::new();
        let balance_before = service.get_balance(&db, alice).await.unwrap();

        let requested = service
            .request_withdrawal(
                &db,
                alice,
                &WithdrawRequest {
                    transaction_ids: None,
                    all: Some(true),
                    guild_tenant_id: None,
                },
            )
            .await
            .unwrap();

        assert_eq!(requested.len(), 1);
        assert_eq!(requested[0].split_id, Some(split_a));
        assert_eq!(requested[0].amount, "45.00".parse::<Decimal>().unwrap());
        let after = service.get_balance(&db, alice).await.unwrap();
        assert_eq!(after.pending_total, Decimal::ZERO);
        assert_eq!(after.requested_total, balance_before.pending_total);
        // The absorbed clawback and the folded duplicate rows are gone; nothing else changed.
        assert_eq!(TransactionEntity::find().all(&db).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn consolidation_leaves_manual_rows_linked_to_a_split_alone() {
        let db = seed_db().await;
        let (alice, split_a) = seed_legacy_ledger(&db).await;
        let manual = ActiveModel {
            to_user_id: Set(alice),
            amount: Set("7.00".parse().unwrap()),
            status: Set(TransactionStatus::Pending.to_string()),
            r#type: Set(TYPE_MANUAL.to_string()),
            split_id: Set(Some(split_a)),
            ..Default::default()
        }
        .insert(&db)
        .await
        .unwrap();

        let txn = db.begin().await.unwrap();
        consolidate_user_open_credits(&txn, alice).await.unwrap();
        txn.commit().await.unwrap();

        let kept = TransactionEntity::find_by_id(manual.id)
            .one(&db)
            .await
            .unwrap()
            .expect("manual row survives consolidation");
        assert_eq!(kept.amount, "7.00".parse::<Decimal>().unwrap());
        assert_eq!(kept.r#type, TYPE_MANUAL);
    }

    #[tokio::test]
    async fn consolidation_never_touches_rows_that_left_the_open_statuses() {
        let db = seed_db().await;
        let (alice, split_a) = seed_legacy_ledger(&db).await;
        // A row that is already requested is not open: it must neither merge nor absorb debt.
        let requested = insert_split_transaction(
            &db,
            alice,
            "30.00",
            TransactionStatus::Requested,
            Some(split_a),
        )
        .await;

        let txn = db.begin().await.unwrap();
        consolidate_user_open_credits(&txn, alice).await.unwrap();
        txn.commit().await.unwrap();

        let row = TransactionEntity::find_by_id(requested)
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.amount, "30.00".parse::<Decimal>().unwrap());
        assert_eq!(row.status, TransactionStatus::Requested.to_string());
    }

    async fn insert_typed_open_row(
        db: &DatabaseConnection,
        to_user_id: i64,
        amount: &str,
        row_type: &str,
    ) -> i64 {
        ActiveModel {
            to_user_id: Set(to_user_id),
            amount: Set(amount.parse().unwrap()),
            status: Set(TransactionStatus::Pending.to_string()),
            r#type: Set(row_type.to_string()),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap()
        .id
    }

    async fn withdraw_all(db: &DatabaseConnection, user_id: i64) -> Vec<TransactionView> {
        BankService::new()
            .request_withdrawal(
                db,
                user_id,
                &WithdrawRequest {
                    transaction_ids: None,
                    all: Some(true),
                    guild_tenant_id: None,
                },
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn withdraw_all_absorbs_clawback_into_non_split_credits_after_split_credits() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let officer = insert_user(&db, "officer", "officer@example.com").await;
        let old = chrono::Utc::now() - chrono::Duration::days(1);
        let split_a = insert_completed_split(&db, officer, old).await;
        let split_b = insert_completed_split(&db, officer, old).await;
        let giveaway = insert_typed_open_row(&db, alice, "20.00", "giveaway_credit").await;
        insert_split_transaction(
            &db,
            alice,
            "10.00",
            TransactionStatus::Pending,
            Some(split_a),
        )
        .await;
        insert_split_transaction(
            &db,
            alice,
            "-15.00",
            TransactionStatus::Withdrawn,
            Some(split_b),
        )
        .await;
        let net = service_pending_total(&db, alice).await;
        assert_eq!(net, "15.00".parse::<Decimal>().unwrap());

        let requested = withdraw_all(&db, alice).await;

        // The split credit is consumed first; the giveaway credit only absorbs the remainder.
        assert_eq!(requested.len(), 1);
        assert_eq!(requested[0].id, giveaway);
        assert_eq!(requested[0].amount, "15.00".parse::<Decimal>().unwrap());
        assert_eq!(TransactionEntity::find().all(&db).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn withdraw_all_keeps_debt_that_open_credits_cannot_absorb() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let officer = insert_user(&db, "officer", "officer@example.com").await;
        let old = chrono::Utc::now() - chrono::Duration::days(1);
        let split_a = insert_completed_split(&db, officer, old).await;
        let split_b = insert_completed_split(&db, officer, old).await;
        insert_typed_open_row(&db, alice, "20.00", "giveaway_credit").await;
        insert_typed_open_row(&db, alice, "4.00", "regear_credit").await;
        insert_split_transaction(
            &db,
            alice,
            "10.00",
            TransactionStatus::Pending,
            Some(split_a),
        )
        .await;
        insert_split_transaction(
            &db,
            alice,
            "-40.00",
            TransactionStatus::Withdrawn,
            Some(split_b),
        )
        .await;

        // 34 of credit against a 40 clawback: nothing is requestable, 6 of debt remains.
        assert!(withdraw_all(&db, alice).await.is_empty());
        let rows = TransactionEntity::find().all(&db).await.unwrap();
        assert_eq!(rows.len(), 1, "only the clawback is left: {rows:?}");
        assert_eq!(rows[0].amount, "-6.00".parse::<Decimal>().unwrap());
        assert_eq!(
            service_pending_total(&db, alice).await,
            "-6.00".parse::<Decimal>().unwrap()
        );
    }

    async fn service_pending_total(db: &DatabaseConnection, user_id: i64) -> Decimal {
        BankService::new()
            .get_balance(db, user_id)
            .await
            .unwrap()
            .pending_total
    }

    #[test]
    fn plan_absorbs_into_non_split_credits_once_split_credits_are_used_up() {
        let mut giveaway = model(3, "20.00", None, TransactionStatus::Pending);
        giveaway.r#type = "giveaway_credit".to_string();
        let open = [
            giveaway,
            model(5, "10.00", Some(1), TransactionStatus::Pending),
        ];
        let clawbacks = [model(9, "-35.00", Some(2), TransactionStatus::Withdrawn)];
        let plan = plan_open_credit_consolidation(&open, &clawbacks);
        let (open_after, claw_after) = plan.apply_in_memory(&open, &clawbacks);
        assert!(open_after.is_empty());
        assert_eq!(claw_after[0].amount, "-5.00".parse::<Decimal>().unwrap());
        assert_eq!(
            net_of_open_state(&open_after, &claw_after),
            net_of_open_state(&open, &clawbacks)
        );

        let clawbacks = [model(9, "-15.00", Some(2), TransactionStatus::Withdrawn)];
        let plan = plan_open_credit_consolidation(&open, &clawbacks);
        // Row 5 (split credit) goes first even though row 3 is older.
        assert_eq!(plan.open_deletes, vec![5]);
        assert_eq!(plan.open_updates, vec![(3, "15.00".parse().unwrap())]);
    }

    fn model(id: i64, amount: &str, split_id: Option<i64>, status: TransactionStatus) -> Model {
        Model {
            id,
            from_user_id: None,
            to_user_id: 1,
            to_guild_bank: false,
            amount: amount.parse().unwrap(),
            status: status.to_string(),
            r#type: TYPE_SPLIT_CREDIT.to_string(),
            split_id,
            created_at: chrono::Utc::now().into(),
            requested_at: None,
            withdrawn_at: None,
            updated_at: chrono::Utc::now().into(),
            alliance_distribution_key: None,
            source_alliance_tenant_id: None,
            source_alliance_split_id: None,
        }
    }

    #[test]
    fn plan_is_a_noop_for_a_clean_ledger() {
        let open = [
            model(1, "10.00", Some(1), TransactionStatus::Pending),
            model(2, "5.00", Some(2), TransactionStatus::Rejected),
        ];
        assert!(plan_open_credit_consolidation(&open, &[]).is_noop());
    }

    #[test]
    fn plan_merges_duplicates_and_absorbs_clawbacks_oldest_first() {
        let open = [
            model(1, "50.00", Some(1), TransactionStatus::Pending),
            model(2, "20.00", Some(1), TransactionStatus::Pending),
            model(3, "10.00", Some(2), TransactionStatus::Pending),
        ];
        let clawbacks = [model(9, "-75.00", Some(3), TransactionStatus::Withdrawn)];
        let plan = plan_open_credit_consolidation(&open, &clawbacks);
        let (open_after, claw_after) = plan.apply_in_memory(&open, &clawbacks);
        // split 1 merges to 70, which the 75 clawback consumes together with 5 of split 2.
        assert_eq!(open_after.len(), 1);
        assert_eq!(open_after[0].id, 3);
        assert_eq!(open_after[0].amount, "5.00".parse::<Decimal>().unwrap());
        assert!(claw_after.is_empty());
        assert_eq!(
            net_of_open_state(&open_after, &claw_after),
            "5.00".parse().unwrap()
        );
        assert_eq!(
            net_of_open_state(&open, &clawbacks),
            "5.00".parse().unwrap(),
            "consolidation preserves the net balance"
        );
    }

    #[test]
    fn plan_keeps_unabsorbed_debt_on_the_clawback_instead_of_dropping_it() {
        let open = [model(1, "10.00", Some(1), TransactionStatus::Pending)];
        let clawbacks = [
            model(8, "-15.00", Some(2), TransactionStatus::Withdrawn),
            model(9, "-5.00", Some(3), TransactionStatus::Withdrawn),
        ];
        let plan = plan_open_credit_consolidation(&open, &clawbacks);
        let (open_after, claw_after) = plan.apply_in_memory(&open, &clawbacks);
        assert!(open_after.is_empty());
        assert_eq!(claw_after.len(), 1);
        assert_eq!(claw_after[0].amount, "-10.00".parse::<Decimal>().unwrap());
        assert_eq!(
            net_of_open_state(&open_after, &claw_after),
            net_of_open_state(&open, &clawbacks)
        );
    }

    #[test]
    fn plan_keeps_non_positive_open_rows_when_there_is_nothing_to_absorb_them() {
        let open = [model(1, "-12.00", Some(1), TransactionStatus::Pending)];
        let plan = plan_open_credit_consolidation(&open, &[]);
        let (open_after, _) = plan.apply_in_memory(&open, &[]);
        assert_eq!(open_after.len(), 1, "the debt must stay recorded");
        assert_eq!(open_after[0].amount, "-12.00".parse::<Decimal>().unwrap());
        assert_eq!(
            net_of_open_state(&open_after, &[]),
            "-12.00".parse::<Decimal>().unwrap()
        );
    }

    #[tokio::test]
    async fn pg_concurrent_balance_reads_and_withdraw_all_never_corrupt_the_ledger() {
        let Some(tenant) = crate::postgres::test_support::TenantSchema::try_new("it_bkc").await
        else {
            return;
        };
        let db = tenant.db.clone();
        let (alice, split_a) = seed_legacy_ledger(&db).await;
        let total: Decimal = "45.00".parse().unwrap();

        let mut readers = Vec::new();
        for _ in 0..16 {
            let db = db.clone();
            readers.push(tokio::spawn(async move {
                BankService::new().get_balance(&db, alice).await
            }));
        }
        let mut writers = Vec::new();
        for _ in 0..3 {
            let db = db.clone();
            writers.push(tokio::spawn(async move {
                BankService::new()
                    .request_withdrawal(
                        &db,
                        alice,
                        &WithdrawRequest {
                            transaction_ids: None,
                            all: Some(true),
                            guild_tenant_id: None,
                        },
                    )
                    .await
            }));
        }

        for reader in readers {
            let balance = reader.await.unwrap().unwrap();
            assert_eq!(
                balance.pending_total + balance.requested_total,
                total,
                "every read sees a consistent snapshot"
            );
        }
        let mut requested_rows = 0;
        for writer in writers {
            requested_rows += writer.await.unwrap().unwrap().len();
        }
        assert_eq!(requested_rows, 1, "the credit is requested exactly once");

        let rows = TransactionEntity::find().all(&db).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].split_id, Some(split_a));
        assert_eq!(rows[0].amount, total);
        assert_eq!(rows[0].status, TransactionStatus::Requested.to_string());
        tenant.cleanup().await;
    }

    /// Two overlapping withdrawal requests must not both pass the net-balance check.
    ///
    /// The test holds the same per-user advisory lock, then proves the request blocks
    /// until that transaction commits a competing request. After the lock is released
    /// the waiter re-reads the balance and rejects the second row.
    #[tokio::test]
    async fn concurrent_withdrawal_requests_cannot_exceed_net_balance() {
        use crate::postgres::{
            connect_with_search_path, drop_schema, ensure_schema,
            test_support::{try_admin_db, unique_schema},
        };
        use std::time::Duration;

        let Some((url, admin)) = try_admin_db().await else {
            eprintln!("skipping concurrent withdrawal test: no postgres");
            return;
        };
        let schema = unique_schema("it_wdl");
        ensure_schema(&admin, &schema).await.expect("schema");
        let result = async {
            let db = connect_with_search_path(&url, &schema)
                .await
                .expect("connect");
            let waiter_db = connect_with_search_path(&url, &schema)
                .await
                .expect("connect waiter");
            crate::migration::Migrator::up(&db, None)
                .await
                .expect("migrate");

            let user = insert_user(&db, "alice", "alice@example.com").await;
            let first = insert_transaction(&db, user, "100.00", TransactionStatus::Pending).await;
            let second = insert_transaction(&db, user, "100.00", TransactionStatus::Pending).await;
            insert_transaction(&db, user, "-100.00", TransactionStatus::Withdrawn).await;

            let holder = db.begin().await.expect("begin holder");
            serialize_user_requestable_balance(&holder, user)
                .await
                .expect("lock balance");

            let service = BankService::new();
            let request = tokio::spawn(async move {
                service
                    .request_withdrawal(
                        &waiter_db,
                        user,
                        &WithdrawRequest {
                            transaction_ids: Some(vec![second]),
                            all: None,
                            guild_tenant_id: None,
                        },
                    )
                    .await
            });

            let started = std::time::Instant::now();
            while !request.is_finished() && started.elapsed() < Duration::from_secs(2) {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert!(
                !request.is_finished(),
                "withdrawal request did not wait for the user balance lock"
            );

            TransactionEntity::update_many()
                .filter(Column::Id.eq(first))
                .set(ActiveModel {
                    status: Set(TransactionStatus::Requested.to_string()),
                    ..Default::default()
                })
                .exec(&holder)
                .await
                .expect("mark competing request");
            holder.commit().await.expect("commit holder");

            let error = request
                .await
                .expect("request task")
                .expect_err("second request must not exceed the net balance");
            assert!(
                matches!(error, AppError::Validation(ref message) if message.contains("net requestable")),
                "unexpected error: {error}"
            );

            let still_pending = TransactionEntity::find_by_id(second)
                .one(&db)
                .await
                .expect("load")
                .expect("row");
            assert_eq!(still_pending.status, TransactionStatus::Pending.to_string());
        }
        .await;
        drop_schema(&admin, &schema).await.expect("drop schema");
        result;
    }
}
