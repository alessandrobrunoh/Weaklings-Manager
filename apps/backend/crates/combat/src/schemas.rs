//! `OpenAPI` response schemas for the `combat` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

/// `OpenAPI` schema wrapper for a roster-suggestions response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseRosterSuggestions {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The proposed assignment.
    pub data: crate::fit::Assignment,
}

/// `OpenAPI` schema wrapper for a member's weapon list.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseUserWeapons {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The member's weapons: declared levels and officer locks.
    pub data: Vec<backend_identity::users::weapons::UserWeaponView>,
}

/// `OpenAPI` schema wrapper for the combat dataset response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseCombatDataset {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The dataset provenance payload.
    pub data: crate::models::CombatDatasetView,
}

/// `OpenAPI` schema wrapper for a simulated burst response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseSimulate {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The resolved burst.
    pub data: crate::models::SimulateView,
}

/// `OpenAPI` schema wrapper for a scenario version response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseScenarioDetail {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The scenario version.
    pub data: crate::models::ScenarioDetail,
}

/// `OpenAPI` schema wrapper for a scenario list response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseScenarioSummaryList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The list of scenario versions.
    pub data: Vec<crate::models::ScenarioSummary>,
}

/// `OpenAPI` schema wrapper for a run response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseRunDetail {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The pinned run.
    pub data: crate::models::RunDetail,
}

/// `OpenAPI` schema wrapper for a run list response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseRunSummaryList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The list of runs.
    pub data: Vec<crate::models::RunSummary>,
}

/// `OpenAPI` schema wrapper for an Item Power response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseItemPower {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The itemised Item Power payload.
    pub data: crate::models::ItemPowerView,
}
