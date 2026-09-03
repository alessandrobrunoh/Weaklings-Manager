use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set,
    sea_query::Expr,
};

use crate::errors::AppError;

use super::entities::{ActiveModel, Column, Entity, Model};

pub struct ApplicationService;

impl ApplicationService {
    /// Opens a ticket for a Discord member. A local web account is optional.
    pub async fn create(
        db: &DatabaseConnection,
        discord_id: &str,
        user_id: Option<i64>,
        username: &str,
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
        let username = username.trim();
        if username.is_empty() {
            return Err(AppError::Validation("username is required".into()));
        }
        if Entity::find()
            .filter(Column::UserDiscordId.eq(discord_id))
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
            user_discord_id: Set(discord_id.to_string()),
            user_id: Set(user_id),
            username_snapshot: Set(username.to_string()),
            channel_id: Set(channel_id.trim().to_string()),
            status: Set("open".into()),
            created_at: Set(Utc::now().into()),
            ..Default::default()
        };
        application.insert(db).await.map_err(AppError::Database)
    }

    /// Marks an open application as accepted, declined, or closed.
    pub async fn resolve(
        db: &DatabaseConnection,
        application_id: i64,
        actor_discord_id: &str,
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
            .col_expr(
                Column::ResolvedByDiscordId,
                Expr::value(actor_discord_id.to_string()),
            )
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::admin::models::UpdateGuildSettingsRequest;
    use crate::modules::admin::service::AdminService;
    use sea_orm::Database;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.expect("connect");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("migrate");
        AdminService::update_guild_settings(
            &db,
            1,
            &UpdateGuildSettingsRequest {
                discord_applications_open: Some(true),
                ..Default::default()
            },
        )
        .await
        .expect("open applications");
        db
    }

    #[tokio::test]
    async fn create_allows_discord_members_without_a_web_account() {
        let db = seed_db().await;
        let created = ApplicationService::create(
            &db,
            "111222333444555666",
            None,
            "applicant",
            "999888777666555444",
        )
        .await
        .expect("create");
        assert_eq!(created.user_discord_id, "111222333444555666");
        assert_eq!(created.user_id, None);
        assert_eq!(created.username_snapshot, "applicant");
        assert_eq!(created.status, "open");
    }

    #[tokio::test]
    async fn create_rejects_a_second_open_ticket() {
        let db = seed_db().await;
        ApplicationService::create(&db, "1", None, "one", "chan-1")
            .await
            .expect("first");
        let error = ApplicationService::create(&db, "1", None, "one", "chan-2")
            .await
            .expect_err("duplicate");
        assert!(matches!(error, AppError::Conflict(_)));
    }
}
