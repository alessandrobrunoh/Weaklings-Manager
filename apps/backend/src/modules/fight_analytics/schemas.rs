//! `OpenAPI` response schemas for the `fight_analytics` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

/// `OpenAPI` schema wrapper for one fight's analytics view.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseFightAnalytics {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Fight analytics view.
    pub data: crate::modules::fight_analytics::service::FightAnalyticsView,
}
