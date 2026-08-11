use super::entities;
use crate::{
    errors::AppError,
    modules::auth::{Permission, Permissions, UserContext},
    pagination::{PaginatedData, PaginationParams},
    responses::ApiResponse,
};
use axum::{Extension, Json, Router, extract::Query, routing::get};
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, utoipa::IntoParams)]
pub struct AuditLogQuery {
    pub page: Option<u64>,
    pub limit: Option<u64>,
    pub action: Option<String>,
    pub entity_type: Option<String>,
    pub entity_id: Option<i64>,
    pub user_id: Option<i64>,
}

impl AuditLogQuery {
    fn pagination(&self) -> PaginationParams {
        PaginationParams {
            page: self.page,
            limit: self.limit,
        }
    }
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct AuditLogResponse {
    pub id: i64,
    pub action: String,
    pub entity_type: Option<String>,
    pub entity_id: Option<i64>,
    pub user_id: Option<i64>,
    pub details: Option<serde_json::Value>,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: chrono::DateTime<chrono::FixedOffset>,
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
    path = "/api/audit",
    tag = "Audit",
    security(("session_cookie" = ["audit.view"])),
    params(
        AuditLogQuery,
    ),
    responses(
        (status = 200, description = "List of audit logs")
    )
)]
async fn list_audit_logs(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Query(query): Query<AuditLogQuery>,
) -> Result<Json<ApiResponse<PaginatedData<AuditLogResponse>>>, AppError> {
    user.require(&perms, Permission::AuditView).await?;

    let mut q = entities::Entity::find().order_by_desc(entities::Column::CreatedAt);

    if let Some(action) = &query.action {
        q = q.filter(entities::Column::Action.eq(action));
    }
    if let Some(entity_type) = &query.entity_type {
        q = q.filter(entities::Column::EntityType.eq(entity_type));
    }
    if let Some(entity_id) = query.entity_id {
        q = q.filter(entities::Column::EntityId.eq(entity_id));
    }
    if let Some(user_id) = query.user_id {
        q = q.filter(entities::Column::UserId.eq(user_id));
    }

    let pagination = query.pagination();
    let limit = pagination.limit();
    let page = pagination.offset_page();

    let paginator = q.paginate(&db, limit);
    let total_items = paginator.num_items().await?;
    let total_pages = paginator.num_pages().await?;
    let models = paginator.fetch_page(page).await?;

    let items = models.into_iter().map(AuditLogResponse::from).collect();

    let paginated = PaginatedData::new(items, total_items, total_pages, page + 1, limit);

    Ok(Json(ApiResponse::new(paginated)))
}
