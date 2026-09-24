use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, Set,
};

use crate::errors::AppError;

use super::entities::{ActiveModel, Column, Entity, Model};

pub struct TicketService;

impl TicketService {
    pub async fn create(
        db: &DatabaseConnection,
        discord_id: &str,
        user_id: Option<i64>,
        username: &str,
        thread_id: &str,
    ) -> Result<Model, AppError> {
        let username = username.trim();
        let thread_id = thread_id.trim();
        if username.is_empty() || thread_id.is_empty() {
            return Err(AppError::Validation(
                "username and thread_id are required".into(),
            ));
        }
        if Entity::find()
            .filter(Column::UserDiscordId.eq(discord_id))
            .filter(Column::Status.eq("open"))
            .one(db)
            .await?
            .is_some()
        {
            return Err(AppError::Conflict("You already have an open ticket".into()));
        }
        ActiveModel {
            user_discord_id: Set(discord_id.to_string()),
            user_id: Set(user_id),
            username_snapshot: Set(username.to_string()),
            thread_id: Set(thread_id.to_string()),
            status: Set("open".into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .map_err(AppError::Database)
    }

    pub async fn active_for_user(
        db: &DatabaseConnection,
        discord_id: &str,
    ) -> Result<Option<Model>, AppError> {
        Entity::find()
            .filter(Column::UserDiscordId.eq(discord_id))
            .filter(Column::Status.eq("open"))
            .order_by_desc(Column::Id)
            .one(db)
            .await
            .map_err(AppError::Database)
    }

    pub async fn close(db: &DatabaseConnection, id: i64, actor: &str) -> Result<Model, AppError> {
        let ticket = Entity::find_by_id(id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound("Ticket not found".into()))?;
        if ticket.status != "open" {
            return Err(AppError::Conflict("Ticket is already closed".into()));
        }
        let mut active: ActiveModel = ticket.into();
        active.status = Set("closed".into());
        active.closed_at = Set(Some(Utc::now().into()));
        active.closed_by_discord_id = Set(Some(actor.to_string()));
        active.update(db).await.map_err(AppError::Database)
    }
}
