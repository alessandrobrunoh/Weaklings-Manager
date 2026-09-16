//! After an Albion register/link, also register the player on the paired alliance/guild tenant.

use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, DatabaseConnection,
    EntityTrait, QueryFilter, Statement,
};

use crate::config::Config;
use crate::errors::AppError;
use crate::modules::auth::UserContext;
use crate::modules::platform::service::PlatformService;
use crate::modules::users::entities::{Column as UserColumn, Entity as UserEntity};
use crate::tenant::TenantRegistry;

use super::discord_guild_role::{self, assign_discord_role, revoke_discord_role};
use super::service::AlbionLinkService;

/// One active alliance membership row plus the guild's Albion id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllianceMember {
    /// Alliance Discord / tenant id.
    pub alliance_tenant_id: String,
    /// Guild Discord / tenant id.
    pub guild_tenant_id: String,
    /// Albion guild id configured on the guild tenant.
    pub guild_albion_id: Option<String>,
}

/// Extra tenants that should receive a copy of the link (not including `current`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FanoutPlan {
    /// Tenant ids to upsert the link into.
    pub other_tenant_ids: Vec<String>,
}

/// Decides which other tenant schemas should receive the register, or rejects alliance outsiders.
///
/// # Errors
///
/// `Forbidden` when registering on an alliance Discord with an IGN whose Albion guild is not a member.
pub fn plan_register_fanout(
    current_tenant_id: &str,
    current_kind: &str,
    player_albion_guild_id: Option<&str>,
    members: &[AllianceMember],
) -> Result<FanoutPlan, AppError> {
    match current_kind {
        "guild" => Ok(FanoutPlan {
            other_tenant_ids: members
                .iter()
                .filter(|row| row.guild_tenant_id == current_tenant_id)
                .map(|row| row.alliance_tenant_id.clone())
                .collect(),
        }),
        "alliance" => {
            let matches: Vec<String> = members
                .iter()
                .filter(|row| {
                    row.alliance_tenant_id == current_tenant_id
                        && player_albion_guild_id
                            .is_some_and(|gid| row.guild_albion_id.as_deref() == Some(gid))
                })
                .map(|row| row.guild_tenant_id.clone())
                .collect();
            if matches.is_empty() {
                return Err(AppError::Forbidden(
                    "ign is not in a member guild of this alliance".to_owned(),
                ));
            }
            Ok(FanoutPlan {
                other_tenant_ids: matches,
            })
        }
        _ => Ok(FanoutPlan {
            other_tenant_ids: Vec::new(),
        }),
    }
}

/// Active memberships touching `tenant_id` (as guild or as alliance).
pub async fn load_active_memberships(
    control: &DatabaseConnection,
    tenant_id: &str,
) -> Result<Vec<AllianceMember>, AppError> {
    let rows = control
        .query_all(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT m.alliance_tenant_id, m.guild_tenant_id, g.albion_guild_id \
             FROM alliance_memberships m \
             JOIN tenants g ON g.id = m.guild_tenant_id \
             WHERE m.status = 'active' \
               AND (m.guild_tenant_id = $1 OR m.alliance_tenant_id = $1)",
            [tenant_id.into()],
        ))
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(AllianceMember {
            alliance_tenant_id: row.try_get_by_index(0)?,
            guild_tenant_id: row.try_get_by_index(1)?,
            guild_albion_id: row.try_get_by_index(2).ok(),
        });
    }
    Ok(out)
}

/// After a successful link on `current_tenant_id`, copy link + alliance roles to paired tenants.
pub async fn after_successful_link(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    cfg: &Config,
    user: &UserContext,
    current_tenant_id: &str,
    current_kind: &str,
    player_id: &str,
    player_name: &str,
    player_albion_guild_id: Option<&str>,
) {
    let members = match load_active_memberships(control, current_tenant_id).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(error = %error, "alliance fan-out: could not load memberships");
            return;
        }
    };
    let plan = match plan_register_fanout(
        current_tenant_id,
        current_kind,
        player_albion_guild_id,
        &members,
    ) {
        Ok(plan) => plan,
        Err(_) => return,
    };
    if plan.other_tenant_ids.is_empty() {
        return;
    }

    let _ = PlatformService::record_membership(control, &user.id, current_tenant_id).await;

    for other_id in &plan.other_tenant_ids {
        let _ = PlatformService::record_membership(control, &user.id, other_id).await;
        match registry.get_or_load(other_id).await {
            Ok(ctx) => {
                if let Err(error) =
                    ensure_user_and_link(&ctx.db, user, player_id, player_name).await
                {
                    tracing::warn!(tenant_id = %other_id, error = %error, "alliance fan-out: link copy failed");
                }
                if let Some(role_id) =
                    discord_guild_role::configured_alliance_role_id(&ctx.db).await
                {
                    assign_discord_role(cfg, other_id, &user.id, &role_id).await;
                }
            }
            Err(error) => {
                tracing::warn!(tenant_id = %other_id, error = %error, "alliance fan-out: tenant load failed");
            }
        }
    }

    // Alliance role on the current Discord too.
    // Caller already has current tenant db via request; we re-load to read settings.
    if let Ok(ctx) = registry.get_or_load(current_tenant_id).await {
        if let Some(role_id) = discord_guild_role::configured_alliance_role_id(&ctx.db).await {
            assign_discord_role(cfg, current_tenant_id, &user.id, &role_id).await;
        }
    }
}

/// Rejects alliance-outsider IGN before a link is written.
pub async fn assert_register_allowed(
    control: &DatabaseConnection,
    current_tenant_id: &str,
    current_kind: &str,
    player_albion_guild_id: Option<&str>,
) -> Result<(), AppError> {
    let members = load_active_memberships(control, current_tenant_id).await?;
    plan_register_fanout(
        current_tenant_id,
        current_kind,
        player_albion_guild_id,
        &members,
    )
    .map(|_| ())
}

/// Best-effort revoke of alliance roles (and extra-tenant links) after unlink.
pub async fn after_successful_unlink(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    cfg: &Config,
    discord_user_id: &str,
    current_tenant_id: &str,
) {
    let members = match load_active_memberships(control, current_tenant_id).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(error = %error, "alliance fan-out unlink: could not load memberships");
            return;
        }
    };
    let mut tenant_ids: Vec<String> = members
        .iter()
        .flat_map(|row| [row.alliance_tenant_id.clone(), row.guild_tenant_id.clone()])
        .collect();
    tenant_ids.push(current_tenant_id.to_owned());
    tenant_ids.sort();
    tenant_ids.dedup();

    let links = AlbionLinkService::new();
    for tenant_id in tenant_ids {
        if let Ok(ctx) = registry.get_or_load(&tenant_id).await {
            if let Some(role_id) = discord_guild_role::configured_alliance_role_id(&ctx.db).await {
                revoke_discord_role(cfg, &tenant_id, discord_user_id, &role_id).await;
            }
            if tenant_id != current_tenant_id {
                let _ = links.delete_link(&ctx.db, discord_user_id).await;
            }
        }
    }
}

async fn ensure_user_and_link(
    db: &DatabaseConnection,
    user: &UserContext,
    player_id: &str,
    player_name: &str,
) -> Result<(), AppError> {
    let _user_id = ensure_user(db, user).await?;
    let links = AlbionLinkService::new();
    match links
        .create_link(db, &user.id, player_id, player_name)
        .await
    {
        Ok(_) | Err(AppError::Conflict(_)) => Ok(()),
        Err(error) => Err(error),
    }
}

async fn ensure_user(db: &DatabaseConnection, user: &UserContext) -> Result<i64, AppError> {
    if let Some(existing) = UserEntity::find()
        .filter(UserColumn::DiscordId.eq(&user.id))
        .one(db)
        .await?
    {
        return Ok(existing.id);
    }
    let email = user
        .email
        .clone()
        .unwrap_or_else(|| format!("discord-{}@alliance.local", user.id));
    if let Some(existing) = UserEntity::find()
        .filter(UserColumn::Email.eq(&email))
        .one(db)
        .await?
    {
        return Ok(existing.id);
    }
    let active = crate::modules::users::entities::ActiveModel {
        username: Set(user.username.clone()),
        email: Set(email),
        role: Set("User".to_owned()),
        discord_id: Set(Some(user.id.clone())),
        ..Default::default()
    };
    Ok(active.insert(db).await?.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(alliance: &str, guild: &str, albion: &str) -> AllianceMember {
        AllianceMember {
            alliance_tenant_id: alliance.to_owned(),
            guild_tenant_id: guild.to_owned(),
            guild_albion_id: Some(albion.to_owned()),
        }
    }

    #[test]
    fn guild_without_alliance_fans_out_nowhere() {
        let plan = plan_register_fanout("g1", "guild", Some("alb"), &[]).unwrap();
        assert!(plan.other_tenant_ids.is_empty());
    }

    #[test]
    fn guild_in_alliance_fans_out_to_alliance() {
        let plan =
            plan_register_fanout("g1", "guild", Some("alb"), &[member("a1", "g1", "alb")]).unwrap();
        assert_eq!(plan.other_tenant_ids, vec!["a1".to_owned()]);
    }

    #[test]
    fn alliance_register_requires_member_albion_guild() {
        let err = plan_register_fanout(
            "a1",
            "alliance",
            Some("other"),
            &[member("a1", "g1", "alb")],
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Forbidden(_)));
    }

    #[test]
    fn alliance_register_with_member_ign_fans_out_to_guild() {
        let plan =
            plan_register_fanout("a1", "alliance", Some("alb"), &[member("a1", "g1", "alb")])
                .unwrap();
        assert_eq!(plan.other_tenant_ids, vec!["g1".to_owned()]);
    }
}
