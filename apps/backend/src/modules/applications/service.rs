use chrono::Utc;
use sea_orm::{ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set};

use crate::errors::AppError;
use crate::modules::auth::UserContext;

use super::entities::{ActiveModel, Column, Entity, Model};

pub struct ApplicationService;

impl ApplicationService {
    pub async fn create(
        db: &DatabaseConnection,
        user: &UserContext,
        channel_id: &str,
    ) -> Result<Model, AppError> {
        if !crate::modules::admin::service::AdminService::get_guild_settings(db)
            .await?
            .discord_applications_open
        {
            return Err(AppError::Conflict(
                "Applications are currently closed".into(),
            ));
        }
        if channel_id.trim().is_empty() {
            return Err(AppError::Validation("channel_id is required".into()));
        }
        if Entity::find()
            .filter(Column::UserDiscordId.eq(&user.id))
            .filter(Column::Status.eq("open"))
            .one(db)
            .await?
            .is_some()
        {
            return Err(AppError::Conflict(
                "You already have an open application".into(),
            ));
        }

        let application = ActiveModel {
            user_discord_id: Set(user.id.clone()),
            user_id: Set(Some(user.user_id)),
            username_snapshot: Set(user.username.clone()),
            channel_id: Set(channel_id.trim().to_string()),
            status: Set("open".into()),
            created_at: Set(Utc::now().into()),
            ..Default::default()
        };
        application.insert(db).await.map_err(AppError::Database)
    }
}
