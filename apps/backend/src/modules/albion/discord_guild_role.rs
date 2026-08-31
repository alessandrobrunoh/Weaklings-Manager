//! Best-effort assignment of the configured Discord guild role after an Albion link.

use crate::config::Config;
use crate::modules::admin::service::AdminService;
use sea_orm::DatabaseConnection;

/// Returns whether a live Albion player profile belongs to the configured guild.
#[must_use]
pub fn belongs_to_configured_guild(
    player_guild_id: Option<&str>,
    configured_guild_id: &str,
) -> bool {
    player_guild_id.is_some_and(|guild_id| guild_id == configured_guild_id.trim())
}

/// Assigns the configured Guild base role to a Discord member.
///
/// The side effect intentionally never fails the caller: linking a character is more valuable than
/// a transient Discord permission, hierarchy, or network error. Discord's role PUT endpoint is
/// idempotent, so retrying a successful link does not duplicate a role.
pub async fn assign_guild_role(db: &DatabaseConnection, cfg: &Config, discord_user_id: &str) {
    let Some(role_id) = configured_role_id(db).await else {
        return;
    };
    let Some(token) = usable_bot_token(cfg.discord_bot_token.as_deref()) else {
        tracing::debug!("skipping Discord guild-role assignment: bot token is not configured");
        return;
    };
    let guild_id = cfg.discord_guild_id.trim();
    if guild_id.is_empty() || discord_user_id.trim().is_empty() {
        return;
    }

    let url = format!(
        "https://discord.com/api/v10/guilds/{guild_id}/members/{discord_user_id}/roles/{role_id}"
    );
    match reqwest::Client::new()
        .put(&url)
        .header("Authorization", format!("Bot {token}"))
        .header("User-Agent", "WeaklingsBackend (0.0.3)")
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            tracing::info!(
                discord_user_id,
                role_id,
                "assigned configured Discord guild role after Albion link"
            );
        }
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            tracing::warn!(
                discord_user_id,
                role_id,
                %status,
                body,
                "failed to assign configured Discord guild role after Albion link"
            );
        }
        Err(error) => {
            tracing::warn!(
                discord_user_id,
                role_id,
                error = %error,
                "failed to assign configured Discord guild role after Albion link"
            );
        }
    }
}

async fn configured_role_id(db: &DatabaseConnection) -> Option<String> {
    match AdminService::get_autorole_settings(db).await {
        Ok(settings) => settings.discord_auto_role_id,
        Err(error) => {
            tracing::warn!(error = %error, "failed to load configured Discord guild role");
            None
        }
    }
}

fn usable_bot_token(bot_token: Option<&str>) -> Option<&str> {
    bot_token.filter(|token| !token.trim().is_empty() && *token != "your_discord_bot_token")
}

#[cfg(test)]
mod tests {
    use super::belongs_to_configured_guild;

    #[test]
    fn membership_requires_an_exact_configured_guild_id() {
        assert!(belongs_to_configured_guild(Some("guild-id"), "guild-id"));
        assert!(!belongs_to_configured_guild(
            Some("other-guild"),
            "guild-id"
        ));
        assert!(!belongs_to_configured_guild(None, "guild-id"));
        assert!(!belongs_to_configured_guild(Some("guild-id"), ""));
    }
}
