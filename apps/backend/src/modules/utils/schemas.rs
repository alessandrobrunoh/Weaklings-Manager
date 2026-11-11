//! `OpenAPI` response schemas for the `utils` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

/// `OpenAPI` schema wrapper for `OcrResult` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseOcrResult {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The OCR result data payload.
    pub data: crate::modules::utils::models::OcrResult,
}
