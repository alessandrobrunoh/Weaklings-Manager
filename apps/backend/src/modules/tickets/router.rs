use axum::{Extension, Json, Router, extract::Path, routing::{get, post}};
use serde::{Deserialize, Serialize};
use crate::{
    errors::AppError,
    modules::auth::{BotDiscordUser, Permission, Permissions, UserContext},
    responses::ApiResponse,
};
use super::{entities::{Column, Entity, Model}, service::TicketService};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};

#[derive(Debug, Serialize)]
pub struct TicketView {
    pub id: i64,
    pub user_discord_id: String,
    pub username: String,
    pub thread_id: String,
    pub status: String,
}

impl From<Model> for TicketView {
    fn from(value: Model) -> Self {
        Self { id: value.id, user_discord_id: value.user_discord_id, username: value.username_snapshot, thread_id: value.thread_id, status: value.status }
    }
}

#[derive(Debug, Deserialize)]
struct CreateTicketBody { thread_id: String, username: Option<String> }

pub fn router() -> Router {
    Router::new()
        .route("/", post(create_ticket))
        .route("/active", get(active_ticket))
        .route("/{id}/close", post(close_ticket))
}

async fn create_ticket(
    actor: BotDiscordUser,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(body): Json<CreateTicketBody>,
) -> Result<Json<ApiResponse<TicketView>>, AppError> {
    let username = body.username.as_deref().filter(|v| !v.trim().is_empty()).unwrap_or(actor.discord_id.as_str());
    let ticket = TicketService::create(&db, &actor.discord_id, actor.user_id, username, &body.thread_id).await?;
    Ok(Json(ApiResponse::new(ticket.into())))
}

async fn active_ticket(
    actor: BotDiscordUser,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<Option<TicketView>>>, AppError> {
    Ok(Json(ApiResponse::new(TicketService::active_for_user(&db, &actor.discord_id).await?.map(Into::into))))
}

async fn close_ticket(
    Path(id): Path<i64>,
    actor: BotDiscordUser,
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<TicketView>>, AppError> {
    let existing = Entity::find().filter(Column::Id.eq(id)).one(&db).await?
        .ok_or_else(|| AppError::NotFound("Ticket not found".into()))?;
    if existing.user_discord_id != actor.discord_id {
        user.require(&perms, Permission::ApplicationsManage).await?;
    }
    Ok(Json(ApiResponse::new(TicketService::close(&db, id, &actor.discord_id).await?.into())))
}
