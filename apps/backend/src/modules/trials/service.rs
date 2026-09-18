use chrono::{Duration, Utc};
use sea_orm::{ActiveModelTrait, DatabaseConnection, EntityTrait, Set};

use crate::errors::AppError;
use crate::modules::admin::entities::Entity as GuildSettingsEntity;

use super::entities::{ActiveModel, Model};

/// The configured trial policy a trial row is created from.
#[derive(Debug)]
pub struct TrialConfig {
    /// Discord role added alongside the standard role for the trialing member.
    pub role_id: String,
    /// How many days the trial lasts by default.
    pub duration_days: i32,
}

pub struct TrialService;

impl TrialService {
    /// Reads the trial configuration, refusing when the guild has not finished setting it up.
    ///
    /// Both fields must be present: accepting someone as a trial with no role to assign would
    /// silently downgrade the feature to a plain accept, and accepting with no duration would
    /// create a trial that never ends.
    pub async fn trial_config(db: &DatabaseConnection) -> Result<TrialConfig, AppError> {
        let settings = GuildSettingsEntity::find()
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| {
                AppError::Internal("guild_settings singleton row is missing".to_string())
            })?;
        let role_id = settings
            .trial_role_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::Conflict("Trial role is not configured".into()))?;
        let duration_days = settings
            .trial_duration_days
            .filter(|days| (1..=365).contains(days))
            .ok_or_else(|| AppError::Conflict("Trial duration is not configured".into()))?;
        Ok(TrialConfig {
            role_id,
            duration_days,
        })
    }

    /// Records a trial for a member whose application was just accepted as a trial.
    pub async fn start_from_accept(
        db: &DatabaseConnection,
        application: &crate::modules::applications::entities::Model,
        actor_discord_id: &str,
    ) -> Result<Model, AppError> {
        Self::start(
            db,
            &application.user_discord_id,
            application.user_id,
            Some(application.id),
            &application.username_snapshot,
            application.ingame_name.clone(),
            actor_discord_id,
        )
        .await
    }

    /// Inserts an active trial ending `duration_days` after now.
    pub async fn start(
        db: &DatabaseConnection,
        discord_id: &str,
        user_id: Option<i64>,
        application_id: Option<i64>,
        username: &str,
        ingame_name: Option<String>,
        actor_discord_id: &str,
    ) -> Result<Model, AppError> {
        let config = Self::trial_config(db).await?;
        let started_at = Utc::now();
        let trial = ActiveModel {
            discord_id: Set(discord_id.to_string()),
            user_id: Set(user_id),
            application_id: Set(application_id),
            username_snapshot: Set(username.to_string()),
            ingame_name: Set(ingame_name),
            started_at: Set(started_at.into()),
            ends_at: Set((started_at + Duration::days(i64::from(config.duration_days))).into()),
            status: Set("active".into()),
            created_by_discord_id: Set(Some(actor_discord_id.to_string())),
            ..Default::default()
        };
        trial.insert(db).await.map_err(AppError::Database)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::admin::entities::ActiveModel as GuildSettingsActiveModel;
    use crate::modules::applications::ApplicationService;
    use sea_orm::{ColumnTrait, Database, QueryFilter};

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.expect("connect");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("migrate");
        db
    }

    async fn configure_trial(db: &DatabaseConnection, role_id: Option<&str>, days: Option<i32>) {
        let settings = GuildSettingsEntity::find()
            .one(db)
            .await
            .expect("settings")
            .expect("settings row");
        let mut active: GuildSettingsActiveModel = settings.into();
        active.trial_role_id = Set(role_id.map(str::to_string));
        active.trial_duration_days = Set(days);
        active.update(db).await.expect("update settings");
    }

    async fn open_application(
        db: &DatabaseConnection,
    ) -> crate::modules::applications::entities::Model {
        crate::modules::admin::service::AdminService::update_guild_settings(
            db,
            1,
            &crate::modules::admin::models::UpdateGuildSettingsRequest {
                discord_applications_open: Some(true),
                ..Default::default()
            },
        )
        .await
        .expect("open applications");
        let application =
            ApplicationService::create(db, "42", None, "applicant", "chan-1", Some("Galvdon"))
                .await
                .expect("create");
        ApplicationService::resolve(db, application.id, "manager", "accepted")
            .await
            .expect("resolve");
        application
    }

    #[tokio::test]
    async fn starting_a_trial_records_an_active_row_ending_after_the_configured_duration() {
        let db = seed_db().await;
        configure_trial(&db, Some("555000111222"), Some(14)).await;
        let application = open_application(&db).await;

        let trial = TrialService::start_from_accept(&db, &application, "manager")
            .await
            .expect("start");

        assert_eq!(trial.discord_id, "42");
        assert_eq!(trial.username_snapshot, "applicant");
        assert_eq!(trial.ingame_name.as_deref(), Some("Galvdon"));
        assert_eq!(trial.application_id, Some(application.id));
        assert_eq!(trial.created_by_discord_id.as_deref(), Some("manager"));
        assert_eq!(trial.status, "active");
        let duration = trial.ends_at.timestamp() - trial.started_at.timestamp();
        assert_eq!(duration, 14 * 24 * 60 * 60);
    }

    #[tokio::test]
    async fn starting_a_trial_without_a_configured_role_conflicts() {
        let db = seed_db().await;
        configure_trial(&db, None, Some(14)).await;
        let application = open_application(&db).await;

        let error = TrialService::start_from_accept(&db, &application, "manager")
            .await
            .expect_err("no role");
        assert!(matches!(error, AppError::Conflict(_)));

        let stored = super::super::entities::Entity::find()
            .all(&db)
            .await
            .expect("list");
        assert!(
            stored.is_empty(),
            "no trial row must survive a refused start"
        );
    }

    #[tokio::test]
    async fn starting_a_trial_without_a_configured_duration_conflicts() {
        let db = seed_db().await;
        configure_trial(&db, Some("555000111222"), None).await;
        let application = open_application(&db).await;

        let error = TrialService::start_from_accept(&db, &application, "manager")
            .await
            .expect_err("no duration");
        assert!(matches!(error, AppError::Conflict(_)));
    }

    #[tokio::test]
    async fn trial_config_rejects_an_out_of_range_duration() {
        let db = seed_db().await;
        configure_trial(&db, Some("555000111222"), Some(0)).await;

        let error = TrialService::trial_config(&db)
            .await
            .expect_err("zero days");
        assert!(matches!(error, AppError::Conflict(_)));
    }

    #[test]
    fn duration_filter_keeps_only_plausible_day_counts() {
        // The closure behind trial_config: 1..=365, everything else is a misconfiguration.
        let in_range = |days: i32| (1..=365).contains(&days);
        assert!(in_range(1));
        assert!(in_range(365));
        assert!(!in_range(0));
        assert!(!in_range(366));
        assert!(!in_range(-7));
    }
}
