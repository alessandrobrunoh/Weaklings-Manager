//! `OpenAPI` response schemas for the `vods` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

/// `OpenAPI` schema wrapper for a claimed VOD review.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseVodReviewView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Claimed VOD row.
    pub data: crate::modules::vods::models::VodReviewView,
}

/// `OpenAPI` schema wrapper for the caller's VOD review list.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseVodReviewViewList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Claimed VOD rows.
    pub data: Vec<crate::modules::vods::models::VodReviewView>,
}
