//! `OpenAPI` response schemas for the `bank` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

use crate::models::TransactionView;
use backend_core::pagination::PaginatedData;

/// `OpenAPI` schema wrapper for `BalanceSummary` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBalanceSummary {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The balance summary data payload.
    pub data: crate::models::BalanceSummary,
}

/// `OpenAPI` schema wrapper for `GuildBankSummary` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseGuildBankSummary {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The guild-wide payout aggregate payload.
    pub data: crate::models::GuildBankSummary,
}

/// `OpenAPI` schema wrapper for administrator Guild Bank analytics.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBankAnalyticsSummary {
    /// Indicates the outcome of the request, always `"success"`.
    #[schema(example = "success")]
    pub status: String,
    /// Guild-wide bank analytics payload.
    pub data: crate::models::BankAnalyticsSummary,
}

/// `OpenAPI` schema wrapper for a list-of-`TransactionView` response (the withdrawal
/// request/accept endpoints return the transactions they just touched, not paginated).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseTransactionViewList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The list of transactions that were just requested or accepted.
    pub data: Vec<crate::models::TransactionView>,
}

/// `OpenAPI` schema wrapper for a single `TransactionView` response (the manual create/edit
/// endpoints return the transaction they just wrote).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseTransactionView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The transaction that was just created or updated.
    pub data: crate::models::TransactionView,
}

/// Concrete paginated transaction response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedTransactionView {
    /// List of transactions on the current page.
    pub items: Vec<TransactionView>,
    /// Total number of items across all pages.
    #[schema(example = 42)]
    pub total_items: u64,
    /// Total number of pages.
    #[schema(example = 5)]
    pub total_pages: u64,
    /// The current page number (1-indexed).
    #[schema(example = 1)]
    pub current_page: u64,
    /// The number of items per page.
    #[schema(example = 10)]
    pub limit: u64,
    /// Member guilds left out of an alliance listing because their ledger was unreachable.
    /// When non-empty the list and its totals are incomplete. Absent on complete results.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unavailable_guilds: Vec<crate::models::UnavailableGuild>,
}

impl PaginatedTransactionView {
    /// Marks this page as incomplete because the listed member guilds could not be read.
    #[must_use]
    pub fn with_unavailable_guilds(
        mut self,
        unavailable_guilds: Vec<crate::models::UnavailableGuild>,
    ) -> Self {
        self.unavailable_guilds = unavailable_guilds;
        self
    }
}

impl From<PaginatedData<TransactionView>> for PaginatedTransactionView {
    fn from(data: PaginatedData<TransactionView>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
            unavailable_guilds: Vec::new(),
        }
    }
}
