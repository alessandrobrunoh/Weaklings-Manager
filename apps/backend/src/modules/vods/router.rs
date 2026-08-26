//! VOD HTTP routes.

use axum::{Extension, Json, Router, routing::get};

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::responses::ApiResponse;

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
/// Returns `403` without `vod.submit`, `400` on forum/config errors, `409` on a duplicate URL.
#[utoipa::path(
    post,
    path = "/api/vods",
    tag = "vods",
    summary = "Claim a VOD review URL",
    description = "Must be posted in the configured VOD forum thread owned by the claimer. Awards \
        XP once per normalized URL per covering season.",
    security(("session_cookie" = ["vod.submit"])),
    request_body = SubmitVodRequest,
    responses(
        (status = 200, description = "VOD claimed", body = crate::responses::ApiResponseVodReviewView),
        (status = 400, description = "Forum not configured or wrong channel", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden or not the thread owner", body = ProblemDetails),
        (status = 409, description = "URL already claimed this season", body = ProblemDetails)
    )
)]
async fn submit_vod(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<SubmitVodRequest>,
) -> Result<Json<ApiResponse<VodReviewView>>, AppError> {
    user.require(&perms, Permission::VodSubmit).await?;
    let view = VodService::new()
        .submit(&db, user.user_id, &user.id, &req)
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
        (status = 200, description = "List retrieved", body = crate::responses::ApiResponseVodReviewViewList),
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
