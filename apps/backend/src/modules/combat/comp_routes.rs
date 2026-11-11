//! Comp and build readiness routes, mounted under `/api/comps`.
//!
//! Item Power, roster fit and readiness are combat arithmetic over a comp's builds, so the
//! handlers live with the combat feature; the app registry merges [`comp_routes`] into the comps
//! router.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::get,
};
use utoipa::IntoParams;

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::modules::combat::models::BuildItemPowerParams;
use crate::responses::ApiResponse;

/// Routes merged into the `/api/comps` router.
pub fn comp_routes() -> Router {
    Router::new()
        .route("/builds/{id}/item-power", get(get_build_item_power))
        .route("/builds/{id}/roster-fit", get(get_build_roster_fit))
        .route("/{id}/readiness", get(get_comp_readiness))
}

/// Query parameters for a comp's readiness roll-up.
#[derive(Debug, Clone, Default, serde::Deserialize, IntoParams)]
pub struct CompReadinessParams {
    /// Score against this event's participants rather than every specialised member.
    #[serde(default)]
    pub event_id: Option<i64>,
}

/// Reports whether a composition can actually be fielded, and where it is weakest.
#[utoipa::path(
    get,
    path = "/api/comps/{id}/readiness",
    tag = "comps",
    summary = "Get a composition's readiness roll-up",
    description = "For every seat the comp defines, finds the best-scoring candidate in the pool \
                   and rolls the result up to comp level: average Item Power now vs. at the \
                   ceiling, the weakest seats, per-build bench depth, and which seats nobody can \
                   currently fill. Pass `event_id` to score against that event's sign-ups instead \
                   of every specialised member in the guild. When `event_id` is given and that \
                   event's fights have a computed analytics rollup, the response also carries \
                   `observed`: the average Item Power the roster that actually fought turned out \
                   to have, and its delta against the prediction. `observed` is `None` — not an \
                   error — when no `event_id` was given, or that event has no analyzed fights yet.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Comp ID"), CompReadinessParams),
    responses(
        (status = 200, description = "Readiness roll-up", body = crate::modules::combat::schemas::ApiResponseCompReadinessView),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing combat.readiness.view", body = ProblemDetails),
        (status = 404, description = "Comp not found", body = ProblemDetails)
    )
)]
async fn get_comp_readiness(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Query(params): Query<CompReadinessParams>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<crate::modules::combat::models::CompReadinessView>>, AppError> {
    user.require(&perms, Permission::CombatReadinessView)
        .await?;
    let readiness = crate::modules::combat::service::CombatService::new()
        .comp_readiness(&db, id, params.event_id)
        .await?;
    Ok(Json(ApiResponse::new(readiness)))
}

/// Returns the Item Power of a build, optionally scored with one member's specialization.
///
/// Reading a build is enough: the figure is a property of the build plus whichever levels the
/// caller asks for, and both are already visible to anyone who can open the build.
#[utoipa::path(
    get,
    path = "/api/comps/builds/{id}/item-power",
    tag = "comps",
    summary = "Calculate a build's Item Power",
    description = "Item Power = base(tier, enchantment) + quality bonus + Destiny Board bonuses. \
                   Pass `spec=max` for the build's ceiling, `spec=current` with a `user_id` for \
                   what one member would actually field, or `spec=fixed` with a `level` to compare \
                   builds rather than people. Every contribution is itemised, so each point traces \
                   back to the node that granted it.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Build version ID"), BuildItemPowerParams),
    responses(
        (status = 200, description = "Item Power breakdown", body = crate::modules::combat::schemas::ApiResponseItemPower),
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
) -> Result<Json<ApiResponse<crate::modules::combat::models::ItemPowerView>>, AppError> {
    user.require(&perms, Permission::CompsBuildsView).await?;
    let loadout = crate::modules::combat::service::parse_loadout(params.loadout.as_deref())?;
    let view = crate::modules::combat::service::CombatService::new()
        .build_item_power(
            &db,
            id,
            loadout,
            params.spec.unwrap_or_default(),
            params.user_id,
            params.level,
        )
        .await?;
    Ok(Json(ApiResponse::new(view)))
}

/// Scores every member with a recorded specialization against one build, best first.
///
/// Gated on the readiness permission rather than on build viewing: it reports on the whole guild
/// at once, which is a different thing from a member working out their own Item Power.
#[utoipa::path(
    get,
    path = "/api/comps/builds/{id}/roster-fit",
    tag = "comps",
    summary = "Rank the roster against a build",
    description = "Returns every member with any recorded Destiny Board level, scored on this \
                   build and sorted by Item Power descending — the answer to \"who should fly \
                   this?\". `blocking_nodes` names, per member, the specializations that would \
                   gain them the most Item Power, so the list doubles as a training plan.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Build version ID"), BuildItemPowerParams),
    responses(
        (status = 200, description = "Members ranked against the build", body = crate::modules::combat::schemas::ApiResponseBuildRosterFit),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing combat.readiness.view", body = ProblemDetails),
        (status = 404, description = "Build not found", body = ProblemDetails)
    )
)]
async fn get_build_roster_fit(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Query(params): Query<BuildItemPowerParams>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<crate::modules::combat::models::BuildRosterFitView>>, AppError> {
    user.require(&perms, Permission::CombatReadinessView)
        .await?;
    let loadout = crate::modules::combat::service::parse_loadout(params.loadout.as_deref())?;
    let view = crate::modules::combat::service::CombatService::new()
        .build_roster_fit(&db, id, loadout)
        .await?;
    Ok(Json(ApiResponse::new(view)))
}
