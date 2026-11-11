//! `OpenAPI` response schemas for the `giveaways` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

use backend_core::pagination::PaginatedData;

/// `OpenAPI` schema wrapper for a giveaway detail.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseGiveawayDetail {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Giveaway detail.
    pub data: crate::giveaways::models::GiveawayDetailView,
}

/// `OpenAPI` schema wrapper for a paginated giveaway list.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedGiveawayView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Giveaway page.
    pub data: PaginatedGiveawayView,
}

/// Concrete paginated giveaway list response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedGiveawayView {
    /// Giveaways on the current page.
    pub items: Vec<crate::giveaways::models::GiveawayView>,
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

impl From<PaginatedData<crate::giveaways::models::GiveawayView>> for PaginatedGiveawayView {
    fn from(data: PaginatedData<crate::giveaways::models::GiveawayView>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}
