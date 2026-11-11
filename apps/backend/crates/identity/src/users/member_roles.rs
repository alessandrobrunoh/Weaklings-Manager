//! Assign and revoke gestionale roles on a member, synced to Discord.
//!
//! Discord remains the source of truth for who holds a role. The panel adds or
//! removes the Discord snowflake linked on `/roles`. The unique `is_staff` role
//! is not assigned directly: anyone holding a `grants_staff` role also receives
//! that Discord role so `@staff` reaches Council, Officer, Recruiter, etc.

use std::collections::HashSet;
use std::future::Future;

use sea_orm::{ActiveModelTrait, DatabaseConnection, EntityTrait, Set};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::auth::service::resolve_linked_roles;
use crate::discord_api::{DiscordRest, LiveDiscordRest, upstream};
use backend_core::config::Config;
use backend_core::errors::AppError;
use backend_entities::auth::role;
use backend_entities::users::{ActiveModel as UserActiveModel, Entity as UserEntity};

/// Discord operations needed to add or remove a guild member's roles.
pub trait DiscordMemberApi: Send + Sync {
    /// Current Discord role snowflakes held by the member.
    fn list_role_ids(
        &self,
        discord_user_id: &str,
    ) -> impl Future<Output = Result<Vec<String>, AppError>> + Send;

    /// Grant one Discord role. Idempotent.
    fn add_role(
        &self,
        discord_user_id: &str,
        discord_role_id: &str,
    ) -> impl Future<Output = Result<(), AppError>> + Send;

    /// Revoke one Discord role. Idempotent when the member does not have it.
    fn remove_role(
        &self,
        discord_user_id: &str,
        discord_role_id: &str,
    ) -> impl Future<Output = Result<(), AppError>> + Send;
}

/// Live Discord operations for one tenant's server, through the shared [`DiscordRest`] client.
pub struct LiveDiscord {
    guild_id: String,
    discord: LiveDiscordRest,
}

impl LiveDiscord {
    /// Builds a client for one tenant's Discord server.
    ///
    /// `guild_id` is the tenant id: role reads and writes must land in the
    /// server the request was scoped to, never in a globally configured one.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::UpstreamService`] when the bot token or guild id is missing.
    pub fn for_guild(cfg: &Config, guild_id: &str) -> Result<Self, AppError> {
        let discord = LiveDiscordRest::new(cfg);
        if !discord.has_bot_token() {
            return Err(AppError::UpstreamService(
                "Discord bot token is not configured".to_string(),
            ));
        }
        let guild_id = guild_id.trim().to_string();
        if guild_id.is_empty() {
            return Err(AppError::UpstreamService(
                "Discord guild id is not configured".to_string(),
            ));
        }
        Ok(Self { guild_id, discord })
    }
}

impl DiscordMemberApi for LiveDiscord {
    async fn list_role_ids(&self, discord_user_id: &str) -> Result<Vec<String>, AppError> {
        match self
            .discord
            .guild_member(&self.guild_id, discord_user_id)
            .await
        {
            Ok(member) => Ok(member.roles),
            Err(error) if error.is_already_gone() => Err(AppError::Validation(
                "this member is not in the Discord guild".to_string(),
            )),
            Err(error) => Err(upstream("Discord member request failed", error)),
        }
    }

    async fn add_role(&self, discord_user_id: &str, discord_role_id: &str) -> Result<(), AppError> {
        self.discord
            .add_member_role(&self.guild_id, discord_user_id, discord_role_id)
            .await
            .map_err(|error| upstream("Discord role update failed", error))
    }

    async fn remove_role(
        &self,
        discord_user_id: &str,
        discord_role_id: &str,
    ) -> Result<(), AppError> {
        match self
            .discord
            .remove_member_role(&self.guild_id, discord_user_id, discord_role_id)
            .await
        {
            // Revoking a role the member no longer has is a success.
            Ok(()) => Ok(()),
            Err(error) if error.is_role_removed() => Ok(()),
            Err(error) => Err(upstream("Discord role update failed", error)),
        }
    }
}

/// One gestionale role and whether the member currently holds its Discord link.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct UserRoleAssignmentView {
    /// Internal gestionale role id.
    pub role_id: String,
    /// Display name.
    pub role_name: String,
    /// Ordering weight; higher wins for `highest_role`.
    pub priority: i32,
    /// Linked Discord snowflake, if any.
    pub discord_role_id: Option<String>,
    /// Default fallback role.
    pub is_default: bool,
    /// Unique generic staff ping role.
    pub is_staff: bool,
    /// Holders also receive the generic staff Discord role.
    pub grants_staff: bool,
    /// Whether the member currently holds the linked Discord role.
    pub held: bool,
    /// Whether the panel may add or remove this role directly.
    pub assignable: bool,
}

/// Member role assignments as seen by the user detail page.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct UserRolesView {
    /// Discord snowflake of the member, when known.
    pub discord_id: Option<String>,
    /// Highest held gestionale role name after matching Discord roles.
    pub highest_role: String,
    /// Every gestionale role, with hold/assignable flags.
    pub roles: Vec<UserRoleAssignmentView>,
}

/// Request body to add a gestionale role to a member.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct AssignUserRoleRequest {
    /// Internal gestionale role id to add.
    pub role_id: String,
}

/// Lists a member's Discord-linked gestionale roles.
///
/// # Errors
///
/// `NotFound` if the user does not exist; `Validation` if they are not in the guild;
/// `UpstreamService` if Discord cannot be reached.
pub async fn list_user_roles(
    db: &DatabaseConnection,
    discord: &impl DiscordMemberApi,
    user_id: u64,
) -> Result<UserRolesView, AppError> {
    let (user, db_roles) = load_user_and_roles(db, user_id).await?;
    let held = match user.discord_id.as_deref() {
        Some(discord_id) => discord.list_role_ids(discord_id).await?,
        None => Vec::new(),
    };
    Ok(build_view(&user, &db_roles, &held))
}

/// Adds a linked gestionale role on Discord and reconciles the staff ping role.
///
/// # Errors
///
/// `NotFound`, `Validation`, `Forbidden` (priority), or `UpstreamService`.
pub async fn add_user_role(
    db: &DatabaseConnection,
    discord: &impl DiscordMemberApi,
    editor_user_id: i64,
    editor_bypasses_priority: bool,
    editor_role_names: &[String],
    user_id: u64,
    role_id: &str,
) -> Result<UserRolesView, AppError> {
    let (user, db_roles) = load_user_and_roles(db, user_id).await?;
    let target = db_roles
        .iter()
        .find(|role| role.id == role_id)
        .ok_or_else(|| AppError::NotFound(format!("role {role_id} not found")))?;
    ensure_assignable(target)?;
    ensure_priority_allowed(
        editor_bypasses_priority,
        editor_role_names,
        &db_roles,
        target,
    )?;

    let discord_id = user.discord_id.clone().ok_or_else(|| {
        AppError::Validation("this member has no Discord id; they must log in once".to_string())
    })?;
    let discord_role_id = target.discord_role_id.clone().ok_or_else(|| {
        AppError::Validation("this role is not linked to a Discord role".to_string())
    })?;

    discord.add_role(&discord_id, &discord_role_id).await?;
    let mut held = discord.list_role_ids(&discord_id).await?;
    if let Err(error) = reconcile_staff_role(discord, &discord_id, &mut held, &db_roles).await {
        tracing::warn!(
            user_id,
            error = %error,
            "failed to reconcile generic staff Discord role after add"
        );
    }

    refresh_cached_highest_role(db, user.id, &held, &db_roles).await?;
    let _ = crate::audit::service::AuditService::log(
        db,
        "USER_ROLE_ADD",
        Some("USER"),
        Some(user.id),
        Some(editor_user_id),
        Some(serde_json::json!({
            "role_id": role_id,
            "role_name": target.name,
            "discord_role_id": discord_role_id,
        })),
    )
    .await;

    let user = UserEntity::find_by_id(user.id)
        .one(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("user {user_id} not found")))?;
    Ok(build_view(&user, &db_roles, &held))
}

/// Removes a linked gestionale role on Discord and reconciles the staff ping role.
///
/// # Errors
///
/// `NotFound`, `Validation`, `Forbidden` (priority), or `UpstreamService`.
pub async fn remove_user_role(
    db: &DatabaseConnection,
    discord: &impl DiscordMemberApi,
    editor_user_id: i64,
    editor_bypasses_priority: bool,
    editor_role_names: &[String],
    user_id: u64,
    role_id: &str,
) -> Result<UserRolesView, AppError> {
    let (user, db_roles) = load_user_and_roles(db, user_id).await?;
    let target = db_roles
        .iter()
        .find(|role| role.id == role_id)
        .ok_or_else(|| AppError::NotFound(format!("role {role_id} not found")))?;
    ensure_assignable(target)?;
    ensure_priority_allowed(
        editor_bypasses_priority,
        editor_role_names,
        &db_roles,
        target,
    )?;

    let discord_id = user.discord_id.clone().ok_or_else(|| {
        AppError::Validation("this member has no Discord id; they must log in once".to_string())
    })?;
    let discord_role_id = target.discord_role_id.clone().ok_or_else(|| {
        AppError::Validation("this role is not linked to a Discord role".to_string())
    })?;

    discord.remove_role(&discord_id, &discord_role_id).await?;
    let mut held = discord.list_role_ids(&discord_id).await?;
    if let Err(error) = reconcile_staff_role(discord, &discord_id, &mut held, &db_roles).await {
        tracing::warn!(
            user_id,
            error = %error,
            "failed to reconcile generic staff Discord role after remove"
        );
    }

    refresh_cached_highest_role(db, user.id, &held, &db_roles).await?;
    let _ = crate::audit::service::AuditService::log(
        db,
        "USER_ROLE_REMOVE",
        Some("USER"),
        Some(user.id),
        Some(editor_user_id),
        Some(serde_json::json!({
            "role_id": role_id,
            "role_name": target.name,
            "discord_role_id": discord_role_id,
        })),
    )
    .await;

    let user = UserEntity::find_by_id(user.id)
        .one(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("user {user_id} not found")))?;
    Ok(build_view(&user, &db_roles, &held))
}

fn ensure_assignable(role: &role::Model) -> Result<(), AppError> {
    if role.is_staff {
        return Err(AppError::Validation(
            "the generic staff role is assigned automatically to staff-eligible roles".to_string(),
        ));
    }
    if role.discord_role_id.is_none() {
        return Err(AppError::Validation(
            "this role is not linked to a Discord role".to_string(),
        ));
    }
    Ok(())
}

fn ensure_priority_allowed(
    editor_bypasses_priority: bool,
    editor_role_names: &[String],
    db_roles: &[role::Model],
    target: &role::Model,
) -> Result<(), AppError> {
    if editor_bypasses_priority {
        return Ok(());
    }
    let actor_max = max_priority_for_names(editor_role_names, db_roles);
    if target.priority > actor_max {
        return Err(AppError::Forbidden(
            "cannot assign or remove a role above your own".to_string(),
        ));
    }
    Ok(())
}

/// Highest priority among the named gestionale roles. Unknown names are ignored.
#[must_use]
pub fn max_priority_for_names(role_names: &[String], db_roles: &[role::Model]) -> i32 {
    db_roles
        .iter()
        .filter(|role| role_names.iter().any(|name| name == &role.name))
        .map(|role| role.priority)
        .max()
        .unwrap_or(0)
}

/// Whether the member should hold the generic staff Discord role.
#[must_use]
pub fn should_hold_staff_role(held_discord_role_ids: &[String], db_roles: &[role::Model]) -> bool {
    let held: HashSet<&str> = held_discord_role_ids.iter().map(String::as_str).collect();
    db_roles.iter().any(|role| {
        role.grants_staff
            && !role.is_staff
            && role
                .discord_role_id
                .as_deref()
                .is_some_and(|id| held.contains(id))
    })
}

/// Discord snowflake of the unique generic staff role, if linked.
#[must_use]
pub fn staff_discord_role_id(db_roles: &[role::Model]) -> Option<&str> {
    db_roles
        .iter()
        .find(|role| role.is_staff)
        .and_then(|role| role.discord_role_id.as_deref())
}

async fn reconcile_staff_role(
    discord: &impl DiscordMemberApi,
    discord_user_id: &str,
    held: &mut Vec<String>,
    db_roles: &[role::Model],
) -> Result<(), AppError> {
    let Some(staff_id) = staff_discord_role_id(db_roles) else {
        return Ok(());
    };
    let want = should_hold_staff_role(held, db_roles);
    let has = held.iter().any(|id| id == staff_id);
    if want && !has {
        discord.add_role(discord_user_id, staff_id).await?;
        held.push(staff_id.to_string());
    } else if !want && has {
        discord.remove_role(discord_user_id, staff_id).await?;
        held.retain(|id| id != staff_id);
    }
    Ok(())
}

async fn load_user_and_roles(
    db: &DatabaseConnection,
    user_id: u64,
) -> Result<(backend_entities::users::Model, Vec<role::Model>), AppError> {
    let user = UserEntity::find_by_id(user_id as i64)
        .one(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("user {user_id} not found")))?;
    let roles = role::Entity::find().all(db).await?;
    Ok((user, roles))
}

fn build_view(
    user: &backend_entities::users::Model,
    db_roles: &[role::Model],
    held_discord_role_ids: &[String],
) -> UserRolesView {
    let held: HashSet<&str> = held_discord_role_ids.iter().map(String::as_str).collect();
    let (_, highest) = resolve_linked_roles(held_discord_role_ids, db_roles);
    let mut roles: Vec<UserRoleAssignmentView> = db_roles
        .iter()
        .map(|role| {
            let linked = role.discord_role_id.is_some();
            let is_held = role
                .discord_role_id
                .as_deref()
                .is_some_and(|id| held.contains(id));
            UserRoleAssignmentView {
                role_id: role.id.clone(),
                role_name: role.name.clone(),
                priority: role.priority,
                discord_role_id: role.discord_role_id.clone(),
                is_default: role.is_default,
                is_staff: role.is_staff,
                grants_staff: role.grants_staff,
                held: is_held,
                assignable: linked && !role.is_staff,
            }
        })
        .collect();
    roles.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| a.role_name.cmp(&b.role_name))
    });
    UserRolesView {
        discord_id: user.discord_id.clone(),
        highest_role: highest,
        roles,
    }
}

async fn refresh_cached_highest_role(
    db: &DatabaseConnection,
    user_id: i64,
    held_discord_role_ids: &[String],
    db_roles: &[role::Model],
) -> Result<(), AppError> {
    let (_, highest) = resolve_linked_roles(held_discord_role_ids, db_roles);
    let Some(user) = UserEntity::find_by_id(user_id).one(db).await? else {
        return Ok(());
    };
    if user.role == highest {
        return Ok(());
    }
    let mut active: UserActiveModel = user.into();
    active.role = Set(highest);
    active.update(db).await?;
    Ok(())
}

/// In-memory Discord stand-in for tests.
#[cfg(test)]
#[derive(Default)]
struct FakeDiscord {
    members: std::sync::Mutex<std::collections::HashMap<String, Vec<String>>>,
}

#[cfg(test)]
impl FakeDiscord {
    fn new() -> Self {
        Self::default()
    }
}

#[cfg(test)]
impl DiscordMemberApi for FakeDiscord {
    async fn list_role_ids(&self, discord_user_id: &str) -> Result<Vec<String>, AppError> {
        Ok(self
            .members
            .lock()
            .expect("fake discord mutex")
            .get(discord_user_id)
            .cloned()
            .unwrap_or_default())
    }

    async fn add_role(&self, discord_user_id: &str, discord_role_id: &str) -> Result<(), AppError> {
        let mut members = self.members.lock().expect("fake discord mutex");
        let roles = members.entry(discord_user_id.to_string()).or_default();
        if !roles.iter().any(|id| id == discord_role_id) {
            roles.push(discord_role_id.to_string());
        }
        Ok(())
    }

    async fn remove_role(
        &self,
        discord_user_id: &str,
        discord_role_id: &str,
    ) -> Result<(), AppError> {
        let mut members = self.members.lock().expect("fake discord mutex");
        if let Some(roles) = members.get_mut(discord_user_id) {
            roles.retain(|id| id != discord_role_id);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::admin::models::CreateRoleRequest;
    use crate::admin::service::AdminService;
    use backend_core::testkit::discord_stub::{DiscordStub, StubReply};
    use sea_orm::{ActiveModelTrait, Set};

    fn role(
        id: &str,
        name: &str,
        priority: i32,
        discord_role_id: Option<&str>,
        is_default: bool,
        is_staff: bool,
        grants_staff: bool,
    ) -> role::Model {
        role::Model {
            id: id.to_string(),
            name: name.to_string(),
            priority,
            discord_role_id: discord_role_id.map(str::to_string),
            is_default,
            is_staff,
            grants_staff,
        }
    }

    #[test]
    fn staff_is_derived_from_grants_staff_roles_only() {
        let roles = vec![
            role("s", "Staff", 30, Some("staff"), false, true, false),
            role("o", "Officer", 50, Some("officer"), false, false, true),
            role("m", "Member", 10, Some("member"), true, false, false),
        ];
        assert!(should_hold_staff_role(&["officer".into()], &roles));
        assert!(!should_hold_staff_role(&["staff".into()], &roles));
        assert!(!should_hold_staff_role(&["member".into()], &roles));
        assert_eq!(staff_discord_role_id(&roles), Some("staff"));
    }

    #[test]
    fn higher_priority_is_blocked_for_non_superadmin() {
        let roles = vec![
            role("a", "Admin", 80, Some("admin"), false, false, true),
            role("o", "Officer", 50, Some("officer"), false, false, true),
        ];
        let officer_names = vec!["Officer".to_string()];
        let admin = roles.iter().find(|role| role.name == "Admin").unwrap();
        let officer = roles.iter().find(|role| role.name == "Officer").unwrap();
        assert!(ensure_priority_allowed(false, &officer_names, &roles, officer).is_ok());
        assert!(ensure_priority_allowed(false, &officer_names, &roles, admin).is_err());
        assert!(ensure_priority_allowed(true, &officer_names, &roles, admin).is_ok());
    }

    async fn seed_db() -> DatabaseConnection {
        backend_migration::testkit::migrated_sqlite().await
    }

    async fn insert_user(db: &DatabaseConnection, discord_id: Option<&str>) -> i64 {
        backend_entities::users::ActiveModel {
            username: Set("member".into()),
            email: Set("member@example.com".into()),
            role: Set("User".into()),
            discord_id: Set(discord_id.map(str::to_string)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("user")
        .id
    }

    #[tokio::test]
    async fn an_editor_who_bypasses_priority_assigns_a_top_priority_role_with_no_roles_of_their_own()
     {
        let db = seed_db().await;
        let user_id = insert_user(&db, Some("discord-1")).await;
        let admin = AdminService::create_role(
            &db,
            1,
            &CreateRoleRequest {
                name: "HubAdmin".into(),
                priority: 100,
                discord_role_id: Some("333333333333333333".into()),
                is_default: false,
                is_staff: false,
                grants_staff: false,
            },
        )
        .await
        .expect("admin role");
        let role_id = admin
            .roles
            .iter()
            .find(|role| role.role_name == "HubAdmin")
            .unwrap()
            .role_id
            .clone();

        // The tenant owner: no roles that map to anything, so actor_max is 0.
        let no_roles: Vec<String> = Vec::new();
        let denied = add_user_role(
            &db,
            &FakeDiscord::new(),
            1,
            false,
            &no_roles,
            user_id as u64,
            &role_id,
        )
        .await
        .expect_err("an ordinary editor without roles cannot");
        assert!(matches!(denied, AppError::Forbidden(_)));

        let view = add_user_role(
            &db,
            &FakeDiscord::new(),
            1,
            true,
            &no_roles,
            user_id as u64,
            &role_id,
        )
        .await
        .expect("an owner bypasses the priority check");
        assert!(
            view.roles
                .iter()
                .any(|r| r.role_name == "HubAdmin" && r.held)
        );
    }

    #[tokio::test]
    async fn adding_a_grants_staff_role_also_assigns_staff() {
        let db = seed_db().await;
        let user_id = insert_user(&db, Some("discord-1")).await;
        AdminService::create_role(
            &db,
            1,
            &CreateRoleRequest {
                name: "Staff".into(),
                priority: 30,
                discord_role_id: Some("111111111111111111".into()),
                is_default: false,
                is_staff: true,
                grants_staff: false,
            },
        )
        .await
        .expect("staff");
        let officer = AdminService::create_role(
            &db,
            1,
            &CreateRoleRequest {
                name: "Officer".into(),
                priority: 50,
                discord_role_id: Some("222222222222222222".into()),
                is_default: false,
                is_staff: false,
                grants_staff: true,
            },
        )
        .await
        .expect("officer");
        let officer_id = officer
            .roles
            .iter()
            .find(|role| role.role_name == "Officer")
            .unwrap()
            .role_id
            .clone();

        let discord = FakeDiscord::new();
        let view = add_user_role(
            &db,
            &discord,
            1,
            true,
            &["Admin".into()],
            user_id as u64,
            &officer_id,
        )
        .await
        .expect("add officer");

        let held: Vec<&str> = view
            .roles
            .iter()
            .filter(|role| role.held)
            .map(|role| role.role_name.as_str())
            .collect();
        assert!(held.contains(&"Officer"));
        assert!(held.contains(&"Staff"));
        assert_eq!(view.highest_role, "Officer");
    }

    #[tokio::test]
    async fn removing_last_grants_staff_role_revokes_staff() {
        let db = seed_db().await;
        let user_id = insert_user(&db, Some("discord-1")).await;
        AdminService::create_role(
            &db,
            1,
            &CreateRoleRequest {
                name: "Staff".into(),
                priority: 30,
                discord_role_id: Some("111111111111111111".into()),
                is_default: false,
                is_staff: true,
                grants_staff: false,
            },
        )
        .await
        .expect("staff");
        let officer = AdminService::create_role(
            &db,
            1,
            &CreateRoleRequest {
                name: "Officer".into(),
                priority: 50,
                discord_role_id: Some("222222222222222222".into()),
                is_default: false,
                is_staff: false,
                grants_staff: true,
            },
        )
        .await
        .expect("officer");
        let officer_id = officer
            .roles
            .iter()
            .find(|role| role.role_name == "Officer")
            .unwrap()
            .role_id
            .clone();

        let discord = FakeDiscord::new();
        add_user_role(
            &db,
            &discord,
            1,
            true,
            &["Admin".into()],
            user_id as u64,
            &officer_id,
        )
        .await
        .expect("add officer");
        let view = remove_user_role(
            &db,
            &discord,
            1,
            true,
            &["Admin".into()],
            user_id as u64,
            &officer_id,
        )
        .await
        .expect("remove officer");

        assert!(view.roles.iter().all(|role| !role.held));
    }

    #[tokio::test]
    async fn cannot_assign_the_generic_staff_role_directly() {
        let db = seed_db().await;
        let user_id = insert_user(&db, Some("discord-1")).await;
        let staff = AdminService::create_role(
            &db,
            1,
            &CreateRoleRequest {
                name: "Staff".into(),
                priority: 30,
                discord_role_id: Some("111111111111111111".into()),
                is_default: false,
                is_staff: true,
                grants_staff: false,
            },
        )
        .await
        .expect("staff");
        let staff_id = staff
            .roles
            .iter()
            .find(|role| role.role_name == "Staff")
            .unwrap()
            .role_id
            .clone();
        let err = add_user_role(
            &db,
            &FakeDiscord::new(),
            1,
            true,
            &["Admin".into()],
            user_id as u64,
            &staff_id,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(msg) if msg.contains("staff")));
    }

    #[tokio::test]
    async fn cannot_assign_role_without_discord_id() {
        let db = seed_db().await;
        let user_id = insert_user(&db, None).await;
        let officer = AdminService::create_role(
            &db,
            1,
            &CreateRoleRequest {
                name: "Officer".into(),
                priority: 50,
                discord_role_id: Some("222222222222222222".into()),
                is_default: false,
                is_staff: false,
                grants_staff: false,
            },
        )
        .await
        .expect("officer");
        let officer_id = officer
            .roles
            .iter()
            .find(|role| role.role_name == "Officer")
            .unwrap()
            .role_id
            .clone();
        let err = add_user_role(
            &db,
            &FakeDiscord::new(),
            1,
            true,
            &["Admin".into()],
            user_id as u64,
            &officer_id,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(msg) if msg.contains("Discord id")));
    }

    fn live_cfg(base_url: &str) -> backend_core::config::Config {
        let mut cfg = backend_core::config::Config::for_tests();
        cfg.discord_api_base = base_url.to_owned();
        cfg.discord_bot_token = Some("bot-token".to_owned());
        cfg
    }

    #[tokio::test]
    async fn live_writer_treats_a_missing_member_as_a_validation_error_and_a_gone_role_as_revoked()
    {
        let stub = DiscordStub::start(|_| {
            StubReply::json(404, r#"{"message":"Unknown Member","code":10007}"#)
        })
        .await;
        let discord =
            LiveDiscord::for_guild(&live_cfg(&stub.base_url), "g-roles-1").expect("client");

        let listed = discord.list_role_ids("42").await;
        assert!(
            matches!(listed, Err(AppError::Validation(message)) if message.contains("not in the Discord guild"))
        );
        assert!(discord.remove_role("42", "r-1").await.is_ok());
        assert!(discord.add_role("42", "r-1").await.is_err());
    }

    #[test]
    fn live_writer_needs_a_bot_token_and_a_guild() {
        let mut cfg = backend_core::config::Config::for_tests();
        cfg.discord_bot_token = None;
        assert!(LiveDiscord::for_guild(&cfg, "g-roles-2").is_err());
        cfg.discord_bot_token = Some("bot-token".to_owned());
        assert!(LiveDiscord::for_guild(&cfg, "  ").is_err());
    }
}
