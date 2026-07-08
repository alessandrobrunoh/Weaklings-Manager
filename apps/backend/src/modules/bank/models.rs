//! Request/response DTOs and view models for the bank module.
//!
//! Business logic lives in `service.rs`; this module only defines the shapes exchanged over
//! the API and their `OpenAPI` schemas.

use sea_orm::prelude::Decimal;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::entities::Model;
use super::status::TransactionStatus;

/// A single transaction as seen by a client.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct TransactionView {
    /// The unique identifier of the transaction.
    #[schema(example = 1)]
    pub id: i64,
    /// The user id of the officer who paid this out, or `None` until withdrawn.
    pub from_user_id: Option<i64>,
    /// A human-readable label for the payer ("Guild Bank" until withdrawn, then the payer's user id).
    #[schema(example = "Guild Bank")]
    pub from_label: String,
    /// The user id who is owed / receives the amount.
    #[schema(example = 7)]
    pub to_user_id: i64,
    /// The transaction amount.
    #[schema(value_type = String, example = "42.50")]
    pub amount: Decimal,
    /// The lifecycle status of the transaction.
    pub status: TransactionStatus,
    /// The kind of transaction, e.g. `"split_credit"`.
    #[schema(example = "split_credit")]
    pub r#type: String,
    /// The split that generated this transaction, if any.
    #[schema(example = 3)]
    pub split_id: Option<i64>,
    /// The timestamp when the transaction was created.
    pub created_at: String,
    /// The timestamp when the recipient requested withdrawal, if they have.
    pub requested_at: Option<String>,
    /// The timestamp when the withdrawal was accepted/paid, if it has been.
    pub withdrawn_at: Option<String>,
}

impl TransactionView {
    pub(super) fn from_model(
        model: Model,
        status: TransactionStatus,
        from_username: Option<String>,
    ) -> Self {
        let from_label = from_username.unwrap_or_else(|| {
            model
                .from_user_id
                .map_or_else(|| "Guild Bank".to_string(), |id| id.to_string())
        });
        Self {
            id: model.id,
            from_user_id: model.from_user_id,
            from_label,
            to_user_id: model.to_user_id,
            amount: model.amount,
            status,
            r#type: model.r#type,
            split_id: model.split_id,
            created_at: model.created_at.to_rfc3339(),
            requested_at: model.requested_at.map(|dt| dt.to_rfc3339()),
            withdrawn_at: model.withdrawn_at.map(|dt| dt.to_rfc3339()),
        }
    }
}

/// A user's derived Guild Bank balance.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct BalanceSummary {
    /// The user this balance belongs to.
    #[schema(example = 7)]
    pub user_id: i64,
    /// The total amount still owed and not yet requested for withdrawal.
    #[schema(value_type = String, example = "128.75")]
    pub pending_total: Decimal,
    /// The number of pending transactions contributing to `pending_total`.
    #[schema(example = 3)]
    pub pending_count: u64,
    /// The total amount requested for withdrawal, awaiting officer acceptance.
    #[schema(value_type = String, example = "40.00")]
    pub requested_total: Decimal,
    /// The number of requested transactions contributing to `requested_total`.
    #[schema(example = 1)]
    pub requested_count: u64,
}

/// Filters that can be applied when listing transactions.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct TransactionFilters {
    /// Filter by transaction status.
    pub status: Option<TransactionStatus>,
}

/// Request body to request withdrawal of one, several, or all of the caller's pending
/// transactions.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct WithdrawRequest {
    /// The specific transaction ids to request withdrawal for. Each must belong to the caller and
    /// currently be `pending`. Omit this and set `all: true` instead to request everything at once.
    #[schema(example = json!([12, 13]))]
    pub transaction_ids: Option<Vec<i64>>,
    /// If `true`, request withdrawal of every one of the caller's currently-pending transactions
    /// instead of listing `transaction_ids` individually.
    #[schema(example = true)]
    pub all: Option<bool>,
}

/// Request body for an officer to accept (and pay out) requested withdrawals.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct AcceptWithdrawalRequest {
    /// The specific transaction ids to accept. Each must currently be `requested` (any member's,
    /// not just the caller's). Omit this and set `all: true` instead to accept everything at once.
    #[schema(example = json!([12, 13]))]
    pub transaction_ids: Option<Vec<i64>>,
    /// If `true`, accept every currently-requested transaction guild-wide (across all members)
    /// instead of listing `transaction_ids` individually.
    #[schema(example = true)]
    pub all: Option<bool>,
}
