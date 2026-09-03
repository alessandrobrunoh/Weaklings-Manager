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

    pub async fn resolve(
        db: &DatabaseConnection,
        application_id: i64,
        actor: &UserContext,
        status: &'static str,
    ) -> Result<Model, AppError> {
        let application = Entity::find()
            .filter(Column::Id.eq(application_id))
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound("Application not found".into()))?;
        if application.status != "open" {
            return Err(AppError::Conflict("Application is already resolved".into()));
        }
        if status == "closed" && application.user_discord_id != actor.id {
            return Err(AppError::Forbidden(
                "Only the applicant or an authorized manager can close this application".into(),
            ));
        }

        let mut active: ActiveModel = application.into();
        active.status = Set(status.to_string());
        active.resolved_at = Set(Some(Utc::now().into()));
        active.resolved_by_discord_id = Set(Some(actor.id.clone()));
        active.update(db).await.map_err(AppError::Database)
    }
}
