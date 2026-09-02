//! Best-effort Discord nickname sync when a member links an Albion character.

use crate::config::Config;

/// Discord guild nicknames are capped at 32 Unicode characters.
const DISCORD_NICK_MAX: usize = 32;

/// Trims an Albion character name into a Discord nick, or `None` if empty.
#[must_use]
pub fn nick_from_albion_name(albion_name: &str) -> Option<String> {
    let trimmed = albion_name.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(DISCORD_NICK_MAX).collect())
}

/// Sets the guild nickname of `discord_user_id` to the Albion character name.
///
/// Failures are logged and never returned: linking must succeed even if the bot lacks
/// `Manage Nicknames`, the member is above the bot in the role list, or Discord is down.
pub async fn sync_guild_nickname(cfg: &Config, discord_user_id: &str, albion_name: &str) {
    let Some(nick) = nick_from_albion_name(albion_name) else {
        return;
    };
    let Some(token) = usable_bot_token(cfg.discord_bot_token.as_deref()) else {
        tracing::debug!("skipping Discord nick sync: bot token is not configured");
        return;
    };
    let guild_id = cfg.discord_guild_id.trim();
    if guild_id.is_empty() || discord_user_id.trim().is_empty() {
        return;
    }

    let url = format!("https://discord.com/api/v10/guilds/{guild_id}/members/{discord_user_id}");
    let payload = serde_json::json!({ "nick": nick });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    match client
        .patch(&url)
        .header("Authorization", format!("Bot {token}"))
        .header("User-Agent", "WeaklingsBackend (0.0.3)")
        .json(&payload)
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => {
            tracing::info!(
                discord_user_id,
                nick,
                "synced Discord nickname from Albion link"
            );
        }
        Ok(res) => {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            tracing::warn!(
                discord_user_id,
                %status,
                body,
                "failed to sync Discord nickname from Albion link"
            );
        }
        Err(error) => {
            tracing::warn!(
                discord_user_id,
                error = %error,
                "failed to sync Discord nickname from Albion link"
            );
        }
    }
}

fn usable_bot_token(bot_token: Option<&str>) -> Option<&str> {
    bot_token.filter(|token| !token.trim().is_empty() && *token != "your_discord_bot_token")
}

#[cfg(test)]
mod tests {
    use super::nick_from_albion_name;

    #[test]
    fn empty_or_whitespace_is_skipped() {
        assert_eq!(nick_from_albion_name("").as_deref(), None);
        assert_eq!(nick_from_albion_name("   ").as_deref(), None);
    }

    #[test]
    fn copies_the_albion_name_verbatim() {
        assert_eq!(
            nick_from_albion_name("  KayTheWeak  ").as_deref(),
            Some("KayTheWeak")
        );
    }

    #[test]
    fn truncates_to_discord_limit() {
        let long = "A".repeat(40);
        let nick = nick_from_albion_name(&long).expect("nick");
        assert_eq!(nick.chars().count(), 32);
        assert!(nick.chars().all(|c| c == 'A'));
    }
}
