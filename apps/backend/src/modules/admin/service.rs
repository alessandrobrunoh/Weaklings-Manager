//! Service logic for the admin module: guild settings and role CRUD.

use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
    Set, TransactionTrait,
};
use serde::Deserialize;

use crate::config::Config;
use crate::errors::AppError;
use crate::modules::auth::Permission;
use crate::modules::auth::entities::{role, role_permission};

use super::entities::{
    ActiveModel as GuildSettingActiveModel, Entity as GuildSettingEntity, Model,
};
use super::models::{
    CreateRoleRequest, GuildSettingsView, PermissionCatalogEntry, PermissionMatrix,
    RolePermissionsView, UpdateGuildSettingsRequest, UpdateRoleRequest,
};

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
        if let Some(value) = &req.discord_splits_forum_channel_id {
            active.discord_splits_forum_channel_id = Set(normalize(value));
        }
        if let Some(value) = &req.discord_event_voice_category_id {
            active.discord_event_voice_category_id = Set(normalize_discord_snowflake(value)?);
        }
        if let Some(value) = req.default_split_fee {
            if !(sea_orm::prelude::Decimal::ZERO..=sea_orm::prelude::Decimal::from(100))
                .contains(&value)
            {
                return Err(AppError::Validation(
                    "default split fee must be between 0 and 100".to_string(),
                ));
            }
            active.default_split_fee = Set(value);
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
                "discord_splits_forum_channel_id": req.discord_splits_forum_channel_id,
                "discord_event_voice_category_id": req.discord_event_voice_category_id,
                "default_split_fee": req.default_split_fee,
            })),
        )
        .await;

        Ok(GuildSettingsView::from_model(updated))
    }

    /// Returns the AutoRole configuration without exposing unrelated guild settings.
    pub async fn get_autorole_settings(
        db: &DatabaseConnection,
    ) -> Result<super::models::AutoRoleSettingsView, AppError> {
        let settings = load_settings(db).await?;
        Ok(super::models::AutoRoleSettingsView {
            discord_auto_role_id: settings.discord_auto_role_id,
        })
    }

    /// Updates the AutoRole after confirming that the selected Discord role exists and is not
    /// managed by an integration or the guild itself (`@everyone`).
    pub async fn update_autorole(
        db: &DatabaseConnection,
        editor_user_id: i64,
        cfg: &Config,
        raw_role_id: &str,
    ) -> Result<super::models::AutoRoleSettingsView, AppError> {
        let role_id = parse_discord_role_id(Some(raw_role_id))?;
        if let Some(role_id) = &role_id {
            let roles = fetch_discord_roles(cfg).await?;
            let role = roles
                .iter()
                .find(|role| role.id == *role_id)
                .ok_or_else(|| {
                    AppError::Validation(
                        "Discord role was not found in the configured guild".to_string(),
                    )
                })?;
            if role.id == cfg.discord_guild_id || role.managed {
                return Err(AppError::Validation(
                    "the selected Discord role cannot be assigned by the bot".to_string(),
                ));
            }
        }

        let existing = load_settings(db).await?;
        let mut active: GuildSettingActiveModel = existing.into();
        active.discord_auto_role_id = Set(role_id.clone());
        active.updated_at = Set(chrono::Utc::now().into());
        active.updated_by_user_id = Set(Some(editor_user_id));
        active.update(db).await.map_err(AppError::Database)?;

        let _ = crate::modules::audit::service::AuditService::log(
            db,
            "AUTOROLE_SET",
            Some("GUILD_SETTINGS"),
            Some(1),
            Some(editor_user_id),
            Some(serde_json::json!({ "discord_auto_role_id": role_id })),
        )
        .await;

        Ok(super::models::AutoRoleSettingsView {
            discord_auto_role_id: role_id,
        })
    }

    /// Retrieves the non-managed Discord roles available to the configured guild.
    pub async fn discord_roles(
        cfg: &Config,
    ) -> Result<Vec<super::models::DiscordRoleView>, AppError> {
        let mut roles: Vec<super::models::DiscordRoleView> = fetch_discord_roles(cfg)
            .await?
            .into_iter()
            .filter(|role| role.id != cfg.discord_guild_id && !role.managed)
            .map(|role| super::models::DiscordRoleView {
                id: role.id,
                name: role.name,
                position: role.position,
                managed: role.managed,
            })
            .collect();
        roles.sort_by(|a, b| {
            b.position
                .cmp(&a.position)
                .then_with(|| a.name.cmp(&b.name))
        });
        Ok(roles)
    }

    /// The full role → permission matrix, including Discord-link fields.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Database`] when either table cannot be read.
    pub async fn permission_matrix(db: &DatabaseConnection) -> Result<PermissionMatrix, AppError> {
        let roles = role::Entity::find().all(db).await?;
        let mappings = role_permission::Entity::find().all(db).await?;

        let mut views: Vec<RolePermissionsView> = roles
            .into_iter()
            .map(|r| {
                let mut permissions: Vec<String> = mappings
                    .iter()
                    .filter(|m| m.role_id == r.id)
                    .map(|m| m.permission.clone())
                    .collect();
                permissions.sort();
                RolePermissionsView {
                    role_id: r.id,
                    role_name: r.name,
                    priority: r.priority,
                    discord_role_id: r.discord_role_id,
                    is_default: r.is_default,
                    permissions,
                }
            })
            .collect();
        views.sort_by(|a, b| {
            b.priority
                .cmp(&a.priority)
                .then_with(|| a.role_name.cmp(&b.role_name))
        });

        let mut catalog: Vec<PermissionCatalogEntry> = Permission::catalog()
            .into_iter()
            .map(|info| PermissionCatalogEntry {
                key: info.key.to_string(),
                resource: info.resource.to_string(),
                action: info.action.to_string(),
            })
            .collect();
        catalog.sort_by(|a, b| a.resource.cmp(&b.resource).then_with(|| a.key.cmp(&b.key)));
        let available_permissions: Vec<String> = catalog.iter().map(|e| e.key.clone()).collect();

        Ok(PermissionMatrix {
            roles: views,
            available_permissions,
            permission_catalog: catalog,
        })
    }

    /// Creates a gestionale role, optionally linked to a Discord snowflake.
    ///
    /// # Errors
    ///
    /// `Validation` for empty name / malformed snowflake; `Conflict` for duplicate name or link.
    pub async fn create_role(
        db: &DatabaseConnection,
        editor_user_id: i64,
        req: &CreateRoleRequest,
    ) -> Result<PermissionMatrix, AppError> {
        let name = normalize_role_name(&req.name)?;
        let discord_role_id = parse_discord_role_id(req.discord_role_id.as_deref())?;

        ensure_name_available(db, &name, None).await?;
        if let Some(snowflake) = &discord_role_id {
            ensure_discord_link_available(db, snowflake, None).await?;
        }

        let model = role::ActiveModel {
            id: Set(uuid::Uuid::new_v4().to_string()),
            name: Set(name.clone()),
            priority: Set(req.priority),
            discord_role_id: Set(discord_role_id.clone()),
            is_default: Set(false),
        };

        let txn = db.begin().await?;
        if req.is_default {
            unset_defaults(&txn).await?;
        }
        let mut model = model;
        model.is_default = Set(req.is_default);
        let inserted = model.insert(&txn).await.map_err(map_role_write_err)?;
        txn.commit().await?;

        let _ = crate::modules::audit::service::AuditService::log(
            db,
            "ROLE_CREATE",
            Some("ROLE"),
            None,
            Some(editor_user_id),
            Some(serde_json::json!({
                "role_id": inserted.id,
                "name": inserted.name,
                "priority": inserted.priority,
                "discord_role_id": inserted.discord_role_id,
                "is_default": inserted.is_default,
            })),
        )
        .await;

        Self::permission_matrix(db).await
    }

    /// Partial-updates a gestionale role.
    ///
    /// # Errors
    ///
    /// `NotFound` if the id is unknown; `Validation`/`Conflict` as for create.
    pub async fn update_role(
        db: &DatabaseConnection,
        editor_user_id: i64,
        role_id: &str,
        req: &UpdateRoleRequest,
    ) -> Result<PermissionMatrix, AppError> {
        let existing = role::Entity::find_by_id(role_id.to_string())
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("role {role_id} not found")))?;

        let mut next_name = existing.name.clone();
        if let Some(name) = &req.name {
            next_name = normalize_role_name(name)?;
            ensure_name_available(db, &next_name, Some(&existing.id)).await?;
        }

        let mut next_discord = existing.discord_role_id.clone();
        if let Some(raw) = &req.discord_role_id {
            next_discord = parse_discord_role_id(Some(raw))?;
            if let Some(snowflake) = &next_discord {
                ensure_discord_link_available(db, snowflake, Some(&existing.id)).await?;
            }
        }

        let next_priority = req.priority.unwrap_or(existing.priority);
        let next_default = req.is_default.unwrap_or(existing.is_default);

        let txn = db.begin().await?;
        if next_default && !existing.is_default {
            unset_defaults(&txn).await?;
        }

        let mut active: role::ActiveModel = existing.clone().into();
        active.name = Set(next_name.clone());
        active.priority = Set(next_priority);
        active.discord_role_id = Set(next_discord.clone());
        active.is_default = Set(next_default);
        active.update(&txn).await.map_err(map_role_write_err)?;
        txn.commit().await?;

        let _ = crate::modules::audit::service::AuditService::log(
            db,
            "ROLE_UPDATE",
            Some("ROLE"),
            None,
            Some(editor_user_id),
            Some(serde_json::json!({
                "role_id": role_id,
                "name": next_name,
                "priority": next_priority,
                "discord_role_id": next_discord,
                "is_default": next_default,
            })),
        )
        .await;

        Self::permission_matrix(db).await
    }

    /// Deletes a gestionale role and its permission rows (FK cascade).
    ///
    /// # Errors
    ///
    /// `NotFound`; `Conflict` when deleting the default role or the last `roles.manage` grant
    /// (unless `is_superadmin`).
    pub async fn delete_role(
        db: &DatabaseConnection,
        editor_user_id: i64,
        role_id: &str,
        is_superadmin: bool,
    ) -> Result<PermissionMatrix, AppError> {
        let existing = role::Entity::find_by_id(role_id.to_string())
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("role {role_id} not found")))?;

        if existing.is_default {
            return Err(AppError::Conflict(
                "cannot delete the default fallback role; assign another default first".to_string(),
            ));
        }

        if !is_superadmin {
            let this_grants = role_grants(db, role_id, Permission::RolesManage).await?;
            if this_grants {
                let others = other_role_grants(db, role_id, Permission::RolesManage).await?;
                if !others {
                    return Err(AppError::Conflict(
                        "cannot delete the last role that grants roles.manage".to_string(),
                    ));
                }
            }
        }

        role::Entity::delete_by_id(role_id.to_string())
            .exec(db)
            .await?;

        let _ = crate::modules::audit::service::AuditService::log(
            db,
            "ROLE_DELETE",
            Some("ROLE"),
            None,
            Some(editor_user_id),
            Some(serde_json::json!({
                "role_id": role_id,
                "name": existing.name,
            })),
        )
        .await;

        Self::permission_matrix(db).await
    }
}

#[derive(Debug, Deserialize)]
struct DiscordRolePayload {
    id: String,
    name: String,
    position: i32,
    managed: bool,
}

async fn fetch_discord_roles(cfg: &Config) -> Result<Vec<DiscordRolePayload>, AppError> {
    let token = cfg
        .discord_bot_token
        .as_deref()
        .filter(|token| !token.trim().is_empty() && *token != "your_discord_bot_token")
        .ok_or_else(|| {
            AppError::UpstreamService("Discord bot token is not configured".to_string())
        })?;

    let response = reqwest::Client::new()
        .get(format!(
            "https://discord.com/api/v10/guilds/{}/roles",
            cfg.discord_guild_id
        ))
        .header("Authorization", format!("Bot {token}"))
        .header("User-Agent", "WeaklingsBackend (0.0.3)")
        .send()
        .await
        .map_err(|error| {
            AppError::UpstreamService(format!("Discord roles request failed: {error}"))
        })?;

    if !response.status().is_success() {
        return Err(AppError::UpstreamService(format!(
            "Discord roles request failed with status {}",
            response.status()
        )));
    }

    response.json().await.map_err(|error| {
        AppError::UpstreamService(format!("Discord roles response was invalid: {error}"))
    })
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

/// Validates a Discord snowflake while retaining the standard empty-string-means-clear convention.
fn normalize_discord_snowflake(value: &str) -> Result<Option<String>, AppError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if !trimmed.chars().all(|character| character.is_ascii_digit())
        || !(17..=20).contains(&trimmed.len())
    {
        return Err(AppError::Validation(
            "discord_event_voice_category_id must be a Discord snowflake (17-20 digits)"
                .to_string(),
        ));
    }
    Ok(Some(trimmed.to_string()))
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

fn normalize_role_name(name: &str) -> Result<String, AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("role name is required".to_string()));
    }
    if trimmed.eq_ignore_ascii_case("SuperAdmin") {
        return Err(AppError::Validation(
            "SuperAdmin is reserved for the env bypass and cannot be created as a role".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

fn parse_discord_role_id(raw: Option<&str>) -> Result<Option<String>, AppError> {
    let Some(value) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if !value.chars().all(|c| c.is_ascii_digit()) || value.len() < 17 || value.len() > 20 {
        return Err(AppError::Validation(
            "discord_role_id must be a Discord snowflake (17-20 digits)".to_string(),
        ));
    }
    Ok(Some(value.to_string()))
}

async fn ensure_name_available(
    db: &DatabaseConnection,
    name: &str,
    except_id: Option<&str>,
) -> Result<(), AppError> {
    let existing = role::Entity::find()
        .filter(role::Column::Name.eq(name))
        .one(db)
        .await?;
    if existing.is_some_and(|row| except_id.is_none_or(|id| row.id != id)) {
        return Err(AppError::Conflict(format!(
            "role name {name} is already taken"
        )));
    }
    Ok(())
}

async fn ensure_discord_link_available(
    db: &DatabaseConnection,
    snowflake: &str,
    except_id: Option<&str>,
) -> Result<(), AppError> {
    let existing = role::Entity::find()
        .filter(role::Column::DiscordRoleId.eq(snowflake))
        .one(db)
        .await?;
    if existing.is_some_and(|row| except_id.is_none_or(|id| row.id != id)) {
        return Err(AppError::Conflict(
            "that Discord role is already linked to another gestionale role".to_string(),
        ));
    }
    Ok(())
}

async fn unset_defaults<C: ConnectionTrait>(db: &C) -> Result<(), AppError> {
    let current = role::Entity::find()
        .filter(role::Column::IsDefault.eq(true))
        .all(db)
        .await?;
    for row in current {
        let mut active: role::ActiveModel = row.into();
        active.is_default = Set(false);
        active.update(db).await?;
    }
    Ok(())
}

fn map_role_write_err(err: sea_orm::DbErr) -> AppError {
    let text = err.to_string();
    if text.to_ascii_lowercase().contains("unique") {
        AppError::Conflict("role name or Discord link already exists".to_string())
    } else {
        AppError::Database(err)
    }
}

async fn role_grants(
    db: &DatabaseConnection,
    role_id: &str,
    perm: Permission,
) -> Result<bool, AppError> {
    let row = role_permission::Entity::find()
        .filter(role_permission::Column::RoleId.eq(role_id))
        .filter(role_permission::Column::Permission.eq(perm.as_str()))
        .one(db)
        .await?;
    Ok(row.is_some())
}

async fn other_role_grants(
    db: &DatabaseConnection,
    except_role_id: &str,
    perm: Permission,
) -> Result<bool, AppError> {
    let rows = role_permission::Entity::find()
        .filter(role_permission::Column::Permission.eq(perm.as_str()))
        .all(db)
        .await?;
    Ok(rows.iter().any(|row| row.role_id != except_role_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use sea_orm::Database;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.expect("connect");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("migrate");
        db
    }

    #[test]
    fn parse_discord_role_id_rejects_junk() {
        assert!(parse_discord_role_id(Some("not-a-snowflake")).is_err());
        assert!(parse_discord_role_id(Some("123")).is_err());
        assert_eq!(
            parse_discord_role_id(Some("123456789012345678")).unwrap(),
            Some("123456789012345678".into())
        );
        assert_eq!(parse_discord_role_id(Some("  ")).unwrap(), None);
        assert_eq!(parse_discord_role_id(Some("")).unwrap(), None);
    }

    #[tokio::test]
    async fn guild_settings_round_trip_event_voice_category_id() {
        let db = seed_db().await;
        let saved = AdminService::update_guild_settings(
            &db,
            1,
            &UpdateGuildSettingsRequest {
                discord_event_voice_category_id: Some(" 123456789012345678 ".into()),
                ..Default::default()
            },
        )
        .await
        .expect("save category");
        assert_eq!(
            saved.discord_event_voice_category_id.as_deref(),
            Some("123456789012345678")
        );
        assert_eq!(
            AdminService::get_guild_settings(&db)
                .await
                .expect("load category")
                .discord_event_voice_category_id
                .as_deref(),
            Some("123456789012345678")
        );

        let cleared = AdminService::update_guild_settings(
            &db,
            1,
            &UpdateGuildSettingsRequest {
                discord_event_voice_category_id: Some("   ".into()),
                ..Default::default()
            },
        )
        .await
        .expect("clear category");
        assert_eq!(cleared.discord_event_voice_category_id, None);

        let error = AdminService::update_guild_settings(
            &db,
            1,
            &UpdateGuildSettingsRequest {
                discord_event_voice_category_id: Some("invalid-category".into()),
                ..Default::default()
            },
        )
        .await
        .expect_err("invalid snowflake must be rejected");
        assert!(matches!(error, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn create_role_links_discord_snowflake() {
        let db = seed_db().await;
        let matrix = AdminService::create_role(
            &db,
            1,
            &CreateRoleRequest {
                name: "Raid Lead".into(),
                priority: 70,
                discord_role_id: Some("123456789012345678".into()),
                is_default: false,
            },
        )
        .await
        .expect("create");
        let created = matrix
            .roles
            .iter()
            .find(|r| r.role_name == "Raid Lead")
            .expect("created role in matrix");
        assert_eq!(
            created.discord_role_id.as_deref(),
            Some("123456789012345678")
        );
        assert!(!created.is_default);
        assert!(created.permissions.is_empty());
        // Internal id is not the snowflake.
        assert_ne!(created.role_id, "123456789012345678");
    }

    #[tokio::test]
    async fn create_role_rejects_duplicate_discord_link() {
        let db = seed_db().await;
        let snowflake = "123456789012345678";
        AdminService::create_role(
            &db,
            1,
            &CreateRoleRequest {
                name: "One".into(),
                priority: 1,
                discord_role_id: Some(snowflake.into()),
                is_default: false,
            },
        )
        .await
        .expect("first");
        let err = AdminService::create_role(
            &db,
            1,
            &CreateRoleRequest {
                name: "Two".into(),
                priority: 2,
                discord_role_id: Some(snowflake.into()),
                is_default: false,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)));
    }

    #[tokio::test]
    async fn cannot_delete_default_role() {
        let db = seed_db().await;
        let matrix = AdminService::permission_matrix(&db).await.expect("matrix");
        let default = matrix
            .roles
            .iter()
            .find(|r| r.is_default)
            .expect("seeded User is default");
        let err = AdminService::delete_role(&db, 1, &default.role_id, false)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Conflict(msg) if msg.contains("default")));
    }

    #[tokio::test]
    async fn unlink_clears_discord_role_id() {
        let db = seed_db().await;
        let created = AdminService::create_role(
            &db,
            1,
            &CreateRoleRequest {
                name: "Temp".into(),
                priority: 5,
                discord_role_id: Some("123456789012345678".into()),
                is_default: false,
            },
        )
        .await
        .expect("create");
        let id = created
            .roles
            .iter()
            .find(|r| r.role_name == "Temp")
            .unwrap()
            .role_id
            .clone();
        let updated = AdminService::update_role(
            &db,
            1,
            &id,
            &UpdateRoleRequest {
                name: None,
                priority: None,
                discord_role_id: Some(String::new()),
                is_default: None,
            },
        )
        .await
        .expect("unlink");
        let temp = updated.roles.iter().find(|r| r.role_id == id).unwrap();
        assert_eq!(temp.discord_role_id, None);
    }
}
