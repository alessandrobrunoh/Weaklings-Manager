//! `OpenAPI` response schemas for the `warns` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

use crate::pagination::PaginatedData;

/// `OpenAPI` schema wrapper for a warn row.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseWarnView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Warn row.
    pub data: crate::modules::warns::models::WarnView,
}

/// `OpenAPI` schema wrapper for a paginated warn list.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedWarnView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Warn page.
    pub data: PaginatedWarnView,
}

/// `OpenAPI` schema wrapper for a warn escalation.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseWarnEscalationView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Escalation row.
    pub data: crate::modules::warns::models::WarnEscalationView,
}

/// `OpenAPI` schema wrapper for a paginated escalation list.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedWarnEscalationView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Escalation page.
    pub data: PaginatedWarnEscalationView,
}

/// Concrete paginated warn list response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedWarnView {
    /// Warn rows on the current page.
    pub items: Vec<crate::modules::warns::models::WarnView>,
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

impl From<PaginatedData<crate::modules::warns::models::WarnView>> for PaginatedWarnView {
    fn from(data: PaginatedData<crate::modules::warns::models::WarnView>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated warn-escalation response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedWarnEscalationView {
    /// Escalation rows on the current page.
    pub items: Vec<crate::modules::warns::models::WarnEscalationView>,
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

impl From<PaginatedData<crate::modules::warns::models::WarnEscalationView>>
    for PaginatedWarnEscalationView
{
    fn from(data: PaginatedData<crate::modules::warns::models::WarnEscalationView>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}
