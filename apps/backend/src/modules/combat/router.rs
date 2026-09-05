//! Combat routing module.
//!
//! Exposes the Item Power calculator. Every handler here is a read: nothing in this module writes
//! to the database, which is why none of them log to the audit trail.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::{get, post},
};

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::responses::{ApiResponse, ApiResponseCombatDataset, ApiResponseItemPower};

use super::models::{CombatDatasetView, ItemPowerRequest, ItemPowerView};
use super::service::CombatService;

/// Builds the combat router.
pub fn router() -> Router {
    Router::new()
        .route("/dataset", get(get_dataset))
        .route("/item-power", post(post_item_power))
        .route("/members/{user_id}/item-power", get(get_member_item_power))
}

/// Reports which ao-bin-dumps commit the bundled combat data came from.
///
/// Every combat response carries this stamp; the endpoint exists so a client can show it once, in
/// a footer, rather than repeating it beside every number.
#[utoipa::path(
    get,
    path = "/api/combat/dataset",
    tag = "combat",
    summary = "Get the bundled combat dataset's provenance",
    description = "Returns the ao-bin-dumps commit the bundled Albion combat data was generated \
                   from, together with how many items, spells and Destiny Board nodes it covers. \
                   The data is compiled into the binary and refreshed by hand after a patch, so \
                   this is what tells a reader how current the numbers are.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Dataset provenance", body = ApiResponseCombatDataset),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn get_dataset(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
) -> Result<Json<ApiResponse<CombatDatasetView>>, AppError> {
    user.require(&perms, Permission::CombatCalculatorUse)
        .await?;
    Ok(Json(ApiResponse::new(CombatService::dataset())))
}

/// Computes Item Power for a loadout described inline.
#[utoipa::path(
    post,
    path = "/api/combat/item-power",
    tag = "combat",
    summary = "Calculate Item Power for an ad-hoc loadout",
    description = "Item Power = base(tier, enchantment) + quality bonus + the Destiny Board \
                   bonuses of whichever specialization levels `spec` selects. The response \
                   itemises every contribution, so each point can be traced to the node that \
                   granted it. `mastery_levels_known` is false while no family mastery level is \
                   recorded, which makes the figure a lower bound rather than the number the game \
                   would show.",
    security(("session_cookie" = [])),
    request_body = ItemPowerRequest,
    responses(
        (status = 200, description = "Item Power breakdown", body = ApiResponseItemPower),
        (status = 400, description = "Unusable loadout or specialization source", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn post_item_power(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(request): Json<ItemPowerRequest>,
) -> Result<Json<ApiResponse<ItemPowerView>>, AppError> {
    user.require(&perms, Permission::CombatCalculatorUse)
        .await?;
    let view = CombatService::new().item_power(&db, &request).await?;
    Ok(Json(ApiResponse::new(view)))
}

/// Computes what one member's Item Power would be on a stored build.
#[utoipa::path(
    get,
    path = "/api/combat/members/{user_id}/item-power",
    tag = "combat",
    summary = "Calculate a member's Item Power on a build",
    description = "Scores a stored build with one member's Destiny Board levels — the \"could this \
                   person fly this?\" question. `at_max_spec` is the same build with every node at \
                   100, and `readiness` is the ratio between them, which is comparable across \
                   builds in a way raw Item Power is not.",
    security(("session_cookie" = [])),
    params(
        ("user_id" = i64, Path, description = "Internal user ID"),
        MemberItemPowerParams
    ),
    responses(
        (status = 200, description = "Item Power breakdown", body = ApiResponseItemPower),
        (status = 400, description = "Missing build_id or unusable parameters", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Build not found", body = ProblemDetails)
    )
)]
async fn get_member_item_power(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(user_id): Path<i64>,
    Query(params): Query<MemberItemPowerParams>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<ItemPowerView>>, AppError> {
    user.require(&perms, Permission::CombatCalculatorUse)
        .await?;
    let loadout = super::service::parse_loadout(params.loadout.as_deref())?;
    let view = CombatService::new()
        .build_item_power(
            &db,
            params.build_id,
            loadout,
            params.spec.unwrap_or_default(),
            Some(user_id),
            params.level,
        )
        .await?;
    Ok(Json(ApiResponse::new(view)))
}

/// Query parameters for a member's Item Power on a build.
#[derive(Debug, Clone, serde::Deserialize, utoipa::IntoParams)]
pub struct MemberItemPowerParams {
    /// The build to score. Required.
    pub build_id: i64,
    /// Which loadout to score: `main` (the default) or `swap`.
    #[serde(default)]
    pub loadout: Option<String>,
    /// Which levels to apply. Defaults to the member's own.
    #[serde(default)]
    pub spec: Option<super::models::SpecSource>,
    /// The flat level for `spec=fixed`.
    #[serde(default)]
    pub level: Option<i32>,
}
