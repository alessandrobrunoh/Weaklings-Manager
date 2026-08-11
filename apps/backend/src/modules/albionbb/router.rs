//! `AlbionBB` routing module.
//!
//! Generic, raw passthroughs to the AlbionBB API. Not typically called directly
//! by the frontend — the [`crate::modules::battles`] module reshapes AlbionBB
//! data for the configured Weaklings guild. Exposed for power users and the
//! OpenAPI explorer.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::get,
};
use serde::Deserialize;
use utoipa::IntoParams;

use super::client::{
    AlbionBbBattleDetail, AlbionBbBattleSummary, AlbionBbBattlesFilters, AlbionBbGuildInfo,
    AlbionBbKillEvent,
};
use super::service::AlbionBbService;
use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::UserContext;
use crate::responses::ApiResponse;

/// Creates the router for the `AlbionBB` module.
pub fn router() -> Router {
    Router::new()
        .route("/battles", get(list_battles))
        .route("/battles/{battle_id}", get(get_battle))
        .route("/battles/{battle_id}/kills", get(get_battle_kills))
        .route("/guilds/{guild_id}", get(get_guild))
        .route("/players/{player_id}/stats", get(get_player_stats))
}

/// Query parameters for browsing battles.
#[derive(Debug, Deserialize, IntoParams)]
pub struct BattlesListQuery {
    /// AlbionBB server segment (`eu`/`na`/`asia`). Defaults to `eu`.
    pub server: Option<String>,
    /// Free-text search string.
    pub search: Option<String>,
    /// Restrict to battles involving this guild id.
    pub guild_id: Option<String>,
    /// Minimum total players threshold.
    pub min_players: Option<i64>,
    /// Minimum players from the queried guild.
    pub min_guild_players: Option<i64>,
    /// 1-indexed page number.
    pub page: Option<u64>,
}

/// Raw battle list response — AlbionBB's payload, with the page metadata that
/// the upstream envelope exposed. NOT wrapped in `PaginatedData` because the
/// upstream already paginates and we only pass `page` through.
#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
pub struct AlbionBbBattlesList {
    /// Battles on the current upstream page.
    pub items: Vec<AlbionBbBattleSummary>,
    /// Total number of results across all pages, if known.
    pub total_results: Option<i64>,
    /// Total number of pages, if known.
    pub total_pages: Option<i64>,
}

/// List battles matching the given filters.
#[utoipa::path(
    get,
    path = "/api/albionbb/battles",
    tag = "albionbb",
    summary = "Browse AlbionBB battles (raw passthrough)",
    description = "Generic AlbionBB battle search. Either `search` (free text) or `guild_id` should \
        be set; both may be combined. `page` is passed straight through to AlbionBB. The response \
        includes any pagination metadata AlbionBB exposes (`total_results`/`total_pages` may be \
        `null` when upstream omits them). The frontend normally calls `/battles` instead, which is \
        pre-scoped to the configured Weaklings guild.",
    security(("session_cookie" = [])),
    params(BattlesListQuery),
    responses(
        (status = 200, description = "Battles retrieved successfully", body = crate::responses::ApiResponseAlbionBbBattlesList),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 502, description = "Upstream AlbionBB API error", body = ProblemDetails)
    )
)]
pub async fn list_battles(
    _user: UserContext,
    Extension(service): Extension<AlbionBbService>,
    Query(query): Query<BattlesListQuery>,
) -> Result<Json<ApiResponse<AlbionBbBattlesList>>, AppError> {
    let filters = AlbionBbBattlesFilters {
        search: query.search,
        guild_id: query.guild_id,
        min_players: query.min_players,
        min_guild_players: query.min_guild_players,
        page: query.page,
    };
    let (items, meta) = service
        .get_battles(query.server.as_deref(), &filters)
        .await?;
    Ok(Json(ApiResponse::new(AlbionBbBattlesList {
        items,
        total_results: meta.total_results,
        total_pages: meta.total_pages,
    })))
}

/// Fetch a single battle by id.
#[utoipa::path(
    get,
    path = "/api/albionbb/battles/{battle_id}",
    tag = "albionbb",
    summary = "Get a single AlbionBB battle (raw passthrough)",
    description = "Includes the per-player breakdown when AlbionBB provides it. Cached server-side \
        for 24h (battle details are historical facts).",
    security(("session_cookie" = [])),
    params(
        ("battle_id" = i64, Path, description = "AlbionBB battle id"),
        ("server" = Option<String>, Query, description = "AlbionBB server segment, defaults to `eu`"),
    ),
    responses(
        (status = 200, description = "Battle retrieved successfully", body = crate::responses::ApiResponseAlbionBbBattleDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "No battle exists with this id", body = ProblemDetails),
        (status = 502, description = "Upstream AlbionBB API error", body = ProblemDetails)
    )
)]
pub async fn get_battle(
    _user: UserContext,
    Extension(service): Extension<AlbionBbService>,
    Path(battle_id): Path<i64>,
    Query(params): Query<ServerQuery>,
) -> Result<Json<ApiResponse<AlbionBbBattleDetail>>, AppError> {
    let detail = service
        .get_battle(params.server.as_deref(), battle_id)
        .await?;
    Ok(Json(ApiResponse::new(detail)))
}

/// Fetch kill events for a battle.
#[utoipa::path(
    get,
    path = "/api/albionbb/battles/{battle_id}/kills",
    tag = "albionbb",
    summary = "Get kill events for an AlbionBB battle (raw passthrough)",
    description = "Returns the kill feed for a battle, one entry per kill. Each event preserves the \
        entire upstream payload in its `raw` field for fields we did not model.",
    security(("session_cookie" = [])),
    params(
        ("battle_id" = i64, Path, description = "AlbionBB battle id"),
        ("server" = Option<String>, Query, description = "AlbionBB server segment, defaults to `eu`"),
    ),
    responses(
        (status = 200, description = "Kills retrieved successfully", body = crate::responses::ApiResponseAlbionBbKillEventList),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 502, description = "Upstream AlbionBB API error", body = ProblemDetails)
    )
)]
pub async fn get_battle_kills(
    _user: UserContext,
    Extension(service): Extension<AlbionBbService>,
    Path(battle_id): Path<i64>,
    Query(params): Query<ServerQuery>,
) -> Result<Json<ApiResponse<Vec<AlbionBbKillEvent>>>, AppError> {
    let kills = service
        .get_battle_kills(params.server.as_deref(), battle_id)
        .await?;
    Ok(Json(ApiResponse::new(kills)))
}

/// Fetch guild info.
#[utoipa::path(
    get,
    path = "/api/albionbb/guilds/{guild_id}",
    tag = "albionbb",
    summary = "Get AlbionBB guild info (raw passthrough)",
    description = "Cached server-side for 24h.",
    security(("session_cookie" = [])),
    params(
        ("guild_id" = String, Path, description = "AlbionBB guild id"),
        ("server" = Option<String>, Query, description = "AlbionBB server segment, defaults to `eu`"),
    ),
    responses(
        (status = 200, description = "Guild retrieved successfully", body = crate::responses::ApiResponseAlbionBbGuildInfo),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "No guild exists with this id", body = ProblemDetails),
        (status = 502, description = "Upstream AlbionBB API error", body = ProblemDetails)
    )
)]
pub async fn get_guild(
    _user: UserContext,
    Extension(service): Extension<AlbionBbService>,
    Path(guild_id): Path<String>,
    Query(params): Query<ServerQuery>,
) -> Result<Json<ApiResponse<AlbionBbGuildInfo>>, AppError> {
    let info = service
        .get_guild(params.server.as_deref(), &guild_id)
        .await?;
    Ok(Json(ApiResponse::new(info)))
}

/// Fetch player career stats (raw passthrough).
#[utoipa::path(
    get,
    path = "/api/albionbb/players/{player_id}/stats",
    tag = "albionbb",
    summary = "Get AlbionBB player career stats (raw passthrough)",
    description = "`data` is whatever JSON AlbionBB returns, untyped. We don't model this yet.",
    security(("session_cookie" = [])),
    params(
        ("player_id" = String, Path, description = "AlbionBB player id"),
        ("server" = Option<String>, Query, description = "AlbionBB server segment, defaults to `eu`"),
        ("min_players" = Option<i64>, Query, description = "Minimum total players threshold"),
    ),
    responses(
        (status = 200, description = "Player stats retrieved successfully", body = crate::responses::ApiResponseAlbionBbPlayerStats),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "No player exists with this id", body = ProblemDetails),
        (status = 502, description = "Upstream AlbionBB API error", body = ProblemDetails)
    )
)]
pub async fn get_player_stats(
    _user: UserContext,
    Extension(service): Extension<AlbionBbService>,
    Path(player_id): Path<String>,
    Query(params): Query<PlayerStatsQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    let stats = service
        .get_player_stats(params.server.as_deref(), &player_id, params.min_players)
        .await?;
    Ok(Json(ApiResponse::new(stats)))
}

/// Shared query params for single-resource lookups (just the server segment).
#[derive(Debug, Deserialize, IntoParams)]
pub struct ServerQuery {
    /// AlbionBB server segment (`eu`/`na`/`asia`). Defaults to `eu`.
    pub server: Option<String>,
}

/// Query params for player stats.
#[derive(Debug, Deserialize, IntoParams)]
pub struct PlayerStatsQuery {
    /// AlbionBB server segment (`eu`/`na`/`asia`). Defaults to `eu`.
    pub server: Option<String>,
    /// Minimum total players threshold.
    pub min_players: Option<i64>,
}
