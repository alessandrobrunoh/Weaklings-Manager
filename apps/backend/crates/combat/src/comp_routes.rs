//! Build Item Power route, mounted under `/api/comps`.
//!
//! Item Power is combat arithmetic over a build's loadout, so the handler lives with the combat
//! feature; the app registry merges [`comp_routes`] into the comps router.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::get,
};

use crate::models::BuildItemPowerParams;
use backend_core::errors::{AppError, ProblemDetails};
use backend_core::responses::ApiResponse;
use backend_identity::auth::{Permission, Permissions, UserContext};

/// Routes merged into the `/api/comps` router.
pub fn comp_routes() -> Router {
    Router::new().route("/builds/{id}/item-power", get(get_build_item_power))
}

/// Returns the Item Power of a build at a hypothetical specialization level.
///
/// Reading a build is enough: the figure is a property of the build plus whichever levels the
/// caller asks for, and both are already visible to anyone who can open the build.
#[utoipa::path(
    get,
    path = "/api/comps/builds/{id}/item-power",
    tag = "comps",
    summary = "Calculate a build's Item Power",
    description = "Item Power = base(tier, enchantment) + quality bonus + Destiny Board bonuses. \
                   Pass `spec=max` for the build's ceiling, or `spec=fixed` with a `level` to \
                   compare builds at the same assumed level. Members' own Destiny Board levels are \
                   not stored. Every contribution is itemised, so each point traces back to the \
                   node that granted it.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Build version ID"), BuildItemPowerParams),
    responses(
        (status = 200, description = "Item Power breakdown", body = crate::schemas::ApiResponseItemPower),
        (status = 400, description = "Unusable specialization source", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Build not found", body = ProblemDetails)
    )
)]
async fn get_build_item_power(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Query(params): Query<BuildItemPowerParams>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<crate::models::ItemPowerView>>, AppError> {
    user.require(&perms, Permission::CompsBuildsView).await?;
    let loadout = crate::service::parse_loadout(params.loadout.as_deref())?;
    let view = crate::service::CombatService::build_item_power(
        &db,
        id,
        loadout,
        params.spec.unwrap_or_default(),
        params.level,
    )
    .await?;
    Ok(Json(ApiResponse::new(view)))
}
