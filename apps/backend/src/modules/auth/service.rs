//! Auth service logic module.
//!
//! Handles communication with Discord API for token exchange and profile retrieval.

use serde::{Deserialize, Serialize};
use sea_orm::{ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use crate::errors::AppError;
use crate::modules::users::entities::{self as user_entities, Entity as UserEntity};

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
            .map_err(|e| AppError::Unauthorized(format!("Failed to request Discord profile: {e}")))?;

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
        // Admin override check (SuperAdmin)
        if user_id == super_admin_id {
            return (vec!["SuperAdmin".to_string()], "SuperAdmin".to_string());
        }

        let client = reqwest::Client::new();
        let mut user_role_ids: Vec<String> = Vec::new();

        if let Some(bot) = bot_token {
            if !bot.trim().is_empty() && bot != "your_discord_bot_token" {
                // Fetch member details using bot token
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
                            user_role_ids = member.roles;
                        }
                    }
                }
            }
        }

        // Fallback: Fetch member details using user's access token if bot token was not used/available
        if user_role_ids.is_empty() {
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
                        user_role_ids = member.roles;
                    }
                }
            }
        }

        // Query the database to find matching roles and determine the highest one
        if !user_role_ids.is_empty() {
            use sea_orm::{EntityTrait, QueryFilter, ColumnTrait};
            use super::entities::role;

            if let Ok(matched_db_roles) = role::Entity::find()
                .filter(role::Column::Id.is_in(user_role_ids))
                .all(db)
                .await
            {
                if !matched_db_roles.is_empty() {
                    let mut matched = matched_db_roles;
                    // Sort by priority descending (highest priority first)
                    matched.sort_by(|a, b| b.priority.cmp(&a.priority));

                    let role_names: Vec<String> = matched.iter().map(|r| r.name.clone()).collect();
                    let highest_role = role_names.first().cloned().unwrap_or_else(|| "User".to_string());

                    return (role_names, highest_role);
                }
            }
        }

        // Fallback default
        (vec!["User".to_string()], "User".to_string())
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
        let email = profile
            .email
            .clone()
            .ok_or_else(|| AppError::Unauthorized("Discord account has no email to provision a user".to_string()))?;

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
