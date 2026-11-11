//! `OpenAPI` response schemas for the `siphoned` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

use crate::pagination::PaginatedData;

/// `OpenAPI` schema wrapper for `IngestResponse` (siphoned module).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseIngestResponse {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The ingest result payload.
    pub data: crate::modules::siphoned::models::IngestResponse,
}

/// `OpenAPI` schema wrapper for one `EntryView` response (siphoned module).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseEntryView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The siphoned energy entry payload.
    pub data: crate::modules::siphoned::models::EntryView,
}

/// `OpenAPI` schema wrapper for paginated `EntryView` response (siphoned module).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedEntryView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated siphoned energy entries data payload.
    pub data: PaginatedEntryView,
}

/// `OpenAPI` schema wrapper for paginated player balances.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedPlayerBalance {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated per-player balance payload.
    pub data: PaginatedPlayerBalance,
}

/// `OpenAPI` schema wrapper for `PlayerBalanceDetail` response (siphoned module).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePlayerBalanceDetail {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The single-player balance detail payload.
    pub data: crate::modules::siphoned::models::PlayerBalanceDetail,
}

/// `OpenAPI` schema wrapper for `BatchSummary` list response (siphoned module).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBatchSummaryList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The ingestion batch list payload.
    pub data: Vec<crate::modules::siphoned::models::BatchSummary>,
}

/// `OpenAPI` schema wrapper for `DeletedCount` response (siphoned module).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseDeletedCount {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The deletion result payload.
    pub data: crate::modules::siphoned::models::DeletedCount,
}

/// Concrete paginated `EntryView` response schema for `OpenAPI` (siphoned module).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedEntryView {
    /// List of siphoned energy entries on the current page.
    pub items: Vec<crate::modules::siphoned::models::EntryView>,
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
    #[schema(example = 50)]
    pub limit: u64,
}

/// Concrete paginated player-balance response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedPlayerBalance {
    /// Balance rows on the current page.
    pub items: Vec<crate::modules::siphoned::models::PlayerBalance>,
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

impl From<PaginatedData<crate::modules::siphoned::models::PlayerBalance>>
    for PaginatedPlayerBalance
{
    fn from(data: PaginatedData<crate::modules::siphoned::models::PlayerBalance>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

impl From<PaginatedData<crate::modules::siphoned::models::EntryView>> for PaginatedEntryView {
    fn from(data: PaginatedData<crate::modules::siphoned::models::EntryView>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}
