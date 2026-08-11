use std::sync::Arc;
use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use sea_orm::{DatabaseConnection, EntityTrait, QueryOrder, QuerySelect, QueryFilter};
use crate::{
    config::Config,
    errors::AppError,
    modules::auth::AdminGuard,
    pagination::{Page, PaginationParams},
};
use super::entities;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct AuditLogQueryParams {
    pub action: Option<String>,
    pub entity_type: Option<String>,
    pub entity_id: Option<i64>,
    pub user_id: Option<i64>,
}

#[derive(Serialize)]
pub struct AuditLogResponse {
    pub id: i64,
    pub action: String,
    pub entity_type: Option<String>,
    pub entity_id: Option<i64>,
    pub user_id: Option<i64>,
    pub details: Option<serde_json::Value>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

impl From<entities::Model> for AuditLogResponse {
    fn from(model: entities::Model) -> Self {
        Self {
            id: model.id,
            action: model.action,
            entity_type: model.entity_type,
            entity_id: model.entity_id,
            user_id: model.user_id,
            details: model.details,
            created_at: model.created_at,
        }
    }
}

pub fn router() -> Router {
    Router::new().route("/", get(list_audit_logs))
}

#[utoipa::path(
    get,
    path = "/audit",
    tag = "Audit",
    security(("bearer_auth" = [])),
    params(
        PaginationParams,
    ),
    responses(
        (status = 200, description = "List of audit logs")
    )
)]
async fn list_audit_logs(
    State(db): State<DatabaseConnection>,
    _admin: AdminGuard,
    Query(pagination): Query<PaginationParams>,
    Query(filters): Query<AuditLogQueryParams>,
) -> Result<Json<Page<AuditLogResponse>>, AppError> {
    let mut query = entities::Entity::find().order_by_desc(entities::Column::CreatedAt);

    if let Some(action) = filters.action {
        query = query.filter(entities::Column::Action.eq(action));
    }
    if let Some(entity_type) = filters.entity_type {
        query = query.filter(entities::Column::EntityType.eq(entity_type));
    }
    if let Some(entity_id) = filters.entity_id {
        query = query.filter(entities::Column::EntityId.eq(entity_id));
    }
    if let Some(user_id) = filters.user_id {
        query = query.filter(entities::Column::UserId.eq(user_id));
    }

    let (items, total) = pagination.paginate(query, &db).await?;
    let items = items.into_iter().map(AuditLogResponse::from).collect();

    Ok(Json(Page {
        items,
        total,
        page: pagination.page,
        size: pagination.size,
    }))
}
