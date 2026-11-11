//! `OpenAPI` response schemas for the `comps` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

use backend_core::pagination::PaginatedData;

/// `OpenAPI` schema wrapper for `BuildCategoryView` list response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBuildCategoryList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The list of build categories.
    pub data: Vec<crate::models::BuildCategoryView>,
}

/// `OpenAPI` schema wrapper for `CompCategoryView` list response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseCompCategoryList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The list of comp categories.
    pub data: Vec<crate::models::CompCategoryView>,
}

/// `OpenAPI` schema wrapper for `BuildDetail` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBuildDetail {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The build detail data payload.
    pub data: crate::models::BuildDetail,
}

/// `OpenAPI` schema wrapper for `CompDetail` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseCompDetail {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The comp detail data payload.
    pub data: crate::models::CompDetail,
}

/// `OpenAPI` schema wrapper for Paginated `CompSummary` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedComps {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated comp summaries data payload.
    pub data: PaginatedCompSummary,
}

/// `OpenAPI` schema wrapper for Paginated `BuildSummary` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedBuilds {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated build summaries data payload.
    pub data: PaginatedBuildSummary,
}

/// Concrete paginated comp summary response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedCompSummary {
    /// List of comp summaries on the current page.
    pub items: Vec<crate::models::CompSummary>,
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

impl From<PaginatedData<crate::models::CompSummary>> for PaginatedCompSummary {
    fn from(data: PaginatedData<crate::models::CompSummary>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated build summary response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedBuildSummary {
    /// List of build summaries on the current page.
    pub items: Vec<crate::models::BuildSummary>,
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

impl From<PaginatedData<crate::models::BuildSummary>> for PaginatedBuildSummary {
    fn from(data: PaginatedData<crate::models::BuildSummary>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}
