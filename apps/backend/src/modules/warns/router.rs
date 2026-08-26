//! Warn HTTP routes.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::{get, post},
};

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::pagination::{PaginatedData, PaginationParams};
use crate::responses::ApiResponse;

use super::models::{IssueWarnRequest, WarnEscalationView, WarnFilters, WarnView};
use super::service::WarnService;

/// Query for `GET /api/warns`.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct ListWarnsQuery {
    /// Page number (1-indexed).
    pub page: Option<u64>,
    /// Page size.
    pub limit: Option<u64>,
    /// Restrict to one member.
    pub user_id: Option<i64>,
    /// Restrict to one severity (`note`, `warn`, `strike`).
    pub severity: Option<super::status::WarnSeverity>,
    /// `true` = only revoked, `false` = only active.
    pub revoked: Option<bool>,
}

impl ListWarnsQuery {
    fn pagination(&self) -> PaginationParams {
        PaginationParams {
            page: self.page,
            limit: self.limit,
        }
    }

    fn filters(&self) -> WarnFilters {
        WarnFilters {
            user_id: self.user_id,
            severity: self.severity,
            revoked: self.revoked,
        }
    }
}

/// Query for `GET /api/warns/escalations`.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct ListEscalationsQuery {
    /// Page number (1-indexed).
    pub page: Option<u64>,
    /// Page size.
    pub limit: Option<u64>,
    /// When true, only unacked and unclosed rows.
    pub open_only: Option<bool>,
}

/// Creates the router for the warn module.
pub fn router() -> Router {
    Router::new()
        .route("/", get(list_warns).post(issue_warn))
        .route("/escalations", get(list_escalations))
        .route("/escalations/{id}/ack", post(ack_escalation))
        .route("/{id}/revoke", post(revoke_warn))
}

/// Issue a warn.
///
/// # Errors
///
/// Returns `403` without `warns.issue`.
#[utoipa::path(
    post,
    path = "/api/warns",
    tag = "warns",
    summary = "Issue a warn",
    security(("session_cookie" = ["warns.issue"])),
    request_body = IssueWarnRequest,
    responses(
        (status = 200, description = "Warn issued", body = crate::responses::ApiResponseWarnView),
        (status = 400, description = "Invalid payload", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Target user not found", body = ProblemDetails)
    )
)]
async fn issue_warn(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<IssueWarnRequest>,
) -> Result<Json<ApiResponse<WarnView>>, AppError> {
    user.require(&perms, Permission::WarnsIssue).await?;
    let view = WarnService::new().issue(&db, user.user_id, &req).await?;
    Ok(Json(ApiResponse::new(view)))
}

/// List warns, including revoked rows unless filtered.
///
/// # Errors
///
/// Returns `403` without `warns.view`.
#[utoipa::path(
    get,
    path = "/api/warns",
    tag = "warns",
    summary = "List warns (including revoked)",
    security(("session_cookie" = ["warns.view"])),
    params(ListWarnsQuery),
    responses(
        (status = 200, description = "Warns retrieved", body = crate::responses::ApiResponsePaginatedWarnView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn list_warns(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(query): Query<ListWarnsQuery>,
) -> Result<Json<ApiResponse<PaginatedData<WarnView>>>, AppError> {
    user.require(&perms, Permission::WarnsView).await?;
    let page = WarnService::new()
        .list(&db, &query.pagination(), &query.filters())
        .await?;
    Ok(Json(ApiResponse::new(page)))
}

/// Soft-revoke a warn.
///
/// # Errors
///
/// Returns `403` without `warns.issue`.
#[utoipa::path(
    post,
    path = "/api/warns/{id}/revoke",
    tag = "warns",
    summary = "Revoke a warn (does not delete)",
    security(("session_cookie" = ["warns.issue"])),
    params(("id" = i64, Path, description = "Warn id")),
    responses(
        (status = 200, description = "Warn revoked", body = crate::responses::ApiResponseWarnView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Warn not found", body = ProblemDetails),
        (status = 409, description = "Already revoked", body = ProblemDetails)
    )
)]
async fn revoke_warn(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<WarnView>>, AppError> {
    user.require(&perms, Permission::WarnsIssue).await?;
    let view = WarnService::new().revoke(&db, user.user_id, id).await?;
    Ok(Json(ApiResponse::new(view)))
}

/// List warn escalations.
///
/// # Errors
///
/// Returns `403` without `warns.view`.
#[utoipa::path(
    get,
    path = "/api/warns/escalations",
    tag = "warns",
    summary = "List warn escalations",
    security(("session_cookie" = ["warns.view"])),
    params(ListEscalationsQuery),
    responses(
        (status = 200, description = "Escalations retrieved", body = crate::responses::ApiResponsePaginatedWarnEscalationView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn list_escalations(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(query): Query<ListEscalationsQuery>,
) -> Result<Json<ApiResponse<PaginatedData<WarnEscalationView>>>, AppError> {
    user.require(&perms, Permission::WarnsView).await?;
    let page = WarnService::new()
        .list_escalations(
            &db,
            &PaginationParams {
                page: query.page,
                limit: query.limit,
            },
            query.open_only.unwrap_or(false),
        )
        .await?;
    Ok(Json(ApiResponse::new(page)))
}

/// Acknowledge an open escalation.
///
/// # Errors
///
/// Returns `403` without `warns.issue` or `progression.settings.manage`.
#[utoipa::path(
    post,
    path = "/api/warns/escalations/{id}/ack",
    tag = "warns",
    summary = "Acknowledge a warn escalation",
    security(("session_cookie" = ["warns.issue"])),
    params(("id" = i64, Path, description = "Escalation id")),
    responses(
        (status = 200, description = "Escalation acknowledged", body = crate::responses::ApiResponseWarnEscalationView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Escalation not found", body = ProblemDetails),
        (status = 409, description = "Already acknowledged", body = ProblemDetails)
    )
)]
async fn ack_escalation(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<WarnEscalationView>>, AppError> {
    let can_issue = user.has_permission(&perms, Permission::WarnsIssue).await;
    let can_settings = user
        .has_permission(&perms, Permission::ProgressionSettingsManage)
        .await;
    if !can_issue && !can_settings {
        return Err(AppError::Forbidden(
            "requires warns.issue or progression.settings.manage".into(),
        ));
    }
    let view = WarnService::new()
        .acknowledge_escalation(&db, user.user_id, id)
        .await?;
    Ok(Json(ApiResponse::new(view)))
}
