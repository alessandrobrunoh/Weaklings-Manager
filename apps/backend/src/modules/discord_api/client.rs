//! The [`DiscordRest`] trait and its live implementation over `reqwest`.

use std::time::Duration;

use async_trait::async_trait;
use reqwest::{Method, RequestBuilder, header};
use serde::de::DeserializeOwned;

use super::error::{DiscordError, classify};
use super::limiter;
use super::types::{DiscordChannelPayload, DiscordGuildMemberPayload, DiscordRolePayload};
use crate::config::Config;

/// `User-Agent` sent with every Discord call.
pub const USER_AGENT: &str = "WeaklingsBackend (0.0.3)";

/// Discord caps a member listing page at 1000 entries.
const MEMBER_PAGE_MAX: u16 = 1000;

/// Discord REST operations the backend performs. Every method names its guild explicitly.
///
/// Methods that need the bot token return [`DiscordError::NotConfigured`] without sending
/// anything when no usable token is configured.
#[async_trait]
pub trait DiscordRest: Send + Sync {
    /// One guild member, with roles and nickname.
    async fn guild_member(
        &self,
        guild_id: &str,
        user_id: &str,
    ) -> Result<DiscordGuildMemberPayload, DiscordError>;

    /// One page of guild members with snowflakes after `after`, at most `limit` (max 1000).
    async fn guild_members_page(
        &self,
        guild_id: &str,
        after: Option<&str>,
        limit: u16,
    ) -> Result<Vec<DiscordGuildMemberPayload>, DiscordError>;

    /// Every role of the guild.
    async fn guild_roles(&self, guild_id: &str) -> Result<Vec<DiscordRolePayload>, DiscordError>;

    /// Every channel of the guild.
    async fn guild_channels(
        &self,
        guild_id: &str,
    ) -> Result<Vec<DiscordChannelPayload>, DiscordError>;

    /// Grants a role to a member. Idempotent on Discord's side.
    async fn add_member_role(
        &self,
        guild_id: &str,
        user_id: &str,
        role_id: &str,
    ) -> Result<(), DiscordError>;

    /// Revokes a role from a member. A `404` comes back as an error; use
    /// [`DiscordError::is_role_removed`] to treat it as success.
    async fn remove_member_role(
        &self,
        guild_id: &str,
        user_id: &str,
        role_id: &str,
    ) -> Result<(), DiscordError>;

    /// Sets the server nickname of a member.
    async fn set_member_nick(
        &self,
        guild_id: &str,
        user_id: &str,
        nick: &str,
    ) -> Result<(), DiscordError>;

    /// The member as seen with the member's own OAuth token (`guilds.members.read` scope).
    /// Does not need the bot token and is not counted against the guild bucket.
    async fn user_guild_member(
        &self,
        access_token: &str,
        guild_id: &str,
    ) -> Result<DiscordGuildMemberPayload, DiscordError>;
}

/// [`DiscordRest`] over HTTPS. Cheap to build per request: the connection pool and the per-guild
/// buckets are shared process-wide.
pub struct LiveDiscordRest {
    base_url: String,
    bot_token: Option<String>,
    timeout: Duration,
    http: reqwest::Client,
}

impl LiveDiscordRest {
    /// Builds a client from the deployment configuration.
    #[must_use]
    pub fn new(cfg: &Config) -> Self {
        Self {
            base_url: cfg.discord_api_base.trim().trim_end_matches('/').to_owned(),
            bot_token: usable_token(cfg.discord_bot_token.as_deref()).map(str::to_owned),
            timeout: Duration::from_secs(cfg.discord_api_timeout_secs.max(1)),
            http: crate::http_client::shared(),
        }
    }

    /// Whether a usable bot token is configured.
    #[must_use]
    pub fn has_bot_token(&self) -> bool {
        self.bot_token.is_some()
    }

    fn bot_authorization(&self) -> Result<String, DiscordError> {
        self.bot_token
            .as_deref()
            .map(|token| format!("Bot {token}"))
            .ok_or(DiscordError::NotConfigured)
    }

    fn request(&self, method: Method, path: &str, authorization: &str) -> RequestBuilder {
        self.http
            .request(method, format!("{}{path}", self.base_url))
            .header(header::AUTHORIZATION, authorization)
            .header(header::USER_AGENT, USER_AGENT)
            .timeout(self.timeout)
    }

    /// Sends one request. `guild_id` selects the guild bucket; `None` skips it.
    async fn send(
        &self,
        guild_id: Option<&str>,
        request: RequestBuilder,
    ) -> Result<String, DiscordError> {
        if let Some(guild) = guild_id {
            limiter::acquire(guild, limiter::REQUEST_WAIT_BUDGET)
                .await
                .map_err(|retry_after| DiscordError::RateLimited { retry_after })?;
        }
        let response = request
            .send()
            .await
            .map_err(|error| DiscordError::Transport(error.to_string()))?;
        let status = response.status();
        let retry_after = response
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = response
            .text()
            .await
            .map_err(|error| DiscordError::Transport(error.to_string()))?;
        if status.is_success() {
            return Ok(body);
        }
        let error = classify(status.as_u16(), retry_after.as_deref(), &body);
        if let (Some(guild), DiscordError::RateLimited { retry_after }) = (guild_id, &error) {
            limiter::block(guild, *retry_after);
        }
        Err(error)
    }

    async fn send_json<T: DeserializeOwned>(
        &self,
        guild_id: Option<&str>,
        request: RequestBuilder,
    ) -> Result<T, DiscordError> {
        let body = self.send(guild_id, request).await?;
        serde_json::from_str(&body).map_err(|error| DiscordError::InvalidPayload(error.to_string()))
    }
}

#[async_trait]
impl DiscordRest for LiveDiscordRest {
    async fn guild_member(
        &self,
        guild_id: &str,
        user_id: &str,
    ) -> Result<DiscordGuildMemberPayload, DiscordError> {
        let auth = self.bot_authorization()?;
        let request = self.request(
            Method::GET,
            &format!("/guilds/{guild_id}/members/{user_id}"),
            &auth,
        );
        self.send_json(Some(guild_id), request).await
    }

    async fn guild_members_page(
        &self,
        guild_id: &str,
        after: Option<&str>,
        limit: u16,
    ) -> Result<Vec<DiscordGuildMemberPayload>, DiscordError> {
        let auth = self.bot_authorization()?;
        let limit = limit.clamp(1, MEMBER_PAGE_MAX);
        let mut path = format!("/guilds/{guild_id}/members?limit={limit}");
        if let Some(after) = after {
            path.push_str("&after=");
            path.push_str(after);
        }
        let request = self.request(Method::GET, &path, &auth);
        self.send_json(Some(guild_id), request).await
    }

    async fn guild_roles(&self, guild_id: &str) -> Result<Vec<DiscordRolePayload>, DiscordError> {
        let auth = self.bot_authorization()?;
        let request = self.request(Method::GET, &format!("/guilds/{guild_id}/roles"), &auth);
        self.send_json(Some(guild_id), request).await
    }

    async fn guild_channels(
        &self,
        guild_id: &str,
    ) -> Result<Vec<DiscordChannelPayload>, DiscordError> {
        let auth = self.bot_authorization()?;
        let request = self.request(Method::GET, &format!("/guilds/{guild_id}/channels"), &auth);
        self.send_json(Some(guild_id), request).await
    }

    async fn add_member_role(
        &self,
        guild_id: &str,
        user_id: &str,
        role_id: &str,
    ) -> Result<(), DiscordError> {
        let auth = self.bot_authorization()?;
        let request = self.request(
            Method::PUT,
            &format!("/guilds/{guild_id}/members/{user_id}/roles/{role_id}"),
            &auth,
        );
        self.send(Some(guild_id), request).await.map(|_| ())
    }

    async fn remove_member_role(
        &self,
        guild_id: &str,
        user_id: &str,
        role_id: &str,
    ) -> Result<(), DiscordError> {
        let auth = self.bot_authorization()?;
        let request = self.request(
            Method::DELETE,
            &format!("/guilds/{guild_id}/members/{user_id}/roles/{role_id}"),
            &auth,
        );
        self.send(Some(guild_id), request).await.map(|_| ())
    }

    async fn set_member_nick(
        &self,
        guild_id: &str,
        user_id: &str,
        nick: &str,
    ) -> Result<(), DiscordError> {
        let auth = self.bot_authorization()?;
        let request = self
            .request(
                Method::PATCH,
                &format!("/guilds/{guild_id}/members/{user_id}"),
                &auth,
            )
            .json(&serde_json::json!({ "nick": nick }));
        self.send(Some(guild_id), request).await.map(|_| ())
    }

    async fn user_guild_member(
        &self,
        access_token: &str,
        guild_id: &str,
    ) -> Result<DiscordGuildMemberPayload, DiscordError> {
        let auth = format!("Bearer {access_token}");
        let request = self.request(
            Method::GET,
            &format!("/users/@me/guilds/{guild_id}/member"),
            &auth,
        );
        self.send_json(None, request).await
    }
}

fn usable_token(token: Option<&str>) -> Option<&str> {
    token.filter(|token| !token.trim().is_empty() && *token != "your_discord_bot_token")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::discord_stub::{DiscordStub, StubReply};

    fn cfg_for(stub: &DiscordStub, token: Option<&str>) -> Config {
        let mut cfg = Config::for_tests();
        cfg.discord_api_base = stub.base_url.clone();
        cfg.discord_bot_token = token.map(str::to_owned);
        cfg
    }

    #[tokio::test]
    async fn guild_member_reads_roles_with_the_bot_token_against_the_base_override() {
        let stub = DiscordStub::start(|_| {
            StubReply::json(
                200,
                r#"{"user":{"id":"42","username":"kay"},"nick":"Kay","roles":["r1","r2"]}"#,
            )
        })
        .await;
        let discord = LiveDiscordRest::new(&cfg_for(&stub, Some("tok-1")));

        let member = discord
            .guild_member("g-client-1", "42")
            .await
            .expect("member");

        assert_eq!(member.roles, vec!["r1".to_string(), "r2".to_string()]);
        assert_eq!(member.nick.as_deref(), Some("Kay"));
        let requests = stub.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, "GET");
        assert_eq!(requests[0].path, "/api/v10/guilds/g-client-1/members/42");
        assert_eq!(requests[0].authorization.as_deref(), Some("Bot tok-1"));
    }

    #[tokio::test]
    async fn unknown_member_and_unknown_guild_are_distinct_errors() {
        let stub = DiscordStub::start(|request| {
            if request.path.contains("g-unknown-guild") {
                StubReply::json(404, r#"{"message":"Unknown Guild","code":10004}"#)
            } else {
                StubReply::json(404, r#"{"message":"Unknown Member","code":10007}"#)
            }
        })
        .await;
        let discord = LiveDiscordRest::new(&cfg_for(&stub, Some("tok")));

        assert_eq!(
            discord.guild_member("g-client-2", "1").await.map(|_| ()),
            Err(DiscordError::MemberNotFound)
        );
        assert_eq!(
            discord
                .guild_member("g-unknown-guild", "1")
                .await
                .map(|_| ()),
            Err(DiscordError::GuildNotFound)
        );
    }

    #[tokio::test]
    async fn a_429_surfaces_its_retry_after_and_forbidden_is_kept_apart() {
        let stub = DiscordStub::start(|request| {
            if request.path.contains("/roles/") {
                StubReply::json(403, r#"{"message":"Missing Permissions","code":50013}"#)
            } else {
                StubReply::json(429, r#"{"message":"rate","retry_after":0.2}"#)
                    .with_retry_after("1.5")
            }
        })
        .await;
        let discord = LiveDiscordRest::new(&cfg_for(&stub, Some("tok")));

        assert_eq!(
            discord.guild_roles("g-client-3").await.map(|_| ()),
            Err(DiscordError::RateLimited {
                retry_after: Duration::from_millis(1500)
            })
        );
        let denied = discord
            .add_member_role("g-client-3b", "1", "r")
            .await
            .expect_err("forbidden");
        assert!(matches!(
            denied,
            DiscordError::Forbidden {
                code: Some(50013),
                ..
            }
        ));
    }

    #[tokio::test]
    async fn role_writes_use_put_and_delete_and_a_404_on_delete_counts_as_removed() {
        let stub = DiscordStub::start(|request| {
            if request.method == "DELETE" {
                StubReply::json(404, r#"{"message":"Unknown Member","code":10007}"#)
            } else {
                StubReply::empty(204)
            }
        })
        .await;
        let discord = LiveDiscordRest::new(&cfg_for(&stub, Some("tok")));

        discord
            .add_member_role("g-client-4", "7", "role-9")
            .await
            .expect("grant");
        let revoke = discord
            .remove_member_role("g-client-4", "7", "role-9")
            .await
            .expect_err("404 on delete");
        assert!(revoke.is_role_removed());

        let requests = stub.requests();
        assert_eq!(requests[0].method, "PUT");
        assert_eq!(
            requests[0].path,
            "/api/v10/guilds/g-client-4/members/7/roles/role-9"
        );
        assert_eq!(requests[1].method, "DELETE");
    }

    #[tokio::test]
    async fn nickname_is_patched_on_the_member() {
        let stub = DiscordStub::start(|_| StubReply::empty(200)).await;
        let discord = LiveDiscordRest::new(&cfg_for(&stub, Some("tok")));

        discord
            .set_member_nick("g-client-5", "8", "Kay")
            .await
            .expect("nick");

        let requests = stub.requests();
        assert_eq!(requests[0].method, "PATCH");
        assert_eq!(requests[0].path, "/api/v10/guilds/g-client-5/members/8");
    }

    #[tokio::test]
    async fn member_pages_pass_limit_and_cursor() {
        let stub = DiscordStub::start(|_| StubReply::json(200, "[]")).await;
        let discord = LiveDiscordRest::new(&cfg_for(&stub, Some("tok")));

        let page = discord
            .guild_members_page("g-client-6", Some("55"), 1000)
            .await
            .expect("page");

        assert!(page.is_empty());
        assert_eq!(
            stub.requests()[0].path,
            "/api/v10/guilds/g-client-6/members?limit=1000&after=55"
        );
    }

    #[tokio::test]
    async fn a_missing_token_fails_before_any_call_is_made() {
        let stub = DiscordStub::start(|_| StubReply::json(200, "{}")).await;
        let discord = LiveDiscordRest::new(&cfg_for(&stub, None));

        assert!(!discord.has_bot_token());
        assert_eq!(
            discord.guild_member("g-client-7", "1").await.map(|_| ()),
            Err(DiscordError::NotConfigured)
        );
        assert!(stub.requests().is_empty());
    }

    #[tokio::test]
    async fn a_placeholder_token_counts_as_no_token() {
        let mut cfg = Config::for_tests();
        cfg.discord_bot_token = Some("your_discord_bot_token".to_owned());
        assert!(!LiveDiscordRest::new(&cfg).has_bot_token());
    }

    #[tokio::test]
    async fn user_token_reads_do_not_use_the_bot_token() {
        let stub = DiscordStub::start(|_| StubReply::json(200, r#"{"roles":["r9"]}"#)).await;
        let discord = LiveDiscordRest::new(&cfg_for(&stub, Some("bot-tok")));

        let member = discord
            .user_guild_member("user-access", "g-client-8")
            .await
            .expect("member");

        assert_eq!(member.roles, vec!["r9".to_string()]);
        let requests = stub.requests();
        assert_eq!(
            requests[0].path,
            "/api/v10/users/@me/guilds/g-client-8/member"
        );
        assert_eq!(
            requests[0].authorization.as_deref(),
            Some("Bearer user-access")
        );
    }

    #[tokio::test]
    async fn a_refused_connection_is_a_transport_error() {
        let mut cfg = Config::for_tests();
        cfg.discord_api_base = "http://127.0.0.1:1/api/v10".to_owned();
        cfg.discord_bot_token = Some("tok".to_owned());
        let discord = LiveDiscordRest::new(&cfg);

        assert!(matches!(
            discord.guild_member("g-client-9", "1").await.map(|_| ()),
            Err(DiscordError::Transport(_))
        ));
    }
}
