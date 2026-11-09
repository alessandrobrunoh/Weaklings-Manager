//! Unauthenticated and first-time-onboarding tenant routes (`/api/tenants`).

use std::collections::HashMap;

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    http::{HeaderMap, StatusCode},
    routing::{get, patch, post},
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
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::responses::ApiResponse;
use crate::tenant::{ControlDb, CurrentTenantId, CurrentTenantKind, TenantRegistry};

use super::models::{
    AllianceContextView, AllianceMemberView, AttachableGuildView, PatchAllianceMemberRequest,
    RegisterTenantRequest, TenantStatusView,
};
use super::service::PlatformService;

/// Public tenant onboarding router (no tenant `search_path`).
pub fn router() -> Router {
    Router::new()
        .route("/{id}/status", get(tenant_status))
        .route(
            "/{id}/capabilities",
            get(crate::modules::capabilities::router::tenant_capabilities),
        )
        .route("/register", post(register_tenant))
        .route("/albion-search", get(albion_search))
        .route("/albion-alliances", get(albion_alliances))
        .route("/attachable-guilds", get(attachable_guilds))
}

/// Alliance membership routes (control-plane, no tenant `search_path`).
pub fn alliance_router() -> Router {
    Router::new()
        .route("/me", get(my_alliance_context))
        .route("/{id}/members", get(list_alliance_members))
        .route(
            "/{alliance_id}/members/{guild_id}",
            patch(patch_alliance_member),
        )
        .route(
            "/{alliance_id}/members/{guild_id}/accept",
            post(accept_alliance_member),
        )
        .route(
            "/{alliance_id}/members/{guild_id}/invite",
            post(invite_alliance_member),
        )
        .route(
            "/{alliance_id}/members/{guild_id}/decline",
            post(decline_alliance_member),
        )
        .route(
            "/{alliance_id}/members/{guild_id}/leave",
            post(leave_alliance_member),
        )
        .route("/{id}/reset-setup", post(reset_alliance_setup))
        .route("/{id}/setup", post(configure_alliance_setup))
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
    responses((status = 200, description = "Registration status", body = ApiResponse<TenantStatusView>))
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
    responses((status = 200, description = "Albion search results", body = ApiResponse<AlbionSearchResult>))
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

/// Guild tenants the caller can attach while registering an alliance.
#[utoipa::path(
    get,
    path = "/api/tenants/attachable-guilds",
    tag = "platform",
    responses(
        (status = 200, description = "Attachable guild tenants", body = ApiResponse<Vec<AttachableGuildView>>),
        (status = 401, description = "No session", body = ApiResponse<Vec<AttachableGuildView>>)
    )
)]
pub async fn attachable_guilds(
    session: SessionUser,
    headers: HeaderMap,
    Extension(key): Extension<Key>,
    Extension(control): Extension<ControlDb>,
    Query(query): Query<AttachableGuildQuery>,
) -> Result<Json<ApiResponse<Vec<AttachableGuildView>>>, AppError> {
    let managed = managed_guild_ids_from_cookie(&headers, key);
    if let Some(alliance_id) = query
        .albion_alliance_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        let region = query.region.as_deref().unwrap_or("europe");
        return Ok(Json(ApiResponse::new(
            PlatformService::list_attachable_guilds_in_alliance(&control.0, alliance_id, region)
                .await?,
        )));
    }
    Ok(Json(ApiResponse::new(
        PlatformService::list_attachable_guilds(&control.0, &session.profile.id, &managed).await?,
    )))
}

#[derive(Debug, Deserialize)]
pub struct AttachableGuildQuery {
    pub albion_alliance_id: Option<String>,
    pub region: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AllianceSetupBody {
    pub albion_alliance_id: String,
    pub albion_api_region: String,
    pub member_guild_ids: Vec<String>,
}

pub async fn albion_alliances(
    _profile: SessionUser,
    Query(query): Query<AlbionSearchQuery>,
) -> Result<Json<ApiResponse<Vec<super::models::AlbionAllianceChoice>>>, AppError> {
    let q = query.q.trim();
    if q.is_empty() {
        return Err(AppError::Validation("q is required".to_owned()));
    }
    let region = AlbionRegion::from_env_str(query.region.as_deref().unwrap_or("europe"));
    let hits = AlbionService::new(region, String::new())
        .search_alliances(q)
        .await?;
    Ok(Json(ApiResponse::new(
        hits.into_iter()
            .map(|(id, name)| super::models::AlbionAllianceChoice { id, name })
            .collect(),
    )))
}

pub async fn reset_alliance_setup(
    session: SessionUser,
    Extension(control): Extension<ControlDb>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    PlatformService::reset_alliance_setup(&control.0, &id, &session.profile.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn configure_alliance_setup(
    session: SessionUser,
    Extension(control): Extension<ControlDb>,
    Path(id): Path<String>,
    Json(body): Json<AllianceSetupBody>,
) -> Result<StatusCode, AppError> {
    PlatformService::configure_alliance_setup(
        &control.0,
        &id,
        &session.profile.id,
        body.albion_alliance_id.trim(),
        body.albion_api_region.trim(),
        &body.member_guild_ids,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Alliance membership and names for the session's current tenant.
#[utoipa::path(
    get,
    path = "/api/alliances/me",
    tag = "platform",
    responses(
        (status = 200, description = "Alliance context", body = ApiResponse<AllianceContextView>),
        (status = 401, description = "No session", body = ApiResponse<AllianceContextView>),
        (status = 404, description = "No tenant on the session", body = ProblemDetails)
    )
)]
pub async fn my_alliance_context(
    session: SessionUser,
    Extension(control): Extension<ControlDb>,
) -> Result<Json<ApiResponse<AllianceContextView>>, AppError> {
    let tenant_id = session
        .profile
        .tenant_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| AppError::NotFound("no tenant on this session".to_owned()))?;
    Ok(Json(ApiResponse::new(
        PlatformService::alliance_context_for_tenant(&control.0, tenant_id).await?,
    )))
}

/// Guilds invited into an alliance, with pending/active status.
#[utoipa::path(
    get,
    path = "/api/alliances/{id}/members",
    tag = "platform",
    params(("id" = String, Path, description = "Alliance tenant id")),
    responses(
        (status = 200, description = "Alliance memberships", body = ApiResponse<Vec<AllianceMemberView>>),
        (status = 401, description = "No session", body = ApiResponse<Vec<AllianceMemberView>>),
        (status = 403, description = "Caller is not in this alliance", body = ProblemDetails),
        (status = 404, description = "Not an alliance", body = ProblemDetails)
    )
)]
pub async fn list_alliance_members(
    session: SessionUser,
    Extension(control): Extension<ControlDb>,
    Path(id): Path<String>,
) -> Result<Json<ApiResponse<Vec<AllianceMemberView>>>, AppError> {
    let session_tenant = session
        .profile
        .tenant_id
        .as_deref()
        .filter(|tenant| !tenant.is_empty());
    let membership = match session_tenant {
        Some(tenant) if tenant != id.as_str() => {
            PlatformService::alliance_membership_status(&control.0, &id, tenant).await?
        }
        _ => None,
    };
    if !alliance_members_visible(
        session.profile.is_superadmin,
        session_tenant,
        &id,
        membership.as_deref(),
    ) {
        return Err(AppError::Forbidden(
            "alliance membership is required to list its guilds".to_owned(),
        ));
    }
    Ok(Json(ApiResponse::new(
        PlatformService::list_alliance_members(&control.0, &id).await?,
    )))
}

/// Who may read an alliance's guild list.
///
/// The alliance tenant itself, a guild with any membership row in that alliance
/// (pending or active — the same audience as `/api/alliances/me`), or a platform
/// admin. Any other authenticated session is refused.
#[must_use]
pub fn alliance_members_visible(
    is_superadmin: bool,
    session_tenant_id: Option<&str>,
    alliance_id: &str,
    session_guild_membership: Option<&str>,
) -> bool {
    if is_superadmin {
        return true;
    }
    let Some(session_tenant) = session_tenant_id.filter(|id| !id.is_empty()) else {
        return false;
    };
    if session_tenant == alliance_id {
        return true;
    }
    session_guild_membership.is_some_and(|status| !status.is_empty())
}

/// Guild owner declines a pending alliance invite.
pub async fn decline_alliance_member(
    session: SessionUser,
    Extension(control): Extension<ControlDb>,
    Path((alliance_id, guild_id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    PlatformService::decline_alliance_membership(
        &control.0,
        &alliance_id,
        &guild_id,
        &session.profile.id,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Member guild leaves its active alliance membership.
#[utoipa::path(
    post,
    path = "/api/alliances/{alliance_id}/members/{guild_id}/leave",
    tag = "platform",
    params(
        ("alliance_id" = String, Path, description = "Alliance tenant id"),
        ("guild_id" = String, Path, description = "Guild tenant id")
    ),
    responses(
        (status = 200, description = "Membership left; historical rows kept", body = ApiResponse<AllianceMemberView>),
        (status = 401, description = "No session", body = ApiResponse<AllianceMemberView>),
        (status = 403, description = "Caller cannot leave for this guild", body = ProblemDetails),
        (status = 404, description = "Active membership not found", body = ProblemDetails),
        (status = 409, description = "Invite is still pending", body = ProblemDetails)
    )
)]
#[allow(clippy::too_many_arguments)]
pub async fn leave_alliance_member(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(control): Extension<ControlDb>,
    Extension(cfg): Extension<Config>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(tenant): Extension<CurrentTenantId>,
    Extension(kind): Extension<CurrentTenantKind>,
    Path((alliance_id, guild_id)): Path<(String, String)>,
) -> Result<Json<ApiResponse<AllianceMemberView>>, AppError> {
    if kind.0 != "guild" || tenant.0 != guild_id {
        return Err(AppError::Forbidden(
            "alliance leave is only available in the member guild".to_owned(),
        ));
    }
    let granted = user
        .has_permission(&perms, crate::modules::auth::Permission::AllianceLeave)
        .await;
    let mut untracked = Vec::new();
    if let Ok(guild) = registry.get_or_load(&guild_id).await {
        if let Some(role_id) =
            crate::modules::albion::discord_guild_role::configured_alliance_role_id(&guild.db).await
        {
            untracked.push(super::service::UntrackedAllianceRole {
                discord_guild_id: guild_id.clone(),
                role_id,
            });
        }
    } else {
        tracing::warn!(
            "alliance leave: guild tenant could not be loaded; alliance role recipients were not guessed"
        );
    }
    if let Some(member) = PlatformService::list_alliance_members(&control.0, &alliance_id)
        .await?
        .into_iter()
        .find(|row| row.guild_tenant_id == guild_id)
        && let Some(role_id) = member.discord_role_id
    {
        untracked.push(super::service::UntrackedAllianceRole {
            discord_guild_id: alliance_id.clone(),
            role_id,
        });
    }
    Ok(Json(ApiResponse::new(
        PlatformService::leave_active_alliance(
            &control.0,
            &alliance_id,
            &guild_id,
            &user.id,
            granted,
            &untracked,
            |discord_guild_id: &str, discord_user_id: &str, role_id: &str| {
                let cfg = cfg.clone();
                let discord_guild_id = discord_guild_id.to_owned();
                let discord_user_id = discord_user_id.to_owned();
                let role_id = role_id.to_owned();
                async move {
                    crate::modules::albion::discord_guild_role::revoke_discord_role_verified(
                        &cfg,
                        &discord_guild_id,
                        &discord_user_id,
                        &role_id,
                    )
                    .await
                }
            },
        )
        .await?,
    )))
}

/// Alliance owner invites a guild, including one that previously left.
#[utoipa::path(
    post,
    path = "/api/alliances/{alliance_id}/members/{guild_id}/invite",
    tag = "platform",
    params(
        ("alliance_id" = String, Path, description = "Alliance tenant id"),
        ("guild_id" = String, Path, description = "Guild tenant id")
    ),
    responses(
        (status = 200, description = "Invite recorded on the existing membership row", body = ApiResponse<AllianceMemberView>),
        (status = 401, description = "No session", body = ApiResponse<AllianceMemberView>),
        (status = 403, description = "Caller does not own this alliance", body = ProblemDetails),
        (status = 409, description = "Guild already has a live membership", body = ProblemDetails)
    )
)]
pub async fn invite_alliance_member(
    session: SessionUser,
    Extension(control): Extension<ControlDb>,
    Path((alliance_id, guild_id)): Path<(String, String)>,
) -> Result<Json<ApiResponse<AllianceMemberView>>, AppError> {
    Ok(Json(ApiResponse::new(
        PlatformService::invite_alliance_membership(
            &control.0,
            &alliance_id,
            &guild_id,
            &session.profile.id,
        )
        .await?,
    )))
}

/// Guild owner accepts a pending alliance invite.
#[utoipa::path(
    post,
    path = "/api/alliances/{alliance_id}/members/{guild_id}/accept",
    tag = "platform",
    params(
        ("alliance_id" = String, Path, description = "Alliance tenant id"),
        ("guild_id" = String, Path, description = "Guild tenant id")
    ),
    responses(
        (status = 200, description = "Membership accepted", body = ApiResponse<AllianceMemberView>),
        (status = 401, description = "No session", body = ApiResponse<AllianceMemberView>),
        (status = 403, description = "Caller is not the guild owner", body = ProblemDetails),
        (status = 404, description = "Invite not found", body = ProblemDetails)
    )
)]
pub async fn accept_alliance_member(
    session: SessionUser,
    Extension(control): Extension<ControlDb>,
    Path((alliance_id, guild_id)): Path<(String, String)>,
) -> Result<Json<ApiResponse<AllianceMemberView>>, AppError> {
    Ok(Json(ApiResponse::new(
        PlatformService::accept_alliance_membership(
            &control.0,
            &alliance_id,
            &guild_id,
            &session.profile.id,
        )
        .await?,
    )))
}

/// Alliance admin sets the hub Discord role for one member guild.
#[utoipa::path(
    patch,
    path = "/api/alliances/{alliance_id}/members/{guild_id}",
    tag = "platform",
    params(
        ("alliance_id" = String, Path, description = "Alliance tenant id"),
        ("guild_id" = String, Path, description = "Guild tenant id")
    ),
    request_body(content = PatchAllianceMemberRequest),
    responses(
        (status = 200, description = "Membership updated", body = ApiResponse<AllianceMemberView>),
        (status = 400, description = "Invalid Discord role id", body = ApiResponse<AllianceMemberView>),
        (status = 401, description = "No session", body = ProblemDetails),
        (status = 403, description = "Lacks admin.settings.manage or not the alliance session", body = ProblemDetails),
        (status = 404, description = "Membership not found", body = ProblemDetails)
    )
)]
pub async fn patch_alliance_member(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(control): Extension<ControlDb>,
    Extension(tenant): Extension<CurrentTenantId>,
    Extension(kind): Extension<CurrentTenantKind>,
    Path((alliance_id, guild_id)): Path<(String, String)>,
    Json(body): Json<PatchAllianceMemberRequest>,
) -> Result<Json<ApiResponse<AllianceMemberView>>, AppError> {
    user.require(&perms, Permission::AdminSettingsManage)
        .await?;
    if kind.0 != "alliance" || tenant.0 != alliance_id {
        return Err(AppError::Forbidden(
            "per-guild alliance roles can only be set from the alliance Discord".to_owned(),
        ));
    }
    Ok(Json(ApiResponse::new(
        PlatformService::set_alliance_member_discord_role(
            &control.0,
            &alliance_id,
            &guild_id,
            body.discord_role_id.as_deref(),
        )
        .await?,
    )))
}

/// First-time tenant registration. The caller becomes the tenant `SuperAdmin` (`owner_discord_id`).
#[utoipa::path(
    post,
    path = "/api/tenants/register",
    tag = "platform",
    responses(
        (status = 200, description = "Tenant registered", body = ApiResponse<TenantStatusView>),
        (status = 401, description = "No session", body = ApiResponse<TenantStatusView>),
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
        kind: Some(view.kind),
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
        let store = parts
            .extensions
            .get::<crate::modules::auth::SessionStore>()
            .cloned()
            .ok_or_else(|| AppError::Internal("session store missing".to_owned()))?;
        let profile =
            crate::modules::auth::session_store::require_session(&parts.headers, &key, &store)
                .await?
                .profile;
        Ok(Self { profile })
    }
}

/// Requires that `discord_id` owns or manages `guild_id`.
///
/// Registering a tenant hands the caller its owner/SuperAdmin seat, so plain
/// Discord membership — all the check this replaces ever verified, and only
/// when `DISCORD_BOT_TOKEN` happened to be set — is not the right bar.
///
/// When `DISCORD_BOT_TOKEN` is set, only a live bot lookup counts. The
/// `registerable_guilds` cookie is a fallback for deployments without a usable
/// bot token: it is only as fresh as the last OAuth login and must not keep
/// manage rights after Discord has revoked them.
///
/// Fails closed: no confirming signal is a `403`. A live lookup that cannot
/// reach Discord is an internal error, not a cookie bypass.
async fn assert_can_manage_guild(
    headers: &HeaderMap,
    key: Key,
    guild_id: &str,
    discord_id: &str,
    bot_token: Option<&str>,
) -> Result<(), AppError> {
    // A bot token makes the live lookup authoritative. The login cookie is only
    // a fallback when that lookup cannot be done: it is not refreshed on role
    // revocation and must not keep manage rights afterwards.
    if let Some(bot_token) = bot_token.filter(|token| {
        let token = token.trim();
        !token.is_empty() && token != "your_discord_bot_token"
    }) {
        return if live_check_confirms_can_manage(bot_token, guild_id, discord_id).await? {
            Ok(())
        } else {
            Err(AppError::Forbidden(
                "you must own or manage that Discord server to register it".to_owned(),
            ))
        };
    }
    if cookie_confirms_can_manage(headers, key, guild_id) {
        return Ok(());
    }
    Err(AppError::Forbidden(
        "you must own or manage that Discord server to register it".to_owned(),
    ))
}

fn cookie_confirms_can_manage(headers: &HeaderMap, key: Key, guild_id: &str) -> bool {
    managed_guild_ids_from_cookie(headers, key)
        .iter()
        .any(|id| id == guild_id)
}

fn managed_guild_ids_from_cookie(headers: &HeaderMap, key: Key) -> Vec<String> {
    let jar = PrivateCookieJar::from_headers(headers, key);
    let stored: Vec<RegisterableGuild> = jar
        .get("registerable_guilds")
        .and_then(|cookie| serde_json::from_str(cookie.value()).ok())
        .unwrap_or_default();
    stored
        .into_iter()
        .filter(|guild| guild.can_manage)
        .map(|guild| guild.id)
        .collect()
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
    let client = crate::http_client::shared();

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

pub(crate) async fn fetch_discord_guild_icon(
    bot_token: Option<&str>,
    guild_id: &str,
) -> Option<String> {
    let token = bot_token?;
    let url = format!("https://discord.com/api/v10/guilds/{guild_id}");
    let response = crate::http_client::shared()
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
    fn alliance_member_list_requires_that_alliance_or_platform_admin() {
        assert!(alliance_members_visible(true, None, "alliance-1", None));
        assert!(alliance_members_visible(
            false,
            Some("alliance-1"),
            "alliance-1",
            None
        ));
        assert!(alliance_members_visible(
            false,
            Some("guild-1"),
            "alliance-1",
            Some("pending")
        ));
        assert!(alliance_members_visible(
            false,
            Some("guild-1"),
            "alliance-1",
            Some("active")
        ));
        assert!(!alliance_members_visible(
            false,
            Some("guild-2"),
            "alliance-1",
            None
        ));
        assert!(!alliance_members_visible(false, None, "alliance-1", None));
        assert!(!alliance_members_visible(
            false,
            Some(""),
            "alliance-1",
            Some("active")
        ));
    }

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
        assert!(compute_can_manage(
            Some("owner"),
            "member",
            "guild-1",
            &roles,
            &[]
        ));
    }

    #[test]
    fn a_held_role_with_manage_guild_is_sufficient() {
        let roles = HashMap::from([("guild-1", 0u64), ("role-officer", PERMISSION_MANAGE_GUILD)]);
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
