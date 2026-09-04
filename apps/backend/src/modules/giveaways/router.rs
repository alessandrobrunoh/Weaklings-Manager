//! HTTP routes for guild giveaways.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::{get, post, put},
};

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::pagination::{PaginatedData, PaginationParams};
use crate::responses::ApiResponse;

use super::models::{
    CreateGiveawayRequest, GiveawayDetailView, GiveawayFilters, GiveawayView,
    SetGiveawayDiscordMessageRequest,
};
use super::service::GiveawayService;
use super::status::GiveawayStatus;

/// Query for `GET /api/giveaways`.
#[derive(Debug, serde::Deserialize, utoipa::IntoParams)]
pub struct ListGiveawaysQuery {
    /// Page number (1-indexed).
    pub page: Option<u64>,
    /// Page size.
    pub limit: Option<u64>,
    /// Restrict to one status.
    pub status: Option<GiveawayStatus>,
    /// Case-insensitive title substring.
    pub search: Option<String>,
    /// Sort column: `created_at`, `ends_at`, `title`, `status`.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc`.
    pub order: Option<String>,
}

impl ListGiveawaysQuery {
    fn pagination(&self) -> PaginationParams {
        PaginationParams {
            page: self.page,
            limit: self.limit,
        }
    }

    fn filters(&self) -> GiveawayFilters {
        GiveawayFilters {
            status: self.status,
            search: self.search.clone(),
            sort: self.sort.clone(),
            order: self.order.clone(),
        }
    }
}

/// Router for `/api/giveaways`.
pub fn router() -> Router {
    Router::new()
        .route("/", get(list_giveaways).post(create_giveaway))
        .route("/{id}", get(get_giveaway))
        .route("/{id}/enter", post(enter_giveaway).delete(leave_giveaway))
        .route("/{id}/cancel", post(cancel_giveaway))
        .route("/{id}/draw", post(draw_giveaway))
        .route("/{id}/discord-message", put(set_discord_message))
}

/// Lists giveaways (admin logs).
#[utoipa::path(
    get,
    path = "/api/giveaways",
    tag = "giveaways",
    summary = "List giveaways",
    security(("session_cookie" = ["giveaways.view"])),
    params(ListGiveawaysQuery),
    responses(
        (status = 200, description = "Giveaways retrieved", body = crate::responses::ApiResponsePaginatedGiveawayView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn list_giveaways(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(query): Query<ListGiveawaysQuery>,
) -> Result<Json<ApiResponse<PaginatedData<GiveawayView>>>, AppError> {
    user.require(&perms, Permission::GiveawaysView).await?;
    let page = GiveawayService::new()
        .list(&db, &query.pagination(), &query.filters())
        .await?;
    Ok(Json(ApiResponse::new(page)))
}

/// Creates a giveaway.
#[utoipa::path(
    post,
    path = "/api/giveaways",
    tag = "giveaways",
    summary = "Create a giveaway",
    security(("session_cookie" = ["giveaways.create"])),
    request_body = CreateGiveawayRequest,
    responses(
        (status = 200, description = "Giveaway created", body = crate::responses::ApiResponseGiveawayDetail),
        (status = 400, description = "Invalid payload", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn create_giveaway(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<CreateGiveawayRequest>,
) -> Result<Json<ApiResponse<GiveawayDetailView>>, AppError> {
    user.require(&perms, Permission::GiveawaysCreate).await?;
    let detail = GiveawayService::new()
        .create(&db, user.user_id, req)
        .await?;
    Ok(Json(ApiResponse::new(detail)))
}

/// Returns one giveaway, including entries.
#[utoipa::path(
    get,
    path = "/api/giveaways/{id}",
    tag = "giveaways",
    summary = "Get giveaway detail",
    security(("session_cookie" = ["giveaways.view"])),
    params(("id" = i64, Path, description = "Giveaway ID")),
    responses(
        (status = 200, description = "Giveaway retrieved", body = crate::responses::ApiResponseGiveawayDetail),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Not found", body = ProblemDetails)
    )
)]
async fn get_giveaway(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<GiveawayDetailView>>, AppError> {
    user.require(&perms, Permission::GiveawaysView).await?;
    Ok(Json(ApiResponse::new(
        GiveawayService::new().get(&db, id).await?,
    )))
}

/// Enters the caller into an open giveaway.
#[utoipa::path(
    post,
    path = "/api/giveaways/{id}/enter",
    tag = "giveaways",
    summary = "Enter a giveaway",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Giveaway ID")),
    responses(
        (status = 200, description = "Entered", body = crate::responses::ApiResponseGiveawayDetail),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Not found", body = ProblemDetails),
        (status = 409, description = "Giveaway is closed", body = ProblemDetails)
    )
)]
async fn enter_giveaway(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<GiveawayDetailView>>, AppError> {
    Ok(Json(ApiResponse::new(
        GiveawayService::new().enter(&db, id, user.user_id).await?,
    )))
}

/// Removes the caller from an open giveaway.
#[utoipa::path(
    delete,
    path = "/api/giveaways/{id}/enter",
    tag = "giveaways",
    summary = "Leave a giveaway",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Giveaway ID")),
    responses(
        (status = 200, description = "Left", body = crate::responses::ApiResponseGiveawayDetail),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Not found", body = ProblemDetails),
        (status = 409, description = "Giveaway is closed", body = ProblemDetails)
    )
)]
async fn leave_giveaway(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<GiveawayDetailView>>, AppError> {
    Ok(Json(ApiResponse::new(
        GiveawayService::new().leave(&db, id, user.user_id).await?,
    )))
}

/// Cancels an open giveaway.
#[utoipa::path(
    post,
    path = "/api/giveaways/{id}/cancel",
    tag = "giveaways",
    summary = "Cancel a giveaway",
    security(("session_cookie" = ["giveaways.manage"])),
    params(("id" = i64, Path, description = "Giveaway ID")),
    responses(
        (status = 200, description = "Cancelled", body = crate::responses::ApiResponseGiveawayDetail),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 409, description = "Giveaway is not open", body = ProblemDetails)
    )
)]
async fn cancel_giveaway(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<GiveawayDetailView>>, AppError> {
    user.require(&perms, Permission::GiveawaysManage).await?;
    Ok(Json(ApiResponse::new(
        GiveawayService::new().cancel(&db, id, user.user_id).await?,
    )))
}

/// Draws a winner now, even if the deadline has not elapsed.
#[utoipa::path(
    post,
    path = "/api/giveaways/{id}/draw",
    tag = "giveaways",
    summary = "Draw a giveaway winner now",
    security(("session_cookie" = ["giveaways.manage"])),
    params(("id" = i64, Path, description = "Giveaway ID")),
    responses(
        (status = 200, description = "Drawn", body = crate::responses::ApiResponseGiveawayDetail),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn draw_giveaway(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<GiveawayDetailView>>, AppError> {
    user.require(&perms, Permission::GiveawaysManage).await?;
    Ok(Json(ApiResponse::new(
        GiveawayService::new().draw(&db, id, true).await?,
    )))
}

/// Records the Discord announcement message so later edits can find it.
#[utoipa::path(
    put,
    path = "/api/giveaways/{id}/discord-message",
    tag = "giveaways",
    summary = "Store the Discord announcement message id",
    security(("session_cookie" = ["giveaways.manage"])),
    params(("id" = i64, Path, description = "Giveaway ID")),
    request_body = SetGiveawayDiscordMessageRequest,
    responses(
        (status = 200, description = "Stored", body = crate::responses::ApiResponseGiveawayDetail),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn set_discord_message(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
    Json(req): Json<SetGiveawayDiscordMessageRequest>,
) -> Result<Json<ApiResponse<GiveawayDetailView>>, AppError> {
    user.require(&perms, Permission::GiveawaysManage).await?;
    Ok(Json(ApiResponse::new(
        GiveawayService::new()
            .set_discord_message(&db, id, req)
            .await?,
    )))
}
