//! Progression HTTP routes.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::{get, post, put},
};

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{BotSecret, Permission, Permissions, UserContext};
use crate::pagination::{PaginatedData, PaginationParams};
use crate::responses::ApiResponse;

use super::models::{
    AdjustProgressionRequest, AwardMessageRequest, AwardMessageView, CreateSeasonRequest,
    LeaderboardEntryView, ProgressionMeView, ProgressionSettingsView, SeasonView,
    UpdateProgressionSettingsRequest, UpdateSeasonRequest, XpLedgerEntryView,
};
use super::service::ProgressionService;

/// Creates the router for the progression module.
pub fn router() -> Router {
    Router::new()
        .route("/me", get(get_me))
        .route("/leaderboard", get(get_leaderboard))
        .route("/award/message", post(award_message))
        .route("/settings", get(get_settings).put(update_settings))
        .route("/seasons", get(list_seasons).post(create_season))
        .route("/seasons/{season_id}", put(update_season))
        .route("/seasons/{season_id}/activate", put(activate_season))
        .route("/users/{id}", get(get_user))
        .route("/users/{id}/ledger", get(get_user_ledger))
        .route("/users/{id}/adjust", post(adjust_user))
}

/// Query for `GET /api/progression/leaderboard`.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct LeaderboardQuery {
    /// Season to rank. Defaults to the covering active season.
    pub season_id: Option<i64>,
    /// Page number (1-indexed).
    pub page: Option<u64>,
    /// Page size.
    pub limit: Option<u64>,
}

/// Query for `GET /api/progression/users/{id}/ledger`.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct LedgerQuery {
    /// Season to read. Defaults to the covering active season.
    pub season_id: Option<i64>,
    /// Page number (1-indexed).
    pub page: Option<u64>,
    /// Page size.
    pub limit: Option<u64>,
}

async fn require_self_or_officer(
    user: &UserContext,
    perms: &Permissions,
    target_user_id: i64,
) -> Result<(), AppError> {
    user.require(perms, Permission::ProgressionView).await?;
    if user.user_id == target_user_id {
        return Ok(());
    }
    let can_adjust = user
        .has_permission(perms, Permission::ProgressionAdjust)
        .await;
    let can_warns = user.has_permission(perms, Permission::WarnsView).await;
    if can_adjust || can_warns {
        return Ok(());
    }
    Err(AppError::Forbidden(
        "members may only view their own progression".into(),
    ))
}

/// Season XP snapshot for the caller.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks `progression.view`.
#[utoipa::path(
    get,
    path = "/api/progression/me",
    tag = "progression",
    summary = "Get the caller's season XP, level, and rank",
    description = "Returns the active covering season (if any), the caller's XP/level in that \
        season, XP remaining to the next level, 1-based rank, live multiplier, and lifetime XP \
        across all seasons. Without a covering season the numeric fields are zeros/level 1.",
    security(("session_cookie" = ["progression.view"])),
    responses(
        (status = 200, description = "Snapshot retrieved", body = crate::responses::ApiResponseProgressionMeView),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks progression.view", body = ProblemDetails)
    )
)]
async fn get_me(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<ProgressionMeView>>, AppError> {
    user.require(&perms, Permission::ProgressionView).await?;
    let view = ProgressionService::new().get_me(&db, user.user_id).await?;
    Ok(Json(ApiResponse::new(view)))
}

/// Read the singleton progression settings (curve, rates, warn threshold).
///
/// # Errors
///
/// Returns `403` without `progression.view`.
#[utoipa::path(
    get,
    path = "/api/progression/settings",
    tag = "progression",
    summary = "Read guild-wide progression settings",
    description = "Returns the XP curve, per-source rates, warn threshold, VOD forum id, and a \
        short level-threshold preview. Members can read it; only admins can write.",
    security(("session_cookie" = ["progression.view"])),
    responses(
        (status = 200, description = "Settings retrieved", body = ProgressionSettingsView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn get_settings(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<ProgressionSettingsView>>, AppError> {
    user.require(&perms, Permission::ProgressionView).await?;
    let view = ProgressionService::new().get_settings(&db).await?;
    Ok(Json(ApiResponse::new(view)))
}

/// Partial-update the singleton progression settings.
///
/// # Errors
///
/// Returns `403` without `progression.settings.manage`, or `400` on invalid knobs.
#[utoipa::path(
    put,
    path = "/api/progression/settings",
    tag = "progression",
    summary = "Update guild-wide progression settings",
    description = "Partial update. Changing the curve recalculates stored levels on the active \
        season (XP is unchanged). Requires `progression.settings.manage`.",
    security(("session_cookie" = ["progression.settings.manage"])),
    request_body = UpdateProgressionSettingsRequest,
    responses(
        (status = 200, description = "Settings updated", body = ProgressionSettingsView),
        (status = 400, description = "Invalid settings", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn update_settings(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<UpdateProgressionSettingsRequest>,
) -> Result<Json<ApiResponse<ProgressionSettingsView>>, AppError> {
    user.require(&perms, Permission::ProgressionSettingsEdit)
        .await?;
    let view = ProgressionService::new()
        .update_settings(&db, user.user_id, &req)
        .await?;
    Ok(Json(ApiResponse::new(view)))
}

/// List every season, newest start first.
///
/// # Errors
///
/// Returns `403` without `progression.view`.
#[utoipa::path(
    get,
    path = "/api/progression/seasons",
    tag = "progression",
    summary = "List progression seasons",
    security(("session_cookie" = ["progression.view"])),
    responses(
        (status = 200, description = "Seasons retrieved", body = Vec<SeasonView>),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn list_seasons(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<Vec<SeasonView>>>, AppError> {
    user.require(&perms, Permission::ProgressionView).await?;
    let seasons = ProgressionService::new().list_seasons(&db).await?;
    Ok(Json(ApiResponse::new(seasons)))
}

/// Create a season (optionally activate it).
///
/// # Errors
///
/// Returns `403` without `progression.settings.manage`, or `400` if the window is invalid.
#[utoipa::path(
    post,
    path = "/api/progression/seasons",
    tag = "progression",
    summary = "Create a progression season",
    security(("session_cookie" = ["progression.settings.manage"])),
    request_body = CreateSeasonRequest,
    responses(
        (status = 200, description = "Season created", body = SeasonView),
        (status = 400, description = "Invalid window or name", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn create_season(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<CreateSeasonRequest>,
) -> Result<Json<ApiResponse<SeasonView>>, AppError> {
    user.require(&perms, Permission::ProgressionSettingsCreate)
        .await?;
    let season = ProgressionService::new()
        .create_season(&db, user.user_id, &req)
        .await?;
    Ok(Json(ApiResponse::new(season)))
}

/// Rename or move a season's dates (lengthen / shorten), including while it is active.
///
/// # Errors
///
/// Returns `404` if unknown, `400` if the resulting window is empty.
#[utoipa::path(
    put,
    path = "/api/progression/seasons/{season_id}",
    tag = "progression",
    summary = "Update a season's name or dates",
    security(("session_cookie" = ["progression.settings.manage"])),
    params(("season_id" = i64, Path, description = "Season id")),
    request_body = UpdateSeasonRequest,
    responses(
        (status = 200, description = "Season updated", body = SeasonView),
        (status = 400, description = "Invalid window or name", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Season not found", body = ProblemDetails)
    )
)]
async fn update_season(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(season_id): Path<i64>,
    Json(req): Json<UpdateSeasonRequest>,
) -> Result<Json<ApiResponse<SeasonView>>, AppError> {
    user.require(&perms, Permission::ProgressionSettingsEdit)
        .await?;
    let season = ProgressionService::new()
        .update_season(&db, user.user_id, season_id, &req)
        .await?;
    Ok(Json(ApiResponse::new(season)))
}

/// Make this season the only active one.
///
/// # Errors
///
/// Returns `404` if unknown.
#[utoipa::path(
    put,
    path = "/api/progression/seasons/{season_id}/activate",
    tag = "progression",
    summary = "Activate a season (deactivates the others)",
    security(("session_cookie" = ["progression.settings.manage"])),
    params(("season_id" = i64, Path, description = "Season id")),
    responses(
        (status = 200, description = "Season activated", body = SeasonView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Season not found", body = ProblemDetails)
    )
)]
async fn activate_season(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(season_id): Path<i64>,
) -> Result<Json<ApiResponse<SeasonView>>, AppError> {
    user.require(&perms, Permission::ProgressionSettingsEdit)
        .await?;
    let season = ProgressionService::new()
        .activate_season(&db, user.user_id, season_id)
        .await?;
    Ok(Json(ApiResponse::new(season)))
}

/// Award Discord message XP. Bot secret only; unlinked authors are a 200 no-op.
///
/// # Errors
///
/// Returns `401` if `X-Bot-Secret` is missing or wrong.
#[utoipa::path(
    post,
    path = "/api/progression/award/message",
    tag = "progression",
    summary = "Award XP for a Discord message (bot only)",
    description = "Authenticated with `X-Bot-Secret`. Does not require `X-Discord-Id`. Unlinked \
        authors return `{ awarded: false, reason: \"unlinked\" }` rather than 401.",
    request_body = AwardMessageRequest,
    responses(
        (status = 200, description = "Award attempted", body = crate::responses::ApiResponseAwardMessageView),
        (status = 401, description = "Invalid or missing bot secret", body = ProblemDetails)
    )
)]
async fn award_message(
    _bot: BotSecret,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<AwardMessageRequest>,
) -> Result<Json<ApiResponse<AwardMessageView>>, AppError> {
    let view = ProgressionService::new().award_message(&db, &req).await?;
    Ok(Json(ApiResponse::new(view)))
}

/// Season XP leaderboard.
///
/// # Errors
///
/// Returns `403` without `progression.view`.
#[utoipa::path(
    get,
    path = "/api/progression/leaderboard",
    tag = "progression",
    summary = "Season XP leaderboard",
    security(("session_cookie" = ["progression.view"])),
    params(LeaderboardQuery),
    responses(
        (status = 200, description = "Leaderboard retrieved", body = crate::responses::ApiResponsePaginatedLeaderboardEntryView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Season not found", body = ProblemDetails)
    )
)]
async fn get_leaderboard(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(query): Query<LeaderboardQuery>,
) -> Result<Json<ApiResponse<PaginatedData<LeaderboardEntryView>>>, AppError> {
    user.require(&perms, Permission::ProgressionView).await?;
    let page = ProgressionService::new()
        .leaderboard(
            &db,
            query.season_id,
            &PaginationParams {
                page: query.page,
                limit: query.limit,
            },
        )
        .await?;
    Ok(Json(ApiResponse::new(page)))
}

/// Another member's season XP snapshot. Members may only read themselves.
///
/// # Errors
///
/// Returns `403` for another member without `progression.adjust` or `warns.view`.
#[utoipa::path(
    get,
    path = "/api/progression/users/{id}",
    tag = "progression",
    summary = "Get a member's season XP snapshot",
    security(("session_cookie" = ["progression.view"])),
    params(("id" = i64, Path, description = "User id")),
    responses(
        (status = 200, description = "Snapshot retrieved", body = crate::responses::ApiResponseProgressionMeView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn get_user(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<ProgressionMeView>>, AppError> {
    require_self_or_officer(&user, &perms, id).await?;
    let view = ProgressionService::new().get_me(&db, id).await?;
    Ok(Json(ApiResponse::new(view)))
}

/// Paginated XP ledger for a member.
///
/// # Errors
///
/// Same auth as [`get_user`].
#[utoipa::path(
    get,
    path = "/api/progression/users/{id}/ledger",
    tag = "progression",
    summary = "Get a member's XP ledger",
    security(("session_cookie" = ["progression.view"])),
    params(("id" = i64, Path, description = "User id"), LedgerQuery),
    responses(
        (status = 200, description = "Ledger retrieved", body = crate::responses::ApiResponsePaginatedXpLedgerEntryView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn get_user_ledger(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
    Query(query): Query<LedgerQuery>,
) -> Result<Json<ApiResponse<PaginatedData<XpLedgerEntryView>>>, AppError> {
    require_self_or_officer(&user, &perms, id).await?;
    let page = ProgressionService::new()
        .list_ledger(
            &db,
            id,
            query.season_id,
            &PaginationParams {
                page: query.page,
                limit: query.limit,
            },
        )
        .await?;
    Ok(Json(ApiResponse::new(page)))
}

/// Officer XP / level / multiplier adjustment.
///
/// # Errors
///
/// Returns `403` without `progression.adjust`.
#[utoipa::path(
    post,
    path = "/api/progression/users/{id}/adjust",
    tag = "progression",
    summary = "Adjust a member's XP, level, or multiplier",
    security(("session_cookie" = ["progression.adjust"])),
    params(("id" = i64, Path, description = "User id")),
    request_body = AdjustProgressionRequest,
    responses(
        (status = 200, description = "Adjusted", body = crate::responses::ApiResponseProgressionMeView),
        (status = 400, description = "Invalid payload", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "User not found", body = ProblemDetails)
    )
)]
async fn adjust_user(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
    Json(req): Json<AdjustProgressionRequest>,
) -> Result<Json<ApiResponse<ProgressionMeView>>, AppError> {
    user.require(&perms, Permission::ProgressionAdjust).await?;
    let view = ProgressionService::new()
        .adjust(&db, user.user_id, id, &req)
        .await?;
    Ok(Json(ApiResponse::new(view)))
}
