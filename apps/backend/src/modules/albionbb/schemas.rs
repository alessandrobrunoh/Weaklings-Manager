//! `OpenAPI` response schemas for the `albionbb` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

/// `OpenAPI` schema wrapper for the `AlbionBB` battles list response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAlbionBbBattlesList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The battles list payload (raw `AlbionBB` page + optional upstream pagination metadata).
    pub data: crate::modules::albionbb::router::AlbionBbBattlesList,
}

/// `OpenAPI` schema wrapper for an `AlbionBB` battle detail response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAlbionBbBattleDetail {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The battle detail data payload.
    pub data: crate::modules::albionbb::client::AlbionBbBattleDetail,
}

/// `OpenAPI` schema wrapper for an `AlbionBB` kill events list response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAlbionBbKillEventList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The list of kill events.
    pub data: Vec<crate::modules::albionbb::client::AlbionBbKillEvent>,
}

/// `OpenAPI` schema wrapper for an `AlbionBB` guild info response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAlbionBbGuildInfo {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The guild info data payload.
    pub data: crate::modules::albionbb::client::AlbionBbGuildInfo,
}

/// `OpenAPI` schema wrapper for an `AlbionBB` player stats response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAlbionBbPlayerStats {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The player stats data payload (raw JSON).
    pub data: serde_json::Value,
}
