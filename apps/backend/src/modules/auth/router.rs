//! Auth routing module.
//!
//! Exposes HTTP endpoints for `OAuth2` login flows, session query, and logout.

use super::permission_cache::Permissions;
use super::service::{
    AuthService, DiscordGuild, DiscordUserProfile, OauthPending, RegisterableGuild, TenantChoice,
    matching_tenants,
};
use crate::config::Config;
use crate::errors::{AppError, ProblemDetails};
use crate::modules::admin::models::BrandColorsView;
use crate::modules::admin::service::AdminService;
use crate::platform_admins::PlatformAdmins;
use crate::postgres::list_active_tenants;
use crate::responses::{ApiResponse, ApiResponseDiscordUserProfile};
use crate::tenant::{ControlDb, TenantRegistry};
use axum::{
    Extension, Json, Router,
    extract::Query,
    http::HeaderMap,
    response::Redirect,
    routing::{get, post},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, Key, PrivateCookieJar, SameSite};
use rand::distributions::{Alphanumeric, DistString};
use sea_orm::EntityTrait;
use serde::Deserialize;

/// Query parameters returned by Discord to the callback URI.
#[derive(Debug, Deserialize)]
pub struct CallbackQuery {
    /// The authorization code to exchange for an access token.
    pub code: String,
    /// The state string passed in the login redirect.
    pub state: String,
}

/// Creates the router for the authentication module.
pub fn router() -> Router {
    Router::new()
        .route("/discord/login", get(discord_login))
        .route("/discord/callback", get(discord_callback))
        .route("/pending-tenants", get(pending_tenants))
        .route("/select-tenant", post(select_tenant))
        .route("/tenants", get(list_session_tenants))
        .route("/registerable-guilds", get(list_registerable_guilds))
        .route("/bot-invite", get(bot_invite))
        .route("/switch-tenant", post(switch_tenant))
        .route("/me", get(get_me))
        .route("/logout", post(logout))
}

/// Optional `next` path after Discord OAuth (must be a relative path).
#[derive(Debug, Deserialize)]
pub struct LoginQuery {
    /// Relative frontend path to return to, e.g. `/register-tenant?guild=…`.
    pub next: Option<String>,
}

/// Redirects to Discord's `OAuth2` authorization page.
///
/// Generates a unique state parameter for CSRF mitigation and stores it in an HTTP-only cookie.
#[utoipa::path(
    get,
    path = "/api/auth/discord/login",
    tag = "auth",
    summary = "Step 1: start the login flow",
    description = "Navigate the browser here (a full page redirect, not a fetch/XHR call — e.g. \
        `window.location.href = \"/api/auth/discord/login\"`) to begin login. Generates a CSRF \
        state token, stores it in a short-lived `oauth_state` cookie, and 307-redirects the browser \
        to Discord's own authorization page. Discord will redirect back to \
        `GET /api/auth/discord/callback` once the user approves. No request body, no auth required.",
    responses(
        (status = 307, description = "Redirects the browser to Discord's OAuth2 authorization page")
    )
)]
pub async fn discord_login(
    Extension(cfg): Extension<Config>,
    jar: CookieJar,
    Query(query): Query<LoginQuery>,
) -> (CookieJar, Redirect) {
    // Generate a secure CSRF state token
    let state = Alphanumeric.sample_string(&mut rand::thread_rng(), 32);

    // Save the state in a secure cookie
    let state_cookie = Cookie::build(("oauth_state", state.clone()))
        .path("/api/auth")
        .http_only(true)
        .secure(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::minutes(10));

    let mut jar = jar.add(state_cookie);
    if let Some(next) = safe_next_path(query.next.as_deref()) {
        jar = jar.add(
            Cookie::build(("oauth_next", next))
                .path("/api/auth")
                .http_only(true)
                .secure(true)
                .same_site(SameSite::Lax)
                .max_age(time::Duration::minutes(10)),
        );
    }

    // Build Discord authorize URL
    // Scope: identify and email
    let auth_url = format!(
        "https://discord.com/api/oauth2/authorize?client_id={}&redirect_uri={}&response_type=code&scope=identify%20email%20guilds&state={}",
        cfg.discord_client_id,
        urlencoding::encode(&cfg.discord_redirect_uri),
        state
    );

    (jar, Redirect::temporary(&auth_url))
}

/// Callback URI invoked by Discord after authorization.
///
/// Validates the CSRF state cookie, exchanges the code for a token, retrieves the Discord profile,
/// serializes it into a secure `session_user` cookie, and redirects the browser back to `/dashboard`.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the CSRF state token does not match.
/// * Returns `AppError::Unauthorized` if Discord token exchange or profile fetch fails.
#[utoipa::path(
    get,
    path = "/api/auth/discord/callback",
    tag = "auth",
    summary = "Step 2: Discord redirects here automatically — never called directly by the frontend",
    description = "The frontend should never link to or fetch this endpoint itself; it exists purely \
        because it's the `redirect_uri` registered with Discord and passed to step 1. Verifies the \
        `state` param against the `oauth_state` cookie (CSRF), exchanges `code` for a Discord access \
        token, fetches the Discord profile, resolves the user's guild roles into `User`/`Officer`/ \
        `Admin`/`SuperAdmin`, upserts the local `users` row, sets the httponly `session_user` cookie \
        (7-day expiry), and 307-redirects the browser to `{FRONTEND_URL}/dashboard`. After this \
        redirect lands, call `GET /api/auth/me` to read the now-active session.",
    params(
        ("code" = String, Query, description = "OAuth2 authorization code from Discord"),
        ("state" = String, Query, description = "CSRF state token sent in the login redirect")
    ),
    responses(
        (status = 307, description = "Login succeeded; redirects the browser to the frontend's /dashboard with the session cookie set"),
        (status = 403, description = "Forbidden - CSRF verification failed (state mismatch or expired cookie); restart at step 1", body = ProblemDetails),
        (status = 401, description = "Unauthorized - Discord rejected the code, or the Discord profile fetch failed", body = ProblemDetails)
    )
)]
#[allow(clippy::too_many_arguments)]
pub async fn discord_callback(
    Extension(cfg): Extension<Config>,
    Extension(admins): Extension<PlatformAdmins>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(key): Extension<Key>,
    jar: CookieJar,
    headers: HeaderMap,
    Query(query): Query<CallbackQuery>,
) -> Result<(CookieJar, PrivateCookieJar, Redirect), AppError> {
    // Retrieve the state cookie
    let cookie_state = jar.get("oauth_state").map(|c| c.value().to_string());

    // Clean up the state cookie immediately
    let next_path = jar
        .get("oauth_next")
        .map(|c| c.value().to_string())
        .and_then(|value| safe_next_path(Some(&value)));
    let jar = jar
        .remove(Cookie::from("oauth_state"))
        .remove(Cookie::from("oauth_next"));

    // Verify CSRF state token to prevent session fixation and CSRF attacks
    if cookie_state.is_none() || cookie_state.as_ref() != Some(&query.state) {
        return Err(AppError::Forbidden(
            "CSRF token verification failed: state mismatch or cookie expired".to_string(),
        ));
    }

    let service = AuthService::new();

    // Exchange code for Access Token
    let token_resp = service
        .exchange_code(
            &cfg.discord_client_id,
            &cfg.discord_client_secret,
            &query.code,
            &cfg.discord_redirect_uri,
        )
        .await?;

    let profile = service.fetch_profile(&token_resp.access_token).await?;
    let user_guilds = service.fetch_user_guilds(&token_resp.access_token).await?;
    let matches = matching_tenants(&user_guilds, &registered_tenants(&control.0).await?);

    if next_path
        .as_deref()
        .is_some_and(|path| path.starts_with("/register-tenant"))
    {
        let private_jar = with_registerable_guilds(
            PrivateCookieJar::from_headers(&headers, key)
                .add(session_cookie(&profile)?)
                .remove(pending_cookie_tombstone()),
            &user_guilds,
        )?;
        let dest = format!("{}{}", cfg.frontend_url, next_path.unwrap());
        return Ok((jar, private_jar, Redirect::temporary(&dest)));
    }

    let after_login = |path: &str| format!("{}{path}", cfg.frontend_url);

    match matches.as_slice() {
        [] => {
            let private_jar = with_registerable_guilds(
                PrivateCookieJar::from_headers(&headers, key)
                    .add(session_cookie(&profile)?)
                    .remove(pending_cookie_tombstone()),
                &user_guilds,
            )?;
            Ok((
                jar,
                private_jar,
                Redirect::temporary(&format!("{}/needs-tenant", cfg.frontend_url)),
            ))
        }
        [tenant] => {
            let profile = finalize_session(
                &cfg,
                &registry,
                &admins,
                &control.0,
                &token_resp.access_token,
                profile,
                tenant,
            )
            .await?;
            let private_jar = with_registerable_guilds(
                PrivateCookieJar::from_headers(&headers, key)
                    .add(session_cookie(&profile)?)
                    .remove(pending_cookie_tombstone()),
                &user_guilds,
            )?;
            Ok((
                jar,
                private_jar,
                Redirect::temporary(&after_login(next_path.as_deref().unwrap_or("/dashboard"))),
            ))
        }
        _ => {
            let pending = OauthPending {
                access_token: token_resp.access_token,
                profile,
                tenants: matches,
            };
            let pending_json = serde_json::to_string(&pending).map_err(|e| {
                AppError::Internal(format!("failed to serialize pending oauth: {e}"))
            })?;
            let private_jar = with_registerable_guilds(
                PrivateCookieJar::from_headers(&headers, key).add(pending_cookie(pending_json)),
                &user_guilds,
            )?;
            Ok((
                jar,
                private_jar,
                Redirect::temporary(&format!("{}/choose-server", cfg.frontend_url)),
            ))
        }
    }
}

/// Tenants shown on the choose-server page (from the pending OAuth cookie).
#[utoipa::path(
    get,
    path = "/api/auth/pending-tenants",
    tag = "auth",
    summary = "List Discord servers the user can enter after OAuth",
    responses(
        (status = 200, description = "Pending tenant choices"),
        (status = 401, description = "No pending OAuth pick", body = ProblemDetails)
    )
)]
pub async fn pending_tenants(
    headers: HeaderMap,
    Extension(key): Extension<Key>,
) -> Result<Json<ApiResponse<Vec<TenantChoice>>>, AppError> {
    let pending = read_pending(&headers, key)?;
    Ok(Json(ApiResponse::new(pending.tenants)))
}

/// Body for finishing a multi-match OAuth login.
#[derive(Debug, Deserialize)]
pub struct SelectTenantBody {
    /// Discord guild / tenant id chosen by the user.
    pub tenant_id: String,
}

/// Completes login after the user picks a server.
#[utoipa::path(
    post,
    path = "/api/auth/select-tenant",
    tag = "auth",
    summary = "Finish login with the chosen Discord server",
    responses(
        (status = 200, description = "Session established", body = ApiResponseDiscordUserProfile),
        (status = 401, description = "No pending OAuth pick", body = ProblemDetails),
        (status = 403, description = "Chosen tenant is not in the pending set", body = ProblemDetails)
    )
)]
pub async fn select_tenant(
    headers: HeaderMap,
    Extension(cfg): Extension<Config>,
    Extension(admins): Extension<PlatformAdmins>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(key): Extension<Key>,
    Json(body): Json<SelectTenantBody>,
) -> Result<(PrivateCookieJar, Json<ApiResponse<DiscordUserProfile>>), AppError> {
    let pending = read_pending(&headers, key.clone())?;
    let tenant = pending
        .tenants
        .iter()
        .find(|tenant| tenant.id == body.tenant_id)
        .cloned()
        .ok_or_else(|| {
            AppError::Forbidden("chosen server is not in your Discord guilds".to_owned())
        })?;
    let profile = finalize_session(
        &cfg,
        &registry,
        &admins,
        &control.0,
        &pending.access_token,
        pending.profile,
        &tenant,
    )
    .await?;
    let jar = PrivateCookieJar::from_headers(&headers, key)
        .add(session_cookie(&profile)?)
        .remove(pending_cookie_tombstone());
    Ok((jar, Json(ApiResponse::new(profile))))
}

/// Tenants the current session may switch into.
#[utoipa::path(
    get,
    path = "/api/auth/tenants",
    tag = "auth",
    responses((status = 200, description = "Accessible tenants"))
)]
pub async fn list_session_tenants(
    headers: HeaderMap,
    Extension(control): Extension<ControlDb>,
    Extension(admins): Extension<PlatformAdmins>,
    Extension(key): Extension<Key>,
) -> Result<Json<ApiResponse<Vec<TenantChoice>>>, AppError> {
    let profile = read_session_profile(&headers, key)?;
    let all = admins.contains(&profile.id);
    Ok(Json(ApiResponse::new(
        crate::modules::platform::service::PlatformService::list_memberships(
            &control.0,
            &profile.id,
            all,
        )
        .await?,
    )))
}

/// Switch the session to another tenant the user already belongs to.
#[utoipa::path(
    post,
    path = "/api/auth/switch-tenant",
    tag = "auth",
    responses((status = 200, description = "Session re-scoped"))
)]
pub async fn switch_tenant(
    headers: HeaderMap,
    Extension(cfg): Extension<Config>,
    Extension(admins): Extension<PlatformAdmins>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(key): Extension<Key>,
    Json(body): Json<SelectTenantBody>,
) -> Result<(PrivateCookieJar, Json<ApiResponse<DiscordUserProfile>>), AppError> {
    let profile = read_session_profile(&headers, key.clone())?;
    let allowed = admins.contains(&profile.id)
        || crate::modules::platform::service::PlatformService::is_member(
            &control.0,
            &profile.id,
            &body.tenant_id,
        )
        .await?;
    if !allowed {
        return Err(AppError::Forbidden(
            "you are not a member of that tenant".to_owned(),
        ));
    }
    let tenants = crate::modules::platform::service::PlatformService::list_memberships(
        &control.0,
        &profile.id,
        admins.contains(&profile.id),
    )
    .await?;
    let tenant = tenants
        .into_iter()
        .find(|tenant| tenant.id == body.tenant_id)
        .ok_or_else(|| AppError::NotFound(format!("tenant {} not found", body.tenant_id)))?;
    let profile =
        finalize_session(&cfg, &registry, &admins, &control.0, "", profile, &tenant).await?;
    let jar = PrivateCookieJar::from_headers(&headers, key).add(session_cookie(&profile)?);
    Ok((jar, Json(ApiResponse::new(profile))))
}

/// Discord servers the caller belongs to that are not yet tenants.
#[utoipa::path(
    get,
    path = "/api/auth/registerable-guilds",
    tag = "auth",
    responses((status = 200, description = "Guilds available to register"))
)]
pub async fn list_registerable_guilds(
    headers: HeaderMap,
    Extension(control): Extension<ControlDb>,
    Extension(key): Extension<Key>,
) -> Result<Json<ApiResponse<Vec<RegisterableGuild>>>, AppError> {
    let _profile = read_session_profile(&headers, key.clone())?;
    let jar = PrivateCookieJar::from_headers(&headers, key);
    let stored = jar
        .get("registerable_guilds")
        .and_then(|cookie| serde_json::from_str::<Vec<RegisterableGuild>>(cookie.value()).ok())
        .unwrap_or_default();
    let registered: std::collections::HashSet<String> = registered_tenants(&control.0)
        .await?
        .into_iter()
        .map(|tenant| tenant.id)
        .collect();
    Ok(Json(ApiResponse::new(
        stored
            .into_iter()
            .filter(|guild| !registered.contains(&guild.id))
            .collect(),
    )))
}

/// Discord permission bitfield the bot is invited with.
///
/// View Channels, Send Messages, Manage Messages, Embed Links, Attach Files,
/// Read Message History, Mention Everyone, Add Reactions and Manage Roles —
/// the set the guild automations (autorole, event pings, tickets) rely on.
const BOT_INVITE_PERMISSIONS: u64 = 268_692_544;

/// OAuth URL that adds the Weaklings Manager bot to a Discord server.
#[derive(Debug, Clone, serde::Serialize, utoipa::ToSchema)]
pub struct BotInvite {
    /// Ready-to-open `discord.com` authorize URL.
    pub url: String,
    /// Discord application id the invite points at.
    pub client_id: String,
}

/// Returns the bot invite link for the onboarding guide.
///
/// Public on purpose: the "add your server" page has to render before the
/// visitor has a tenant, and the URL only exposes the public application id.
#[utoipa::path(
    get,
    path = "/api/auth/bot-invite",
    tag = "auth",
    summary = "Invite URL used by the add-a-server onboarding guide",
    responses((status = 200, description = "Bot invite URL"))
)]
pub async fn bot_invite(Extension(cfg): Extension<Config>) -> Json<ApiResponse<BotInvite>> {
    let url = format!(
        "https://discord.com/oauth2/authorize?client_id={}&scope=bot%20applications.commands&permissions={BOT_INVITE_PERMISSIONS}",
        cfg.discord_client_id
    );
    Json(ApiResponse::new(BotInvite {
        url,
        client_id: cfg.discord_client_id,
    }))
}

/// The tenant's brand colours, or `None` when it has not picked any.
///
/// Never fails the caller: theming is decoration, and a session must still be
/// established when the colours cannot be read.
async fn tenant_brand(db: &sea_orm::DatabaseConnection) -> Option<BrandColorsView> {
    match AdminService::get_brand_colors(db).await {
        Ok(brand) if !brand.is_empty() => Some(brand),
        Ok(_) => None,
        Err(err) => {
            tracing::warn!(error = %err, "could not read the tenant's brand colours");
            None
        }
    }
}

/// True when the session carries no tenant to scope requests to.
fn session_needs_a_tenant(profile: &DiscordUserProfile) -> bool {
    profile
        .tenant_id
        .as_deref()
        .is_none_or(|id| id.trim().is_empty())
}

/// Re-scopes a tenant-less session onto the one registered tenant it matches.
///
/// A session opened before the user's Discord server was registered carries no
/// tenant, and nothing ever revisits that: the tenant is pinned into the cookie
/// at login and only read back. Without this the user sits on the "this server
/// is not registered" screen even after someone registers it, until they log
/// out and back in by hand.
///
/// Runs the same guild match the OAuth callback does and adopts the tenant only
/// when exactly one matches — an ambiguous set is the callback's
/// `/choose-server` case, and picking one for the user would be a guess.
///
/// Best-effort by design: a tenant that fails to open leaves the session as it
/// was rather than turning the session probe into a `500`.
async fn adopt_matching_tenant(
    jar: &PrivateCookieJar,
    cfg: &Config,
    registry: &TenantRegistry,
    admins: &PlatformAdmins,
    control: &sea_orm::DatabaseConnection,
    profile: &mut DiscordUserProfile,
) -> Result<(), AppError> {
    let candidates = adoptable_tenants(jar, control).await?;
    let [tenant] = candidates.as_slice() else {
        return Ok(());
    };
    match finalize_session(cfg, registry, admins, control, "", profile.clone(), tenant).await {
        Ok(adopted) => *profile = adopted,
        Err(err) => tracing::warn!(
            tenant_id = %tenant.id,
            error = %err,
            "could not adopt the session's matching tenant"
        ),
    }
    Ok(())
}

/// Registered tenants the session's own Discord guilds match.
///
/// Reads the guild list cached in the `registerable_guilds` cookie at login,
/// so re-resolving a tenant-less session costs one control-plane query and no
/// Discord round-trip. An unreadable or absent cookie simply yields nothing:
/// the caller then leaves the session as it was.
async fn adoptable_tenants(
    jar: &PrivateCookieJar,
    control: &sea_orm::DatabaseConnection,
) -> Result<Vec<TenantChoice>, AppError> {
    let Some(cookie) = jar.get("registerable_guilds") else {
        return Ok(Vec::new());
    };
    let Ok(cached) = serde_json::from_str::<Vec<RegisterableGuild>>(cookie.value()) else {
        return Ok(Vec::new());
    };
    if cached.is_empty() {
        return Ok(Vec::new());
    }
    let guilds: Vec<DiscordGuild> = cached
        .into_iter()
        .map(|guild| DiscordGuild {
            id: guild.id,
            name: guild.name,
            icon: guild.icon_hash,
            // `matching_tenants` below only reads `id`/`name`/`icon`; these
            // never mattered for the login-adoption path and are already
            // collapsed once into `RegisterableGuild::can_manage`.
            owner: false,
            permissions: String::new(),
        })
        .collect();
    Ok(matching_tenants(
        &guilds,
        &registered_tenants(control).await?,
    ))
}

fn with_registerable_guilds(
    jar: PrivateCookieJar,
    guilds: &[DiscordGuild],
) -> Result<PrivateCookieJar, AppError> {
    let payload: Vec<RegisterableGuild> = guilds
        .iter()
        .take(40)
        .map(|guild| RegisterableGuild {
            id: guild.id.clone(),
            name: guild.name.clone(),
            icon_hash: guild.icon.clone(),
            can_manage: guild.can_manage(),
        })
        .collect();
    let json = serde_json::to_string(&payload)
        .map_err(|err| AppError::Internal(format!("failed to serialize guild list: {err}")))?;
    Ok(jar.add(
        Cookie::build(("registerable_guilds", json))
            .path("/api/auth")
            .http_only(true)
            .secure(true)
            .same_site(SameSite::Lax)
            .max_age(time::Duration::days(7)),
    ))
}

fn read_session_profile(headers: &HeaderMap, key: Key) -> Result<DiscordUserProfile, AppError> {
    let jar = PrivateCookieJar::from_headers(headers, key);
    let cookie = jar
        .get("session_user")
        .ok_or_else(|| AppError::Unauthorized("No active session".to_owned()))?;
    serde_json::from_str(cookie.value())
        .map_err(|e| AppError::Unauthorized(format!("Invalid session cookie format: {e}")))
}

fn safe_next_path(raw: Option<&str>) -> Option<String> {
    let next = raw?.trim();
    if next.starts_with('/') && !next.starts_with("//") && !next.contains('\\') {
        Some(next.to_owned())
    } else {
        None
    }
}

fn read_pending(headers: &HeaderMap, key: Key) -> Result<OauthPending, AppError> {
    let jar = PrivateCookieJar::from_headers(headers, key);
    let cookie = jar
        .get("oauth_pending")
        .ok_or_else(|| AppError::Unauthorized("no pending server choice".to_owned()))?;
    serde_json::from_str(cookie.value())
        .map_err(|e| AppError::Unauthorized(format!("invalid pending oauth cookie: {e}")))
}

async fn registered_tenants(
    control_db: &sea_orm::DatabaseConnection,
) -> Result<Vec<TenantChoice>, AppError> {
    let active = list_active_tenants(control_db).await?;
    Ok(active
        .into_iter()
        .map(|tenant| TenantChoice {
            id: tenant.id,
            name: tenant.name,
            slug: tenant.slug,
            icon_hash: None,
        })
        .collect())
}

#[allow(clippy::too_many_arguments)]
async fn finalize_session(
    cfg: &Config,
    registry: &TenantRegistry,
    admins: &PlatformAdmins,
    control: &sea_orm::DatabaseConnection,
    access_token: &str,
    mut profile: DiscordUserProfile,
    tenant: &TenantChoice,
) -> Result<DiscordUserProfile, AppError> {
    let ctx = registry.get_or_load(&tenant.id).await?;
    profile.tenant_id = Some(tenant.id.clone());
    profile.tenant_name = Some(tenant.name.clone());
    profile.is_superadmin = admins.contains(&profile.id);
    profile.is_platform_admin = profile.is_superadmin;
    if profile.is_superadmin {
        profile.roles = vec!["SuperAdmin".to_string()];
        profile.highest_role = "SuperAdmin".to_string();
    } else {
        let (roles, highest_role) = AuthService::new()
            .fetch_member_roles(
                &ctx.db,
                &profile.id,
                access_token,
                &tenant.id,
                cfg.discord_bot_token.as_deref(),
                "",
            )
            .await;
        profile.roles = roles;
        profile.highest_role = highest_role;
    }
    profile.permissions = ctx
        .permissions
        .granted_permissions(profile.is_superadmin, &profile.roles)
        .await;
    // Modules are per-tenant, so they must be re-resolved here rather than
    // inherited. `profile` is the *previous* session on a tenant switch, and
    // leaving its `features` in place hands the new tenant whatever the old one
    // had enabled — the session then keeps that until the next `/auth/me`.
    let mut feature_keys: Vec<_> = ctx.features.iter().cloned().collect();
    feature_keys.sort();
    profile.features = feature_keys;
    // Same reasoning for the brand colours: they belong to the tenant being
    // entered, so a switch must repaint rather than carry the old server's.
    profile.brand = tenant_brand(&ctx.db).await;
    profile.user_id = AuthService::new().upsert_user(&ctx.db, &profile).await?;
    crate::modules::platform::service::PlatformService::record_membership(
        control,
        &profile.id,
        &tenant.id,
    )
    .await?;
    Ok(profile)
}

fn session_cookie(profile: &DiscordUserProfile) -> Result<Cookie<'static>, AppError> {
    let profile_json = serde_json::to_string(profile)
        .map_err(|e| AppError::Internal(format!("Failed to serialize session: {e}")))?;
    Ok(Cookie::build(("session_user", profile_json))
        .path("/")
        .http_only(true)
        .secure(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::days(7))
        .into())
}

fn pending_cookie(value: String) -> Cookie<'static> {
    Cookie::build(("oauth_pending", value))
        .path("/api/auth")
        .http_only(true)
        .secure(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::minutes(10))
        .into()
}

fn pending_cookie_tombstone() -> Cookie<'static> {
    Cookie::build(("oauth_pending", ""))
        .path("/api/auth")
        .http_only(true)
        .secure(true)
        .same_site(SameSite::Lax)
        .into()
}

/// Retrieves the profile of the currently logged-in user.
///
/// Reads and deserializes the `session_user` cookie.
///
/// # Errors
///
/// * Returns `AppError::Unauthorized` if no valid `session_user` cookie is present.
#[utoipa::path(
    get,
    path = "/api/auth/me",
    tag = "auth",
    summary = "Check whether the caller is logged in, and get their profile/roles",
    description = "Call this on app load to bootstrap auth state: reads the `session_user` cookie, \
        re-resolves Discord guild roles against linked gestionale roles when a bot token is \
        configured (so an admin linking a Discord role takes effect without a fresh OAuth login), \
        and returns the profile with `roles`, `highest_role`, and `permissions`. A `401` means \
        \"not logged in\" — render the Discord login button linking to `GET /api/auth/discord/login`.",
    responses(
        (status = 200, description = "Active session found; data is the logged-in user's Discord profile", body = ApiResponseDiscordUserProfile),
        (status = 401, description = "Unauthorized - no active session or invalid/expired session cookie", body = ProblemDetails)
    )
)]
#[allow(clippy::too_many_arguments)]
pub async fn get_me(
    headers: HeaderMap,
    Extension(cfg): Extension<Config>,
    Extension(perms): Extension<Permissions>,
    db: Option<Extension<sea_orm::DatabaseConnection>>,
    Extension(admins): Extension<PlatformAdmins>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(key): Extension<Key>,
) -> Result<(PrivateCookieJar, Json<ApiResponse<DiscordUserProfile>>), AppError> {
    let jar = PrivateCookieJar::from_headers(&headers, key);
    let session_cookie = jar
        .get("session_user")
        .ok_or_else(|| AppError::Unauthorized("No active session".to_string()))?;

    let mut profile: DiscordUserProfile = serde_json::from_str(session_cookie.value())
        .map_err(|e| AppError::Unauthorized(format!("Invalid session cookie format: {e}")))?;

    // The cookie caches the Discord username from login time; re-resolve here so a display
    // name change (e.g. linking an Albion Online character after logging in) shows up without
    // requiring a fresh login.
    profile.is_superadmin = admins.contains(&profile.id);
    profile.is_platform_admin = profile.is_superadmin;

    if session_needs_a_tenant(&profile) {
        adopt_matching_tenant(&jar, &cfg, &registry, &admins, &control.0, &mut profile).await?;
    }

    if let Some(tenant_id) = profile.tenant_id.as_deref().filter(|id| !id.is_empty()) {
        match registry.get_or_load(tenant_id).await {
            Ok(ctx) => {
                let mut keys: Vec<_> = ctx.features.iter().cloned().collect();
                keys.sort();
                profile.features = keys;
                // Re-read rather than trust the cookie, so an admin's colour
                // change reaches every other member on their next page load.
                profile.brand = tenant_brand(&ctx.db).await;
            }
            Err(_) => {
                profile.tenant_id = None;
                profile.tenant_name = None;
                profile.permissions.clear();
                profile.features.clear();
                profile.brand = None;
            }
        }
    }

    if let Some(Extension(db)) = db.as_ref() {
        if profile.user_id > 0 {
            profile.username =
                crate::modules::users::display_name::resolve_by_id(db, profile.user_id).await?;
        }
        // Roles are read from the tenant's own Discord server. Without a
        // selected tenant there is no server to ask, so the cookie's roles stand.
        if let Some(tenant_id) = profile.tenant_id.clone().filter(|id| !id.trim().is_empty()) {
            let service = AuthService::new();
            if let Some(role_ids) = service
                .fetch_guild_member_role_ids(
                    &profile.id,
                    "",
                    &tenant_id,
                    cfg.discord_bot_token.as_deref(),
                )
                .await
            {
                if profile.is_superadmin {
                    profile.roles = vec!["SuperAdmin".to_string()];
                    profile.highest_role = "SuperAdmin".to_string();
                } else {
                    let db_roles = crate::modules::auth::entities::role::Entity::find()
                        .all(db)
                        .await?;
                    let (roles, highest) =
                        crate::modules::auth::service::resolve_linked_roles(&role_ids, &db_roles);
                    profile.roles = roles;
                    profile.highest_role = highest;
                }
                persist_session_highest_role(db, profile.user_id, &profile.highest_role).await?;
            } else if profile.is_superadmin
                && !profile.roles.iter().any(|role| role == "SuperAdmin")
            {
                profile.roles.insert(0, "SuperAdmin".to_string());
                profile.highest_role = "SuperAdmin".to_string();
            }
        }
    } else if profile.is_superadmin && !profile.roles.iter().any(|role| role == "SuperAdmin") {
        profile.roles.insert(0, "SuperAdmin".to_string());
        profile.highest_role = "SuperAdmin".to_string();
    }

    profile.permissions = perms
        .granted_permissions(profile.is_superadmin, &profile.roles)
        .await;

    let profile_json = serde_json::to_string(&profile)
        .map_err(|e| AppError::Internal(format!("Failed to serialize session: {e}")))?;
    let jar = jar.add(
        Cookie::build(("session_user", profile_json))
            .path("/")
            .http_only(true)
            .secure(true)
            .same_site(SameSite::Lax)
            .max_age(time::Duration::days(7)),
    );

    Ok((jar, Json(ApiResponse::new(profile))))
}

async fn persist_session_highest_role(
    db: &sea_orm::DatabaseConnection,
    user_id: i64,
    highest_role: &str,
) -> Result<(), AppError> {
    if user_id <= 0 {
        return Ok(());
    }
    use crate::modules::users::entities::{ActiveModel as UserActive, Entity as UserEntity};
    use sea_orm::{ActiveModelTrait, EntityTrait};
    let Some(existing) = UserEntity::find_by_id(user_id).one(db).await? else {
        return Ok(());
    };
    if existing.role == highest_role {
        return Ok(());
    }
    let mut active: UserActive = existing.into();
    active.role = sea_orm::Set(highest_role.to_string());
    active.update(db).await?;
    Ok(())
}

/// Logs out the user by deleting the `session_user` cookie.
#[utoipa::path(
    post,
    path = "/api/auth/logout",
    tag = "auth",
    summary = "Log out",
    description = "Clears the `session_user` cookie. No request body. Always succeeds, even if there \
        was no active session. After calling this, redirect the user to the landing/login page — \
        `GET /api/auth/me` will now return `401`.",
    responses(
        (status = 200, description = "Logout succeeded (cookie cleared); data is null")
    )
)]
pub async fn logout(jar: CookieJar) -> (CookieJar, Json<ApiResponse<()>>) {
    // The removal cookie must match the attributes used when the session was created
    // (see `discord_callback`). Browsers only delete a cookie when path/domain/samesite
    // align — omitting path here would default to the request path (`/api/auth/logout`)
    // and leave the real cookie on `/` intact, so logout would silently no-op.
    let jar = jar.remove(
        Cookie::build(("session_user", ""))
            .path("/")
            .http_only(true)
            .secure(true)
            .same_site(SameSite::Lax)
            .max_age(time::Duration::ZERO),
    );
    let jar = jar.remove(pending_cookie_tombstone());
    let jar = jar.remove(
        Cookie::build(("registerable_guilds", ""))
            .path("/api/auth")
            .http_only(true)
            .secure(true)
            .same_site(SameSite::Lax),
    );
    (jar, Json(ApiResponse::new(())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse;

    /// Every auth cookie this module issues must carry `Secure`. The stack was
    /// deployed with the backend's port published on every interface
    /// (`docker-compose.yml`, fixed alongside this), and without `Secure` a
    /// session cookie set over the app's real HTTPS origin would still be
    /// replayable over a plain-HTTP request straight to that port.
    fn assert_secure(cookie: &Cookie<'static>) {
        assert_eq!(
            cookie.secure(),
            Some(true),
            "cookie {:?} is missing Secure",
            cookie.name()
        );
    }

    fn stub_profile() -> DiscordUserProfile {
        serde_json::from_str(
            r#"{"id":"111","username":"bob","email":null,"avatar":null,
                "roles":[],"highest_role":"User","user_id":1}"#,
        )
        .expect("valid profile fixture")
    }

    fn stub_config() -> Config {
        Config {
            backend_port: 3000,
            database_url: "postgres://localhost/weaklings".to_owned(),
            control_database_url: None,
            discord_client_id: "id".to_owned(),
            discord_client_secret: "secret".to_owned(),
            discord_redirect_uri: "http://localhost/callback".to_owned(),
            bot_api_secret: None,
            discord_bot_token: None,
            super_admin_discord_id: "admin".to_owned(),
            session_secret: "x".repeat(64),
            frontend_url: "http://localhost".to_owned(),
            albion_api_region: "europe".to_owned(),
            albion_guild_id: "albion".to_owned(),
            albion_allied_guild_ids: String::new(),
            albion_allied_guild_names: String::new(),
            mistral_api_key: String::new(),
            albionbb_base_url: "http://localhost".to_owned(),
            albionbb_request_timeout_secs: 60,
            albiondata_request_timeout_secs: 30,
        }
    }

    #[tokio::test]
    async fn discord_login_issues_secure_state_and_next_cookies() {
        let jar = CookieJar::new();
        let (jar, _redirect) = discord_login(
            Extension(stub_config()),
            jar,
            Query(LoginQuery {
                next: Some("/dashboard".to_owned()),
            }),
        )
        .await;
        assert_secure(&jar.get("oauth_state").expect("oauth_state set").clone());
        assert_secure(&jar.get("oauth_next").expect("oauth_next set").clone());
    }

    #[test]
    fn session_cookie_is_secure() {
        let cookie = session_cookie(&stub_profile()).expect("builds");
        assert_secure(&cookie);
    }

    #[test]
    fn pending_cookie_and_its_tombstone_are_secure() {
        assert_secure(&pending_cookie("payload".to_owned()));
        assert_secure(&pending_cookie_tombstone());
    }

    #[test]
    fn registerable_guilds_cookie_is_secure() {
        let key = Key::generate();
        let jar = with_registerable_guilds(PrivateCookieJar::new(key), &[]).expect("builds");
        assert_secure(&jar.get("registerable_guilds").expect("cookie set").clone());
    }

    #[tokio::test]
    async fn logout_removal_cookies_are_secure() {
        // `CookieJar::remove` only emits a removal `Set-Cookie` for a name the
        // jar already holds as an "original" — what a real request's incoming
        // `Cookie` header seeds — so the fixture has to look like a browser
        // that is actually logged in, built the same way axum does it.
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            "session_user=stub; registerable_guilds=stub"
                .parse()
                .expect("header value"),
        );
        let incoming = CookieJar::from_headers(&headers);

        let response = logout(incoming).await.into_response();
        let set_cookie_headers: Vec<_> = response
            .headers()
            .get_all(axum::http::header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().expect("ascii header").to_owned())
            .collect();
        assert_eq!(
            set_cookie_headers.len(),
            2,
            "both cookies should have a removal Set-Cookie: {set_cookie_headers:?}"
        );
        // A removal cookie is still a `Cookie` with attributes on the wire; it
        // must match the creation cookie's `Secure`, or some browsers keep the
        // original around instead of overwriting it with the expired one.
        for header_value in set_cookie_headers {
            let cookie = Cookie::parse_encoded(header_value).expect("valid Set-Cookie");
            assert_eq!(
                cookie.secure(),
                Some(true),
                "cookie {:?} is missing Secure",
                cookie.name()
            );
        }
    }
}
