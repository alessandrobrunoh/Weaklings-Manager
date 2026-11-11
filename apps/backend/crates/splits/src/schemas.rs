//! `OpenAPI` response schemas for the `splits` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

use backend_core::pagination::PaginatedData;

/// `OpenAPI` schema wrapper for split KPI totals.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseSplitKpiSummary {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Guild-wide split totals.
    pub data: crate::models::SplitKpiSummary,
}

/// `OpenAPI` schema wrapper for `SplitDetail` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseSplitDetail {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The split detail data payload.
    pub data: crate::models::SplitDetail,
}

/// `OpenAPI` schema wrapper for `MatchedParticipant` list response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseMatchedParticipantList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The list of candidate names that matched a known, saved player.
    pub data: Vec<crate::models::MatchedParticipant>,
}

/// Concrete paginated split summary response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedSplitSummary {
    /// List of split summaries on the current page.
    pub items: Vec<crate::models::SplitSummary>,
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

impl From<PaginatedData<crate::models::SplitSummary>> for PaginatedSplitSummary {
    fn from(data: PaginatedData<crate::models::SplitSummary>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}
