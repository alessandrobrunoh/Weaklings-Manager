use super::entities;
use super::service::{AuditListFilters, AuditService};
use crate::{
    errors::AppError,
    modules::auth::{Permission, Permissions, UserContext},
    pagination::{PaginatedData, PaginationParams},
};
use axum::{Extension, Json, Router, extract::Query, routing::get};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, utoipa::IntoParams)]
pub struct AuditLogQuery {
    pub page: Option<u64>,
    pub limit: Option<u64>,
    pub action: Option<String>,
    pub entity_type: Option<String>,
    pub entity_id: Option<i64>,
    pub user_id: Option<i64>,
    /// Case-insensitive substring match on `action`.
    pub search: Option<String>,
    /// Sort column: `created_at` (default), `action`, `entity_type`, `user_id`.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc`. Defaults to `desc`.
    pub order: Option<String>,
}

impl AuditLogQuery {
    fn pagination(&self) -> PaginationParams {
        PaginationParams {
            page: self.page,
            limit: self.limit,
        }
    }
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct AuditLogResponse {
    pub id: i64,
    pub action: String,
    pub entity_type: Option<String>,
    pub entity_id: Option<i64>,
    pub split_id: Option<i64>,
    pub user_id: Option<i64>,
    pub details: Option<serde_json::Value>,
    #[schema(example = "2026-08-11T21:00:00+00:00")]
    pub created_at: String,
}

impl From<entities::Model> for AuditLogResponse {
    fn from(model: entities::Model) -> Self {
        Self {
            id: model.id,
            action: model.action,
            entity_type: model.entity_type,
            entity_id: model.entity_id,
            split_id: model.split_id,
            user_id: model.user_id,
            details: model.details,
            created_at: model.created_at.to_rfc3339(),
        }
    }
}

pub fn router() -> Router {
    Router::new().route("/", get(list_audit_logs))
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct PaginatedAuditLogResponse {
    pub items: Vec<AuditLogResponse>,
    pub total_items: u64,
    pub total_pages: u64,
    pub current_page: u64,
    pub per_page: u64,
}

impl From<PaginatedData<AuditLogResponse>> for PaginatedAuditLogResponse {
    fn from(data: PaginatedData<AuditLogResponse>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            per_page: data.limit,
        }
    }
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct ApiResponsePaginatedAuditLogs {
    pub status: String,
    pub data: PaginatedAuditLogResponse,
}

#[utoipa::path(
    get,
    path = "/api/audit",
    tag = "Audit",
    security(("session_cookie" = ["audit.view"])),
    params(
        AuditLogQuery,
    ),
    responses(
        (status = 200, description = "List of audit logs", body = ApiResponsePaginatedAuditLogs)
    )
)]
async fn list_audit_logs(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Query(query): Query<AuditLogQuery>,
) -> Result<Json<ApiResponsePaginatedAuditLogs>, AppError> {
    user.require(&perms, Permission::AuditView).await?;

    let pagination = query.pagination();
    let page = AuditService::list(
        &db,
        &pagination,
        &AuditListFilters {
            action: query.action,
            entity_type: query.entity_type,
            entity_id: query.entity_id,
            user_id: query.user_id,
            search: query.search,
            sort: query.sort,
            order: query.order,
        },
    )
    .await?;
    let items = page.items.into_iter().map(AuditLogResponse::from).collect();
    let paginated = PaginatedData::new(
        items,
        page.total_items,
        page.total_pages,
        page.current_page,
        page.limit,
    );

    Ok(Json(ApiResponsePaginatedAuditLogs {
        status: "success".to_string(),
        data: PaginatedAuditLogResponse::from(paginated),
    }))
}
