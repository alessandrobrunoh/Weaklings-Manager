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
use super::entities::albion_link;
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
    /// Discord role on the alliance hub for this guild's members.
    pub discord_role_id: Option<String>,
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
            "SELECT m.alliance_tenant_id, m.guild_tenant_id, g.albion_guild_id, m.discord_role_id \
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
            discord_role_id: row
                .try_get_by_index(3)
                .ok()
                .filter(|id: &String| !id.is_empty()),
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
                assign_alliance_roles_on_tenant(
                    cfg,
                    &ctx.db,
                    other_id,
                    &user.id,
                    &members,
                    current_kind,
                    current_tenant_id,
                    player_albion_guild_id,
                )
                .await;
            }
            Err(error) => {
                tracing::warn!(tenant_id = %other_id, error = %error, "alliance fan-out: tenant load failed");
            }
        }
    }

    // Alliance role on the current Discord too.
    // Caller already has current tenant db via request; we re-load to read settings.
    if let Ok(ctx) = registry.get_or_load(current_tenant_id).await {
        assign_alliance_roles_on_tenant(
            cfg,
            &ctx.db,
            current_tenant_id,
            &user.id,
            &members,
            current_kind,
            current_tenant_id,
            player_albion_guild_id,
        )
        .await;
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
            for role_id in alliance_hub_roles_on_tenant(&members, &tenant_id) {
                revoke_discord_role(cfg, &tenant_id, discord_user_id, &role_id).await;
            }
            if tenant_id != current_tenant_id {
                let _ = links.delete_link(&ctx.db, discord_user_id).await;
            }
        }
    }
}

/// Guild tenants to scan when the alliance hub has no local Albion link yet.
#[must_use]
pub fn guilds_to_search_for_existing_link(
    current_kind: &str,
    local_link_exists: bool,
    current_tenant_id: &str,
    members: &[AllianceMember],
) -> Vec<String> {
    if local_link_exists || current_kind != "alliance" {
        return Vec::new();
    }
    members
        .iter()
        .filter(|row| row.alliance_tenant_id == current_tenant_id)
        .map(|row| row.guild_tenant_id.clone())
        .collect()
}

/// Discord role on `alliance_tenant_id` for members of `guild_tenant_id`.
#[must_use]
pub fn alliance_hub_role_for_guild(
    members: &[AllianceMember],
    alliance_tenant_id: &str,
    guild_tenant_id: &str,
) -> Option<String> {
    members.iter().find_map(|row| {
        if row.alliance_tenant_id != alliance_tenant_id || row.guild_tenant_id != guild_tenant_id {
            return None;
        }
        row.discord_role_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned)
    })
}

/// If this alliance tenant has no local link, copy one from a member guild.
///
/// # Errors
///
/// Returns a database error when the local link lookup fails.
pub async fn adopt_existing_member_link(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    cfg: &Config,
    user: &UserContext,
    current_tenant_id: &str,
    current_kind: &str,
    local_db: &DatabaseConnection,
) -> Result<Option<albion_link::Model>, AppError> {
    let links = AlbionLinkService::new();
    if let Some(existing) = links.get_link_for_discord_user(local_db, &user.id).await? {
        return Ok(Some(existing));
    }
    if current_kind != "alliance" {
        return Ok(None);
    }
    let members = match load_active_memberships(control, current_tenant_id).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(error = %error, "alliance adopt-link: could not load memberships");
            return Ok(None);
        }
    };
    let guilds =
        guilds_to_search_for_existing_link(current_kind, false, current_tenant_id, &members);
    for guild_id in guilds {
        let Ok(ctx) = registry.get_or_load(&guild_id).await else {
            continue;
        };
        let Ok(Some(found)) = links.get_link_for_discord_user(&ctx.db, &user.id).await else {
            continue;
        };
        let _ = PlatformService::record_membership(control, &user.id, current_tenant_id).await;
        if let Err(error) = ensure_user_and_link(
            local_db,
            user,
            &found.albion_player_id,
            &found.albion_player_name,
        )
        .await
        {
            tracing::warn!(
                tenant_id = %current_tenant_id,
                error = %error,
                "alliance adopt-link: copy into alliance schema failed"
            );
        }
        if let Some(role_id) = alliance_hub_role_for_guild(&members, current_tenant_id, &guild_id) {
            assign_discord_role(cfg, current_tenant_id, &user.id, &role_id).await;
        }
        if let Some(local) = links.get_link_for_discord_user(local_db, &user.id).await? {
            return Ok(Some(local));
        }
        return Ok(Some(found));
    }
    Ok(None)
}

fn home_guild_tenant_id(
    current_tenant_id: &str,
    current_kind: &str,
    player_albion_guild_id: Option<&str>,
    members: &[AllianceMember],
) -> Option<String> {
    match current_kind {
        "guild" => Some(current_tenant_id.to_owned()),
        "alliance" => members.iter().find_map(|row| {
            (row.alliance_tenant_id == current_tenant_id
                && player_albion_guild_id
                    .is_some_and(|gid| row.guild_albion_id.as_deref() == Some(gid)))
            .then(|| row.guild_tenant_id.clone())
        }),
        _ => None,
    }
}

async fn assign_alliance_roles_on_tenant(
    cfg: &Config,
    db: &DatabaseConnection,
    tenant_id: &str,
    discord_user_id: &str,
    members: &[AllianceMember],
    current_kind: &str,
    current_tenant_id: &str,
    player_albion_guild_id: Option<&str>,
) {
    if members
        .iter()
        .any(|row| row.alliance_tenant_id == tenant_id)
    {
        if let Some(guild_id) = home_guild_tenant_id(
            current_tenant_id,
            current_kind,
            player_albion_guild_id,
            members,
        ) {
            if let Some(role_id) = alliance_hub_role_for_guild(members, tenant_id, &guild_id) {
                assign_discord_role(cfg, tenant_id, discord_user_id, &role_id).await;
            }
        }
        return;
    }
    if let Some(role_id) = discord_guild_role::configured_alliance_role_id(db).await {
        assign_discord_role(cfg, tenant_id, discord_user_id, &role_id).await;
    }
}

fn alliance_hub_roles_on_tenant(members: &[AllianceMember], tenant_id: &str) -> Vec<String> {
    members
        .iter()
        .filter(|row| row.alliance_tenant_id == tenant_id)
        .filter_map(|row| {
            row.discord_role_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(ToOwned::to_owned)
        })
        .collect()
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
            discord_role_id: None,
        }
    }

    fn member_with_role(alliance: &str, guild: &str, albion: &str, role: &str) -> AllianceMember {
        AllianceMember {
            alliance_tenant_id: alliance.to_owned(),
            guild_tenant_id: guild.to_owned(),
            guild_albion_id: Some(albion.to_owned()),
            discord_role_id: Some(role.to_owned()),
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

    #[test]
    fn alliance_hub_role_is_per_guild_and_ignores_blank() {
        let members = [
            member_with_role("a1", "g1", "alb-1", "role-weaklings"),
            member_with_role("a1", "g2", "alb-2", "  "),
            member("a1", "g3", "alb-3"),
        ];
        assert_eq!(
            alliance_hub_role_for_guild(&members, "a1", "g1").as_deref(),
            Some("role-weaklings")
        );
        assert_eq!(alliance_hub_role_for_guild(&members, "a1", "g2"), None);
        assert_eq!(alliance_hub_role_for_guild(&members, "a1", "g3"), None);
        assert_eq!(alliance_hub_role_for_guild(&members, "a1", "missing"), None);
        assert_eq!(alliance_hub_role_for_guild(&members, "other", "g1"), None);
    }

    #[test]
    fn alliance_without_local_link_searches_member_guilds() {
        let members = [member("a1", "g1", "alb"), member("a1", "g2", "alb-2")];
        assert_eq!(
            guilds_to_search_for_existing_link("alliance", false, "a1", &members),
            vec!["g1".to_owned(), "g2".to_owned()]
        );
        assert!(guilds_to_search_for_existing_link("alliance", true, "a1", &members).is_empty());
        assert!(guilds_to_search_for_existing_link("guild", false, "g1", &members).is_empty());
    }
}
