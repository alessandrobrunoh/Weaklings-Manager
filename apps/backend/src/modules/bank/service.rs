//! Bank service logic module.
//!
//! Provides the Guild Bank ledger: derived balances, transaction listing, and the two-step
//! withdrawal workflow (a user requests withdrawal of their pending transactions, then an
//! officer accepts and pays them out — becoming the recorded payer via `from_user_id`).
//! Request/response types live in `models.rs`; the status enum lives in `status.rs`.

use std::str::FromStr;

use sea_orm::prelude::Decimal;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait,
    PaginatorTrait, QueryFilter, TransactionTrait,
};

use crate::errors::AppError;
use crate::pagination::{PaginatedData, PaginationParams};

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

    /// Computes the derived balance for a user: what's pending (not yet requested) and what's
    /// requested (awaiting officer acceptance).
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
            .filter(Column::Status.eq(TransactionStatus::Pending.to_string()))
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
    /// Returns `AppError::Database` if the query fails.
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

    /// Requests withdrawal of one, several, or all of a user's pending transactions, moving them
    /// to `"requested"` status. Does not pay them out — an officer must accept via
    /// [`Self::accept_withdrawal`].
    ///
    /// A transaction can only have its withdrawal requested if it belongs to the caller and is
    /// still pending — this is enforced directly by the update predicate.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::Validation` if neither `transaction_ids` nor `all` is provided, or if
    ///   one or more requested transaction ids are not the caller's or are not pending.
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
                .filter(Column::Status.eq(TransactionStatus::Pending.to_string()))
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
            .filter(Column::Status.eq(TransactionStatus::Pending.to_string()))
            .all(&txn)
            .await?;

        if targets.len() != ids.len() {
            return Err(AppError::Validation(
                "one or more transactions are not yours or are not pending".to_string(),
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
            TransactionEntity::find()
                .filter(Column::Status.eq(TransactionStatus::Requested.to_string()))
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

        let updated_views = to_views_with_usernames(db, updated_models).await?;

        Ok(updated_views)
    }

    /// Rejects one, several, or all currently-requested withdrawals, returning them to `"pending"`.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::Validation` if neither `transaction_ids` nor `all` is provided, or if
    ///   one or more requested transaction ids are not currently in `"requested"` status.
    /// * Returns `AppError::Database` if the query fails.
    pub async fn reject_withdrawal(
        &self,
        db: &DatabaseConnection,
        req: &RejectWithdrawalRequest,
    ) -> Result<Vec<TransactionView>, AppError> {
        let ids: Vec<i64> = if req.all.unwrap_or(false) {
            TransactionEntity::find()
                .filter(Column::Status.eq(TransactionStatus::Requested.to_string()))
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
            active.status = Set(TransactionStatus::Pending.to_string());
            active.requested_at = Set(None);
            let updated = active.update(&txn).await?;
            updated_models.push(updated);
        }

        txn.commit().await?;

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
        insert_transaction(&db, user_id, "99.00", TransactionStatus::Withdrawn).await;

        let service = BankService::new();
        let balance = service.get_balance(&db, user_id).await.unwrap();

        assert_eq!(balance.pending_count, 2);
        assert_eq!(balance.pending_total, "15.25".parse::<Decimal>().unwrap());
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

        assert_eq!(requested.len(), 2);
        assert!(
            requested
                .iter()
                .all(|tx| tx.status == TransactionStatus::Requested)
        );

        let balance = service.get_balance(&db, alice).await.unwrap();
        assert_eq!(balance.pending_count, 0);
        assert_eq!(balance.requested_count, 2);
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
                    transaction_ids: Some(vec![tx_id]),
                    all: None,
                },
            )
            .await
            .unwrap();

        assert_eq!(accepted.len(), 1);
        assert_eq!(accepted[0].status, TransactionStatus::Withdrawn);
        assert_eq!(accepted[0].from_user_id, Some(officer));
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
                    transaction_ids: Some(vec![tx_id]),
                    all: None,
                },
            )
            .await;

        assert!(result.is_err());
    }
}
