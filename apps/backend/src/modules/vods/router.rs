//! VOD HTTP routes.

use axum::{Extension, Json, Router, routing::get};

use crate::config::Config;
use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::responses::ApiResponse;
use crate::tenant::CurrentTenantId;

use super::models::{SubmitVodRequest, VodReviewView};
use super::service::VodService;

/// Creates the router for the VOD module.
pub fn router() -> Router {
    Router::new()
        .route("/", axum::routing::post(submit_vod))
        .route("/me", get(list_mine))
}

/// Claim a VOD review URL for XP.
///
/// # Errors
///
/// Returns `403` without `vod.submit`, `400` on forum/config/thread/host errors, `409` on a
/// duplicate URL, `429` past the daily cap, `502` when Discord cannot verify the thread.
#[utoipa::path(
    post,
    path = "/api/vods",
    tag = "vods",
    summary = "Claim a VOD review URL",
    description = "Must be posted in a thread of the configured VOD forum that Discord confirms \
        exists in this server and is owned by the claimer. The URL must be on an allowed video \
        host. Awards XP once per normalized URL per covering season, at most 5 claims per \
        member per 24 hours.",
    security(("session_cookie" = ["vod.submit"])),
    request_body = SubmitVodRequest,
    responses(
        (status = 200, description = "VOD claimed", body = crate::modules::vods::schemas::ApiResponseVodReviewView),
        (status = 400, description = "Forum not configured, thread not found / wrong forum / other server, or URL host not allowed", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden or not the thread owner", body = ProblemDetails),
        (status = 409, description = "URL already claimed this season", body = ProblemDetails),
        (status = 429, description = "Daily VOD claim cap reached", body = ProblemDetails),
        (status = 502, description = "Discord could not verify the thread", body = ProblemDetails)
    )
)]
async fn submit_vod(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Json(req): Json<SubmitVodRequest>,
) -> Result<Json<ApiResponse<VodReviewView>>, AppError> {
    user.require(&perms, Permission::VodSubmit).await?;
    // The tenant id is the Discord guild id, which the verified thread must belong to.
    let view = VodService::new()
        .submit(
            &db,
            cfg.discord_bot_token.as_deref(),
            &tenant_id,
            user.user_id,
            &user.id,
            &req,
        )
        .await?;
    Ok(Json(ApiResponse::new(view)))
}

/// List the caller's claimed VOD reviews.
///
/// # Errors
///
/// Returns `403` without `vod.submit`.
#[utoipa::path(
    get,
    path = "/api/vods/me",
    tag = "vods",
    summary = "List the caller's claimed VOD reviews",
    security(("session_cookie" = ["vod.submit"])),
    responses(
        (status = 200, description = "List retrieved", body = crate::modules::vods::schemas::ApiResponseVodReviewViewList),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn list_mine(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<Vec<VodReviewView>>>, AppError> {
    user.require(&perms, Permission::VodSubmit).await?;
    let rows = VodService::new().list_mine(&db, user.user_id).await?;
    Ok(Json(ApiResponse::new(rows)))
}
