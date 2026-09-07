use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, Set,
    prelude::DateTime, sea_query::Expr,
};

use crate::errors::AppError;

use super::entities::{ActiveModel, Column, Entity, Model};

/// Trims an in-game name and drops it when there is nothing left.
///
/// Albion names top out well under this; the cap only stops a pasted essay
/// from reaching the column.
fn normalize_ingame_name(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| name.chars().take(64).collect())
}

pub struct ApplicationService;

impl ApplicationService {
    /// Opens a ticket for a Discord member. A local web account is optional.
    pub async fn create(
        db: &DatabaseConnection,
        discord_id: &str,
        user_id: Option<i64>,
        username: &str,
        channel_id: &str,
        ingame_name: Option<&str>,
    ) -> Result<Model, AppError> {
        Self::assert_open(db).await?;
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
            ingame_name: Set(normalize_ingame_name(ingame_name)),
            ..Default::default()
        };
        application.insert(db).await.map_err(AppError::Database)
    }

    /// The applicant's most recent ticket, whatever state it ended in.
    ///
    /// The bot asks for this before opening a new one: if the archived channel
    /// is still around, the returning member goes back into it instead of
    /// starting a second ticket with none of the history.
    pub async fn latest_for_user(
        db: &DatabaseConnection,
        discord_id: &str,
    ) -> Result<Option<Model>, AppError> {
        Entity::find()
            .filter(Column::UserDiscordId.eq(discord_id))
            .order_by_desc(Column::Id)
            .one(db)
            .await
            .map_err(AppError::Database)
    }

    /// Brings a resolved ticket back to `open` for the same applicant.
    ///
    /// The row is reused rather than replaced, so the ticket keeps its id and
    /// its channel — which is the point: the manager reopening it wants the
    /// previous conversation, not a blank one. The previous decision is dropped
    /// (the ticket is genuinely undecided again) but `reopen_count` records
    /// that this applicant has been here before.
    pub async fn reopen(
        db: &DatabaseConnection,
        application_id: i64,
        discord_id: &str,
        ingame_name: Option<&str>,
    ) -> Result<Model, AppError> {
        Self::assert_open(db).await?;
        let application = Entity::find_by_id(application_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound("Application not found".into()))?;
        if application.user_discord_id != discord_id {
            return Err(AppError::Forbidden(
                "That application belongs to someone else".into(),
            ));
        }
        if application.status == "open" {
            return Err(AppError::Conflict("Application is already open".into()));
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

        let reopen_count = application.reopen_count.saturating_add(1);
        // Conditioned on the row still being resolved, so two clicks racing
        // each other cannot both count as a reopen.
        let reopened_at: sea_orm::prelude::DateTimeWithTimeZone = Utc::now().into();
        let result = Entity::update_many()
            .col_expr(Column::Status, Expr::value("open"))
            .col_expr(Column::ResolvedAt, Expr::value(Option::<DateTime>::None))
            .col_expr(
                Column::ResolvedByDiscordId,
                Expr::value(Option::<String>::None),
            )
            .col_expr(Column::ReopenedAt, Expr::value(reopened_at))
            .col_expr(Column::ReopenCount, Expr::value(reopen_count))
            .filter(Column::Id.eq(application_id))
            .filter(Column::Status.ne("open"))
            .exec(db)
            .await
            .map_err(AppError::Database)?;
        if result.rows_affected != 1 {
            return Err(AppError::Conflict("Application is already open".into()));
        }

        if let Some(name) = normalize_ingame_name(ingame_name) {
            let mut active: ActiveModel = Entity::find_by_id(application_id)
                .one(db)
                .await?
                .ok_or_else(|| AppError::NotFound("Application not found".into()))?
                .into();
            active.ingame_name = Set(Some(name));
            active.update(db).await.map_err(AppError::Database)?;
        }

        Entity::find_by_id(application_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound("Application not found".into()))
    }

    /// Rejects the call when this guild has applications switched off.
    async fn assert_open(db: &DatabaseConnection) -> Result<(), AppError> {
        if crate::modules::admin::service::AdminService::get_guild_settings(db)
            .await?
            .discord_applications_open
        {
            return Ok(());
        }
        Err(AppError::Conflict(
            "Applications are currently closed".into(),
        ))
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
            Some("Galvdon"),
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
        ApplicationService::create(&db, "1", None, "one", "chan-1", None)
            .await
            .expect("first");
        let error = ApplicationService::create(&db, "1", None, "one", "chan-2", None)
            .await
            .expect_err("duplicate");
        assert!(matches!(error, AppError::Conflict(_)));
    }

    #[tokio::test]
    async fn reopen_reuses_the_row_so_the_channel_and_its_history_carry_over() {
        let db = seed_db().await;
        let created = ApplicationService::create(&db, "1", None, "one", "chan-1", Some("Galvdon"))
            .await
            .expect("create");
        ApplicationService::resolve(&db, created.id, "manager", "declined")
            .await
            .expect("decline");

        let reopened = ApplicationService::reopen(&db, created.id, "1", None)
            .await
            .expect("reopen");

        assert_eq!(reopened.id, created.id, "the ticket keeps its identity");
        assert_eq!(reopened.channel_id, "chan-1", "and its channel");
        assert_eq!(reopened.status, "open");
        assert_eq!(reopened.reopen_count, 1);
        assert!(reopened.reopened_at.is_some());
        // The old decision is gone: the ticket is genuinely undecided again.
        assert_eq!(reopened.resolved_at, None);
        assert_eq!(reopened.resolved_by_discord_id, None);
        // And it is manageable again from the start.
        ApplicationService::resolve(&db, reopened.id, "manager", "accepted")
            .await
            .expect("accept after reopen");
    }

    #[tokio::test]
    async fn reopen_records_the_new_ingame_name_when_the_form_is_filled_again() {
        let db = seed_db().await;
        let created = ApplicationService::create(&db, "1", None, "one", "chan-1", Some("OldName"))
            .await
            .expect("create");
        ApplicationService::resolve(&db, created.id, "manager", "closed")
            .await
            .expect("close");

        let reopened = ApplicationService::reopen(&db, created.id, "1", Some("  NewName  "))
            .await
            .expect("reopen");

        assert_eq!(reopened.ingame_name.as_deref(), Some("NewName"));
    }

    #[tokio::test]
    async fn reopen_refuses_a_ticket_belonging_to_someone_else() {
        let db = seed_db().await;
        let created = ApplicationService::create(&db, "1", None, "one", "chan-1", None)
            .await
            .expect("create");
        ApplicationService::resolve(&db, created.id, "manager", "declined")
            .await
            .expect("decline");

        let error = ApplicationService::reopen(&db, created.id, "2", None)
            .await
            .expect_err("other user");
        assert!(matches!(error, AppError::Forbidden(_)));
    }

    #[tokio::test]
    async fn reopen_refuses_a_ticket_that_is_still_open() {
        let db = seed_db().await;
        let created = ApplicationService::create(&db, "1", None, "one", "chan-1", None)
            .await
            .expect("create");

        let error = ApplicationService::reopen(&db, created.id, "1", None)
            .await
            .expect_err("already open");
        assert!(matches!(error, AppError::Conflict(_)));
    }

    #[tokio::test]
    async fn latest_returns_the_most_recent_ticket_whatever_state_it_ended_in() {
        let db = seed_db().await;
        assert!(
            ApplicationService::latest_for_user(&db, "1")
                .await
                .expect("latest")
                .is_none()
        );

        let first = ApplicationService::create(&db, "1", None, "one", "chan-1", None)
            .await
            .expect("create");
        ApplicationService::resolve(&db, first.id, "manager", "declined")
            .await
            .expect("decline");

        let latest = ApplicationService::latest_for_user(&db, "1")
            .await
            .expect("latest")
            .expect("some");
        assert_eq!(latest.id, first.id);
        assert_eq!(latest.status, "declined");
    }
}
