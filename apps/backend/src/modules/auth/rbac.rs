//! Authentication and Authorization.
//!
//! Defines [`UserContext`] and provides an Axum extractor that authorizes
//! requests using the Discord session cookie. Authorization decisions are
//! delegated to the [`Permissions`](super::permission_cache::Permissions) cache,
//! which maps role names to fine-grained [`Permission`](super::permissions::Permission)s
//! loaded from the `role_permissions` table.

use super::permission_cache::Permissions;
use super::permissions::Permission;
use super::service::DiscordUserProfile;
use crate::config::Config;
use crate::errors::AppError;
use crate::platform_admins::PlatformAdmins;
use axum::{extract::FromRequestParts, http::request::Parts};
use axum_extra::extract::cookie::{Key, PrivateCookieJar};
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use utoipa::ToSchema;

/// Request context holding authenticated user details retrieved from session.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UserContext {
    /// The unique Snowflake ID of the Discord user.
    pub id: String,
    /// The username of the user.
    pub username: String,
    /// The registered email address of the user.
    pub email: Option<String>,
    /// The avatar hash of the user.
    pub avatar: Option<String>,
    /// The list of Discord role names the user has.
    pub roles: Vec<String>,
    /// The highest role name of the user.
    pub highest_role: String,
    /// The internal database primary key of the user (see `users` table).
    pub user_id: i64,
    /// Discord id of this user when they hold a platform role, used to bypass
    /// every permission check. Populated from [`PlatformAdmins`] at extraction
    /// time; never serialized into the session cookie.
    #[serde(skip)]
    pub super_admin_id: Option<String>,
    /// True only when the authenticated Discord user owns the current guild tenant.
    /// Resolved from the control database for each request, never trusted from a cookie.
    #[serde(skip)]
    pub is_tenant_owner: bool,
}

impl UserContext {
    /// `true` when this user holds a platform-level role (matched by Discord id,
    /// not by a tenant role name).
    #[must_use]
    pub fn is_superadmin(&self) -> bool {
        self.super_admin_id
            .as_deref()
            .is_some_and(|id| id == self.id)
    }

    /// Whether this user is exempt from the "not above your own role" priority checks.
    ///
    /// The same set that bypasses permission checks in [`Self::require`]: platform admins and
    /// the tenant owner. Without it an owner whose Discord roles map to nothing has priority 0
    /// and passes `roles.manage` only to be refused every assignment.
    #[must_use]
    pub fn bypasses_priority(&self) -> bool {
        self.is_superadmin() || self.is_tenant_owner
    }

    /// Returns `true` if the user holds `perm` through any of their roles.
    ///
    /// Async because the shared permission cache sits behind an `RwLock`.
    pub async fn has_permission(&self, perms: &Permissions, perm: Permission) -> bool {
        perms
            .check(self.bypasses_priority(), &self.roles, perm)
            .await
    }

    /// Like [`Self::has_permission`] but returns `AppError::Forbidden` when denied.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Forbidden` when the user lacks `perm`.
    pub async fn require(&self, perms: &Permissions, perm: Permission) -> Result<(), AppError> {
        perms
            .require(self.bypasses_priority(), &self.roles, perm)
            .await
    }
}

impl<S> FromRequestParts<S> for UserContext
where
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        // ── Path 1: session cookie (browser / frontend) ──────────────────────
        if let Some(ctx) = try_from_session_cookie(parts).await {
            return Ok(ctx);
        }

        // ── Path 2: bot header auth (Discord bot) ────────────────────────────
        if let Some(ctx) = try_from_bot_headers(parts).await? {
            return Ok(ctx);
        }

        Err(AppError::Unauthorized("No active session".to_string()))
    }
}

/// Attempts to build a `UserContext` from the `session_user` cookie.
///
/// Returns `None` if the cookie is absent (not an error — bot requests have no cookie), if the
/// server has no `Key` configured, or if the cookie fails to decrypt/authenticate (tampered,
/// forged, or signed with a different key) — we treat all of these as "no session" rather than
/// hard-failing so bot auth can still succeed.
async fn try_from_session_cookie(parts: &mut Parts) -> Option<UserContext> {
    let key = parts.extensions.get::<Key>()?;
    let jar = PrivateCookieJar::from_headers(&parts.headers, key.clone());
    let session_cookie = jar.get("session_user")?;

    let profile: DiscordUserProfile = serde_json::from_str(session_cookie.value()).ok()?;

    let super_admin_id = parts
        .extensions
        .get::<PlatformAdmins>()
        .and_then(|admins| admins.contains(&profile.id).then(|| profile.id.clone()));

    // Prefer the `users` row for this Discord snowflake over the cookie's cached `user_id`.
    // Login used to key that cache by email, so a colliding address could pin the session to
    // someone else's splits and bank while `users.discord_id` in the database stayed correct.
    let user_id = if let Some(db) = parts.extensions.get::<DatabaseConnection>() {
        crate::modules::users::identity::user_id_for_discord_id(db, &profile.id)
            .await
            .ok()
            .flatten()
            .unwrap_or(profile.user_id)
    } else {
        profile.user_id
    };

    let is_tenant_owner = tenant_owner_for_request(parts, &profile.id).await;
    let mut ctx = UserContext {
        id: profile.id,
        username: profile.username,
        email: profile.email,
        avatar: profile.avatar,
        roles: profile.roles,
        highest_role: profile.highest_role,
        user_id,
        super_admin_id,
        is_tenant_owner,
    };
    apply_live_guild_roles(parts, &mut ctx).await;
    Some(ctx)
}

async fn tenant_owner_for_request(parts: &Parts, discord_id: &str) -> bool {
    let Some(tenant) = parts.extensions.get::<crate::tenant::CurrentTenantId>() else {
        return false;
    };
    let Some(control) = parts.extensions.get::<crate::tenant::ControlDb>() else {
        return false;
    };
    crate::modules::platform::service::PlatformService::is_tenant_owner(
        &control.0, &tenant.0, discord_id,
    )
    .await
    .unwrap_or(false)
}

/// Re-reads Discord guild roles for the request tenant when a bot token is
/// configured. A confirmed removal replaces the cookie roles; an outage leaves
/// them in place. No-ops when the tenant or token is missing, so tests and
/// deployments without a bot keep the session cookie.
async fn apply_live_guild_roles(parts: &Parts, ctx: &mut UserContext) {
    if ctx.is_superadmin() {
        return;
    }
    let Some(cfg) = parts.extensions.get::<Config>() else {
        return;
    };
    let Some(tenant) = parts.extensions.get::<crate::tenant::CurrentTenantId>() else {
        return;
    };
    if tenant.0.trim().is_empty() {
        return;
    }
    let Some(db) = parts.extensions.get::<DatabaseConnection>() else {
        return;
    };
    let lookup = super::service::AuthService::new()
        .fetch_guild_member_role_ids(&ctx.id, "", &tenant.0, cfg.discord_bot_token.as_deref())
        .await;
    if matches!(lookup, super::service::GuildMemberLookup::Unavailable) {
        return;
    }
    let Ok(db_roles) = super::entities::role::Entity::find().all(db).await else {
        return;
    };
    let (roles, highest) = super::service::roles_after_member_lookup(
        &lookup,
        &ctx.roles,
        &ctx.highest_role,
        &db_roles,
        false,
    );
    if ctx.user_id > 0 && ctx.highest_role != highest {
        // Same row the bot fallback and alliance guild checks read. Ignore a
        // write failure: this request still uses the live roles.
        if let Err(error) = persist_highest_role(db, ctx.user_id, &highest).await {
            tracing::warn!(error = %error, "could not persist refreshed guild role");
        }
    }
    ctx.roles = roles;
    ctx.highest_role = highest;
}

async fn persist_highest_role(
    db: &DatabaseConnection,
    user_id: i64,
    highest_role: &str,
) -> Result<(), sea_orm::DbErr> {
    use crate::modules::users::entities::{ActiveModel as UserActive, Entity as UserEntity};
    use sea_orm::{ActiveModelTrait, EntityTrait};
    let Some(existing) = UserEntity::find_by_id(user_id).one(db).await? else {
        return Ok(());
    };
    if existing.role == highest_role {
        return Ok(());
    }
    let mut active: UserActive = existing.into();
    active.role = sea_orm::Set(highest_role.to_string());
    active.update(db).await?;
    Ok(())
}

/// Attempts to build a `UserContext` from the `X-Bot-Secret` + `X-Discord-Id` headers.
///
/// Three outcomes:
/// - `Ok(None)` — `X-Bot-Secret` absent → not a bot request, fall through to 401.
/// - `Err(Unauthorized)` — `X-Bot-Secret` present but wrong → reject immediately.
/// - `Ok(Some(ctx))` — secret valid:
///   - `X-Discord-Id` present → resolve to local user (per-user context).
///   - `X-Discord-Id` absent  → "bot system" context used for background operations
///     like the poller, which have no associated user.
async fn try_from_bot_headers(parts: &mut Parts) -> Result<Option<UserContext>, AppError> {
    // Read the bot secret header. Absence means this isn't a bot request at all.
    let provided_secret = match parts
        .headers
        .get(crate::tenant::BOT_SECRET_HEADER)
        .and_then(|v| v.to_str().ok())
    {
        Some(s) => s.to_string(),
        None => return Ok(None),
    };

    // Validate the secret against the configured value.
    let cfg = parts
        .extensions
        .get::<Config>()
        .ok_or_else(|| AppError::Internal("Config extension missing".to_string()))?;

    let expected_secret = cfg.bot_api_secret.as_deref().ok_or_else(|| {
        AppError::Unauthorized(
            "Bot authentication is not configured on this server (BOT_API_SECRET not set)"
                .to_string(),
        )
    })?;

    // Constant-time comparison: an early-exit `!=` would let an attacker time the mismatch
    // position and brute-force the secret byte-by-byte.
    let secret_matches: bool = provided_secret
        .as_bytes()
        .ct_eq(expected_secret.as_bytes())
        .into();
    if !secret_matches {
        return Err(AppError::Unauthorized(
            "Invalid bot secret (X-Bot-Secret mismatch)".to_string(),
        ));
    }

    // If X-Discord-Id is absent, this is a background / system call (e.g. the poller).
    // Return a trusted "bot system" context so background endpoints can run without a user.
    let discord_id = parts
        .headers
        .get("X-Discord-Id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let Some(discord_id) = discord_id else {
        tracing::debug!("bot system request (no X-Discord-Id) authenticated");
        return Ok(Some(UserContext {
            id: "bot_system".to_string(),
            username: "Bot System".to_string(),
            email: None,
            avatar: None,
            roles: vec!["Admin".to_string()],
            highest_role: "Admin".to_string(),
            user_id: 0,
            // Background bot requests are trusted through BOT_API_SECRET and must not
            // depend on the role-permission cache being seeded on this deployment.
            super_admin_id: Some("bot_system".to_string()),
            is_tenant_owner: false,
        }));
    };

    // X-Discord-Id is present → resolve to the real local user.
    let db = parts
        .extensions
        .get::<DatabaseConnection>()
        .ok_or_else(|| AppError::Internal("Database extension missing".to_string()))?;

    use crate::modules::users::entities::Entity as UserEntity;
    use crate::modules::users::identity::{self, MemberSeed, Presence, Via};

    // `X-Discord-Role-Ids` is only sent for an interaction by a member of this server (even one
    // with no roles), so its presence proves Discord membership.
    let claims_member = parts.headers.contains_key("X-Discord-Role-Ids");
    let role_ids_header = parts
        .headers
        .get("X-Discord-Role-Ids")
        .map(|value| {
            value
                .to_str()
                .map_err(|_| AppError::Unauthorized("Invalid Discord role ID header".to_string()))
        })
        .transpose()?;

    let existing = identity::find_by_discord_id(db, &discord_id).await?;
    let user = match (existing, claims_member) {
        (Some(user), _) if user.active => user,
        (Some(_), false) => {
            return Err(AppError::Forbidden("member_inactive".to_string()));
        }
        (None, false) => {
            return Err(AppError::Unauthorized("member_not_provisioned".to_string()));
        }
        // The interaction proves presence: create the row, or reactivate it. The snapshot and the
        // web membership row are written here only, not on every request.
        (_, true) => {
            let username = decode_username_header(parts);
            let role_ids = role_ids_header
                .map(|raw| {
                    raw.split(',')
                        .map(str::trim)
                        .filter(|id| !id.is_empty())
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let ensured = identity::ensure_member(
                db,
                MemberSeed {
                    discord_id: &discord_id,
                    username: username.as_deref(),
                    verified_email: None,
                    role_ids: Some(&role_ids),
                    presence: Presence::Present,
                    via: Via::Bot,
                    event_at: chrono::Utc::now(),
                },
            )
            .await?;
            record_bot_membership(parts, &discord_id).await?;
            UserEntity::find_by_id(ensured.user_id)
                .one(db)
                .await
                .map_err(|e| AppError::Internal(format!("DB error reloading member: {e}")))?
                .ok_or_else(|| AppError::Internal("member row vanished".to_string()))?
        }
    };

    let (mut roles, mut highest_role) =
        super::service::resolve_bot_role_ids(db, role_ids_header, &user.role).await?;

    let super_admin_id = parts
        .extensions
        .get::<PlatformAdmins>()
        .and_then(|admins| admins.contains(&discord_id).then(|| discord_id.clone()));
    let is_superadmin = super_admin_id.as_deref() == Some(discord_id.as_str());

    // Resolve permissions from the role cache
    let perms = parts
        .extensions
        .get::<super::permission_cache::Permissions>();
    let _permissions = if let Some(perms) = perms {
        perms.granted_permissions(is_superadmin, &roles).await
    } else {
        vec![]
    };

    // Platform-level access takes precedence over tenant role priority.
    if is_superadmin {
        roles.insert(0, "SuperAdmin".to_string());
        highest_role = "SuperAdmin".to_string();
    }

    tracing::debug!(
        discord_id = %discord_id,
        user_id = user.id,
        role = %user.role,
        "bot request authenticated"
    );

    let is_tenant_owner = tenant_owner_for_request(parts, &discord_id).await;
    Ok(Some(UserContext {
        id: discord_id,
        username: user.username,
        email: Some(user.email),
        avatar: None,
        roles,
        highest_role,
        user_id: user.id,
        super_admin_id,
        is_tenant_owner,
    }))
}

/// Reads the actor's Discord username from `X-Discord-Username` (percent-encoded UTF-8, at most
/// 100 characters). Absent or undecodable gives `None`; the stored name is kept then.
fn decode_username_header(parts: &Parts) -> Option<String> {
    let raw = parts
        .headers
        .get("X-Discord-Username")
        .and_then(|value| value.to_str().ok())?;
    let decoded = urlencoding::decode(raw).ok()?;
    let trimmed = decoded.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(100).collect())
}

/// Records that this Discord user belongs to the request's tenant (web access follows presence).
/// A no-op without a control database or tenant, as in unit tests.
async fn record_bot_membership(parts: &Parts, discord_id: &str) -> Result<(), AppError> {
    let (Some(control), Some(tenant)) = (
        parts.extensions.get::<crate::tenant::ControlDb>(),
        parts.extensions.get::<crate::tenant::CurrentTenantId>(),
    ) else {
        return Ok(());
    };
    if tenant.0.trim().is_empty() {
        return Ok(());
    }
    crate::modules::platform::service::PlatformService::record_membership(
        &control.0, discord_id, &tenant.0,
    )
    .await
}

/// Marker extracted when the request carries a valid `X-Bot-Secret`.
///
/// Unlike [`UserContext`], this does **not** require `X-Discord-Id` and does not 401 when the
/// Discord user is unlinked. Used by bot-only endpoints such as message XP.
pub struct BotSecret;

impl<S> FromRequestParts<S> for BotSecret
where
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let provided_secret = parts
            .headers
            .get(crate::tenant::BOT_SECRET_HEADER)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| AppError::Unauthorized("Missing X-Bot-Secret".to_string()))?;

        let cfg = parts
            .extensions
            .get::<Config>()
            .ok_or_else(|| AppError::Internal("Config extension missing".to_string()))?;

        let expected_secret = cfg.bot_api_secret.as_deref().ok_or_else(|| {
            AppError::Unauthorized(
                "Bot authentication is not configured on this server (BOT_API_SECRET not set)"
                    .to_string(),
            )
        })?;

        // Constant-time comparison: an early-exit `!=` would let an attacker time the mismatch
        // position and brute-force the secret byte-by-byte.
        let secret_matches: bool = provided_secret
            .as_bytes()
            .ct_eq(expected_secret.as_bytes())
            .into();
        if !secret_matches {
            return Err(AppError::Unauthorized(
                "Invalid bot secret (X-Bot-Secret mismatch)".to_string(),
            ));
        }

        Ok(Self)
    }
}

/// Bot-authenticated Discord actor identified by `X-Discord-Id`.
///
/// Unlike [`UserContext`], a missing local `users` row is not an error: application tickets are
/// opened by people who have not logged into the web app yet. `user_id` / `roles` are populated
/// only when that Discord id is already linked.
#[derive(Debug, Clone)]
pub struct BotDiscordUser {
    /// Discord snowflake from `X-Discord-Id`.
    pub discord_id: String,
    /// Local `users.id` when this Discord member has logged in before.
    pub user_id: Option<i64>,
    /// Local username when a `users` row exists.
    pub username: Option<String>,
    /// Gestionale role names used for permission checks when the member is linked.
    pub roles: Vec<String>,
    /// Whether this Discord id is the configured super-admin.
    pub is_superadmin: bool,
}

impl<S> FromRequestParts<S> for BotDiscordUser
where
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let _secret = BotSecret::from_request_parts(parts, state).await?;
        let discord_id = parts
            .headers
            .get("X-Discord-Id")
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::Unauthorized("Missing X-Discord-Id".to_string()))?
            .to_string();

        let is_superadmin = parts
            .extensions
            .get::<PlatformAdmins>()
            .is_some_and(|admins| admins.contains(&discord_id));

        let db = parts
            .extensions
            .get::<DatabaseConnection>()
            .ok_or_else(|| AppError::Internal("Database extension missing".to_string()))?;

        use crate::modules::users::entities::{Column as UserCol, Entity as UserEntity};

        let user = UserEntity::find()
            .filter(UserCol::DiscordId.eq(&discord_id))
            .one(db)
            .await
            .map_err(|error| {
                AppError::Internal(format!("DB error resolving Discord ID: {error}"))
            })?;

        let (user_id, username, roles) = if let Some(user) = user {
            let role_ids_header = parts
                .headers
                .get("X-Discord-Role-Ids")
                .map(|value| {
                    value.to_str().map_err(|_| {
                        AppError::Unauthorized("Invalid Discord role ID header".to_string())
                    })
                })
                .transpose()?;
            let (resolved, _) =
                super::service::resolve_bot_role_ids(db, role_ids_header, &user.role).await?;
            let roles = if is_superadmin {
                let mut roles = vec!["SuperAdmin".to_string()];
                roles.extend(resolved.into_iter().filter(|role| role != "SuperAdmin"));
                roles
            } else {
                resolved
            };
            (Some(user.id), Some(user.username), roles)
        } else {
            (None, None, Vec::new())
        };

        Ok(Self {
            discord_id,
            user_id,
            username,
            roles,
            is_superadmin,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use axum::response::IntoResponse;

    #[tokio::test]
    async fn tenant_owner_bypasses_grantable_permissions_without_becoming_platform_admin() {
        let permissions = Permissions::new_empty();
        let owner = UserContext {
            id: "guild-owner".to_string(),
            username: "Guild owner".to_string(),
            email: None,
            avatar: None,
            roles: vec![],
            highest_role: "Member".to_string(),
            user_id: 1,
            super_admin_id: None,
            is_tenant_owner: true,
        };
        assert!(!owner.is_superadmin());
        assert!(owner.super_admin_id.is_none());
        assert!(
            owner
                .has_permission(&permissions, Permission::AllianceLeave)
                .await
        );
        assert!(
            !permissions
                .check(false, &owner.roles, Permission::AllianceLeave)
                .await
        );
        let mut member = owner.clone();
        member.is_tenant_owner = false;
        assert!(
            !member
                .has_permission(&permissions, Permission::AllianceLeave)
                .await
        );
    }

    #[tokio::test]
    async fn tenant_owner_without_roles_passes_roles_manage_and_bypasses_priority() {
        // auth-6/auth-19: an alliance owner holds no Discord role that maps to anything.
        let permissions = Permissions::new_empty();
        let owner = UserContext {
            id: "alliance-owner".to_string(),
            username: "Alliance owner".to_string(),
            email: None,
            avatar: None,
            roles: vec![],
            highest_role: "User".to_string(),
            user_id: 1,
            super_admin_id: None,
            is_tenant_owner: true,
        };
        assert!(
            owner
                .require(&permissions, Permission::RolesManage)
                .await
                .is_ok()
        );
        assert!(owner.bypasses_priority());
        assert!(!owner.is_superadmin());

        let mut member = owner.clone();
        member.is_tenant_owner = false;
        assert!(
            member
                .require(&permissions, Permission::RolesManage)
                .await
                .is_err()
        );
        assert!(!member.bypasses_priority());

        let mut admin = member.clone();
        admin.super_admin_id = Some(admin.id.clone());
        assert!(admin.bypasses_priority());
    }

    /// Encrypts `profile_json` into a `session_user` cookie the way `discord_callback`/`get_me`
    /// do, and returns just the `name=value` pair as a browser would send it back on `Cookie`.
    fn encrypt_session_cookie(key: &Key, profile_json: String) -> String {
        let response = PrivateCookieJar::new(key.clone())
            .add(("session_user", profile_json))
            .into_response();
        let set_cookie = response
            .headers()
            .get(axum::http::header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        set_cookie.split(';').next().unwrap().to_string()
    }

    #[tokio::test]
    async fn test_user_context_extraction_success() {
        let profile_json = r#"{"id":"386488773351047168","username":"admin_user","email":"admin@example.com","avatar":null,"roles":["Admin"],"highest_role":"Admin","user_id":0}"#;
        let key = Key::generate();
        let cookie_str = encrypt_session_cookie(&key, profile_json.to_string());

        let req = Request::builder()
            .header("Cookie", cookie_str)
            .body(())
            .unwrap();
        let (mut parts, ()) = req.into_parts();
        parts.extensions.insert(key);

        let context = UserContext::from_request_parts(&mut parts, &())
            .await
            .expect("Failed to extract UserContext");

        assert_eq!(context.id, "386488773351047168");
        assert_eq!(context.highest_role, "Admin");
        // No PlatformAdmins extension → not superadmin.
        assert!(!context.is_superadmin());
    }

    #[tokio::test]
    async fn session_cookie_is_superadmin_when_listed_in_platform_admins() {
        let profile_json = r#"{"id":"386488773351047168","username":"admin_user","email":"admin@example.com","avatar":null,"roles":["Admin"],"highest_role":"Admin","user_id":0}"#;
        let key = Key::generate();
        let cookie_str = encrypt_session_cookie(&key, profile_json.to_string());
        let admins = crate::platform_admins::PlatformAdmins::new_empty();
        admins.insert_for_test("386488773351047168");

        let req = Request::builder()
            .header("Cookie", cookie_str)
            .body(())
            .unwrap();
        let (mut parts, ()) = req.into_parts();
        parts.extensions.insert(key);
        parts.extensions.insert(admins);

        let context = UserContext::from_request_parts(&mut parts, &())
            .await
            .expect("extract");
        assert!(context.is_superadmin());
    }

    #[tokio::test]
    async fn session_cookie_user_id_follows_discord_id_not_stale_cache() {
        use crate::migration::MigratorTrait;
        use crate::modules::users::entities as user_entities;
        use sea_orm::{ActiveModelTrait, ActiveValue::Set, Database};

        let db = Database::connect("sqlite::memory:").await.expect("connect");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("migrate");
        let alice = user_entities::ActiveModel {
            username: Set("alice".into()),
            email: Set("alice@example.com".into()),
            role: Set("User".into()),
            discord_id: Set(Some("111".into())),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("alice")
        .id;
        let bob = user_entities::ActiveModel {
            username: Set("bob".into()),
            email: Set("bob@example.com".into()),
            role: Set("User".into()),
            discord_id: Set(Some("222".into())),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("bob")
        .id;
        assert_ne!(alice, bob);

        let profile_json = format!(
            r#"{{"id":"222","username":"bob","email":"bob@example.com","avatar":null,"roles":["User"],"highest_role":"User","user_id":{alice}}}"#
        );
        let key = Key::generate();
        let cookie_str = encrypt_session_cookie(&key, profile_json);

        let req = Request::builder()
            .header("Cookie", cookie_str)
            .body(())
            .unwrap();
        let (mut parts, ()) = req.into_parts();
        parts.extensions.insert(key);
        parts.extensions.insert(db);

        let context = UserContext::from_request_parts(&mut parts, &())
            .await
            .expect("extract");
        assert_eq!(context.id, "222");
        assert_eq!(context.user_id, bob);
    }

    #[tokio::test]
    async fn bot_user_context_resolves_and_validates_role_headers() {
        use crate::migration::MigratorTrait;
        use crate::modules::auth::entities::role;
        use crate::modules::users::entities as user_entities;
        use sea_orm::{ActiveModelTrait, ActiveValue::Set, Database};

        async fn extract_bot_context(
            db: &DatabaseConnection,
            role_ids: Option<axum::http::HeaderValue>,
            is_platform_admin: bool,
        ) -> Result<UserContext, AppError> {
            let mut request = Request::builder()
                .header("X-Bot-Secret", "test-bot-secret")
                .header("X-Discord-Id", "111");
            if let Some(role_ids) = role_ids {
                request = request.header("X-Discord-Role-Ids", role_ids);
            }
            let (mut parts, ()) = request.body(()).unwrap().into_parts();
            parts.extensions.insert(Config {
                backend_port: 3000,
                database_url: "sqlite::memory:".into(),
                control_database_url: None,
                discord_client_id: "test-client".into(),
                discord_client_secret: "test-secret".into(),
                discord_redirect_uri: "http://localhost/callback".into(),
                bot_api_secret: Some("test-bot-secret".into()),
                discord_bot_token: None,
                super_admin_discord_id: "111".into(),
                session_secret: "x".repeat(64),
                frontend_url: "http://localhost".into(),
                albion_api_region: "europe".into(),
                albion_guild_id: "test-guild".into(),
                albion_allied_guild_ids: String::new(),
                albion_allied_guild_names: String::new(),
                mistral_api_key: String::new(),
                albionbb_base_url: "http://localhost".into(),
                albionbb_request_timeout_secs: 60,
                albiondata_request_timeout_secs: 30,
                discord_api_base: "http://127.0.0.1:1/api/v10".to_owned(),
                discord_api_timeout_secs: 10,
            });
            parts.extensions.insert(db.clone());
            let admins = PlatformAdmins::new_empty();
            if is_platform_admin {
                admins.insert_for_test("111");
            }
            parts.extensions.insert(admins);
            UserContext::from_request_parts(&mut parts, &()).await
        }

        let db = Database::connect("sqlite::memory:").await.expect("connect");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("migrate");
        user_entities::ActiveModel {
            username: Set("bot-user".into()),
            email: Set("bot-user@example.com".into()),
            role: Set("Legacy".into()),
            discord_id: Set(Some("111".into())),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("insert user");
        role::ActiveModel {
            id: Set("manager-role".into()),
            name: Set("Manager".into()),
            priority: Set(20),
            discord_role_id: Set(Some("100000000000000001".into())),
            is_default: Set(false),
            is_staff: Set(false),
            grants_staff: Set(false),
        }
        .insert(&db)
        .await
        .expect("insert manager role");
        role::ActiveModel {
            id: Set("moderator-role".into()),
            name: Set("Event Moderator".into()),
            priority: Set(10),
            discord_role_id: Set(Some("200000000000000002".into())),
            is_default: Set(false),
            is_staff: Set(false),
            grants_staff: Set(false),
        }
        .insert(&db)
        .await
        .expect("insert moderator role");

        let mapped = extract_bot_context(
            &db,
            Some(axum::http::HeaderValue::from_static(
                "100000000000000001,200000000000000002",
            )),
            false,
        )
        .await
        .expect("bot auth");
        assert_eq!(mapped.roles, vec!["Manager", "Event Moderator"]);
        assert_eq!(mapped.highest_role, "Manager");

        let platform_admin = extract_bot_context(
            &db,
            Some(axum::http::HeaderValue::from_static(
                "100000000000000001,200000000000000002",
            )),
            true,
        )
        .await
        .expect("bot auth");
        assert_eq!(
            platform_admin.roles,
            vec!["SuperAdmin", "Manager", "Event Moderator"]
        );
        assert_eq!(platform_admin.highest_role, "SuperAdmin");

        let legacy = extract_bot_context(&db, None, false)
            .await
            .expect("bot auth");
        assert_eq!(legacy.roles, vec!["Legacy"]);
        assert_eq!(legacy.highest_role, "Legacy");

        let malformed_header =
            axum::http::HeaderValue::from_bytes(&[0xff]).expect("valid opaque header value");
        let malformed = extract_bot_context(&db, Some(malformed_header), false).await;
        assert!(matches!(
            malformed,
            Err(AppError::Unauthorized(message))
                if message == "Invalid Discord role ID header"
        ));
    }

    #[tokio::test]
    async fn test_user_context_extraction_missing_cookie() {
        let req = Request::builder().body(()).unwrap();
        let (mut parts, ()) = req.into_parts();
        parts.extensions.insert(Key::generate());
        let result = UserContext::from_request_parts(&mut parts, &()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_user_context_extraction_tampered_cookie_rejected() {
        // A plaintext/forged cookie (as the old unsigned scheme would have accepted) must be
        // rejected now that the cookie is encrypted — decryption fails and we fall through to
        // "no session" rather than trusting attacker-controlled JSON.
        let profile_json = r#"{"id":"386488773351047168","username":"admin_user","email":"admin@example.com","avatar":null,"roles":["Admin"],"highest_role":"Admin","user_id":0}"#;
        let cookie_str = format!("session_user={}", urlencoding::encode(profile_json));

        let req = Request::builder()
            .header("Cookie", cookie_str)
            .body(())
            .unwrap();
        let (mut parts, ()) = req.into_parts();
        parts.extensions.insert(Key::generate());

        let result = UserContext::from_request_parts(&mut parts, &()).await;
        assert!(result.is_err());
    }

    /// Parts for a bot request, with the config and a migrated tenant database attached.
    async fn bot_parts(
        db: &sea_orm::DatabaseConnection,
        discord_id: &str,
        claims_member: bool,
        username: Option<&str>,
    ) -> Parts {
        let mut config = crate::config::Config::for_tests();
        config.bot_api_secret = Some("bot-secret".to_string());
        let mut builder = axum::http::Request::builder()
            .header(crate::tenant::BOT_SECRET_HEADER, "bot-secret")
            .header("X-Discord-Id", discord_id);
        if claims_member {
            builder = builder.header("X-Discord-Role-Ids", "");
        }
        if let Some(name) = username {
            builder = builder.header("X-Discord-Username", name);
        }
        let (mut parts, _) = builder.body(()).expect("request").into_parts();
        parts.extensions.insert(config);
        parts.extensions.insert(db.clone());
        parts
    }

    async fn tenant_db() -> sea_orm::DatabaseConnection {
        use sea_orm::Database;
        use sea_orm_migration::MigratorTrait;
        let db = Database::connect("sqlite::memory:").await.expect("sqlite");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("migrate");
        db
    }

    #[tokio::test]
    async fn bot_interaction_provisions_an_unseen_member_with_a_decoded_username() {
        let db = tenant_db().await;
        let mut parts = bot_parts(&db, "4242", true, Some("Mon%20Nom")).await;
        let ctx = try_from_bot_headers(&mut parts)
            .await
            .expect("provisioned")
            .expect("bot request");
        assert_eq!(ctx.id, "4242");
        assert_eq!(ctx.username, "Mon Nom");
        let stored = crate::modules::users::identity::find_by_discord_id(&db, "4242")
            .await
            .expect("lookup")
            .expect("row created");
        assert!(stored.active);
        assert_eq!(stored.provisioned_via, "bot");
        assert_eq!(stored.id, ctx.user_id);
    }

    #[tokio::test]
    async fn unseen_member_without_presence_proof_is_not_provisioned() {
        let db = tenant_db().await;
        let mut parts = bot_parts(&db, "5151", false, None).await;
        let err = try_from_bot_headers(&mut parts).await.expect_err("refused");
        assert!(matches!(err, AppError::Unauthorized(ref m) if m == "member_not_provisioned"));
        assert!(
            crate::modules::users::identity::find_by_discord_id(&db, "5151")
                .await
                .expect("lookup")
                .is_none()
        );
    }

    #[tokio::test]
    async fn inactive_member_is_refused_without_presence_proof_and_reactivated_with_it() {
        use sea_orm::{ActiveModelTrait, ActiveValue::Set};
        let db = tenant_db().await;
        let seeded = crate::modules::users::entities::ActiveModel {
            username: Set("left".to_string()),
            email: Set("6161@discord.invalid".to_string()),
            role: Set("User".to_string()),
            discord_id: Set(Some("6161".to_string())),
            active: Set(false),
            left_reason: Set(Some("left".to_string())),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("seed inactive");

        let mut refused = bot_parts(&db, "6161", false, None).await;
        let err = try_from_bot_headers(&mut refused)
            .await
            .expect_err("inactive refused");
        assert!(matches!(err, AppError::Forbidden(ref m) if m == "member_inactive"));

        let mut present = bot_parts(&db, "6161", true, None).await;
        let ctx = try_from_bot_headers(&mut present)
            .await
            .expect("reactivated")
            .expect("bot request");
        assert_eq!(ctx.user_id, seeded.id);
        let stored = crate::modules::users::identity::find_by_discord_id(&db, "6161")
            .await
            .expect("lookup")
            .expect("row");
        assert!(stored.active);
        assert_eq!(stored.left_reason, None);
    }

    #[test]
    fn username_header_is_percent_decoded_trimmed_and_capped() {
        let long = "a".repeat(150);
        let (parts, _) = axum::http::Request::builder()
            .header("X-Discord-Username", format!("%20 {long} "))
            .body(())
            .expect("request")
            .into_parts();
        let name = decode_username_header(&parts).expect("name");
        assert_eq!(name.chars().count(), 100);
        assert!(name.starts_with('a'));
        let (none, _) = axum::http::Request::builder()
            .body(())
            .expect("request")
            .into_parts();
        assert_eq!(decode_username_header(&none), None);
    }
}
