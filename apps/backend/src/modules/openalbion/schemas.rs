//! `OpenAPI` response schemas for the `openalbion` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

use crate::pagination::PaginatedData;

/// `OpenAPI` schema wrapper for Paginated `OpenAlbionWeapon` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedOpenAlbionWeapons {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated weapon catalog data payload.
    pub data: PaginatedOpenAlbionWeapon,
}

/// `OpenAPI` schema wrapper for Paginated `OpenAlbionItem` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedOpenAlbionItems {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated item catalog data payload.
    pub data: PaginatedOpenAlbionItem,
}

/// `OpenAPI` schema wrapper for the bundled Albion ability catalog.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseOpenAlbionAbilities {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Selectable abilities keyed by tier-stripped base identifier, e.g. `MAIN_SWORD`.
    pub data: std::collections::HashMap<
        String,
        crate::modules::openalbion::catalog::OpenAlbionItemAbilities,
    >,
}

/// `OpenAPI` schema wrapper for the complete `OpenAlbion` item catalog.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseOpenAlbionCatalog {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Complete item catalog data payload.
    pub data: Vec<crate::modules::openalbion::catalog::OpenAlbionItem>,
}

/// Concrete paginated `OpenAlbion` weapon response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedOpenAlbionWeapon {
    /// List of weapons on the current page.
    pub items: Vec<crate::modules::openalbion::catalog::OpenAlbionWeapon>,
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

impl From<PaginatedData<crate::modules::openalbion::catalog::OpenAlbionWeapon>>
    for PaginatedOpenAlbionWeapon
{
    fn from(data: PaginatedData<crate::modules::openalbion::catalog::OpenAlbionWeapon>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated `OpenAlbionItem` response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedOpenAlbionItem {
    /// List of items on the current page.
    pub items: Vec<crate::modules::openalbion::catalog::OpenAlbionItem>,
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

impl From<PaginatedData<crate::modules::openalbion::catalog::OpenAlbionItem>>
    for PaginatedOpenAlbionItem
{
    fn from(data: PaginatedData<crate::modules::openalbion::catalog::OpenAlbionItem>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}
