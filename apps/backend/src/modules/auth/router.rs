//! Auth routing module.
//!
//! Exposes HTTP endpoints for `OAuth2` login flows, session query, and logout.

use super::permission_cache::Permissions;
use super::service::{AuthService, DiscordUserProfile};
use crate::config::Config;
use crate::errors::{AppError, ProblemDetails};
use crate::responses::{ApiResponse, ApiResponseDiscordUserProfile};
use axum::{
    Extension, Json, Router,
    extract::Query,
    response::Redirect,
    routing::{get, post},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
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
        .route("/me", get(get_me))
        .route("/logout", post(logout))
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
) -> (CookieJar, Redirect) {
    // Generate a secure CSRF state token
    let state = Alphanumeric.sample_string(&mut rand::thread_rng(), 32);

    // Save the state in a secure cookie
    let state_cookie = Cookie::build(("oauth_state", state.clone()))
        .path("/api/auth")
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::minutes(10));

    let jar = jar.add(state_cookie);

    // Build Discord authorize URL
    // Scope: identify and email
    let auth_url = format!(
        "https://discord.com/api/oauth2/authorize?client_id={}&redirect_uri={}&response_type=code&scope=identify%20email&state={}",
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
pub async fn discord_callback(
    Extension(cfg): Extension<Config>,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    jar: CookieJar,
    Query(query): Query<CallbackQuery>,
) -> Result<(CookieJar, Redirect), AppError> {
    // Retrieve the state cookie
    let cookie_state = jar.get("oauth_state").map(|c| c.value().to_string());

    // Clean up the state cookie immediately
    let jar = jar.remove(Cookie::from("oauth_state"));

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

    // Fetch Discord Profile details
    let mut profile = service.fetch_profile(&token_resp.access_token).await?;

    // Fetch and enrich profile with Discord roles
    let (roles, highest_role) = service
        .fetch_member_roles(
            &db,
            &profile.id,
            &token_resp.access_token,
            &cfg.discord_guild_id,
            cfg.discord_bot_token.as_deref(),
            &cfg.super_admin_discord_id,
        )
        .await;

    profile.roles = roles;
    profile.highest_role = highest_role;
    profile.is_superadmin = profile.id == cfg.super_admin_discord_id;
    profile.permissions = perms
        .granted_permissions(profile.is_superadmin, &profile.roles)
        .await;
    profile.user_id = service.upsert_user(&db, &profile).await?;

    // Serialize profile to JSON for storage in session cookie
    let profile_json = serde_json::to_string(&profile)
        .map_err(|e| AppError::Internal(format!("Failed to serialize session: {e}")))?;

    // Set secure session cookie valid for 7 days
    let session_cookie = Cookie::build(("session_user", profile_json))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::days(7));

    let jar = jar.add(session_cookie);

    let redirect_url = format!("{}/dashboard", cfg.frontend_url);
    Ok((jar, Redirect::temporary(&redirect_url)))
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
pub async fn get_me(
    jar: CookieJar,
    Extension(cfg): Extension<Config>,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<(CookieJar, Json<ApiResponse<DiscordUserProfile>>), AppError> {
    let session_cookie = jar
        .get("session_user")
        .ok_or_else(|| AppError::Unauthorized("No active session".to_string()))?;

    let mut profile: DiscordUserProfile = serde_json::from_str(session_cookie.value())
        .map_err(|e| AppError::Unauthorized(format!("Invalid session cookie format: {e}")))?;

    // The cookie caches the Discord username from login time; re-resolve here so a display
    // name change (e.g. linking an Albion Online character after logging in) shows up without
    // requiring a fresh login.
    profile.username =
        crate::modules::users::display_name::resolve_by_id(&db, profile.user_id).await?;
    profile.is_superadmin = profile.id == cfg.super_admin_discord_id;

    // Re-map Discord guild roles onto gestionale roles so linking a Discord role in admin
    // takes effect on the next page load, without forcing a full OAuth round-trip.
    // If Discord is unreachable the cookie's previous role list is kept (fail closed on
    // connectivity, not on "member has no linked roles").
    let service = AuthService::new();
    if let Some(role_ids) = service
        .fetch_guild_member_role_ids(
            &profile.id,
            "",
            &cfg.discord_guild_id,
            cfg.discord_bot_token.as_deref(),
        )
        .await
    {
        if profile.is_superadmin {
            profile.roles = vec!["SuperAdmin".to_string()];
            profile.highest_role = "SuperAdmin".to_string();
        } else {
            let db_roles = crate::modules::auth::entities::role::Entity::find()
                .all(&db)
                .await?;
            let (roles, highest) =
                crate::modules::auth::service::resolve_linked_roles(&role_ids, &db_roles);
            profile.roles = roles;
            profile.highest_role = highest;
        }
        persist_session_highest_role(&db, profile.user_id, &profile.highest_role).await?;
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
            .same_site(SameSite::Lax)
            .max_age(time::Duration::ZERO),
    );
    (jar, Json(ApiResponse::new(())))
}
