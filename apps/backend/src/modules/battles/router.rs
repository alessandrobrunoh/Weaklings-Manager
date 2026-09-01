//! `Battles` routing module.
//!
//! Three endpoints, all session-protected:
//! - `GET /` — list battles of the configured Weaklings guild (paginated).
//! - `GET /{battle_id}` — full detail (battle + kills).
//! - `GET /me` — battles the calling user participated in.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::get,
};
use sea_orm::DatabaseConnection;
use serde::Deserialize;
use utoipa::IntoParams;

use super::models::BattleDetail;
use super::service::BattlesService;
use crate::errors::{AppError, ProblemDetails};
use crate::modules::albiondata::service::AlbionDataService;
use crate::modules::auth::UserContext;
use crate::pagination::{PaginatedBattleSummary, PaginationParams, SortOrder};
use crate::responses::{ApiResponse, ApiResponsePaginatedBattles};

/// Creates the router for the `battles` module.
///
/// `/me` is registered alongside `/{battle_id}` — axum's path matcher handles
/// the literal segment `/me` first when it's a registered route, and the
/// numeric `i64` extractor on `/{battle_id}` rejects any non-numeric value
/// anyway (returning 404 for `/battles/foo`).
pub fn router() -> Router {
    Router::new()
        .route("/", get(list_battles))
        .route("/me", get(list_my_battles))
        .route("/{battle_id}", get(get_battle))
}

/// Query parameters for listing battles.
#[derive(Debug, Deserialize, IntoParams)]
pub struct BattlesListQuery {
    /// 1-indexed page number. Defaults to 1.
    pub page: Option<u64>,
    /// Page size. Defaults to 10.
    pub limit: Option<u64>,
    /// Minimum total players threshold. Defaults to 10.
    pub min_players: Option<i64>,
    /// Case-insensitive match on battle id, guild name, or alliance.
    pub search: Option<String>,
    /// Sort column: `start_time` (default), `fame`, `kills`, `deaths`, `players`, `id`, `outcome`.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc` (default).
    pub order: Option<String>,
    /// Derived outcome filter: `victory`, `defeat`, or `contested`.
    pub outcome: Option<String>,
}

/// Query parameters for `/me`.
#[derive(Debug, Deserialize, IntoParams)]
pub struct MyBattlesQuery {
    /// 1-indexed page number. Defaults to 1.
    pub page: Option<u64>,
    /// Maximum number of items per page. Defaults to 10.
    pub limit: Option<u64>,
    /// Case-insensitive match on battle id, guild name, or alliance.
    pub search: Option<String>,
    /// Sort column: `start_time` (default), `fame`, `kills`, `deaths`, `players`, `id`, `outcome`.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc` (default).
    pub order: Option<String>,
    /// Derived outcome filter: `victory`, `defeat`, or `contested`.
    pub outcome: Option<String>,
}

/// List recent battles of the configured Weaklings guild.
#[utoipa::path(
    get,
    path = "/api/battles",
    tag = "battles",
    summary = "List recent battles of the configured Weaklings guild",
    description = "Paginated list of battles involving the configured guild. AlbionBB cannot sort, \
        so the backend hydrates recent pages, then filters/sorts/paginates locally. \
        `min_players` defaults to 10. Use `/battles/{battle_id}` for full per-player details.",
    security(("session_cookie" = [])),
    params(BattlesListQuery),
    responses(
        (status = 200, description = "Battles retrieved successfully", body = ApiResponsePaginatedBattles),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 502, description = "Upstream AlbionBB API error", body = ProblemDetails)
    )
)]
pub async fn list_battles(
    _user: UserContext,
    Extension(service): Extension<BattlesService>,
    Extension(db): Extension<DatabaseConnection>,
    Query(query): Query<BattlesListQuery>,
) -> Result<Json<ApiResponse<PaginatedBattleSummary>>, AppError> {
    let pagination = PaginationParams {
        page: query.page,
        limit: query.limit,
    };
    let paginated = service
        .list_guild_battles(
            &db,
            query.min_players,
            &pagination,
            query.search.as_deref(),
            query.sort.as_deref(),
            SortOrder::from_query(query.order.as_deref()),
            query.outcome.as_deref(),
        )
        .await?;
    Ok(Json(ApiResponse::new(PaginatedBattleSummary::from(
        paginated,
    ))))
}

/// Fetch full detail for a battle.
#[utoipa::path(
    get,
    path = "/api/battles/{battle_id}",
    tag = "battles",
    summary = "Get full detail for a single battle (players + kill timeline)",
    description = "Combines AlbionBB's battle detail and kill feed into one response. The kill \
        timeline preserves the entire upstream kill event in each entry's `raw` field.",
    security(("session_cookie" = [])),
    params(("battle_id" = i64, Path, description = "AlbionBB battle id")),
    responses(
        (status = 200, description = "Battle retrieved successfully", body = crate::responses::ApiResponseBattleDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "No battle exists with this id", body = ProblemDetails),
        (status = 502, description = "Upstream AlbionBB API error", body = ProblemDetails)
    )
)]
pub async fn get_battle(
    _user: UserContext,
    Extension(service): Extension<BattlesService>,
    Extension(albiondata): Extension<AlbionDataService>,
    Extension(db): Extension<DatabaseConnection>,
    Path(battle_id): Path<i64>,
) -> Result<Json<ApiResponse<BattleDetail>>, AppError> {
    let detail = service
        .get_battle_detail_with_losses(&db, battle_id, &albiondata)
        .await?;
    Ok(Json(ApiResponse::new(detail)))
}

/// List battles the calling user participated in.
#[utoipa::path(
    get,
    path = "/api/battles/me",
    tag = "battles",
    summary = "List battles the calling user participated in (linked Albion character)",
    description = "Requires the caller to have linked an Albion character via `POST /albion/link`. \
        Returns `400` otherwise. Pages through up to 5 AlbionBB pages of the configured guild's \
        battles, fetches each battle's detail (cached 24h), and keeps only those whose players list \
        contains the linked Albion player id. Results are sorted newest-first and paginated locally.",
    security(("session_cookie" = [])),
    params(MyBattlesQuery),
    responses(
        (status = 200, description = "Battles retrieved successfully", body = ApiResponsePaginatedBattles),
        (status = 400, description = "Caller has not linked an Albion character", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 502, description = "Upstream AlbionBB API error", body = ProblemDetails)
    )
)]
pub async fn list_my_battles(
    user: UserContext,
    Extension(service): Extension<BattlesService>,
    Extension(db): Extension<DatabaseConnection>,
    Query(query): Query<MyBattlesQuery>,
) -> Result<Json<ApiResponse<PaginatedBattleSummary>>, AppError> {
    let pagination = PaginationParams {
        page: query.page,
        limit: query.limit,
    };
    let paginated = service
        .list_my_battles(
            &db,
            &user.id,
            &pagination,
            query.search.as_deref(),
            query.sort.as_deref(),
            SortOrder::from_query(query.order.as_deref()),
            query.outcome.as_deref(),
        )
        .await?;
    Ok(Json(ApiResponse::new(PaginatedBattleSummary::from(
        paginated,
    ))))
}
