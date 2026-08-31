//! Notification HTTP routes.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::{get, post},
};

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::pagination::{PaginatedData, PaginationParams};
use crate::responses::ApiResponse;

use super::models::{
    BroadcastRequest, BroadcastResult, NotificationFilters, NotificationView, ReadAllResult,
    UnreadCountView,
};
use super::service::NotificationService;

/// Query for `GET /api/notifications`.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct ListNotificationsQuery {
    /// Page number (1-indexed).
    pub page: Option<u64>,
    /// Page size.
    pub limit: Option<u64>,
    /// When true, only unread rows.
    pub unread: Option<bool>,
}

impl ListNotificationsQuery {
    fn pagination(&self) -> PaginationParams {
        PaginationParams {
            page: self.page,
            limit: self.limit,
        }
    }

    fn filters(&self) -> NotificationFilters {
        NotificationFilters {
            unread: self.unread,
        }
    }
}

/// Creates the router for the notification module.
pub fn router() -> Router {
    Router::new()
        .route("/", get(list_notifications))
        .route("/unread-count", get(unread_count))
        .route("/read-all", post(mark_all_read))
        .route("/broadcast", post(broadcast))
        .route("/{id}/read", post(mark_read))
}

/// Lists the caller's inbox.
///
/// # Errors
///
/// `401` without a session.
#[utoipa::path(
    get,
    path = "/api/notifications",
    tag = "notifications",
    summary = "List the caller's notifications",
    security(("session_cookie" = [])),
    params(ListNotificationsQuery),
    responses(
        (status = 200, description = "Inbox page", body = crate::responses::ApiResponsePaginatedNotificationView),
        (status = 401, description = "Unauthorized", body = ProblemDetails)
    )
)]
async fn list_notifications(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(query): Query<ListNotificationsQuery>,
) -> Result<Json<ApiResponse<PaginatedData<NotificationView>>>, AppError> {
    let page = NotificationService::new()
        .list(&db, user.user_id, &query.pagination(), &query.filters())
        .await?;
    Ok(Json(ApiResponse::new(page)))
}

/// Unread count for the topbar badge.
///
/// # Errors
///
/// `401` without a session.
#[utoipa::path(
    get,
    path = "/api/notifications/unread-count",
    tag = "notifications",
    summary = "Count unread notifications for the caller",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Unread count", body = crate::responses::ApiResponseUnreadCountView),
        (status = 401, description = "Unauthorized", body = ProblemDetails)
    )
)]
async fn unread_count(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<UnreadCountView>>, AppError> {
    let view = NotificationService::new()
        .unread_count(&db, user.user_id)
        .await?;
    Ok(Json(ApiResponse::new(view)))
}

/// Marks one of the caller's notifications as read.
///
/// # Errors
///
/// `404` if the row is missing or belongs to someone else.
#[utoipa::path(
    post,
    path = "/api/notifications/{id}/read",
    tag = "notifications",
    summary = "Mark one notification as read",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Notification id")),
    responses(
        (status = 200, description = "Notification marked read", body = crate::responses::ApiResponseNotificationView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Not found", body = ProblemDetails)
    )
)]
async fn mark_read(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<NotificationView>>, AppError> {
    let view = NotificationService::new()
        .mark_read(&db, user.user_id, id)
        .await?;
    Ok(Json(ApiResponse::new(view)))
}

/// Marks every unread notification of the caller as read.
///
/// # Errors
///
/// `401` without a session.
#[utoipa::path(
    post,
    path = "/api/notifications/read-all",
    tag = "notifications",
    summary = "Mark every unread notification as read",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Unread rows marked read", body = crate::responses::ApiResponseReadAllResult),
        (status = 401, description = "Unauthorized", body = ProblemDetails)
    )
)]
async fn mark_all_read(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<ReadAllResult>>, AppError> {
    let result = NotificationService::new()
        .mark_all_read(&db, user.user_id)
        .await?;
    Ok(Json(ApiResponse::new(result)))
}

/// Fans a guild announcement out to every member's inbox.
///
/// # Errors
///
/// `403` without `notifications.broadcast`; `400` on invalid title/body.
#[utoipa::path(
    post,
    path = "/api/notifications/broadcast",
    tag = "notifications",
    summary = "Broadcast an announcement to every member",
    security(("session_cookie" = ["notifications.broadcast"])),
    request_body = BroadcastRequest,
    responses(
        (status = 200, description = "Broadcast fanned out", body = crate::responses::ApiResponseBroadcastResult),
        (status = 400, description = "Invalid payload", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn broadcast(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<BroadcastRequest>,
) -> Result<Json<ApiResponse<BroadcastResult>>, AppError> {
    user.require(&perms, Permission::NotificationsBroadcast)
        .await?;
    let result = NotificationService::new()
        .broadcast(&db, user.user_id, &req)
        .await?;
    Ok(Json(ApiResponse::new(result)))
}
