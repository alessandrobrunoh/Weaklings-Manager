//! Unauthenticated and first-time-onboarding tenant routes (`/api/tenants`).

use std::collections::HashMap;

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    http::HeaderMap,
    routing::{get, post},
};
use axum_extra::extract::cookie::{Key, PrivateCookieJar};
use serde::Deserialize;

use crate::config::Config;
use crate::errors::{AppError, ProblemDetails};
use crate::modules::albion::client::{AlbionRegion, AlbionSearchResult};
use crate::modules::albion::service::AlbionService;
use crate::modules::auth::service::{
    DiscordUserProfile, PERMISSION_ADMINISTRATOR, PERMISSION_MANAGE_GUILD, RegisterableGuild,
};
use crate::responses::ApiResponse;
use crate::tenant::{ControlDb, TenantRegistry};

use super::models::{RegisterTenantRequest, TenantStatusView};
use super::service::PlatformService;

/// Public tenant onboarding router (no tenant `search_path`).
pub fn router() -> Router {
    Router::new()
        .route("/{id}/status", get(tenant_status))
        .route("/register", post(register_tenant))
        .route("/albion-search", get(albion_search))
}

#[derive(Debug, Deserialize)]
pub struct AlbionSearchQuery {
    pub q: String,
    pub region: Option<String>,
}

/// Whether this Discord guild is already a tenant.
#[utoipa::path(
    get,
    path = "/api/tenants/{id}/status",
    tag = "platform",
    params(("id" = String, Path, description = "Discord guild id")),
    responses((status = 200, description = "Registration status"))
)]
pub async fn tenant_status(
    Extension(control): Extension<ControlDb>,
    Extension(cfg): Extension<Config>,
    Path(id): Path<String>,
) -> Result<Json<ApiResponse<TenantStatusView>>, AppError> {
    Ok(Json(ApiResponse::new(
        PlatformService::tenant_status(&control.0, &id, &cfg.frontend_url).await?,
    )))
}

/// Search Albion guilds during onboarding (no tenant session required).
#[utoipa::path(
    get,
    path = "/api/tenants/albion-search",
    tag = "platform",
    responses((status = 200, description = "Albion search results"))
)]
pub async fn albion_search(
    _profile: SessionUser,
    Query(query): Query<AlbionSearchQuery>,
) -> Result<Json<ApiResponse<AlbionSearchResult>>, AppError> {
    let q = query.q.trim();
    if q.is_empty() {
        return Err(AppError::Validation("q is required".to_owned()));
    }
    let region = AlbionRegion::from_env_str(query.region.as_deref().unwrap_or("europe"));
    let service = AlbionService::new(region, String::new());
    Ok(Json(ApiResponse::new(service.search(q).await?)))
}

/// First-time tenant registration. The caller becomes the tenant SuperAdmin (`owner_discord_id`).
#[utoipa::path(
    post,
    path = "/api/tenants/register",
    tag = "platform",
    responses(
        (status = 200, description = "Tenant registered"),
        (status = 401, description = "No session", body = ProblemDetails),
        (status = 403, description = "Caller does not own or manage that Discord server", body = ProblemDetails),
        (status = 409, description = "Already registered", body = ProblemDetails)
    )
)]
pub async fn register_tenant(
    session: SessionUser,
    headers: HeaderMap,
    Extension(key): Extension<Key>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(cfg): Extension<Config>,
    Json(body): Json<RegisterTenantRequest>,
) -> Result<Json<ApiResponse<TenantStatusView>>, AppError> {
    let guild_id = body.id.trim().to_owned();
    if guild_id.is_empty() {
        return Err(AppError::Validation("guild id is required".to_owned()));
    }
    assert_can_manage_guild(
        &headers,
        key,
        &guild_id,
        &session.profile.id,
        cfg.discord_bot_token.as_deref(),
    )
    .await?;
    let icon = fetch_discord_guild_icon(cfg.discord_bot_token.as_deref(), &guild_id).await;
    let view = PlatformService::register_tenant(
        &control.0,
        &registry,
        body,
        &session.profile.id,
        icon.as_deref(),
    )
    .await?;
    Ok(Json(ApiResponse::new(TenantStatusView {
        id: view.id,
        registered: true,
        status: Some(view.status),
        name: Some(view.name),
        register_url: None,
    })))
}

/// Session cookie without a platform-role requirement.
pub struct SessionUser {
    pub profile: DiscordUserProfile,
}

impl<S> axum::extract::FromRequestParts<S> for SessionUser
where
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        let key = parts
            .extensions
            .get::<Key>()
            .cloned()
            .ok_or_else(|| AppError::Internal("session key missing".to_owned()))?;
        let jar = PrivateCookieJar::from_headers(&parts.headers, key);
        let cookie = jar
            .get("session_user")
            .ok_or_else(|| AppError::Unauthorized("No active session".to_owned()))?;
        let profile: DiscordUserProfile = serde_json::from_str(cookie.value())
            .map_err(|_| AppError::Unauthorized("Invalid session cookie format".to_owned()))?;
        Ok(Self { profile })
    }
}

/// Requires that `discord_id` owns or manages `guild_id`.
///
/// Registering a tenant hands the caller its owner/SuperAdmin seat, so plain
/// Discord membership — all the check this replaces ever verified, and only
/// when `DISCORD_BOT_TOKEN` happened to be set — is not the right bar.
///
/// Two independent signals, either one sufficient:
/// - The `registerable_guilds` cookie set at OAuth login (`guilds` scope, see
///   `with_registerable_guilds`): no Discord round trip, but only as fresh as
///   the caller's last login and capped at 40 guilds.
/// - A live bot-token lookup (guild roles + member roles, cross-referenced):
///   always current, covers a server the bot just joined, but unavailable
///   without `DISCORD_BOT_TOKEN`.
///
/// Fails closed: neither signal confirming manage rights is a `403`, not a
/// silent pass — unlike the old check, which skipped itself entirely when the
/// bot token was unset.
async fn assert_can_manage_guild(
    headers: &HeaderMap,
    key: Key,
    guild_id: &str,
    discord_id: &str,
    bot_token: Option<&str>,
) -> Result<(), AppError> {
    if cookie_confirms_can_manage(headers, key, guild_id) {
        return Ok(());
    }
    if let Some(bot_token) = bot_token
        && live_check_confirms_can_manage(bot_token, guild_id, discord_id).await?
    {
        return Ok(());
    }
    Err(AppError::Forbidden(
        "you must own or manage that Discord server to register it".to_owned(),
    ))
}

fn cookie_confirms_can_manage(headers: &HeaderMap, key: Key, guild_id: &str) -> bool {
    let jar = PrivateCookieJar::from_headers(headers, key);
    let stored: Vec<RegisterableGuild> = jar
        .get("registerable_guilds")
        .and_then(|cookie| serde_json::from_str(cookie.value()).ok())
        .unwrap_or_default();
    stored
        .iter()
        .any(|guild| guild.id == guild_id && guild.can_manage)
}

/// Live cross-reference of `GET /guilds/{id}` (owner id, every role's
/// permission bitfield) against `GET /guilds/{id}/members/{id}` (which of
/// those roles this member holds). Every member implicitly holds `@everyone`,
/// whose role id equals the guild id, so that role's bits always count too.
///
/// # Errors
///
/// Returns `AppError::Internal` if either Discord request fails or returns an
/// unreadable body — a transport failure here must not be mistaken for "not a
/// manager" and silently swallowed into a 403.
async fn live_check_confirms_can_manage(
    bot_token: &str,
    guild_id: &str,
    discord_id: &str,
) -> Result<bool, AppError> {
    let client = reqwest::Client::new();

    let guild: serde_json::Value = client
        .get(format!("https://discord.com/api/v10/guilds/{guild_id}"))
        .header("Authorization", format!("Bot {bot_token}"))
        .send()
        .await
        .map_err(|err| AppError::Internal(format!("discord guild lookup failed: {err}")))?
        .json()
        .await
        .map_err(|err| AppError::Internal(format!("discord guild response unreadable: {err}")))?;

    // Short-circuits the member lookup below for the common case: the caller
    // registering their own server.
    if guild.get("owner_id").and_then(serde_json::Value::as_str) == Some(discord_id) {
        return Ok(true);
    }

    let role_permissions: HashMap<&str, u64> = guild
        .get("roles")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|role| {
            let id = role.get("id")?.as_str()?;
            let bits = role.get("permissions")?.as_str()?.parse().ok()?;
            Some((id, bits))
        })
        .collect();

    let member_response = client
        .get(format!(
            "https://discord.com/api/v10/guilds/{guild_id}/members/{discord_id}"
        ))
        .header("Authorization", format!("Bot {bot_token}"))
        .send()
        .await
        .map_err(|err| AppError::Internal(format!("discord member lookup failed: {err}")))?;
    if member_response.status().as_u16() == 404 {
        return Ok(false);
    }
    let member: serde_json::Value = member_response
        .json()
        .await
        .map_err(|err| AppError::Internal(format!("discord member response unreadable: {err}")))?;
    let member_role_ids: Vec<&str> = member
        .get("roles")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .collect();

    Ok(compute_can_manage(
        guild.get("owner_id").and_then(serde_json::Value::as_str),
        discord_id,
        guild_id,
        &role_permissions,
        &member_role_ids,
    ))
}

/// Pure decision at the heart of [`live_check_confirms_can_manage`], split out
/// so it can be exercised without a live Discord round trip: owns the guild,
/// or the OR of every role they hold (including the implicit `@everyone`,
/// keyed by the guild's own id) sets `MANAGE_GUILD` or `ADMINISTRATOR`.
fn compute_can_manage(
    owner_id: Option<&str>,
    discord_id: &str,
    guild_id: &str,
    role_permissions: &HashMap<&str, u64>,
    member_role_ids: &[&str],
) -> bool {
    if owner_id == Some(discord_id) {
        return true;
    }
    let mut bits = role_permissions.get(guild_id).copied().unwrap_or(0);
    for role_id in member_role_ids {
        bits |= role_permissions.get(role_id).copied().unwrap_or(0);
    }
    bits & (PERMISSION_MANAGE_GUILD | PERMISSION_ADMINISTRATOR) != 0
}

async fn fetch_discord_guild_icon(bot_token: Option<&str>, guild_id: &str) -> Option<String> {
    let token = bot_token?;
    let url = format!("https://discord.com/api/v10/guilds/{guild_id}");
    let response = reqwest::Client::new()
        .get(url)
        .header("Authorization", format!("Bot {token}"))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: serde_json::Value = response.json().await.ok()?;
    body.get("icon")
        .and_then(serde_json::Value::as_str)
        .filter(|hash| !hash.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse;

    #[test]
    fn owner_can_manage_with_no_roles_at_all() {
        assert!(compute_can_manage(
            Some("42"),
            "42",
            "guild-1",
            &HashMap::new(),
            &[],
        ));
    }

    #[test]
    fn everyone_role_bits_count_even_with_no_explicit_roles() {
        // @everyone's role id equals the guild id, and every member holds it
        // implicitly — a member with zero listed roles can still be an admin
        // through a guild-wide @everyone grant.
        let roles = HashMap::from([("guild-1", PERMISSION_ADMINISTRATOR)]);
        assert!(compute_can_manage(Some("owner"), "member", "guild-1", &roles, &[]));
    }

    #[test]
    fn a_held_role_with_manage_guild_is_sufficient() {
        let roles = HashMap::from([
            ("guild-1", 0u64),
            ("role-officer", PERMISSION_MANAGE_GUILD),
        ]);
        assert!(compute_can_manage(
            Some("owner"),
            "member",
            "guild-1",
            &roles,
            &["role-officer"],
        ));
    }

    #[test]
    fn an_unrelated_role_is_not_sufficient() {
        // SEND_MESSAGES only — an ordinary member, the escalation this check
        // exists to close.
        let roles = HashMap::from([("guild-1", 0u64), ("role-member", 0x800)]);
        assert!(!compute_can_manage(
            Some("owner"),
            "member",
            "guild-1",
            &roles,
            &["role-member"],
        ));
    }

    #[test]
    fn a_role_id_absent_from_the_guilds_role_list_contributes_nothing() {
        // Defensive: a role id the guild payload didn't describe (stale cache,
        // a role deleted between the two requests, ...) must not panic or be
        // treated as "unknown therefore allow."
        let roles = HashMap::from([("guild-1", 0u64)]);
        assert!(!compute_can_manage(
            Some("owner"),
            "member",
            "guild-1",
            &roles,
            &["role-deleted"],
        ));
    }

    fn stub_key() -> Key {
        Key::generate()
    }

    fn registerable_guilds_cookie(key: &Key, guilds: &[RegisterableGuild]) -> String {
        let json = serde_json::to_string(guilds).expect("serializes");
        let jar = PrivateCookieJar::new(key.clone()).add(("registerable_guilds", json));
        let response = jar.into_response();
        response
            .headers()
            .get(axum::http::header::SET_COOKIE)
            .expect("set-cookie")
            .to_str()
            .expect("ascii cookie")
            .split(';')
            .next()
            .expect("cookie pair")
            .to_owned()
    }

    fn guild(id: &str, can_manage: bool) -> RegisterableGuild {
        RegisterableGuild {
            id: id.to_owned(),
            name: "Guild".to_owned(),
            icon_hash: None,
            can_manage,
        }
    }

    #[test]
    fn cookie_confirms_can_manage_only_for_a_flagged_guild() {
        let key = stub_key();
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            registerable_guilds_cookie(&key, &[guild("111", true), guild("222", false)])
                .parse()
                .expect("header value"),
        );
        assert!(cookie_confirms_can_manage(&headers, key.clone(), "111"));
        assert!(!cookie_confirms_can_manage(&headers, key.clone(), "222"));
        assert!(!cookie_confirms_can_manage(&headers, key, "333"));
    }

    #[test]
    fn missing_or_unreadable_cookie_never_confirms_management() {
        let key = stub_key();
        assert!(!cookie_confirms_can_manage(
            &HeaderMap::new(),
            key.clone(),
            "111"
        ));

        let mut garbled = HeaderMap::new();
        garbled.insert(
            axum::http::header::COOKIE,
            "registerable_guilds=not-a-valid-cookie-for-this-key"
                .parse()
                .expect("header value"),
        );
        assert!(!cookie_confirms_can_manage(&garbled, key, "111"));
    }
}
