//! `OpenAPI` response schemas for the `attention` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

/// `OpenAPI` schema wrapper for the current attention findings list.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAttentionFindingList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Currently-held attention findings.
    pub data: Vec<crate::attention::service::AttentionFindingView>,
}
