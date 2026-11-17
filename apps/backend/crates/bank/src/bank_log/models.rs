//! Request and response shapes of the Albion bank log API.

use sea_orm::prelude::Decimal;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

/// One line of the Albion guild bank log, as the in-game JSON export writes it.
///
/// The export keys are capitalised (`Date`, `Player`, `Reason`, `Amount`); lowercase keys are
/// accepted too. `Date` is UTC, `YYYY-MM-DD HH:MM:SS`. `Amount` is a signed integer string.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "Date": "2026-11-16 23:10:00",
    "Player": "Galvdon",
    "Reason": "Withdrawal",
    "Amount": "-7414881"
}))]
pub struct BankLogImportRow {
    #[serde(alias = "Date")]
    pub date: String,
    #[serde(alias = "Player")]
    pub player: String,
    #[serde(alias = "Reason")]
    pub reason: String,
    /// Signed silver amount, as a string or a number.
    #[serde(alias = "Amount")]
    #[schema(value_type = String)]
    pub amount: serde_json::Value,
}

/// Body of `POST /api/bank/log/import`.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct BankLogImportRequest {
    /// Every line of the export, in any order.
    pub rows: Vec<BankLogImportRow>,
}

/// What an import stored.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BankLogImportResult {
    /// Id shared by the rows this import stored (empty when nothing new was stored).
    pub batch_id: String,
    /// Lines in the request.
    pub total: u64,
    /// Rows stored now.
    pub inserted: u64,
    /// Lines already stored by an earlier import.
    pub already_stored: u64,
    /// Stored rows that are a second (or later) identical line of the same minute.
    pub duplicates_kept: u64,
    /// Suggestions proposed after the import.
    pub suggestions: u64,
}

/// A Manager record a log row is linked to.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BankLogLinkTargetView {
    /// Bank transaction, for payouts and created transactions.
    pub transaction_id: Option<i64>,
    /// Split, for bags and loot sales.
    pub split_id: Option<i64>,
    /// Short label (`Payout to Alice`, `Split #12 bags`). `Removed` when the record is gone.
    pub label: String,
    /// Member who received a payout.
    pub member_username: Option<String>,
    /// The amount this target stands for (payout amount, bags value, expected sale).
    #[schema(value_type = Option<String>)]
    pub amount: Option<Decimal>,
    /// When the Manager record happened (payout time, split creation).
    pub at: Option<String>,
}

/// A link between log rows and Manager records.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BankLogLinkView {
    pub id: i64,
    /// `payout`, `bags`, `loot_sale` or `manual`.
    pub kind: String,
    /// `false` while it is a suggestion.
    pub confirmed: bool,
    /// Every log row in the link.
    pub entry_ids: Vec<i64>,
    /// Sum of the log rows in the link (signed).
    #[schema(value_type = String)]
    pub entries_total: Decimal,
    pub targets: Vec<BankLogLinkTargetView>,
}

/// One stored log row with its links.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BankLogEntryView {
    pub id: i64,
    pub occurred_at: String,
    pub player_name: String,
    pub reason: String,
    #[schema(value_type = String)]
    pub amount: Decimal,
    /// 1 for the first identical line of a minute, 2 for the second, ...
    pub occurrence: i32,
    pub category: String,
    /// `unmatched`, `suggested`, `matched` or `explained`.
    pub status: String,
    pub note: Option<String>,
    pub explained_at: Option<String>,
    pub batch_id: String,
    pub imported_at: String,
    pub created_transaction_id: Option<i64>,
    /// Confirmed links first, then suggestions.
    pub links: Vec<BankLogLinkView>,
}

/// Query of `GET /api/bank/log/entries`.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
pub struct BankLogEntryQuery {
    pub page: Option<u64>,
    pub limit: Option<u64>,
    /// Inclusive UTC day, `YYYY-MM-DD`.
    pub from: Option<String>,
    /// Inclusive UTC day, `YYYY-MM-DD`.
    pub to: Option<String>,
    pub status: Option<String>,
    pub category: Option<String>,
    /// Matches player name or reason.
    pub search: Option<String>,
}

/// Query of `GET /api/bank/log/summary`.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
pub struct BankLogPeriodQuery {
    /// Inclusive UTC day, `YYYY-MM-DD`. Defaults to 28 days ago.
    pub from: Option<String>,
    /// Inclusive UTC day, `YYYY-MM-DD`. Defaults to today.
    pub to: Option<String>,
}

/// Totals of one category over a period.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BankLogCategoryTotals {
    pub category: String,
    pub rows: u64,
    /// Sum of the game rows (signed).
    #[schema(value_type = String)]
    pub game_total: Decimal,
    /// Sum of the rows in confirmed links.
    #[schema(value_type = String)]
    pub linked_total: Decimal,
    /// Sum of the rows marked explained.
    #[schema(value_type = String)]
    pub explained_total: Decimal,
    /// What is neither linked nor explained.
    #[schema(value_type = String)]
    pub open_total: Decimal,
}

/// Import status shown above the page and used by the reminder.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BankLogImportStatus {
    pub last_import_at: Option<String>,
    /// Whole UTC days since the last import.
    pub days_since_import: Option<i64>,
    /// Days before the oldest unimported rows start leaving the 28-day game log.
    pub days_until_loss: Option<i64>,
    /// Reminders start on this day after the last import.
    pub reminder_after_days: i64,
    pub reminder_channel_set: bool,
    pub staff_role_set: bool,
    pub last_reminded_on: Option<String>,
    pub reminder_error: Option<String>,
}

/// `GET /api/bank/log/summary`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BankLogSummary {
    pub from: String,
    pub to: String,
    #[schema(value_type = String)]
    pub game_in: Decimal,
    #[schema(value_type = String)]
    pub game_out: Decimal,
    /// Game in + out.
    #[schema(value_type = String)]
    pub game_net: Decimal,
    /// Payouts the Manager accepted in the period (its own total, independent of the links).
    #[schema(value_type = String)]
    pub manager_payouts: Decimal,
    /// Game withdrawals categorised as payouts in the period (as a positive number).
    #[schema(value_type = String)]
    pub game_payouts: Decimal,
    pub unmatched: u64,
    pub suggested: u64,
    pub matched: u64,
    pub explained: u64,
    pub categories: Vec<BankLogCategoryTotals>,
    pub import: BankLogImportStatus,
    pub seller_accounts: Vec<String>,
}

/// One import batch.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BankLogBatchView {
    pub batch_id: String,
    pub imported_at: String,
    pub imported_by: Option<i64>,
    pub rows: u64,
    pub first_at: String,
    pub last_at: String,
}

/// `PATCH /api/bank/log/entries/{id}`.
#[derive(Debug, Clone, Default, Deserialize, ToSchema)]
pub struct BankLogUpdateEntryRequest {
    /// New category.
    pub category: Option<String>,
    /// New note. Empty clears it (and un-explains the row).
    pub note: Option<String>,
    /// `true` marks the row explained (needs a note), `false` clears it.
    pub explained: Option<bool>,
}

/// `POST /api/bank/log/links`: a manual, confirmed link.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct BankLogCreateLinkRequest {
    pub entry_ids: Vec<i64>,
    #[serde(default)]
    pub transaction_ids: Vec<i64>,
    #[serde(default)]
    pub split_ids: Vec<i64>,
    /// `payout`, `bags`, `loot_sale` or `manual` (default).
    pub kind: Option<String>,
}

/// `POST /api/bank/log/entries/{id}/transaction`.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct BankLogCreateEntryTransactionRequest {
    /// Member the transaction belongs to.
    pub to_user_id: i64,
    /// Positive silver amount. Defaults to the row amount without sign.
    #[schema(value_type = Option<String>)]
    pub amount: Option<Decimal>,
}

/// A Manager record an officer can link a row to by hand.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BankLogCandidateView {
    /// `transaction` or `split`.
    pub kind: String,
    pub transaction_id: Option<i64>,
    pub split_id: Option<i64>,
    pub label: String,
    pub member_username: Option<String>,
    /// Payout amount, or for splits the bags value / expected sale (see `split_*`).
    #[schema(value_type = Option<String>)]
    pub amount: Option<Decimal>,
    #[schema(value_type = Option<String>)]
    pub split_bags_value: Option<Decimal>,
    #[schema(value_type = Option<String>)]
    pub split_expected_sale: Option<Decimal>,
    pub at: Option<String>,
    /// Already part of a confirmed link.
    pub linked: bool,
}

/// `POST /api/bank/log/suggestions/refresh`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BankLogRefreshResult {
    /// Suggestions proposed.
    pub suggestions: u64,
}

/// `DELETE /api/bank/log/batches/{batch_id}`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BankLogDeleteBatchResult {
    /// Rows deleted.
    pub deleted: u64,
}
