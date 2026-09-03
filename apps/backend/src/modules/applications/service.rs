use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set,
    sea_query::Expr,
};

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

        // Resolve only an application that is still open. This closes the race between two
        // manager retries: exactly one request can transition the row out of `open`.
        let resolved_at: sea_orm::prelude::DateTimeWithTimeZone = Utc::now().into();
        let result = Entity::update_many()
            .col_expr(Column::Status, Expr::value(status))
            .col_expr(Column::ResolvedAt, Expr::value(resolved_at))
            .col_expr(Column::ResolvedByDiscordId, Expr::value(actor.id.clone()))
            .filter(Column::Id.eq(application_id))
            .filter(Column::Status.eq("open"))
            .exec(db)
            .await
            .map_err(AppError::Database)?;
        if result.rows_affected != 1 {
            return Err(AppError::Conflict("Application is already resolved".into()));
        }

        Entity::find_by_id(application_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound("Application not found".into()))
    }
}
