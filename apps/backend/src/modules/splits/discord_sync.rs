//! Bot-facing, incremental contract for per-split Discord forum threads.
//!
//! Every log query is explicitly scoped by `split_id`; cursors are monotonically increasing
//! database ids and are safe to replay after a bot restart.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::get,
};
use chrono::{DateTime, Utc};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, Set,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::{
    entities::{
        split::{Column as SplitColumn, Entity as SplitEntity},
        split_discord_sync::{ActiveModel as SyncActiveModel, Entity as SyncEntity},
    },
    models::SplitDetail,
    service::SplitService,
};
use crate::{errors::AppError, modules::auth::BotSecret, responses::ApiResponse};

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct DiscoveryQuery {
    pub updated_after: Option<String>,
    pub after_id: Option<i64>,
    pub limit: Option<u64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SplitDiscovery {
    pub items: Vec<SplitDetail>,
    pub next_id: Option<i64>,
    pub has_more: bool,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct ChangeQuery {
    pub audit_cursor: Option<i64>,
    pub transaction_cursor: Option<i64>,
    pub limit: Option<u64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SplitDiscordSync {
    pub split_id: i64,
    pub detail: SplitDetail,
    pub transactions: Vec<crate::modules::bank::models::TransactionView>,
    pub audit: Vec<crate::modules::audit::router::AuditLogResponse>,
    pub next_audit_cursor: i64,
    pub next_transaction_cursor: i64,
    pub thread_id: Option<String>,
    pub summary_message_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct UpdateSyncState {
    pub thread_id: Option<String>,
    pub summary_message_id: Option<String>,
    pub last_audit_id: Option<i64>,
    pub last_transaction_id: Option<i64>,
}

pub fn router() -> Router {
    Router::new()
        .route("/discord-sync", get(discover))
        .route("/{split_id}/discord-sync", get(get_sync).put(update_state))
}

async fn discover(
    _bot: BotSecret,
    Extension(db): Extension<DatabaseConnection>,
    Query(q): Query<DiscoveryQuery>,
) -> Result<Json<ApiResponse<SplitDiscovery>>, AppError> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let after = q.after_id.unwrap_or(0);
    let mut query = SplitEntity::find().filter(SplitColumn::Id.gt(after));
    if let Some(raw) = q.updated_after.as_deref() {
        let timestamp = DateTime::parse_from_rfc3339(raw)
            .map_err(|_| AppError::Validation("updated_after must be RFC3339".into()))?
            .with_timezone(&Utc);
        query = query.filter(SplitColumn::UpdatedAt.gt(timestamp));
    }
    let rows = query
        .order_by_asc(SplitColumn::UpdatedAt)
        .order_by_asc(SplitColumn::Id)
        .limit(limit + 1)
        .all(&db)
        .await?;
    let has_more = rows.len() > limit as usize;
    let rows = rows.into_iter().take(limit as usize);
    let service = SplitService::new();
    let mut items = Vec::new();
    for split in rows {
        items.push(service.get_split(&db, split.id).await?);
    }
    let next_id = items.last().map(|item| item.summary.id);
    Ok(Json(ApiResponse::new(SplitDiscovery {
        items,
        next_id,
        has_more,
    })))
}

async fn get_sync(
    _bot: BotSecret,
    Extension(db): Extension<DatabaseConnection>,
    Path(split_id): Path<i64>,
    Query(q): Query<ChangeQuery>,
) -> Result<Json<ApiResponse<SplitDiscordSync>>, AppError> {
    let detail = SplitService::new().get_split(&db, split_id).await?;
    let limit = q.limit.unwrap_or(100).clamp(1, 200);
    let audit_cursor = q.audit_cursor.unwrap_or(0);
    let transaction_cursor = q.transaction_cursor.unwrap_or(0);
    let audits = crate::modules::audit::entities::Entity::find()
        .filter(crate::modules::audit::entities::Column::SplitId.eq(split_id))
        .filter(crate::modules::audit::entities::Column::Id.gt(audit_cursor))
        .order_by_asc(crate::modules::audit::entities::Column::Id)
        .limit(limit)
        .all(&db)
        .await?;
    let transactions = crate::modules::bank::entities::Entity::find()
        .filter(crate::modules::bank::entities::Column::SplitId.eq(split_id))
        .filter(crate::modules::bank::entities::Column::Id.gt(transaction_cursor))
        .order_by_asc(crate::modules::bank::entities::Column::Id)
        .limit(limit)
        .all(&db)
        .await?;
    let transaction_cursor = transactions.last().map_or(transaction_cursor, |row| row.id);
    let transactions =
        crate::modules::bank::service::to_views_with_usernames(&db, transactions).await?;
    let next_audit_cursor = audits.last().map_or(audit_cursor, |row| row.id);
    let audit = audits
        .into_iter()
        .map(crate::modules::audit::router::AuditLogResponse::from)
        .collect();
    let state = SyncEntity::find_by_id(split_id).one(&db).await?;
    Ok(Json(ApiResponse::new(SplitDiscordSync {
        split_id,
        detail,
        transactions,
        audit,
        next_audit_cursor,
        next_transaction_cursor: transaction_cursor,
        thread_id: state.as_ref().and_then(|s| s.thread_id.clone()),
        summary_message_id: state.and_then(|s| s.summary_message_id),
    })))
}

async fn update_state(
    _bot: BotSecret,
    Extension(db): Extension<DatabaseConnection>,
    Path(split_id): Path<i64>,
    Json(body): Json<UpdateSyncState>,
) -> Result<Json<ApiResponse<UpdateSyncState>>, AppError> {
    if SplitEntity::find_by_id(split_id).one(&db).await?.is_none() {
        return Err(AppError::NotFound(format!("Split {split_id} not found")));
    }
    let existing = SyncEntity::find_by_id(split_id).one(&db).await?;
    let was_existing = existing.is_some();
    let mut active = existing.map(Into::into).unwrap_or_else(|| SyncActiveModel {
        split_id: Set(split_id),
        ..Default::default()
    });
    if body.thread_id.is_some() {
        active.thread_id = Set(body.thread_id.clone());
    }
    if body.summary_message_id.is_some() {
        active.summary_message_id = Set(body.summary_message_id.clone());
    }
    if let Some(id) = body.last_audit_id {
        active.last_audit_id = Set(id.max(0));
    }
    if let Some(id) = body.last_transaction_id {
        active.last_transaction_id = Set(id.max(0));
    }
    active.updated_at = Set(Utc::now().into());
    if was_existing {
        active.update(&db).await?;
    } else {
        active.insert(&db).await?;
    }
    Ok(Json(ApiResponse::new(body)))
}
