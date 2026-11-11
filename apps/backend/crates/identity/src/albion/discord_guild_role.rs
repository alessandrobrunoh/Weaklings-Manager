//! Best-effort assignment of the configured Discord guild role after an Albion link.

use crate::admin::service::AdminService;
use crate::discord_api::{DiscordRest, LiveDiscordRest};
use backend_core::config::Config;
use sea_orm::DatabaseConnection;

/// Returns whether a live Albion player profile belongs to the configured guild.
#[must_use]
pub fn belongs_to_configured_guild(
    player_guild_id: Option<&str>,
    configured_guild_id: &str,
) -> bool {
    player_guild_id.is_some_and(|guild_id| guild_id == configured_guild_id.trim())
}

/// Assigns the configured Guild base role to a Discord member of `guild_id`.
///
/// `guild_id` is the tenant's own Discord server (the tenant id *is* the guild
/// id), so a link made in one server never grants a role in another.
///
/// The side effect intentionally never fails the caller: linking a character is more valuable than
/// a transient Discord permission, hierarchy, or network error. Discord's role PUT endpoint is
/// idempotent, so retrying a successful link does not duplicate a role.
pub async fn assign_guild_role(
    db: &DatabaseConnection,
    cfg: &Config,
    guild_id: &str,
    discord_user_id: &str,
) {
    let Some(role_id) = configured_base_role_id(db).await else {
        return;
    };
    assign_discord_role(cfg, guild_id, discord_user_id, &role_id).await;
}

/// Assigns `role_id` on `guild_id` (best-effort, never fails the caller).
///
/// Returns whether Discord confirmed the assignment. Only a confirmed assignment
/// may be recorded as a membership grant.
pub async fn assign_discord_role(
    cfg: &Config,
    guild_id: &str,
    discord_user_id: &str,
    role_id: &str,
) -> bool {
    let discord = LiveDiscordRest::new(cfg);
    if !discord.has_bot_token() {
        tracing::debug!("skipping Discord role assignment: bot token is not configured");
        return false;
    }
    let guild_id = guild_id.trim();
    let role_id = role_id.trim();
    if guild_id.is_empty() || discord_user_id.trim().is_empty() || role_id.is_empty() {
        return false;
    }

    match discord
        .add_member_role(guild_id, discord_user_id, role_id)
        .await
    {
        Ok(()) => {
            tracing::info!(
                discord_user_id,
                role_id,
                "assigned configured Discord guild role after Albion link"
            );
            true
        }
        Err(error) => {
            tracing::warn!(
                discord_user_id,
                role_id,
                error = %error,
                "failed to assign configured Discord guild role after Albion link"
            );
            false
        }
    }
}

/// Revokes the configured Guild base role from a Discord member of `guild_id`.
///
/// The side effect intentionally never fails the caller: unlinking a character must succeed even
/// if the bot lacks permissions, hierarchy, or Discord is unreachable. Discord's role DELETE
/// endpoint is idempotent and returns success even if the member never had the role, so this is
/// safe to call unconditionally on unlink.
pub async fn revoke_guild_role(
    db: &DatabaseConnection,
    cfg: &Config,
    guild_id: &str,
    discord_user_id: &str,
) {
    let Some(role_id) = configured_base_role_id(db).await else {
        return;
    };
    revoke_discord_role(cfg, guild_id, discord_user_id, &role_id).await;
}

/// Revokes `role_id` and reports whether Discord confirmed it.
///
/// Missing bot token and any failure other than a `404` (the member no longer has the role, or
/// the bot is no longer in the server) are errors so the caller can retry.
pub async fn revoke_discord_role_verified(
    cfg: &Config,
    guild_id: &str,
    discord_user_id: &str,
    role_id: &str,
) -> Result<(), String> {
    let discord = LiveDiscordRest::new(cfg);
    if !discord.has_bot_token() {
        return Err("discord bot token is not configured".to_owned());
    }
    let guild_id = guild_id.trim();
    let role_id = role_id.trim();
    let discord_user_id = discord_user_id.trim();
    if guild_id.is_empty() || discord_user_id.is_empty() || role_id.is_empty() {
        return Err("discord role revocation is missing guild, user, or role".to_owned());
    }
    match discord
        .remove_member_role(guild_id, discord_user_id, role_id)
        .await
    {
        Ok(()) => Ok(()),
        Err(error) if error.is_role_removed() => Ok(()),
        Err(error) => Err(format!("discord role revocation failed: {error}")),
    }
}

/// Revokes `role_id` on `guild_id` (best-effort).
pub async fn revoke_discord_role(
    cfg: &Config,
    guild_id: &str,
    discord_user_id: &str,
    role_id: &str,
) {
    let discord = LiveDiscordRest::new(cfg);
    if !discord.has_bot_token() {
        tracing::debug!("skipping Discord role revocation: bot token is not configured");
        return;
    }
    let guild_id = guild_id.trim();
    let role_id = role_id.trim();
    if guild_id.is_empty() || discord_user_id.trim().is_empty() || role_id.is_empty() {
        return;
    }

    match discord
        .remove_member_role(guild_id, discord_user_id, role_id)
        .await
    {
        Ok(()) => {
            tracing::info!(
                discord_user_id,
                role_id,
                "revoked configured Discord guild role after Albion unlink"
            );
        }
        Err(error) if error.is_role_removed() => {
            tracing::info!(
                discord_user_id,
                role_id,
                "configured Discord guild role was already gone after Albion unlink"
            );
        }
        Err(error) => {
            tracing::warn!(
                discord_user_id,
                role_id,
                error = %error,
                "failed to revoke configured Discord guild role after Albion unlink"
            );
        }
    }
}

async fn configured_base_role_id(db: &DatabaseConnection) -> Option<String> {
    if let Ok(settings) = AdminService::get_guild_settings(db).await {
        if let Some(role_id) = settings.discord_applications_accepted_role_id
            && !role_id.trim().is_empty()
        {
            return Some(role_id);
        }
        if let Some(role_id) = settings.default_role_discord_id
            && !role_id.trim().is_empty()
        {
            return Some(role_id);
        }
    }
    None
}

/// Alliance-member role configured on this tenant's Discord, if any.
pub async fn configured_alliance_role_id(db: &DatabaseConnection) -> Option<String> {
    let settings = AdminService::get_guild_settings(db).await.ok()?;
    settings
        .discord_alliance_role_id
        .filter(|role_id| !role_id.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::{belongs_to_configured_guild, revoke_discord_role_verified};
    use backend_core::config::Config;
    use backend_core::testkit::discord_stub::{DiscordStub, StubReply};

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

    fn cfg_for(base_url: &str) -> Config {
        let mut cfg = Config::for_tests();
        cfg.discord_api_base = base_url.to_owned();
        cfg.discord_bot_token = Some("bot-token".to_owned());
        cfg
    }

    #[tokio::test]
    async fn revoking_an_already_removed_role_counts_as_revoked() {
        let stub = DiscordStub::start(|_| {
            StubReply::json(404, r#"{"message":"Unknown Member","code":10007}"#)
        })
        .await;
        let cfg = cfg_for(&stub.base_url);

        assert_eq!(
            revoke_discord_role_verified(&cfg, "g-role-1", "7", "r-1").await,
            Ok(())
        );
    }

    #[tokio::test]
    async fn an_outage_keeps_the_revocation_pending() {
        let stub = DiscordStub::start(|_| StubReply::json(500, "down")).await;
        let cfg = cfg_for(&stub.base_url);

        assert!(
            revoke_discord_role_verified(&cfg, "g-role-2", "7", "r-1")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn an_unknown_guild_404_counts_as_revoked_like_the_old_path() {
        let stub = DiscordStub::start(|_| {
            StubReply::json(404, r#"{"message":"Unknown Guild","code":10004}"#)
        })
        .await;
        let cfg = cfg_for(&stub.base_url);

        assert_eq!(
            revoke_discord_role_verified(&cfg, "g-role-unknown", "7", "r-1").await,
            Ok(())
        );
    }

    #[tokio::test]
    async fn a_missing_token_is_reported_without_a_call() {
        let stub = DiscordStub::start(|_| StubReply::empty(204)).await;
        let mut cfg = cfg_for(&stub.base_url);
        cfg.discord_bot_token = None;

        assert_eq!(
            revoke_discord_role_verified(&cfg, "g-role-3", "7", "r-1").await,
            Err("discord bot token is not configured".to_owned())
        );
        assert!(stub.requests().is_empty());
    }
}
