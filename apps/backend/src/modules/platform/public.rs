//! Unauthenticated and first-time-onboarding tenant routes (`/api/tenants`).

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::{get, post},
};
use axum_extra::extract::cookie::{Key, PrivateCookieJar};
use serde::Deserialize;

use crate::config::Config;
use crate::errors::{AppError, ProblemDetails};
use crate::modules::albion::client::{AlbionRegion, AlbionSearchResult};
use crate::modules::albion::service::AlbionService;
use crate::modules::auth::service::DiscordUserProfile;
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
        (status = 409, description = "Already registered", body = ProblemDetails)
    )
)]
pub async fn register_tenant(
    session: SessionUser,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(cfg): Extension<Config>,
    Json(body): Json<RegisterTenantRequest>,
) -> Result<Json<ApiResponse<TenantStatusView>>, AppError> {
    let guild_id = body.id.trim().to_owned();
    if guild_id.is_empty() {
        return Err(AppError::Validation("guild id is required".to_owned()));
    }
    let icon = fetch_discord_guild_icon(cfg.discord_bot_token.as_deref(), &guild_id).await;
    if let Some(token) = cfg.discord_bot_token.as_deref() {
        assert_guild_member(token, &guild_id, &session.profile.id).await?;
    }
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

async fn assert_guild_member(
    bot_token: &str,
    guild_id: &str,
    discord_id: &str,
) -> Result<(), AppError> {
    let url = format!("https://discord.com/api/v10/guilds/{guild_id}/members/{discord_id}");
    let response = reqwest::Client::new()
        .get(url)
        .header("Authorization", format!("Bot {bot_token}"))
        .send()
        .await
        .map_err(|err| AppError::Internal(format!("discord member lookup failed: {err}")))?;
    if response.status().as_u16() == 404 {
        return Err(AppError::Forbidden(
            "you must be a member of that Discord server to register it".to_owned(),
        ));
    }
    if !response.status().is_success() {
        return Err(AppError::Internal(format!(
            "discord member lookup returned {}",
            response.status()
        )));
    }
    Ok(())
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
