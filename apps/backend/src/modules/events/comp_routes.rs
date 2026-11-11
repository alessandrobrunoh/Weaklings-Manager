//! Comp and build performance routes, mounted under `/api/comps`.
//!
//! The numbers come from events and their linked battles, so the handlers live with the events
//! feature; the app registry merges [`comp_routes`] into the comps router.

use axum::{Extension, Json, Router, extract::Path, routing::get};

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::modules::events::schemas::ApiResponseCompPerformance;
use crate::responses::ApiResponse;

/// Routes merged into the `/api/comps` router.
pub fn comp_routes() -> Router {
    Router::new()
        .route("/builds/{id}/performance", get(get_build_performance))
        .route("/{id}/performance", get(get_comp_performance))
}

/// Gets linked-event performance for a comp.
///
/// Any authenticated user can inspect these analytics because they are derived
/// from event and battle data already visible to guild members.
#[utoipa::path(
    get,
    path = "/api/comps/{id}/performance",
    tag = "comps",
    summary = "Get comp performance analytics",
    description = "Aggregates win/loss, K/D, kill fame and opponent performance from battles linked to events using this comp.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Comp ID")),
    responses(
        (status = 200, description = "Comp performance retrieved successfully", body = ApiResponseCompPerformance),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Comp not found", body = ProblemDetails)
    )
)]
async fn get_comp_performance(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<crate::modules::events::models::CompPerformanceView>>, AppError> {
    user.require(&perms, Permission::CompsCompsView).await?;
    let service = crate::modules::events::service::EventService::new();
    let performance = service.get_comp_performance(&db, id).await?;
    Ok(Json(ApiResponse::new(performance)))
}

/// Returns how one build version has performed.
///
/// Any authenticated user can read build performance.
#[utoipa::path(
    get,
    path = "/api/comps/builds/{id}/performance",
    tag = "comps",
    summary = "Get a build version's battle performance",
    description = "Attributes battle numbers to the players who actually ran this build version, \
                   by matching sign-ups to the per-player rows in the stored battle snapshots \
                   through their linked Albion character name. `stats` is null — not zeroed — when \
                   the version has no battle data, so 'never used' stays distinguishable from \
                   'lost every time'. `players_without_an_albion_link` and \
                   `stats.matched_players` report the coverage behind the numbers.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Build version ID")),
    responses(
        (status = 200, description = "Build performance", body = crate::modules::events::schemas::ApiResponseBuildPerformance),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Build not found", body = ProblemDetails)
    )
)]
async fn get_build_performance(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<crate::modules::events::models::BuildPerformanceView>>, AppError> {
    user.require(&perms, Permission::CompsBuildsView).await?;
    let service = crate::modules::events::service::EventService::new();
    let performance = service.get_build_performance(&db, id).await?;
    Ok(Json(ApiResponse::new(performance)))
}
