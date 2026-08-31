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
    /// The username of the user who is owed / receives the amount.
    #[schema(example = "Alice")]
    pub to_username: String,
    /// The display label for the actual destination. This is `Guild Bank` for donations.
    #[schema(example = "Guild Bank")]
    pub to_label: String,
    /// Whether this row represents a movement to the virtual Guild Bank.
    pub to_guild_bank: bool,
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
    /// The timestamp when the recipient last requested withdrawal, if the request is active.
    pub requested_at: Option<String>,
    /// The timestamp when the withdrawal was accepted/paid, if it has been.
    pub withdrawn_at: Option<String>,
}

impl TransactionView {
    pub(super) fn from_model(
        model: Model,
        status: TransactionStatus,
        from_username: Option<String>,
        to_username: String,
    ) -> Self {
        let from_label = from_username.unwrap_or_else(|| {
            model
                .from_user_id
                .map_or_else(|| "Guild Bank".to_string(), |id| id.to_string())
        });
        let to_label = if model.to_guild_bank {
            "Guild Bank".to_string()
        } else {
            to_username.clone()
        };
        Self {
            id: model.id,
            from_user_id: model.from_user_id,
            from_label,
            to_user_id: model.to_user_id,
            to_username,
            to_label,
            to_guild_bank: model.to_guild_bank,
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
    /// The total amount still owed and currently requestable for withdrawal.
    #[schema(value_type = String, example = "128.75")]
    pub pending_total: Decimal,
    /// The number of pending or rejected transactions contributing to `pending_total`.
    #[schema(example = 3)]
    pub pending_count: u64,
    /// The total amount requested for withdrawal, awaiting officer acceptance.
    #[schema(value_type = String, example = "40.00")]
    pub requested_total: Decimal,
    /// The number of requested transactions contributing to `requested_total`.
    #[schema(example = 1)]
    pub requested_count: u64,
}

/// Guild-wide aggregate of paid-out Guild Bank transactions.
///
/// Lives apart from `BalanceSummary` because the latter is per-user and only covers
/// `pending`/`requested` states — it intentionally excludes the `withdrawn` ledger
/// that officers have already settled. This struct surfaces that hidden total so the
/// dashboard can show "how much the guild has actually paid out".
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct GuildBankSummary {
    /// Total silver the Guild Bank has paid out across all members (status `withdrawn`).
    #[schema(value_type = String, example = "12_480.50")]
    pub paid_total: Decimal,
    /// Number of `withdrawn` transactions contributing to `paid_total`.
    #[schema(example = 87)]
    pub paid_count: u64,
}

/// One grouped money-flow line in the administrator bank report.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct BankBreakdown {
    /// Human-readable group label, such as a username, `Guild Bank`, or transaction type.
    pub label: String,
    /// Number of ledger rows in this group.
    pub transaction_count: u64,
    /// Sum of the positive amounts represented by this group.
    #[schema(value_type = String, example = "1250.00")]
    pub total_amount: Decimal,
}

/// Guild-wide bank statistics for the administrator panel.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct BankAnalyticsSummary {
    /// Number of ledger rows, regardless of current status.
    pub transaction_count: u64,
    /// Sum of all ledger row amounts.
    #[schema(value_type = String, example = "12500.00")]
    pub ledger_volume: Decimal,
    /// Rows that are still available to request or request again.
    #[schema(value_type = String, example = "3000.00")]
    pub outstanding_total: Decimal,
    pub outstanding_count: u64,
    /// Rows whose withdrawal was requested but not yet paid.
    #[schema(value_type = String, example = "800.00")]
    pub requested_total: Decimal,
    pub requested_count: u64,
    /// Rows already paid out by an officer.
    #[schema(value_type = String, example = "9000.00")]
    pub paid_out_total: Decimal,
    pub paid_out_count: u64,
    /// Rows donated back to the Guild Bank.
    #[schema(value_type = String, example = "500.00")]
    pub donated_total: Decimal,
    pub donated_count: u64,
    /// Aggregation by recorded source.
    pub sources: Vec<BankBreakdown>,
    /// Aggregation by actual destination.
    pub destinations: Vec<BankBreakdown>,
    /// Aggregation by transaction type.
    pub transaction_types: Vec<BankBreakdown>,
}

/// Filters that can be applied when listing transactions.
#[derive(Debug, Clone, Deserialize, ToSchema, Default)]
pub struct TransactionFilters {
    /// Filter by transaction status.
    pub status: Option<TransactionStatus>,
    /// Case-insensitive substring match on the recipient username.
    pub search: Option<String>,
    /// Sort column. Allowed: `created_at` (default), `amount`, `status`, `to_username`.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc`. Defaults to `desc`.
    pub order: Option<String>,
}

/// Request body to request withdrawal of one, several, or all of the caller's requestable
/// transactions.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct WithdrawRequest {
    /// The specific transaction ids to request withdrawal for. Each must belong to the caller and
    /// currently be `pending` or `rejected`. Omit this and set `all: true` instead to request
    /// everything at once.
    #[schema(example = json!([12, 13]))]
    pub transaction_ids: Option<Vec<i64>>,
    /// If `true`, request withdrawal of every one of the caller's currently-requestable transactions
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
    /// Restrict `all` to a single member.
    ///
    /// Without it `all: true` sweeps the whole guild, which is the wrong tool
    /// when an officer wants to settle up with one person: they would have to
    /// list that member's transaction ids by hand.
    #[schema(example = 7)]
    pub user_id: Option<i64>,
}

/// Request body for an officer to reject requested withdrawals.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct RejectWithdrawalRequest {
    /// The specific transaction ids to reject. Each must currently be `requested`. Omit this and
    /// set `all: true` instead to reject everything at once.
    #[schema(example = json!([12, 13]))]
    pub transaction_ids: Option<Vec<i64>>,
    /// If `true`, reject every currently-requested transaction guild-wide (across all members)
    /// instead of listing `transaction_ids` individually.
    #[schema(example = true)]
    pub all: Option<bool>,
    /// Restrict `all` to a single member.
    ///
    /// Without it `all: true` sweeps the whole guild, which is the wrong tool
    /// when an officer wants to settle up with one person: they would have to
    /// list that member's transaction ids by hand.
    #[schema(example = 7)]
    pub user_id: Option<i64>,
}
