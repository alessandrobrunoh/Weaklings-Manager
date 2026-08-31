//! Bank service logic module.
//!
//! Provides the Guild Bank ledger: derived balances, transaction listing, and the two-step
//! withdrawal workflow (a user requests withdrawal of their requestable transactions, then an
//! officer accepts and pays them out — becoming the recorded payer via `from_user_id`).
//! Request/response types live in `models.rs`; the status enum lives in `status.rs`.

use std::str::FromStr;

use sea_orm::prelude::Decimal;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, Condition, DatabaseConnection, EntityTrait,
    JoinType, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, RelationTrait,
    TransactionTrait,
};

use crate::errors::AppError;
use crate::modules::users::entities::{Column as UserColumn, Entity as UserEntity};
use crate::pagination::{PaginatedData, PaginationParams, SortOrder, resolve_sort_key};

use super::entities::{ActiveModel, Column, Entity as TransactionEntity, Model};
use super::models::{
    AcceptWithdrawalRequest, BalanceSummary, GuildBankSummary, RejectWithdrawalRequest,
    TransactionFilters, TransactionView, WithdrawRequest,
};
use super::status::TransactionStatus;

/// The transaction type generated when a split is completed.
pub const TYPE_SPLIT_CREDIT: &str = "split_credit";

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

async fn to_views_with_usernames(
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
            let mut active: ActiveModel = model.into();
            active.status = Set(TransactionStatus::Requested.to_string());
            active.requested_at = Set(Some(now));
            let updated = active.update(&txn).await?;
            updated_models.push(updated);
        }

        txn.commit().await?;

        for updated in &updated_models {
            let _ = crate::modules::audit::service::AuditService::log(
                db,
                "WITHDRAW_REQUESTED",
                Some("TRANSACTION"),
                Some(updated.id),
                Some(user_id),
                Some(serde_json::json!({ "status": "requested" })),
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
            let mut active: ActiveModel = model.into();
            active.status = Set(TransactionStatus::Withdrawn.to_string());
            active.from_user_id = Set(Some(officer_user_id));
            active.withdrawn_at = Set(Some(now));
            let updated = active.update(&txn).await?;
            updated_models.push(updated);
        }

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
                    "target_user_id": updated.to_user_id
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
        for model in targets {
            let mut active: ActiveModel = model.into();
            active.status = Set(TransactionStatus::Rejected.to_string());
            active.requested_at = Set(None);
            let updated = active.update(&txn).await?;
            updated_models.push(updated);
        }

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
                    "target_user_id": updated.to_user_id
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
        let active = ActiveModel {
            from_user_id: Set(None),
            to_user_id: Set(to_user_id),
            amount: Set(amount.parse().unwrap()),
            status: Set(status.to_string()),
            r#type: Set(TYPE_SPLIT_CREDIT.to_string()),
            split_id: Set(None),
            ..Default::default()
        };
        active
            .insert(db)
            .await
            .expect("Failed to insert transaction")
            .id
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
}
