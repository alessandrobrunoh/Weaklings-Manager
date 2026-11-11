//! `OpenAPI` response schemas for the `intel` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

use backend_core::pagination::PaginatedData;

/// `OpenAPI` schema wrapper for one page of a manual scouting backfill.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseScoutBackfillOutcome {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The backfill page outcome.
    pub data: crate::auto_scout::BackfillOutcome,
}

/// Concrete paginated scouted-comp response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedScoutedComp {
    /// List of scouted enemy compositions on the current page.
    pub items: Vec<crate::models::ScoutedCompSummary>,
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

impl From<PaginatedData<crate::models::ScoutedCompSummary>> for PaginatedScoutedComp {
    fn from(data: PaginatedData<crate::models::ScoutedCompSummary>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}
