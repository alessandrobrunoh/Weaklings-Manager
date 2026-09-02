//! Intel routing module.
//!
//! Exposes enemy scouting: browsing the scout library, scouting a battle,
//! similarity comparisons, counter recommendations and the matchup matrix.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::{get, post},
};

use crate::config::Config;
use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::modules::events::service::BattleLinkingContext;
use crate::modules::intel::cache::ReportCache;
use crate::modules::intel::matchups::{MatchupReport, matchups};
use crate::modules::intel::models::{
    CounterSuggestion, ScoutFilters, ScoutOutcome, ScoutedCompDetail, SimilarityHit,
    UpdateScoutRequest,
};
use crate::modules::intel::report::{
    DateRange, GuildReport, ReportLeaderboards, ReportParams, build_guild_report,
};
use crate::modules::intel::service::IntelService;
use crate::pagination::{PaginatedScoutedComp, PaginationParams};
use crate::responses::ApiResponse;

/// Default number of entries returned by the similarity and counter endpoints.
const DEFAULT_SUGGESTION_LIMIT: usize = 5;
/// Hard ceiling so a client cannot ask for an unbounded comparison sweep.
const MAX_SUGGESTION_LIMIT: usize = 50;

/// Query parameters for `GET /scouts`.
///
/// Pagination fields are declared inline rather than flattened, since axum's
/// `Query` extractor cannot deserialize non-string fields through a flattened
/// struct — the same constraint documented in the regear router.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct ListScoutsQuery {
    /// The page number to fetch (1-indexed). Defaults to 1.
    pub page: Option<u64>,
    /// The maximum number of items per page.
    pub limit: Option<u64>,
    /// The filter query parameters.
    #[serde(flatten)]
    pub filters: ScoutFilters,
}

impl ListScoutsQuery {
    fn pagination(&self) -> PaginationParams {
        PaginationParams {
            page: self.page,
            limit: self.limit,
        }
    }
}

/// Query parameters for `POST /scouts/from-battle/{battle_id}`.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct ScoutBattleQuery {
    /// Compute the drafts and return them without writing anything.
    pub dry_run: Option<bool>,
}

/// Query parameters for the similarity and counter endpoints.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct SuggestionQuery {
    /// Maximum entries to return.
    pub limit: Option<usize>,
}

impl SuggestionQuery {
    fn resolved(&self) -> usize {
        self.limit
            .unwrap_or(DEFAULT_SUGGESTION_LIMIT)
            .clamp(1, MAX_SUGGESTION_LIMIT)
    }
}

/// Query parameters for `GET /matchups`.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct MatchupQuery {
    /// Restrict the matrix to one scouted comp.
    pub scout_id: Option<i64>,
}

/// Creates the router for the intel module.
///
/// `/scouts/from-battle/{battle_id}` is registered before `/scouts/{id}` so the
/// literal segment always wins; the same ordering caveat applies here as in the
/// battles router.
pub fn router() -> Router {
    Router::new()
        .route("/scouts", get(list_scouts))
        .route("/scouts/from-battle/{battle_id}", post(scout_battle))
        .route(
            "/scouts/{id}",
            get(get_scout).patch(update_scout).delete(delete_scout),
        )
        .route("/scouts/{id}/similar", get(similar_scouts))
        .route("/scouts/{id}/counters", get(counters))
        .route("/comps/{comp_id}/threats", get(threats_to_comp))
        .route("/matchups", get(matchup_matrix))
        .route("/leaderboards", get(leaderboards))
        .route("/report", get(guild_report))
        .route("/report/refresh", post(refresh_guild_report))
}

/// Builds the friendly-guild classifier from configuration.
///
/// Guild identity is always configuration-driven; no guild name is ever
/// hardcoded in this module.
fn guild_context(cfg: &Config) -> BattleLinkingContext {
    BattleLinkingContext::new(
        &cfg.albion_guild_id,
        &cfg.albion_allied_guild_ids(),
        &cfg.albion_allied_guild_names(),
    )
}

/// Paginated list of scouted enemy compositions.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks `intel.view`, or `400` if an
/// unknown `category` is supplied.
#[utoipa::path(
    get,
    path = "/api/intel/scouts",
    tag = "intel",
    summary = "List scouted enemy compositions",
    description = "Browse the scout library. Supports free-text search over scout and guild \
        name, filtering by engagement bracket and opponent guild, and sorting by `saved_at` \
        (default), `threat` or `battles`. Archived scouts are hidden unless requested.",
    security(("session_cookie" = ["intel.view"])),
    params(ListScoutsQuery),
    responses(
        (status = 200, description = "Scouts retrieved", body = PaginatedScoutedComp),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks intel.view", body = ProblemDetails)
    )
)]
pub async fn list_scouts(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(query): Query<ListScoutsQuery>,
) -> Result<Json<ApiResponse<PaginatedScoutedComp>>, AppError> {
    user.require(&perms, Permission::IntelView).await?;
    let service = IntelService::new();
    let paginated = service
        .list_scouts(&db, &query.pagination(), &query.filters)
        .await?;
    Ok(Json(ApiResponse::new(PaginatedScoutedComp::from(
        paginated,
    ))))
}

/// Full dossier for one scouted composition.
///
/// # Errors
///
/// Returns `403 Forbidden` without `intel.view`, `404` if the scout is unknown.
#[utoipa::path(
    get,
    path = "/api/intel/scouts/{id}",
    tag = "intel",
    summary = "Get one scouted enemy composition",
    description = "Returns the roster, role and weapon histograms, source battles and the \
        win/loss record of our comps against this scout. `weapon_sample_size` reports how many \
        of the observed players actually contributed a weapon.",
    security(("session_cookie" = ["intel.view"])),
    params(("id" = i64, Path, description = "Scouted comp id")),
    responses(
        (status = 200, description = "Scout retrieved", body = ScoutedCompDetail),
        (status = 403, description = "Forbidden - lacks intel.view", body = ProblemDetails),
        (status = 404, description = "Scout not found", body = ProblemDetails)
    )
)]
pub async fn get_scout(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<ScoutedCompDetail>>, AppError> {
    user.require(&perms, Permission::IntelView).await?;
    let detail = IntelService::new().get_scout(&db, id).await?;
    Ok(Json(ApiResponse::new(detail)))
}

/// Updates the officer-editable fields of a scout.
///
/// # Errors
///
/// Returns `403 Forbidden` without `intel.manage`, `404` if unknown.
#[utoipa::path(
    patch,
    path = "/api/intel/scouts/{id}",
    tag = "intel",
    summary = "Update a scouted enemy composition",
    description = "Renames a scout, edits officer notes, corrects its engagement bracket, or \
        archives it. Archiving hides a scout while preserving its battles and matchup history.",
    security(("session_cookie" = ["intel.manage"])),
    params(("id" = i64, Path, description = "Scouted comp id")),
    request_body = UpdateScoutRequest,
    responses(
        (status = 200, description = "Scout updated", body = ScoutedCompDetail),
        (status = 403, description = "Forbidden - lacks intel.manage", body = ProblemDetails),
        (status = 404, description = "Scout not found", body = ProblemDetails)
    )
)]
pub async fn update_scout(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
    Json(body): Json<UpdateScoutRequest>,
) -> Result<Json<ApiResponse<ScoutedCompDetail>>, AppError> {
    user.require(&perms, Permission::IntelEdit).await?;
    let detail = IntelService::new().update_scout(&db, id, &body).await?;
    Ok(Json(ApiResponse::new(detail)))
}

/// Permanently deletes a scout and its battle links.
///
/// # Errors
///
/// Returns `403 Forbidden` without `intel.manage`, `404` if unknown.
#[utoipa::path(
    delete,
    path = "/api/intel/scouts/{id}",
    tag = "intel",
    summary = "Delete a scouted enemy composition",
    description = "Removes the scout and its battle links. Prefer archiving when the intent is \
        to tidy the board, since deletion also discards matchup history.",
    security(("session_cookie" = ["intel.manage"])),
    params(("id" = i64, Path, description = "Scouted comp id")),
    responses(
        (status = 200, description = "Scout deleted"),
        (status = 403, description = "Forbidden - lacks intel.manage", body = ProblemDetails),
        (status = 404, description = "Scout not found", body = ProblemDetails)
    )
)]
pub async fn delete_scout(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    user.require(&perms, Permission::IntelDelete).await?;
    IntelService::new().delete_scout(&db, id).await?;
    Ok(Json(ApiResponse::new(())))
}

/// Scouts one stored battle, creating or merging one comp per opposing guild.
///
/// # Errors
///
/// Returns `403 Forbidden` without `intel.manage`, `404` if no snapshot exists.
#[utoipa::path(
    post,
    path = "/api/intel/scouts/from-battle/{battle_id}",
    tag = "intel",
    summary = "Scout a battle",
    description = "Reads the stored battle snapshot and derives one enemy composition per \
        opposing guild, merging into an existing scout when the fingerprint or the \
        guild-and-bracket pair already matches. Our own guild and configured allies are always \
        excluded. Pass `dry_run=true` to preview without writing. Idempotent: re-scouting a \
        battle already linked to a scout changes nothing.",
    security(("session_cookie" = ["intel.manage"])),
    params(("battle_id" = i64, Path, description = "AlbionBB battle id"), ScoutBattleQuery),
    responses(
        (status = 200, description = "Battle scouted", body = Vec<ScoutOutcome>),
        (status = 403, description = "Forbidden - lacks intel.manage", body = ProblemDetails),
        (status = 404, description = "No stored snapshot for that battle", body = ProblemDetails)
    )
)]
pub async fn scout_battle(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Path(battle_id): Path<i64>,
    Query(query): Query<ScoutBattleQuery>,
) -> Result<Json<ApiResponse<Vec<ScoutOutcome>>>, AppError> {
    user.require(&perms, Permission::IntelCreate).await?;
    let outcomes = IntelService::new()
        .scout_battle(
            &db,
            &guild_context(&cfg),
            battle_id,
            query.dry_run.unwrap_or(false),
            Some(user.user_id),
        )
        .await?;
    Ok(Json(ApiResponse::new(outcomes)))
}

/// Other scouts ranked by resemblance to this one.
///
/// # Errors
///
/// Returns `403 Forbidden` without `intel.view`, `404` if the scout is unknown.
#[utoipa::path(
    get,
    path = "/api/intel/scouts/{id}/similar",
    tag = "intel",
    summary = "Find similar enemy compositions",
    description = "Scores every other scout against this one. The blend is 55% role shape and \
        45% weapon mix, scaled down by roster-size mismatch. `full_weapon_coverage` is false \
        when either side's weapons came from a partial kill feed, which understates the score.",
    security(("session_cookie" = ["intel.view"])),
    params(("id" = i64, Path, description = "Scouted comp id"), SuggestionQuery),
    responses(
        (status = 200, description = "Similar scouts", body = Vec<SimilarityHit>),
        (status = 403, description = "Forbidden - lacks intel.view", body = ProblemDetails),
        (status = 404, description = "Scout not found", body = ProblemDetails)
    )
)]
pub async fn similar_scouts(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
    Query(query): Query<SuggestionQuery>,
) -> Result<Json<ApiResponse<Vec<SimilarityHit>>>, AppError> {
    user.require(&perms, Permission::IntelView).await?;
    let hits = IntelService::new()
        .similar_scouts(&db, id, query.resolved())
        .await?;
    Ok(Json(ApiResponse::new(hits)))
}

/// Our comps ranked as answers to this scout.
///
/// # Errors
///
/// Returns `403 Forbidden` without `intel.view`, `404` if the scout is unknown.
#[utoipa::path(
    get,
    path = "/api/intel/scouts/{id}/counters",
    tag = "intel",
    summary = "Recommend counters to an enemy composition",
    description = "Ranks our comps against this scout, proven record first and resemblance \
        second. `tested` distinguishes comps we have actually fielded against this opponent \
        from those suggested purely by similarity.",
    security(("session_cookie" = ["intel.view"])),
    params(("id" = i64, Path, description = "Scouted comp id"), SuggestionQuery),
    responses(
        (status = 200, description = "Counter suggestions", body = Vec<CounterSuggestion>),
        (status = 403, description = "Forbidden - lacks intel.view", body = ProblemDetails),
        (status = 404, description = "Scout not found", body = ProblemDetails)
    )
)]
pub async fn counters(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
    Query(query): Query<SuggestionQuery>,
) -> Result<Json<ApiResponse<Vec<CounterSuggestion>>>, AppError> {
    user.require(&perms, Permission::IntelView).await?;
    let suggestions = IntelService::new()
        .counters(&db, id, query.resolved())
        .await?;
    Ok(Json(ApiResponse::new(suggestions)))
}

/// Scouts ranked by how closely they resemble one of our comps.
///
/// # Errors
///
/// Returns `403 Forbidden` without `intel.view`, `404` if the comp has no builds.
#[utoipa::path(
    get,
    path = "/api/intel/comps/{comp_id}/threats",
    tag = "intel",
    summary = "Find enemy compositions resembling one of our comps",
    description = "Scores every scout against one of our own comps, expanded from its build \
        quantities into virtual players. Comp variants do not inherit their parent's builds.",
    security(("session_cookie" = ["intel.view"])),
    params(("comp_id" = i64, Path, description = "Our comp id"), SuggestionQuery),
    responses(
        (status = 200, description = "Threatening scouts", body = Vec<SimilarityHit>),
        (status = 403, description = "Forbidden - lacks intel.view", body = ProblemDetails),
        (status = 404, description = "Comp not found or has no builds", body = ProblemDetails)
    )
)]
pub async fn threats_to_comp(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(comp_id): Path<i64>,
    Query(query): Query<SuggestionQuery>,
) -> Result<Json<ApiResponse<Vec<SimilarityHit>>>, AppError> {
    user.require(&perms, Permission::IntelView).await?;
    let hits = IntelService::new()
        .threats_to_comp(&db, comp_id, query.resolved())
        .await?;
    Ok(Json(ApiResponse::new(hits)))
}

/// The full matchup matrix of our comps against scouted comps.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks `intel.view`.
#[utoipa::path(
    get,
    path = "/api/intel/matchups",
    tag = "intel",
    summary = "Matchup matrix",
    description = "Win/loss tallies per (our comp, scouted comp) pair, taken from the stored \
        battle outcomes. `coverage` reports how many of the underlying battles could be \
        attributed to one of our comps: battles never linked to an event have no comp and are \
        excluded, which is the usual reason a matrix looks sparse.",
    security(("session_cookie" = ["intel.view"])),
    params(MatchupQuery),
    responses(
        (status = 200, description = "Matchup matrix", body = MatchupReport),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks intel.view", body = ProblemDetails)
    )
)]
pub async fn matchup_matrix(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(query): Query<MatchupQuery>,
) -> Result<Json<ApiResponse<MatchupReport>>, AppError> {
    user.require(&perms, Permission::IntelView).await?;
    let scope: Vec<i64> = query.scout_id.into_iter().collect();
    let report = matchups(&db, &scope).await?;
    Ok(Json(ApiResponse::new(report)))
}

/// The full guild report for a window.
///
/// # Errors
///
/// Returns `403 Forbidden` without `intel.report.view`, or `400` if the
/// window bounds are not RFC 3339 or are inverted.
#[utoipa::path(
    get,
    path = "/api/intel/report",
    tag = "intel",
    summary = "Guild report",
    description = "One aggregate behind every Intel dashboard tab: combat performance, \
        operations and attendance, silver flow, per-member and per-comp rows, enemy threat \
        board, weapon meta, an hour-of-day histogram, activity timeline and leaderboards. \
        Defaults to the last 30 days. Served from a short-lived cache; `data_quality` reports \
        how much of the underlying data could be attributed to a comp or a linked member.",
    security(("session_cookie" = ["intel.report.view"])),
    params(ReportParams),
    responses(
        (status = 200, description = "Report computed", body = GuildReport),
        (status = 400, description = "Invalid window", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks intel.report.view", body = ProblemDetails)
    )
)]
pub async fn guild_report(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Extension(cache): Extension<ReportCache>,
    Query(params): Query<ReportParams>,
) -> Result<Json<ApiResponse<GuildReport>>, AppError> {
    user.require(&perms, Permission::IntelReportView).await?;
    let range = DateRange::resolve(params.from.as_deref(), params.to.as_deref())?;
    if let Some(cached) = cache.get(range) {
        return Ok(Json(ApiResponse::new(cached)));
    }
    let report = build_guild_report(&db, &guild_context(&cfg), range).await?;
    cache.put(range, &report);
    Ok(Json(ApiResponse::new(report)))
}

/// Recomputes the report, bypassing and refreshing the cache.
///
/// # Errors
///
/// Returns `403 Forbidden` without `intel.manage`, or `400` for a bad window.
#[utoipa::path(
    post,
    path = "/api/intel/report/refresh",
    tag = "intel",
    summary = "Recompute the guild report",
    description = "Drops the cached report and recomputes it. Use after an import or a bulk \
        correction, when waiting out the cache would show officers stale figures.",
    security(("session_cookie" = ["intel.manage"])),
    params(ReportParams),
    responses(
        (status = 200, description = "Report recomputed", body = GuildReport),
        (status = 400, description = "Invalid window", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks intel.manage", body = ProblemDetails)
    )
)]
pub async fn refresh_guild_report(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Extension(cache): Extension<ReportCache>,
    Query(params): Query<ReportParams>,
) -> Result<Json<ApiResponse<GuildReport>>, AppError> {
    user.require(&perms, Permission::IntelEdit).await?;
    let range = DateRange::resolve(params.from.as_deref(), params.to.as_deref())?;
    cache.invalidate();
    let report = build_guild_report(&db, &guild_context(&cfg), range).await?;
    cache.put(range, &report);
    Ok(Json(ApiResponse::new(report)))
}

/// Member leaderboards for a window.
///
/// Split out from the full report deliberately. Rankings are something every
/// member should see, while the report around them carries silver flow and
/// per-member bank balances that are officer business — so this endpoint is
/// gated at `intel.view` and returns only the boards. The financial boards
/// (`silver_lost`, `split_earnings`, `regear_silver`, `siphoned`) are further
/// gated behind `intel.report.view`: a caller without it gets every other
/// board with the financial ones returned empty rather than 403ing the whole
/// request.
///
/// # Errors
///
/// Returns `403 Forbidden` without `intel.view`, or `400` for a bad window.
#[utoipa::path(
    get,
    path = "/api/intel/leaderboards",
    tag = "intel",
    summary = "Member leaderboards",
    description = "Attendance, kills, deaths, kill and death fame, silver lost, split \
        earnings, regear silver and siphoned energy, each ranked over the window and computed \
        from real activity rather than stored counters. Members with nothing to show are \
        omitted rather than padding the tail with zeroes. Defaults to the last 30 days. The \
        silver lost, split earnings, regear silver and siphoned boards are only populated for \
        callers who also hold `intel.report.view`; other callers get empty arrays for those \
        boards.",
    security(("session_cookie" = ["intel.view"])),
    params(ReportParams),
    responses(
        (status = 200, description = "Leaderboards computed", body = ReportLeaderboards),
        (status = 400, description = "Invalid window", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks intel.view", body = ProblemDetails)
    )
)]
pub async fn leaderboards(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Extension(cache): Extension<ReportCache>,
    Query(params): Query<ReportParams>,
) -> Result<Json<ApiResponse<ReportLeaderboards>>, AppError> {
    user.require(&perms, Permission::IntelView).await?;
    // Silver flow is officer business (same gate as `/report`); a caller with
    // only `intel.view` gets the combat/attendance boards but not the
    // financial ones.
    let can_see_financials = user
        .has_permission(&perms, Permission::IntelReportView)
        .await;
    let range = DateRange::resolve(params.from.as_deref(), params.to.as_deref())?;
    // Shares the report's cache: an officer who already opened the dashboard
    // has paid for this computation, and vice versa.
    let mut leaderboards = if let Some(cached) = cache.get(range) {
        cached.leaderboards
    } else {
        let report = build_guild_report(&db, &guild_context(&cfg), range).await?;
        cache.put(range, &report);
        report.leaderboards
    };
    if !can_see_financials {
        leaderboards.silver_lost.clear();
        leaderboards.split_earnings.clear();
        leaderboards.regear_silver.clear();
        leaderboards.siphoned.clear();
    }
    Ok(Json(ApiResponse::new(leaderboards)))
}
