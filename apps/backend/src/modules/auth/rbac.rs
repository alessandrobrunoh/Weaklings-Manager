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
use serde::{Deserialize, Serialize};
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
    #[allow(dead_code)]
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
        let cookie_header = parts
            .headers
            .get(axum::http::header::COOKIE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");

        // Parse the session_user cookie
        let session_cookie_val = cookie_header
            .split(';')
            .map(|c| c.trim())
            .find(|c| c.starts_with("session_user="))
            .map(|c| &c["session_user=".len()..]);

        let Some(encoded_val) = session_cookie_val else {
            return Err(AppError::Unauthorized(
                "No active session cookie".to_string(),
            ));
        };

        let decoded_val = urlencoding::decode(encoded_val)
            .map_err(|_| AppError::Unauthorized("Invalid cookie encoding".to_string()))?;

        let profile: DiscordUserProfile = serde_json::from_str(&decoded_val)
            .map_err(|_| AppError::Unauthorized("Invalid session format".to_string()))?;

        // Pull the super-admin id from the Config extension (set in main.rs).
        // Falls back to None if Config isn't in extensions (e.g. in unit tests),
        // in which case is_superadmin() is always false.
        let super_admin_id = parts
            .extensions
            .get::<Config>()
            .map(|c| c.super_admin_discord_id.clone());

        Ok(Self {
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;

    #[tokio::test]
    async fn test_user_context_extraction_success() {
        let profile_json = r#"{"id":"386488773351047168","username":"admin_user","email":"admin@example.com","avatar":null,"roles":["Admin"],"highest_role":"Admin","user_id":0}"#;
        let cookie_str = format!("session_user={}", urlencoding::encode(profile_json));

        let req = Request::builder()
            .header("Cookie", cookie_str)
            .body(())
            .unwrap();
        let (mut parts, _) = req.into_parts();

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
        let result = UserContext::from_request_parts(&mut parts, &()).await;
        assert!(result.is_err());
    }
}
