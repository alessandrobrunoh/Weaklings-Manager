//! `Fight analytics` routing module.
//!
//! One read-only endpoint: `GET /fight-analytics/{fight_id}`, nested at
//! `/fight-analytics` in `modules::mod`, so the full path is
//! `/api/fight-analytics/{fight_id}`. Gated on `Permission::FightsView` —
//! the same permission `fights::router`'s own read endpoints already use,
//! since this is a drill-down of that same data, not a separate resource
//! with its own access rules.

use axum::{Extension, Json, Router, extract::Path, routing::get};
use sea_orm::DatabaseConnection;

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::responses::{ApiResponse, ApiResponseFightAnalytics};

use super::service::{self, FightAnalyticsView};

/// Creates the router for the `fight_analytics` module.
pub fn router() -> Router {
    Router::new().route("/{fight_id}", get(get_fight_analytics))
}

/// Get one fight's persisted analytics: its decided outcome plus the
/// `fight_stats` rollup, when one has been computed.
#[utoipa::path(
    get,
    path = "/api/fight-analytics/{fight_id}",
    tag = "fight_analytics",
    summary = "Get one fight's persisted analytics",
    description = "Reads the outcome/rollup `fight_analytics::writer` last computed for this \
        fight, recomputed eagerly on battle hydration and manual Fight merge/split/move — there \
        is no on-demand recompute here. `stats` is `None` (not a 404) when the fight exists but \
        has never been recomputed yet. `enemy_kills`/`enemy_kill_fame`/`enemy_estimated_loss` are \
        trade/observation indicators only, never income.",
    security(("session_cookie" = ["fights.view"])),
    params(("fight_id" = i64, Path, description = "Canonical fight id")),
    responses(
        (status = 200, description = "Fight analytics retrieved successfully", body = ApiResponseFightAnalytics),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing the fights.view permission", body = ProblemDetails),
        (status = 404, description = "No fight exists with this id", body = ProblemDetails)
    )
)]
pub async fn get_fight_analytics(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Path(fight_id): Path<i64>,
) -> Result<Json<ApiResponse<FightAnalyticsView>>, AppError> {
    user.require(&perms, Permission::FightsView).await?;
    let view = service::get_fight_analytics(&db, fight_id).await?;
    Ok(Json(ApiResponse::new(view)))
}
