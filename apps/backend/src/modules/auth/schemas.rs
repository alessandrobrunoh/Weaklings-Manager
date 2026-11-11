//! `OpenAPI` response schemas for the `auth` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

/// `OpenAPI` schema wrapper for `DiscordUserProfile` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseDiscordUserProfile {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The Discord user profile data payload.
    pub data: crate::modules::auth::service::DiscordUserProfile,
}
