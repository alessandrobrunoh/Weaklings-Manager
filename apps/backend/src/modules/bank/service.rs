//! Bank service logic module.
//!
//! Provides the Guild Bank ledger: derived balances, transaction listing, and the two-step
//! withdrawal workflow (a user requests withdrawal of their requestable transactions, then an
//! officer accepts and pays them out — becoming the recorded payer via `from_user_id`).
//! Request/response types live in `models.rs`; the status enum lives in `status.rs`.

use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
};

use sea_orm::prelude::Decimal;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait,
    DatabaseConnection, EntityTrait, JoinType, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, RelationTrait, TransactionTrait,
};

use crate::errors::AppError;
use crate::modules::splits::entities::split::{Column as SplitColumn, Entity as SplitEntity};
use crate::modules::splits::status::SplitStatus;
use crate::modules::users::entities::{Column as UserColumn, Entity as UserEntity};
use crate::pagination::{PaginatedData, PaginationParams, SortOrder, resolve_sort_key};

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

/// Shared predicate for balances and withdrawal requests.
///
/// A rejected withdrawal should behave like available balance, but keeping this predicate in one
/// place prevents the acceptance path from accidentally treating rejected rows as payable.
///
/// # Example
/// ```rust,ignore
/// let query = TransactionEntity::find().filter(requestable_status_condition());
/// ```
fn requestable_status_condition() -> Condition {
    Condition::any()
        .add(Column::Status.eq(TransactionStatus::Pending.to_string()))
        .add(Column::Status.eq(TransactionStatus::Rejected.to_string()))
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
    /// requested again before an officer can accept them.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Database` if the query fails.
    pub async fn get_balance(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
    ) -> Result<BalanceSummary, AppError> {
        let pending = TransactionEntity::find()
            .filter(Column::ToUserId.eq(user_id))
            .filter(requestable_status_condition())
            .all(db)
            .await?;
        let requested = TransactionEntity::find()
            .filter(Column::ToUserId.eq(user_id))
            .filter(Column::Status.eq(TransactionStatus::Requested.to_string()))
            .all(db)
            .await?;

        let pending_total = pending
            .iter()
            .fold(Decimal::ZERO, |acc, tx| acc + tx.amount);
        let requested_total = requested
            .iter()
            .fold(Decimal::ZERO, |acc, tx| acc + tx.amount);

        Ok(BalanceSummary {
            user_id,
            pending_total,
            pending_count: pending.len() as u64,
            requested_total,
            requested_count: requested.len() as u64,
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
            .filter(requestable_status_condition())
            .all(&txn)
            .await?;

        let Some(candidate) = candidates.into_iter().next() else {
            return Err(AppError::Conflict(
                "no requestable split share is available for this user".to_string(),
            ));
        };

        let updated = TransactionEntity::update_many()
            .filter(Column::Id.eq(candidate.id))
            .filter(requestable_status_condition())
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
        let needs_user_join = search.is_some() || sort_key == "to_username";
        if needs_user_join {
            query = query.join(JoinType::InnerJoin, super::entities::Relation::ToUser.def());
        }
        if let Some(term) = search {
            let pattern = format!("%{}%", term.to_lowercase());
            query = query.filter(
                Expr::expr(Func::lower(Expr::col((UserEntity, UserColumn::Username))))
                    .like(pattern),
            );
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
        let ids: Vec<i64> = if req.all.unwrap_or(false) {
            TransactionEntity::find()
                .filter(Column::ToUserId.eq(user_id))
                .filter(requestable_status_condition())
                .all(db)
                .await?
                .into_iter()
                .map(|tx| tx.id)
                .collect()
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
            .filter(Column::ToUserId.eq(user_id))
            .filter(requestable_status_condition())
            .all(&txn)
            .await?;

        if targets.len() != ids.len() {
            return Err(AppError::Validation(
                "one or more transactions are not yours or are not requestable".to_string(),
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
                .filter(requestable_status_condition())
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
            crate::modules::audit::service::AuditService::log(
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
            .await?;
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
            crate::modules::audit::service::AuditService::log(
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
            .await?;
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
    /// * Returns `AppError::Validation` if `amount` is not positive.
    /// * Returns `AppError::NotFound` if `to_user_id`, `from_user_id`, or `split_id` don't exist.
    /// * Returns `AppError::Database` if the query fails.
    pub async fn create_transaction(
        &self,
        db: &DatabaseConnection,
        req: &CreateTransactionRequest,
        actor_user_id: i64,
    ) -> Result<TransactionView, AppError> {
        if req.amount <= Decimal::ZERO {
            return Err(AppError::Validation("amount must be positive".to_string()));
        }
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
        if let Some(from_user_id) = req.from_user_id {
            if UserEntity::find_by_id(from_user_id).one(db).await?.is_none() {
                return Err(AppError::NotFound(format!("User {from_user_id} not found")));
            }
        }
        if let Some(split_id) = req.split_id {
            if SplitEntity::find_by_id(split_id).one(db).await?.is_none() {
                return Err(AppError::NotFound(format!("Split {split_id} not found")));
            }
        }

        let status = req.status.unwrap_or(TransactionStatus::Pending);
        let now = chrono::Utc::now().into();
        let active = ActiveModel {
            from_user_id: Set(req.from_user_id),
            to_user_id: Set(req.to_user_id),
            to_guild_bank: Set(req.to_guild_bank.unwrap_or(false)),
            amount: Set(req.amount),
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
    /// * Returns `AppError::Validation` if a provided `amount` is not positive.
    /// * Returns `AppError::Database` if the query fails.
    pub async fn update_transaction(
        &self,
        db: &DatabaseConnection,
        id: i64,
        req: &UpdateTransactionRequest,
        actor_user_id: i64,
    ) -> Result<TransactionView, AppError> {
        let existing = TransactionEntity::find_by_id(id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Transaction {id} not found")))?;

        if let Some(amount) = req.amount {
            if amount <= Decimal::ZERO {
                return Err(AppError::Validation("amount must be positive".to_string()));
            }
        }
        if let Some(to_user_id) = req.to_user_id {
            if UserEntity::find_by_id(to_user_id).one(db).await?.is_none() {
                return Err(AppError::NotFound(format!("User {to_user_id} not found")));
            }
        }
        if let Some(Some(from_user_id)) = req.from_user_id {
            if UserEntity::find_by_id(from_user_id).one(db).await?.is_none() {
                return Err(AppError::NotFound(format!("User {from_user_id} not found")));
            }
        }
        if let Some(Some(split_id)) = req.split_id {
            if SplitEntity::find_by_id(split_id).one(db).await?.is_none() {
                return Err(AppError::NotFound(format!("Split {split_id} not found")));
            }
        }

        let old_split_id = existing.split_id;
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
            active.amount = Set(amount);
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
        active.updated_at = Set(chrono::Utc::now().into());

        let updated = active.update(db).await?;

        let mut touched_splits: Vec<i64> = old_split_id.into_iter().collect();
        touched_splits.extend(updated.split_id);
        touched_splits.sort_unstable();
        touched_splits.dedup();
        touch_split_ids(db, &touched_splits).await?;

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
    /// * Returns `AppError::Database` if the query fails.
    pub async fn delete_transaction(
        &self,
        db: &DatabaseConnection,
        id: i64,
        actor_user_id: i64,
    ) -> Result<(), AppError> {
        let existing = TransactionEntity::find_by_id(id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Transaction {id} not found")))?;

        TransactionEntity::delete_by_id(id).exec(db).await?;

        if let Some(split_id) = existing.split_id {
            touch_split_ids(db, &[split_id]).await?;
        }

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
                "split_id": existing.split_id
            })),
        )
        .await?;

        Ok(())
    }
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
        insert_split_transaction(&db, alice, "10.00", TransactionStatus::Pending, Some(split_a))
            .await;
        insert_split_transaction(&db, alice, "5.00", TransactionStatus::Pending, Some(split_b))
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
    async fn create_transaction_rejects_non_positive_amount() {
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
                },
                alice,
            )
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::Validation(_)));
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
        let id =
            insert_split_transaction(&db, alice, "10.00", TransactionStatus::Pending, Some(split_id))
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
        let id =
            insert_split_transaction(&db, alice, "10.00", TransactionStatus::Pending, Some(split_id))
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
}
