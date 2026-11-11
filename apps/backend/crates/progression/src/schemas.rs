//! `OpenAPI` response schemas for the `progression` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

use backend_core::pagination::PaginatedData;

/// `OpenAPI` schema wrapper for the caller's season XP snapshot.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseProgressionMeView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Season XP, level, rank, multiplier, and lifetime total.
    pub data: crate::models::ProgressionMeView,
}

/// `OpenAPI` schema wrapper for a message XP award result.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAwardMessageView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Whether XP was granted and why not, if skipped.
    pub data: crate::models::AwardMessageView,
}

/// `OpenAPI` schema wrapper for a paginated XP leaderboard.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedLeaderboardEntryView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Leaderboard page.
    pub data: PaginatedLeaderboardEntryView,
}

/// `OpenAPI` schema wrapper for a paginated XP ledger.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedXpLedgerEntryView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Ledger page.
    pub data: PaginatedXpLedgerEntryView,
}

/// Concrete paginated XP leaderboard response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedLeaderboardEntryView {
    /// Leaderboard rows on the current page.
    pub items: Vec<crate::models::LeaderboardEntryView>,
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
}

impl From<PaginatedData<crate::models::LeaderboardEntryView>> for PaginatedLeaderboardEntryView {
    fn from(data: PaginatedData<crate::models::LeaderboardEntryView>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated XP ledger response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedXpLedgerEntryView {
    /// Ledger rows on the current page.
    pub items: Vec<crate::models::XpLedgerEntryView>,
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
}

impl From<PaginatedData<crate::models::XpLedgerEntryView>> for PaginatedXpLedgerEntryView {
    fn from(data: PaginatedData<crate::models::XpLedgerEntryView>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}
