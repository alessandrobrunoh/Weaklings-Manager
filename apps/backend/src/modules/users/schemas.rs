//! `OpenAPI` response schemas for the `users` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

use crate::pagination::PaginatedData;

/// `OpenAPI` schema wrapper for `UserProfile` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseUserProfile {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The user profile data payload.
    pub data: crate::modules::users::service::UserProfile,
}

/// `OpenAPI` schema wrapper for `UserMetrics` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseUserMetrics {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The user metrics data payload.
    pub data: crate::modules::users::service::UserMetrics,
}

/// `OpenAPI` schema wrapper for Paginated `UserProfile` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedUsers {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated user profiles data payload.
    pub data: PaginatedUserProfile,
}

/// Concrete paginated user profile response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedUserProfile {
    /// List of user profiles on the current page.
    pub items: Vec<crate::modules::users::service::UserProfile>,
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

impl From<PaginatedData<crate::modules::users::service::UserProfile>> for PaginatedUserProfile {
    fn from(data: PaginatedData<crate::modules::users::service::UserProfile>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}
