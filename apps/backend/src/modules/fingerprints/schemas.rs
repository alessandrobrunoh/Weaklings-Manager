//! `OpenAPI` response schemas for the `fingerprints` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

use crate::pagination::PaginatedData;

/// `OpenAPI` schema wrapper for a paginated fingerprint list.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedFingerprints {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Fingerprint page.
    pub data: PaginatedFingerprintSummary,
}

/// `OpenAPI` schema wrapper for one fingerprint's detail.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseFingerprintDetail {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Fingerprint detail.
    pub data: crate::modules::fingerprints::models::FingerprintDetail,
}

/// `OpenAPI` schema wrapper for one build's observed usage.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBuildObservationSummary {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Build observation summary.
    pub data: crate::modules::fingerprints::models::BuildObservationSummary,
}

/// `OpenAPI` schema wrapper for a meta ranking.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseMetaEntries {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Meta entries, most-observed first.
    pub data: Vec<crate::modules::fingerprints::models::MetaEntry>,
}

/// Concrete paginated fingerprint summary response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedFingerprintSummary {
    /// List of fingerprint summaries on the current page.
    pub items: Vec<crate::modules::fingerprints::models::FingerprintSummary>,
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

impl From<PaginatedData<crate::modules::fingerprints::models::FingerprintSummary>>
    for PaginatedFingerprintSummary
{
    fn from(data: PaginatedData<crate::modules::fingerprints::models::FingerprintSummary>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}
