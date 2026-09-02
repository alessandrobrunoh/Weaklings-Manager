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
    /// The configured SuperAdmin Discord id (from env), used to bypass every
    /// permission check. Populated from the `Config` extension at extraction
    /// time; never serialized into the session cookie.
    #[serde(skip)]
    pub super_admin_id: Option<String>,
}

impl UserContext {
    /// `true` when this user is the configured super-admin (matched by Discord id,
    /// not by role name — so renaming the role on Discord can't revoke the override).
    #[must_use]
    pub fn is_superadmin(&self) -> bool {
        self.super_admin_id
            .as_deref()
            .is_some_and(|id| id == self.id)
    }

    /// Returns `true` if the user holds `perm` through any of their roles.
    ///
    /// Async because the shared permission cache sits behind an `RwLock`.
    pub async fn has_permission(&self, perms: &Permissions, perm: Permission) -> bool {
        perms.check(self.is_superadmin(), &self.roles, perm).await
    }

    /// Like [`Self::has_permission`] but returns `AppError::Forbidden` when denied.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Forbidden` when the user lacks `perm`.
    pub async fn require(&self, perms: &Permissions, perm: Permission) -> Result<(), AppError> {
        perms.require(self.is_superadmin(), &self.roles, perm).await
    }
}

impl<S> FromRequestParts<S> for UserContext
where
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        // ── Path 1: session cookie (browser / frontend) ──────────────────────
        if let Some(ctx) = try_from_session_cookie(parts) {
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
fn try_from_session_cookie(parts: &mut Parts) -> Option<UserContext> {
    let key = parts.extensions.get::<Key>()?;
    let jar = PrivateCookieJar::from_headers(&parts.headers, key.clone());
    let session_cookie = jar.get("session_user")?;

    let profile: DiscordUserProfile = serde_json::from_str(session_cookie.value()).ok()?;

    let super_admin_id = parts
        .extensions
        .get::<Config>()
        .map(|c| c.super_admin_discord_id.clone());

    Some(UserContext {
        id: profile.id,
        username: profile.username,
        email: profile.email,
        avatar: profile.avatar,
        roles: profile.roles,
        highest_role: profile.highest_role,
        user_id: profile.user_id,
        super_admin_id,
    })
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
        .get("X-Bot-Secret")
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

    let super_admin_id = Some(cfg.super_admin_discord_id.clone());

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
        }));
    };

    // X-Discord-Id is present → resolve to the real local user.
    let db = parts
        .extensions
        .get::<DatabaseConnection>()
        .ok_or_else(|| AppError::Internal("Database extension missing".to_string()))?;

    use crate::modules::users::entities::{Column as UserCol, Entity as UserEntity};

    let user = UserEntity::find()
        .filter(UserCol::DiscordId.eq(&discord_id))
        .one(db)
        .await
        .map_err(|e| AppError::Internal(format!("DB error resolving Discord ID: {e}")))?
        .ok_or_else(|| {
            AppError::Unauthorized(format!(
                "Discord user {discord_id} has no linked account in this system. \
                 Please log in via the web app first."
            ))
        })?;

    let is_superadmin = super_admin_id.as_deref() == Some(&discord_id);

    // Resolve permissions from the role cache
    let perms = parts
        .extensions
        .get::<super::permission_cache::Permissions>();
    let _permissions = if let Some(perms) = perms {
        let roles = vec![user.role.clone()];
        perms.granted_permissions(is_superadmin, &roles).await
    } else {
        vec![]
    };

    // Build roles list from single DB role (same shape as cookie-based UserContext)
    let roles = if is_superadmin {
        vec!["SuperAdmin".to_string(), user.role.clone()]
    } else {
        vec![user.role.clone()]
    };

    let highest_role = roles.first().cloned().unwrap_or_default();

    tracing::debug!(
        discord_id = %discord_id,
        user_id = user.id,
        role = %user.role,
        "bot request authenticated"
    );

    Ok(Some(UserContext {
        id: discord_id,
        username: user.username,
        email: Some(user.email),
        avatar: None,
        roles,
        highest_role,
        user_id: user.id,
        super_admin_id,
    }))
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
            .get("X-Bot-Secret")
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use axum::response::IntoResponse;

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
        let (mut parts, _) = req.into_parts();
        parts.extensions.insert(key);

        let context = UserContext::from_request_parts(&mut parts, &())
            .await
            .expect("Failed to extract UserContext");

        assert_eq!(context.id, "386488773351047168");
        assert_eq!(context.highest_role, "Admin");
        // No Config extension in this test → super_admin_id is None → not superadmin.
        assert!(!context.is_superadmin());
    }

    #[tokio::test]
    async fn test_user_context_extraction_missing_cookie() {
        let req = Request::builder().body(()).unwrap();
        let (mut parts, _) = req.into_parts();
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
        let (mut parts, _) = req.into_parts();
        parts.extensions.insert(Key::generate());

        let result = UserContext::from_request_parts(&mut parts, &()).await;
        assert!(result.is_err());
    }
}
