//! `OpenAPI` response schemas for the `notifications` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

use backend_core::pagination::PaginatedData;

/// `OpenAPI` schema wrapper for a notification inbox row.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseNotificationView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Inbox row.
    pub data: crate::notifications::models::NotificationView,
}

/// `OpenAPI` schema wrapper for a paginated inbox.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedNotificationView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Inbox page.
    pub data: PaginatedNotificationView,
}

/// `OpenAPI` schema wrapper for the unread badge.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseUnreadCountView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Unread count.
    pub data: crate::notifications::models::UnreadCountView,
}

/// `OpenAPI` schema wrapper for mark-all-read.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseReadAllResult {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// How many rows flipped to read.
    pub data: crate::notifications::models::ReadAllResult,
}

/// `OpenAPI` schema wrapper for a guild broadcast.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBroadcastResult {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Fan-out result.
    pub data: crate::notifications::models::BroadcastResult,
}

/// Concrete paginated notification list response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedNotificationView {
    /// Inbox rows on the current page.
    pub items: Vec<crate::notifications::models::NotificationView>,
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

impl From<PaginatedData<crate::notifications::models::NotificationView>>
    for PaginatedNotificationView
{
    fn from(data: PaginatedData<crate::notifications::models::NotificationView>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}
