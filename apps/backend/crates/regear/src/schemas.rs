//! `OpenAPI` response schemas for the `regear` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

use backend_core::pagination::PaginatedData;

/// Concrete paginated `DeathView` response schema for `OpenAPI` (regear module).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedDeathView {
    /// List of regear deaths on the current page.
    pub items: Vec<crate::models::DeathView>,
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

impl From<PaginatedData<crate::models::DeathView>> for PaginatedDeathView {
    fn from(data: PaginatedData<crate::models::DeathView>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}
