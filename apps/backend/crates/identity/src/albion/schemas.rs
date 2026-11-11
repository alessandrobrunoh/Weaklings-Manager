//! `OpenAPI` response schemas for the `albion` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

use backend_core::pagination::PaginatedData;

/// `OpenAPI` schema wrapper for `AlbionLinkStatus` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAlbionLinkStatus {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The Albion player link status data payload.
    pub data: crate::albion::service::AlbionLinkStatus,
}

/// `OpenAPI` schema wrapper for the list of pending Albion link requests.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAlbionLinkRequests {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Open requests, oldest first.
    pub data: Vec<crate::albion::service::AlbionLinkRequestView>,
}

/// `OpenAPI` schema wrapper for Paginated `AlbionGuildMember` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedAlbionGuildMembers {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated guild roster data payload.
    pub data: PaginatedAlbionGuildMember,
}

/// Concrete paginated Albion guild member response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedAlbionGuildMember {
    /// List of guild members on the current page.
    pub items: Vec<crate::albion::client::AlbionGuildMember>,
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

impl From<PaginatedData<crate::albion::client::AlbionGuildMember>> for PaginatedAlbionGuildMember {
    fn from(data: PaginatedData<crate::albion::client::AlbionGuildMember>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}
