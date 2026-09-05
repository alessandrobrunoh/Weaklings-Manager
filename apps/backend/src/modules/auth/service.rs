//! Auth service logic module.
//!
//! Handles communication with Discord API for token exchange and profile retrieval.

use crate::errors::AppError;
use crate::modules::users::entities::{self as user_entities, Entity as UserEntity};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
};
use serde::{Deserialize, Serialize};

/// Token response returned from Discord's token exchange endpoint.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct DiscordTokenResponse {
    /// The access token to authenticate API requests.
    pub access_token: String,
    /// The type of token returned (typically "Bearer").
    pub token_type: String,
    /// The number of seconds until the access token expires.
    pub expires_in: u64,
    /// An optional token used to refresh expired access tokens.
    pub refresh_token: Option<String>,
    /// The scopes granted by the user.
    pub scope: String,
}

/// Discord user profile details retrieved from `/users/@me` and enriched with guild roles.
#[derive(Debug, Deserialize, Serialize, Clone, utoipa::ToSchema)]
pub struct DiscordUserProfile {
    /// The unique Snowflake ID of the Discord user.
    #[schema(example = "123456789012345678")]
    pub id: String,
    /// The username of the user.
    #[schema(example = "discord_user")]
    pub username: String,
    /// The registered email address of the user (requires `email` scope).
    #[schema(example = "user@example.com")]
    pub email: Option<String>,
    /// The avatar hash of the user.
    #[schema(example = "a_1234567890abcdef1234567890abcdef")]
    pub avatar: Option<String>,
    /// The Discord role names this user has in the configured guild.
    #[schema(example = r#"["Admin", "Mod"]"#)]
    #[serde(default)]
    pub roles: Vec<String>,
    /// The highest role name of this user in the configured guild.
    #[schema(example = "Admin")]
    #[serde(default)]
    pub highest_role: String,
    /// The internal database primary key of the user, resolved/provisioned on login.
    #[schema(example = 42)]
    #[serde(default)]
    pub user_id: i64,
    /// Capability flag derived from the configured Discord user id, not from guild roles.
    ///
    /// This lets clients expose privileged UI without depending on a Discord role row named
    /// `SuperAdmin`, and `/api/auth/me` recomputes it on every request so env changes do not
    /// require users to clear their cookies.
    #[schema(example = true)]
    #[serde(default)]
    pub is_superadmin: bool,
    /// Stable permission keys granted to this session.
    ///
    /// The frontend should render privileged actions from this list instead of duplicating role
    /// checks. Super-admin receives every known permission from the backend permission enum.
    #[schema(example = json!(["splits.manage", "permissions.reload"]))]
    #[serde(default)]
    pub permissions: Vec<String>,
}

/// Service for interacting with the Discord `OAuth2` API.
pub struct AuthService;

impl AuthService {
    /// Creates a new instance of the `AuthService`.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Exchanges the authorization code for an `OAuth2` token from Discord.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Unauthorized` if Discord rejects the code or credentials.
    pub async fn exchange_code(
        &self,
        client_id: &str,
        client_secret: &str,
        code: &str,
        redirect_uri: &str,
    ) -> Result<DiscordTokenResponse, AppError> {
        let client = reqwest::Client::new();

        let params = [
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
        ];

        let response = client
            .post("https://discord.com/api/oauth2/token")
            .form(&params)
            .send()
            .await
            .map_err(|e| AppError::Unauthorized(format!("Failed to contact Discord: {e}")))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::Unauthorized(format!(
                "Discord token exchange failed: {error_text}"
            )));
        }

        let token_resp = response
            .json::<DiscordTokenResponse>()
            .await
            .map_err(|e| AppError::Unauthorized(format!("Failed to parse Discord token: {e}")))?;

        Ok(token_resp)
    }

    /// Retrieves the Discord user profile using the access token.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Unauthorized` if the profile request fails.
    pub async fn fetch_profile(&self, access_token: &str) -> Result<DiscordUserProfile, AppError> {
        let client = reqwest::Client::new();

        let response = client
            .get("https://discord.com/api/users/@me")
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| {
                AppError::Unauthorized(format!("Failed to request Discord profile: {e}"))
            })?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::Unauthorized(format!(
                "Failed to get Discord profile: {error_text}"
            )));
        }

        let profile = response
            .json::<DiscordUserProfile>()
            .await
            .map_err(|e| AppError::Unauthorized(format!("Failed to parse Discord profile: {e}")))?;

        Ok(profile)
    }

    /// Fetches the user's roles from Discord and maps them to database role names/priorities.
    pub async fn fetch_member_roles(
        &self,
        db: &sea_orm::DatabaseConnection,
        user_id: &str,
        user_access_token: &str,
        guild_id: &str,
        bot_token: Option<&str>,
        super_admin_id: &str,
    ) -> (Vec<String>, String) {
        if user_id == super_admin_id {
            return (vec!["SuperAdmin".to_string()], "SuperAdmin".to_string());
        }

        let user_role_ids = self
            .fetch_guild_member_role_ids(user_id, user_access_token, guild_id, bot_token)
            .await
            .unwrap_or_default();

        let db_roles = match super::entities::role::Entity::find().all(db).await {
            Ok(roles) => roles,
            Err(_) => return fallback_unmatched_roles(&[]),
        };

        resolve_linked_roles(&user_role_ids, &db_roles)
    }

    /// Fetches the member's Discord role snowflakes from the guild.
    ///
    /// Returns `None` when Discord cannot be reached (caller should keep cached session roles).
    /// Returns `Some(ids)` when the member payload was parsed, including an empty list.
    pub async fn fetch_guild_member_role_ids(
        &self,
        user_id: &str,
        user_access_token: &str,
        guild_id: &str,
        bot_token: Option<&str>,
    ) -> Option<Vec<String>> {
        let client = reqwest::Client::new();

        if let Some(bot) = usable_bot_token(bot_token) {
            let url = format!("https://discord.com/api/v10/guilds/{guild_id}/members/{user_id}");
            if let Ok(res) = client
                .get(&url)
                .header("Authorization", format!("Bot {bot}"))
                .header("User-Agent", "WeaklingsBackend (0.0.1)")
                .send()
                .await
            {
                #[derive(Deserialize)]
                struct GuildMemberResponse {
                    roles: Vec<String>,
                }

                if res.status().is_success() {
                    if let Ok(member) = res.json::<GuildMemberResponse>().await {
                        return Some(member.roles);
                    }
                }
            }
        }

        if user_access_token.is_empty() {
            return None;
        }

        let url = format!("https://discord.com/api/v10/users/@me/guilds/{guild_id}/member");
        if let Ok(res) = client
            .get(&url)
            .bearer_auth(user_access_token)
            .header("User-Agent", "WeaklingsBackend (0.0.1)")
            .send()
            .await
        {
            #[derive(Deserialize)]
            struct UserGuildMemberResponse {
                roles: Vec<String>,
            }

            if res.status().is_success() {
                if let Ok(member) = res.json::<UserGuildMemberResponse>().await {
                    return Some(member.roles);
                }
            }
        }

        None
    }

    /// Finds or creates the local `users` row backing this Discord profile, keyed by email.
    ///
    /// Discord login is always requested with the `email` scope, so `profile.email` should be
    /// present; keeps `users` up to date with the latest username/role on every login.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Unauthorized` if Discord did not provide an email, or `AppError::Database`
    /// if the lookup/write fails.
    pub async fn upsert_user(
        &self,
        db: &DatabaseConnection,
        profile: &DiscordUserProfile,
    ) -> Result<i64, AppError> {
        let email = profile.email.clone().ok_or_else(|| {
            AppError::Unauthorized("Discord account has no email to provision a user".to_string())
        })?;

        let existing = UserEntity::find()
            .filter(user_entities::Column::Email.eq(&email))
            .one(db)
            .await?;

        if let Some(existing) = existing {
            let id = existing.id;
            let mut active: user_entities::ActiveModel = existing.into();
            active.username = Set(profile.username.clone());
            active.role = Set(profile.highest_role.clone());
            active.discord_id = Set(Some(profile.id.clone()));
            active.update(db).await?;
            Ok(id)
        } else {
            let active = user_entities::ActiveModel {
                username: Set(profile.username.clone()),
                email: Set(email),
                role: Set(profile.highest_role.clone()),
                discord_id: Set(Some(profile.id.clone())),
                ..Default::default()
            };
            let inserted = active.insert(db).await?;
            Ok(inserted.id)
        }
    }
}

impl Default for AuthService {
    fn default() -> Self {
        Self::new()
    }
}

/// Maps a member's Discord role snowflakes onto gestionale role names.
///
/// Matching is on `discord_role_id`, never on the internal `id`. Unmatched members receive the
/// unique `is_default` role when one exists, otherwise the hardcoded name `"User"`.
#[must_use]
pub fn resolve_linked_roles(
    member_discord_role_ids: &[String],
    db_roles: &[super::entities::role::Model],
) -> (Vec<String>, String) {
    let held: std::collections::HashSet<&str> =
        member_discord_role_ids.iter().map(String::as_str).collect();

    let mut matched: Vec<&super::entities::role::Model> = db_roles
        .iter()
        .filter(|role| {
            role.discord_role_id
                .as_deref()
                .is_some_and(|id| held.contains(id))
        })
        .collect();

    if matched.is_empty() {
        return fallback_unmatched_roles(db_roles);
    }

    matched.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| a.name.cmp(&b.name))
    });
    let names: Vec<String> = matched.iter().map(|role| role.name.clone()).collect();
    let highest = names.first().cloned().unwrap_or_else(|| "User".to_string());
    (names, highest)
}

fn fallback_unmatched_roles(db_roles: &[super::entities::role::Model]) -> (Vec<String>, String) {
    if let Some(default) = db_roles.iter().find(|role| role.is_default) {
        return (vec![default.name.clone()], default.name.clone());
    }
    (vec!["User".to_string()], "User".to_string())
}

fn usable_bot_token(bot_token: Option<&str>) -> Option<&str> {
    bot_token.filter(|token| !token.trim().is_empty() && *token != "your_discord_bot_token")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::auth::entities::role;

    fn role(
        id: &str,
        name: &str,
        priority: i32,
        discord_role_id: Option<&str>,
        is_default: bool,
    ) -> role::Model {
        role::Model {
            id: id.to_string(),
            name: name.to_string(),
            priority,
            discord_role_id: discord_role_id.map(str::to_string),
            is_default,
            is_staff: false,
            grants_staff: false,
        }
    }

    #[test]
    fn matches_discord_role_id_not_internal_id() {
        let roles = vec![
            role(
                "uuid-raid-lead",
                "Raid Lead",
                80,
                Some("999888777666555444"),
                false,
            ),
            role("222333444555666777", "User", 10, None, true),
        ];
        let (names, highest) = resolve_linked_roles(&["999888777666555444".into()], &roles);
        assert_eq!(names, vec!["Raid Lead".to_string()]);
        assert_eq!(highest, "Raid Lead");
    }

    #[test]
    fn ignores_internal_id_equal_to_a_discord_snowflake() {
        // After the column split, matching must not fall back to `roles.id`. A leftover snowflake
        // sitting in `id` with a cleared link must not grant that role.
        let roles = vec![
            role("999888777666555444", "Stale", 90, None, false),
            role("user-uuid", "Member", 10, None, true),
        ];
        let (names, highest) = resolve_linked_roles(&["999888777666555444".into()], &roles);
        assert_eq!(names, vec!["Member".to_string()]);
        assert_eq!(highest, "Member");
    }

    #[test]
    fn unions_linked_roles_highest_priority_first() {
        let roles = vec![
            role("a", "Officer", 50, Some("111"), false),
            role("b", "Raider", 30, Some("222"), false),
            role("c", "User", 10, None, true),
        ];
        let (names, highest) = resolve_linked_roles(&["222".into(), "111".into()], &roles);
        assert_eq!(names, vec!["Officer".to_string(), "Raider".to_string()]);
        assert_eq!(highest, "Officer");
    }

    #[test]
    fn unmatched_member_gets_default_role() {
        let roles = vec![
            role("a", "Admin", 100, Some("111"), false),
            role("b", "Recruit", 1, None, true),
        ];
        let (names, highest) = resolve_linked_roles(&["nope".into()], &roles);
        assert_eq!(names, vec!["Recruit".to_string()]);
        assert_eq!(highest, "Recruit");
    }

    #[test]
    fn unmatched_without_default_falls_back_to_user_name() {
        let roles = vec![role("a", "Admin", 100, Some("111"), false)];
        let (names, highest) = resolve_linked_roles(&[], &roles);
        assert_eq!(names, vec!["User".to_string()]);
        assert_eq!(highest, "User");
    }
}
