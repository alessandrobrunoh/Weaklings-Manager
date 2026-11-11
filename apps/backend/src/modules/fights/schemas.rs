//! `OpenAPI` response schemas for the `fights` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

/// `OpenAPI` schema wrapper for the fight backfill issue list.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseFightBackfillIssueList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Recorded fight backfill issues, newest first.
    pub data: Vec<crate::modules::fights::FightBackfillIssueView>,
}
