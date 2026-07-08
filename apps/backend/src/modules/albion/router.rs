//! Albion routing module.
//!
//! Exposes HTTP endpoints for browsing the configured guild's roster, generic Albion Online
//! API passthroughs, and the self-service Discord <-> Albion player link.

use axum::{extract::Query, routing::{get, post}, Extension, Json, Router};
use serde::Deserialize;
use crate::config::Config;
use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::UserContext;
use crate::responses::{ApiResponse, ApiResponseAlbionLinkStatus, ApiResponsePaginatedAlbionGuildMembers};
use crate::pagination::{PaginatedAlbionGuildMember, PaginationParams};
use super::client::{AlbionGuild, AlbionPlayer, AlbionRegion, AlbionSearchResult};
use super::service::{AlbionLinkService, AlbionLinkStatus, AlbionService};

/// Creates the router for the Albion module.
pub fn router() -> Router {
    Router::new()
        .route("/guild/roster", get(get_guild_roster))
        .route("/search", get(search))
        .route("/players/{id}", get(get_player))
        .route("/guilds/{id}", get(get_guild))
        .route("/link/me", get(get_link_status))
        .route("/link", post(link_player).delete(unlink_player))
}

fn build_service(cfg: &Config) -> AlbionService {
    AlbionService::new(AlbionRegion::from_env_str(&cfg.albion_api_region), cfg.albion_guild_id.clone())
}

/// Query parameters for browsing the configured guild's roster.
///
/// Pagination fields are declared inline rather than via `#[serde(flatten)]` on
/// `PaginationParams`, since axum's `Query` extractor (backed by `serde_html_form`) cannot
/// deserialize non-string fields (e.g. `u64`) through a flattened struct from a query string.
#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct RosterQuery {
    /// Optional case-insensitive substring filter on player name.
    pub q: Option<String>,
    /// The page number to fetch (1-indexed). Defaults to 1.
    pub page: Option<u64>,
    /// The maximum number of items per page. Defaults to 10.
    pub limit: Option<u64>,
}

impl RosterQuery {
    fn pagination(&self) -> PaginationParams {
        PaginationParams {
            page: self.page,
            limit: self.limit,
        }
    }
}

/// List the configured guild's roster, optionally filtered by name.
#[utoipa::path(
    get,
    path = "/api/albion/guild/roster",
    tag = "albion",
    summary = "Browse the configured in-game guild's roster (for the link picker)",
    description = "This is the endpoint the \"link my Discord to my Albion character\" search box \
        should call: it lists members of **the one Albion guild configured server-side** (env \
        `ALBION_GUILD_ID`), not an arbitrary guild — there is no `guild_id` parameter. Filter with \
        `?q=<substring>` (case-insensitive match on player name); omit for the full roster. \
        Live-fetched from Albion Online's own API on every call (no caching), then filtered/paginated \
        locally, since that upstream endpoint has no query support of its own — so a large guild with \
        a narrow `limit` may feel slightly slower than a purely local query. Each `AlbionGuildMember.id` \
        is the value to send as `albion_player_id` to `POST /albion/link`.",
    security(("session_cookie" = [])),
    params(RosterQuery),
    responses(
        (status = 200, description = "Roster retrieved successfully", body = ApiResponsePaginatedAlbionGuildMembers),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 502, description = "Upstream Albion API error - Sandbox Interactive's gameinfo API failed or timed out", body = ProblemDetails)
    )
)]
pub async fn get_guild_roster(
    _user: UserContext,
    Extension(cfg): Extension<Config>,
    Query(query): Query<RosterQuery>,
) -> Result<Json<ApiResponse<PaginatedAlbionGuildMember>>, AppError> {
    let service = build_service(&cfg);
    let pagination = query.pagination();
    let paginated = service
        .search_configured_guild_roster(query.q.as_deref(), &pagination)
        .await?;

    Ok(Json(ApiResponse::new(PaginatedAlbionGuildMember::from(paginated))))
}

/// Query parameters for the generic Albion search passthrough.
#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct SearchQuery {
    /// The search term (player or guild name).
    pub q: String,
}

/// Generic passthrough to Albion Online's global search (players and guilds).
#[utoipa::path(
    get,
    path = "/api/albion/search",
    tag = "albion",
    summary = "Global Albion Online search — any player/guild, not just the configured guild",
    description = "Unlike `GET /albion/guild/roster`, this searches **all of Albion Online**, across \
        every guild, not just the one configured server-side. Returns two separate arrays — \
        `guilds` and `players` — both possibly empty. Use this for general lookups (e.g. \"who is \
        this enemy guild\"); use the roster endpoint specifically for the self-link participant \
        picker. `q` requires at least 1 character.",
    security(("session_cookie" = [])),
    params(SearchQuery),
    responses(
        (status = 200, description = "Search results retrieved successfully (guilds and players arrays, either may be empty)", body = AlbionSearchResult),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 502, description = "Upstream Albion API error - Sandbox Interactive's gameinfo API failed or timed out", body = ProblemDetails)
    )
)]
pub async fn search(
    _user: UserContext,
    Extension(cfg): Extension<Config>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<AlbionSearchResult>, AppError> {
    let service = build_service(&cfg);
    Ok(Json(service.search(&query.q).await?))
}

/// Generic passthrough to Albion Online's player lookup.
#[utoipa::path(
    get,
    path = "/api/albion/players/{id}",
    tag = "albion",
    summary = "Get one Albion Online player's public profile by their Albion player id",
    description = "`id` is Albion Online's own opaque player identifier (e.g. as returned in \
        `AlbionPlayerSummary.id` from `GET /albion/search`, or `AlbionGuildMember.id` from the \
        roster) — **not** this app's internal integer `user_id`, and not a Discord id. Direct, \
        uncached passthrough to Sandbox Interactive's API.",
    security(("session_cookie" = [])),
    params(("id" = String, Path, description = "Albion Online player ID (opaque string, not this app's user_id)")),
    responses(
        (status = 200, description = "Player retrieved successfully", body = AlbionPlayer),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "No Albion Online player exists with this id", body = ProblemDetails),
        (status = 502, description = "Upstream Albion API error - Sandbox Interactive's gameinfo API failed or timed out", body = ProblemDetails)
    )
)]
pub async fn get_player(
    _user: UserContext,
    Extension(cfg): Extension<Config>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<AlbionPlayer>, AppError> {
    let service = build_service(&cfg);
    Ok(Json(service.get_player(&id).await?))
}

/// Generic passthrough to Albion Online's guild lookup.
#[utoipa::path(
    get,
    path = "/api/albion/guilds/{id}",
    tag = "albion",
    summary = "Get one Albion Online guild's public profile by its Albion guild id",
    description = "`id` is Albion Online's own opaque guild identifier — the same shape as the \
        server-side `ALBION_GUILD_ID` config value, but this endpoint accepts **any** guild id, not \
        just the configured one (use `GET /albion/guild/roster` for the configured guild's member \
        list specifically). Direct, uncached passthrough to Sandbox Interactive's API.",
    security(("session_cookie" = [])),
    params(("id" = String, Path, description = "Albion Online guild ID (opaque string)")),
    responses(
        (status = 200, description = "Guild retrieved successfully", body = AlbionGuild),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "No Albion Online guild exists with this id", body = ProblemDetails),
        (status = 502, description = "Upstream Albion API error - Sandbox Interactive's gameinfo API failed or timed out", body = ProblemDetails)
    )
)]
pub async fn get_guild(
    _user: UserContext,
    Extension(cfg): Extension<Config>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<AlbionGuild>, AppError> {
    let service = build_service(&cfg);
    Ok(Json(service.get_guild(&id).await?))
}

/// Retrieves the current user's Albion player link status.
#[utoipa::path(
    get,
    path = "/api/albion/link/me",
    tag = "albion",
    summary = "Check whether the caller's Discord account is linked to an Albion character",
    description = "Call this to render the dashboard's link status (\"Linked to X\" vs. \"Not linked, \
        search below\"). Always returns `200` — check the `linked` boolean in the response, not the \
        HTTP status; there is no `404` for \"not linked\". When `linked` is `true`, \
        `albion_player_id`/`albion_player_name`/`linked_at` are populated; when `false`, all three \
        are omitted from the JSON entirely (not sent as `null`).",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Link status retrieved successfully (check the linked field)", body = ApiResponseAlbionLinkStatus),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
pub async fn get_link_status(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<AlbionLinkStatus>>, AppError> {
    let link_service = AlbionLinkService::new();
    let link = link_service.get_link_for_discord_user(&db, &user.id).await?;
    Ok(Json(ApiResponse::new(AlbionLinkStatus::from(link))))
}

/// Request body for linking the current Discord account to an Albion player.
#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[schema(example = json!({ "albion_player_id": "aPngkjfLT2CGiZoWXLr8UQ", "albion_player_name": "Kay" }))]
pub struct LinkPlayerRequest {
    /// The Albion Online player ID to link to. Must be the `id` of a current member of the
    /// configured guild's roster (`GET /albion/guild/roster`) — the server re-validates this
    /// against a fresh roster fetch, it does not trust the client blindly.
    #[schema(example = "aPngkjfLT2CGiZoWXLr8UQ")]
    pub albion_player_id: String,
    /// The Albion Online player's display name. Purely informational on the client's side — the
    /// server ignores this field and instead uses the name from its own roster lookup, so it
    /// cannot be spoofed to attach an arbitrary display name to the link. Send the same name you
    /// displayed for this `albion_player_id` in the picker.
    #[schema(example = "Kay")]
    pub albion_player_name: String,
}

/// Links the current Discord user to an Albion player from the configured guild's roster.
///
/// # Errors
///
/// * Returns `AppError::Validation` if the player is not a member of the configured guild.
/// * Returns `AppError::Conflict` if either side of the link is already claimed.
#[utoipa::path(
    post,
    path = "/api/albion/link",
    tag = "albion",
    summary = "Self-link the caller's Discord account to one Albion character",
    description = "Strictly 1:1 in both directions: one Discord account can hold at most one link, \
        and one Albion character can be claimed by at most one Discord account — enforced by unique \
        constraints in the database, not just application logic. The server re-fetches the \
        configured guild's roster and rejects `albion_player_id` values that aren't currently a \
        member (`400`), so this cannot be used to claim a character outside the configured guild. \
        There is no \"re-link\"/\"force\" option: `DELETE /albion/link` first, then call this again.",
    security(("session_cookie" = [])),
    request_body(content = LinkPlayerRequest, description = "The Albion character to claim, as picked from GET /albion/guild/roster."),
    responses(
        (status = 200, description = "Player linked successfully; linked is now true", body = ApiResponseAlbionLinkStatus),
        (status = 400, description = "The given albion_player_id is not currently a member of the configured guild", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 409, description = "Conflict - the caller's Discord account already has a link, or this Albion character is already linked to a different Discord account", body = ProblemDetails)
    )
)]
pub async fn link_player(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Json(body): Json<LinkPlayerRequest>,
) -> Result<Json<ApiResponse<AlbionLinkStatus>>, AppError> {
    let albion = build_service(&cfg);
    let roster = albion.get_configured_guild_roster().await?;

    let matched = roster
        .iter()
        .find(|member| member.id == body.albion_player_id)
        .ok_or_else(|| AppError::Validation("Selected player is not a member of the configured guild".to_string()))?;

    let link_service = AlbionLinkService::new();
    let link = link_service
        .create_link(&db, &user.id, &matched.id, &matched.name)
        .await?;

    Ok(Json(ApiResponse::new(AlbionLinkStatus::from(Some(link)))))
}

/// Unlinks the current Discord user from their Albion player.
///
/// # Errors
///
/// Returns `AppError::NotFound` if the account has no active link.
#[utoipa::path(
    delete,
    path = "/api/albion/link",
    tag = "albion",
    summary = "Unlink the caller's Discord account from its Albion character",
    description = "No request body. Frees the Albion character up so it (or a different one) can be \
        linked again, by this account or another. Not idempotent-by-design: calling this when \
        there's no active link returns `404`, so a naive \"always call unlink then re-link\" client \
        pattern must handle that case (or check `GET /albion/link/me` first).",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Link removed successfully; data is null"),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "No active link exists for this account", body = ProblemDetails)
    )
)]
pub async fn unlink_player(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    let link_service = AlbionLinkService::new();
    link_service.delete_link(&db, &user.id).await?;
    Ok(Json(ApiResponse::new(())))
}
