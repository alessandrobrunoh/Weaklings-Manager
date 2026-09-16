//! `Enemies` routing module.
//!
//! Four endpoints, all gated on `intel.opponents.view`:
//! - `GET /guilds` — paginated list of enemy guilds.
//! - `GET /guilds/{id}` — one enemy guild's full dossier.
//! - `GET /players` — paginated list of enemy players.
//! - `GET /players/{id}` — one enemy player's full dossier.
//!
//! Nested at `/enemies` in `modules::mod`, so the full paths are
//! `/api/enemies/guilds`, `/api/enemies/guilds/{id}`, `/api/enemies/players`,
//! `/api/enemies/players/{id}`. `/guilds` (rather than an unprefixed `/`) is
//! used for the guild list since two resource types live under this one nest.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::get,
};
use sea_orm::DatabaseConnection;

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::pagination::{
    PaginatedEnemyGuildSummary, PaginatedEnemyPlayerSummary, PaginationParams, SortOrder,
};
use crate::responses::{
    ApiResponse, ApiResponseEnemyGuildDossier, ApiResponseEnemyPlayerDossier,
    ApiResponsePaginatedEnemyGuilds, ApiResponsePaginatedEnemyPlayers,
};

use super::models::{
    EnemyGuildDossier, EnemyPlayerDossier, ListEnemyGuildsQuery, ListEnemyPlayersQuery,
};
use super::service::EnemiesService;

/// Creates the router for the `enemies` module.
pub fn router() -> Router {
    Router::new()
        .route("/guilds", get(list_enemy_guilds))
        .route("/guilds/{id}", get(get_enemy_guild))
        .route("/players", get(list_enemy_players))
        .route("/players/{id}", get(get_enemy_player))
}

/// List enemy guilds we have battle evidence for.
#[utoipa::path(
    get,
    path = "/api/enemies/guilds",
    tag = "enemies",
    summary = "List enemy guilds",
    description = "Paginated list of enemy guilds identified from battle evidence. `search` is a \
        case-insensitive substring match on the guild's latest known name. Each row includes \
        battle-derived tallies (`battles_fought`, `our_kills`, `their_kills`) computed from \
        `enemy_player_battles` for just this page's guilds — a single batched query, not N+1.",
    security(("session_cookie" = ["intel.opponents.view"])),
    params(ListEnemyGuildsQuery),
    responses(
        (status = 200, description = "Enemy guilds retrieved successfully", body = ApiResponsePaginatedEnemyGuilds),
        (status = 400, description = "Unknown sort column", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing the intel.opponents.view permission", body = ProblemDetails)
    )
)]
pub async fn list_enemy_guilds(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Query(query): Query<ListEnemyGuildsQuery>,
) -> Result<Json<ApiResponse<PaginatedEnemyGuildSummary>>, AppError> {
    user.require(&perms, Permission::IntelOpponentsView).await?;
    let pagination = PaginationParams {
        page: query.page,
        limit: query.limit,
    };
    let paginated = EnemiesService::new()
        .list_guilds(
            &db,
            &pagination,
            query.search.as_deref(),
            query.sort.as_deref(),
            SortOrder::from_query(query.order.as_deref()),
        )
        .await?;
    Ok(Json(ApiResponse::new(PaginatedEnemyGuildSummary::from(
        paginated,
    ))))
}

/// Get one enemy guild's full dossier.
#[utoipa::path(
    get,
    path = "/api/enemies/guilds/{id}",
    tag = "enemies",
    summary = "Get one enemy guild's dossier",
    description = "Identity fields, alias (name/alliance) history grouped by kind, battle-derived \
        tallies, the current roster of enemy players believed to belong to this guild (each with \
        their most recently observed role/weapon), and a weapon histogram across the whole roster's \
        battle history.",
    security(("session_cookie" = ["intel.opponents.view"])),
    params(("id" = i64, Path, description = "Enemy guild id")),
    responses(
        (status = 200, description = "Enemy guild retrieved successfully", body = ApiResponseEnemyGuildDossier),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing the intel.opponents.view permission", body = ProblemDetails),
        (status = 404, description = "No enemy guild exists with this id", body = ProblemDetails)
    )
)]
pub async fn get_enemy_guild(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EnemyGuildDossier>>, AppError> {
    user.require(&perms, Permission::IntelOpponentsView).await?;
    let dossier = EnemiesService::new().get_guild(&db, id).await?;
    Ok(Json(ApiResponse::new(dossier)))
}

/// List enemy players we have battle evidence for.
#[utoipa::path(
    get,
    path = "/api/enemies/players",
    tag = "enemies",
    summary = "List enemy players",
    description = "Paginated list of enemy players identified from battle evidence. `search` is a \
        case-insensitive substring match on name; `guild_id` restricts to players currently believed \
        to belong to one enemy guild; `role` restricts to players whose most recently observed role \
        matches (case-insensitive). Each row includes the player's latest observed role/weapon/item \
        power and the same battle-derived tallies as the guild list, batched for the returned page.",
    security(("session_cookie" = ["intel.opponents.view"])),
    params(ListEnemyPlayersQuery),
    responses(
        (status = 200, description = "Enemy players retrieved successfully", body = ApiResponsePaginatedEnemyPlayers),
        (status = 400, description = "Unknown sort column", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing the intel.opponents.view permission", body = ProblemDetails)
    )
)]
pub async fn list_enemy_players(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Query(query): Query<ListEnemyPlayersQuery>,
) -> Result<Json<ApiResponse<PaginatedEnemyPlayerSummary>>, AppError> {
    user.require(&perms, Permission::IntelOpponentsView).await?;
    let pagination = PaginationParams {
        page: query.page,
        limit: query.limit,
    };
    let paginated = EnemiesService::new()
        .list_players(
            &db,
            &pagination,
            query.search.as_deref(),
            query.guild_id,
            query.role.as_deref(),
            query.sort.as_deref(),
            SortOrder::from_query(query.order.as_deref()),
        )
        .await?;
    Ok(Json(ApiResponse::new(PaginatedEnemyPlayerSummary::from(
        paginated,
    ))))
}

/// Get one enemy player's full dossier.
#[utoipa::path(
    get,
    path = "/api/enemies/players/{id}",
    tag = "enemies",
    summary = "Get one enemy player's dossier",
    description = "Identity fields, current guild (id + name), full battle-by-battle history \
        ordered newest first, and battle-derived tallies across that whole history.",
    security(("session_cookie" = ["intel.opponents.view"])),
    params(("id" = i64, Path, description = "Enemy player id")),
    responses(
        (status = 200, description = "Enemy player retrieved successfully", body = ApiResponseEnemyPlayerDossier),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing the intel.opponents.view permission", body = ProblemDetails),
        (status = 404, description = "No enemy player exists with this id", body = ProblemDetails)
    )
)]
pub async fn get_enemy_player(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EnemyPlayerDossier>>, AppError> {
    user.require(&perms, Permission::IntelOpponentsView).await?;
    let dossier = EnemiesService::new().get_player(&db, id).await?;
    Ok(Json(ApiResponse::new(dossier)))
}
