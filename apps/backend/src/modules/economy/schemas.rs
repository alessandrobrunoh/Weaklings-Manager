//! `OpenAPI` response schemas for the `economy` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

/// `OpenAPI` schema wrapper for one battle's economy view.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBattleEconomy {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Battle economy view.
    pub data: crate::modules::economy::models::BattleEconomyView,
}

/// `OpenAPI` schema wrapper for one fight's economy view.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseFightEconomy {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Fight economy view.
    pub data: crate::modules::economy::models::FightEconomyView,
}

/// `OpenAPI` schema wrapper for one event's economy view.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseEventEconomy {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Event economy view.
    pub data: crate::modules::economy::models::EventEconomyView,
}
