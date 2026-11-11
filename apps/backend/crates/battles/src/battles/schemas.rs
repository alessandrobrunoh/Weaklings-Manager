//! `OpenAPI` response schemas for the `battles` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

use backend_core::pagination::PaginatedData;

/// `OpenAPI` schema wrapper for the paginated `BattleSummary` response (guild-scoped).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedBattles {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated battle summaries data payload.
    pub data: PaginatedBattleSummary,
}

/// `OpenAPI` schema wrapper for the `BattleDetail` response (guild-scoped).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBattleDetail {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The battle detail data payload.
    pub data: crate::battles::models::BattleDetail,
}

/// Concrete paginated `BattleSummary` response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedBattleSummary {
    /// List of battle summaries on the current page.
    pub items: Vec<crate::battles::models::BattleSummary>,
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

impl From<PaginatedData<crate::battles::models::BattleSummary>> for PaginatedBattleSummary {
    fn from(data: PaginatedData<crate::battles::models::BattleSummary>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}
