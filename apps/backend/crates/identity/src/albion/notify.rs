//! Tells the staff that a member asked to link an Albion character.
//!
//! A self-service link is only a request until an officer approves it, and nothing else tells
//! the officers it exists. The message goes to the guild's audit-log channel (the
//! `discord_audit_log_channel_id` setting), which the admins already point at their staff
//! channel. It never pings a role.

use super::client::AlbionPlayer;
use crate::admin::service::AdminService;
use crate::audit::service::AuditService;
use backend_core::config::Config;
use sea_orm::DatabaseConnection;

/// Embed colour: amber, "needs attention".
const AMBER: u32 = 16_705_372;

/// The Discord message announcing an open link request.
///
/// `members_url` is where an officer reviews it. Mentions are disabled outright, so nobody is
/// notified by it beyond seeing the channel.
#[must_use]
pub fn request_payload(
    discord_id: &str,
    username: &str,
    player: &AlbionPlayer,
    members_url: &str,
) -> serde_json::Value {
    let guild = player.guild_name.as_deref().unwrap_or("No guild");
    serde_json::json!({
        "allowed_mentions": { "parse": [] },
        "embeds": [{
            "author": { "name": "⚔️ WEAKLINGS — ALBION LINK" },
            "title": "🔗 Link request waiting for approval",
            "description": format!(
                "<@{discord_id}> asked to link **{}**.\nApprove or reject it on the [Members page]({members_url}).",
                player.name
            ),
            "color": AMBER,
            "fields": [
                { "name": "⚔️ Character", "value": format!("**{}**", player.name), "inline": true },
                { "name": "🏰 Albion guild", "value": guild, "inline": true },
                { "name": "👤 Discord", "value": format!("{username} (<@{discord_id}>)"), "inline": true },
            ],
            "footer": { "text": "Nothing is linked until an officer approves" },
            "timestamp": chrono::Utc::now().to_rfc3339(),
        }],
    })
}

/// Best-effort: posts the request to the audit-log channel when one is configured.
///
/// Never fails and never delays the caller — the Discord call runs in the background, and a
/// missing channel, token or Discord outage only means the officers find the request on the
/// Members page instead.
pub async fn announce_link_request(
    db: &DatabaseConnection,
    cfg: &Config,
    discord_id: &str,
    username: &str,
    player: &AlbionPlayer,
) {
    let Some(token) = cfg.discord_bot_token.clone() else {
        return;
    };
    let channel = match AdminService::get_guild_settings(db).await {
        Ok(settings) => settings.discord_audit_log_channel_id,
        Err(error) => {
            tracing::warn!(error = %error, "albion link request: could not read guild settings");
            return;
        }
    };
    let Some(channel) = channel.filter(|id| !id.trim().is_empty()) else {
        return;
    };
    let members_url = format!("{}/users", cfg.frontend_url.trim_end_matches('/'));
    let payload = request_payload(discord_id, username, player, &members_url);
    tokio::spawn(async move {
        AuditService::send_discord_payload(&channel, &token, payload).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn player(guild: Option<&str>) -> AlbionPlayer {
        AlbionPlayer {
            id: "p1".to_owned(),
            name: "Galvdon".to_owned(),
            guild_id: None,
            guild_name: guild.map(ToOwned::to_owned),
            kill_fame: None,
            death_fame: None,
        }
    }

    #[test]
    fn the_message_names_the_requester_and_links_the_review_page() {
        let payload = request_payload(
            "42",
            "nelly",
            &player(Some("Weaklings")),
            "https://x.test/users",
        );
        let embed = &payload["embeds"][0];
        let description = embed["description"].as_str().unwrap();
        assert!(description.contains("<@42>"));
        assert!(description.contains("**Galvdon**"));
        assert!(description.contains("(https://x.test/users)"));
        assert_eq!(embed["fields"][1]["value"], "Weaklings");
    }

    #[test]
    fn a_character_without_a_guild_says_so() {
        let payload = request_payload("42", "nelly", &player(None), "https://x.test/users");
        assert_eq!(payload["embeds"][0]["fields"][1]["value"], "No guild");
    }

    #[test]
    fn the_message_never_pings_anyone() {
        let payload = request_payload("42", "nelly", &player(None), "https://x.test/users");
        assert_eq!(payload["allowed_mentions"]["parse"], serde_json::json!([]));
    }
}
