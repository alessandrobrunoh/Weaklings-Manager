//! Service logic for the admin module's guild settings singleton.

use sea_orm::{ActiveModelTrait, DatabaseConnection, EntityTrait, Set};

use crate::errors::AppError;

use super::entities::{ActiveModel as GuildSettingActiveModel, Entity as GuildSettingEntity, Model};
use super::models::{GuildSettingsView, UpdateGuildSettingsRequest};

pub struct AdminService;

impl AdminService {
    /// Returns the singleton `guild_settings` row as a view.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Internal`] if the singleton is missing.
    pub async fn get_guild_settings(
        db: &DatabaseConnection,
    ) -> Result<GuildSettingsView, AppError> {
        let model = load_settings(db).await?;
        Ok(GuildSettingsView::from_model(model))
    }

    /// Updates the singleton `guild_settings` row with the non-`None` fields of `req`.
    ///
    /// An empty string clears the field (see [`UpdateGuildSettingsRequest`]); a field that is
    /// simply absent (`None`) is left as-is.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Database`] on DB failure.
    pub async fn update_guild_settings(
        db: &DatabaseConnection,
        editor_user_id: i64,
        req: &UpdateGuildSettingsRequest,
    ) -> Result<GuildSettingsView, AppError> {
        let existing = load_settings(db).await?;
        let mut active: GuildSettingActiveModel = existing.into();

        if let Some(value) = &req.discord_events_channel_id {
            active.discord_events_channel_id = Set(normalize(value));
        }
        if let Some(value) = &req.discord_battles_channel_id {
            active.discord_battles_channel_id = Set(normalize(value));
        }
        if let Some(value) = &req.discord_battles_cta_channel_id {
            active.discord_battles_cta_channel_id = Set(normalize(value));
        }
        if let Some(value) = &req.discord_audit_log_channel_id {
            active.discord_audit_log_channel_id = Set(normalize(value));
        }
        if let Some(value) = &req.discord_transaction_spam_channel_id {
            active.discord_transaction_spam_channel_id = Set(normalize(value));
        }
        if let Some(value) = &req.discord_event_role_id {
            active.discord_event_role_id = Set(normalize(value));
        }
        active.updated_at = Set(chrono::Utc::now().into());
        active.updated_by_user_id = Set(Some(editor_user_id));
        let updated = active.update(db).await.map_err(AppError::Database)?;

        let _ = crate::modules::audit::service::AuditService::log(
            db,
            "GUILD_SETTINGS_SET",
            Some("GUILD_SETTINGS"),
            Some(1),
            Some(editor_user_id),
            Some(serde_json::json!({
                "discord_events_channel_id": req.discord_events_channel_id,
                "discord_battles_channel_id": req.discord_battles_channel_id,
                "discord_battles_cta_channel_id": req.discord_battles_cta_channel_id,
                "discord_audit_log_channel_id": req.discord_audit_log_channel_id,
                "discord_transaction_spam_channel_id": req.discord_transaction_spam_channel_id,
                "discord_event_role_id": req.discord_event_role_id,
            })),
        )
        .await;

        Ok(GuildSettingsView::from_model(updated))
    }
}

/// Empty string means "clear"; anything else is stored verbatim (trimmed).
fn normalize(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Loads the singleton settings row, raising `Internal` if it is missing (it is seeded by the
/// migration so this should only happen on a corrupted DB).
async fn load_settings(db: &DatabaseConnection) -> Result<Model, AppError> {
    GuildSettingEntity::find()
        .one(db)
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::Internal("guild_settings singleton row is missing".to_string()))
}
