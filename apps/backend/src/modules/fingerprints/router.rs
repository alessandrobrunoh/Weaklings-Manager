//! `Fingerprints` routing module.
//!
//! Four endpoints, all gated on `intel.report.view` (the same officer-level
//! combat analytics bucket already used by the guild/player report
//! endpoints — equipment-identity read access is squarely part of that):
//! - `GET /` — paginated list of equipment fingerprints.
//! - `GET /{id}` — one fingerprint's full detail (slots, matched build,
//!   observation history).
//! - `GET /builds/{build_id}` — one internal build's observed usage.
//! - `GET /meta` — the current meta for one side, ranked by observation count.
//!
//! Nested at `/fingerprints` in `modules::mod`, so the full paths are
//! `/api/fingerprints`, `/api/fingerprints/{id}`,
//! `/api/fingerprints/builds/{build_id}`, `/api/fingerprints/meta`.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::get,
};
use sea_orm::DatabaseConnection;

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::pagination::{PaginatedFingerprintSummary, PaginationParams, SortOrder};
use crate::responses::{
    ApiResponse, ApiResponseBuildObservationSummary, ApiResponseFingerprintDetail,
    ApiResponseMetaEntries, ApiResponsePaginatedFingerprints,
};

use super::models::{
    BuildObservationSummary, FingerprintDetail, ListFingerprintsQuery, MetaEntry, MetaQuery,
};
use super::service::FingerprintsService;

/// Creates the router for the `fingerprints` module.
pub fn router() -> Router {
    Router::new()
        .route("/", get(list_fingerprints))
        .route("/meta", get(meta))
        .route("/{id}", get(get_fingerprint))
        .route("/builds/{build_id}", get(get_build_observations))
}

/// List equipment fingerprints observed across battle evidence.
#[utoipa::path(
    get,
    path = "/api/fingerprints",
    tag = "fingerprints",
    summary = "List equipment fingerprints",
    description = "Paginated list of equipment fingerprints (immutable, deduplicated equipment \
        identities). `mode`/`role`/`match_status` are exact-match filters. Each row includes \
        observation tallies (`observations`, `friendly_observations`, `enemy_observations`) \
        computed from `battle_loadout_observations` for just this page's fingerprints — a single \
        batched query, not N+1.",
    security(("session_cookie" = ["intel.report.view"])),
    params(ListFingerprintsQuery),
    responses(
        (status = 200, description = "Fingerprints retrieved successfully", body = ApiResponsePaginatedFingerprints),
        (status = 400, description = "Unknown sort column", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing the intel.report.view permission", body = ProblemDetails)
    )
)]
pub async fn list_fingerprints(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Query(query): Query<ListFingerprintsQuery>,
) -> Result<Json<ApiResponse<PaginatedFingerprintSummary>>, AppError> {
    user.require(&perms, Permission::IntelReportView).await?;
    let pagination = PaginationParams {
        page: query.page,
        limit: query.limit,
    };
    let paginated = FingerprintsService::new()
        .list_fingerprints(
            &db,
            &pagination,
            query.mode.as_deref(),
            query.role.as_deref(),
            query.match_status.as_deref(),
            query.sort.as_deref(),
            SortOrder::from_query(query.order.as_deref()),
        )
        .await?;
    Ok(Json(ApiResponse::new(PaginatedFingerprintSummary::from(
        paginated,
    ))))
}

/// Get one fingerprint's full detail.
#[utoipa::path(
    get,
    path = "/api/fingerprints/{id}",
    tag = "fingerprints",
    summary = "Get one fingerprint's detail",
    description = "Identity fields, the full slot -> base item id map, the matched build's name \
        (when any), observation-derived tallies, and the full battle-by-battle observation \
        history ordered newest first.",
    security(("session_cookie" = ["intel.report.view"])),
    params(("id" = i64, Path, description = "Fingerprint id")),
    responses(
        (status = 200, description = "Fingerprint retrieved successfully", body = ApiResponseFingerprintDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing the intel.report.view permission", body = ProblemDetails),
        (status = 404, description = "No fingerprint exists with this id", body = ProblemDetails)
    )
)]
pub async fn get_fingerprint(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<FingerprintDetail>>, AppError> {
    user.require(&perms, Permission::IntelReportView).await?;
    let detail = FingerprintsService::new().get_fingerprint(&db, id).await?;
    Ok(Json(ApiResponse::new(detail)))
}

/// Get one internal build's observed usage.
#[utoipa::path(
    get,
    path = "/api/fingerprints/builds/{build_id}",
    tag = "fingerprints",
    summary = "Get one build's observed usage",
    description = "Every fingerprint ever matched to this build, plus observation tallies \
        aggregated across all of them. A build that has never been observed in battle evidence \
        returns a zeroed rollup and an empty fingerprint list rather than a 404 — that is a \
        valid, meaningful answer.",
    security(("session_cookie" = ["intel.report.view"])),
    params(("build_id" = i64, Path, description = "Internal build id")),
    responses(
        (status = 200, description = "Build observation summary retrieved successfully", body = ApiResponseBuildObservationSummary),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing the intel.report.view permission", body = ProblemDetails),
        (status = 404, description = "No build exists with this id", body = ProblemDetails)
    )
)]
pub async fn get_build_observations(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Path(build_id): Path<i64>,
) -> Result<Json<ApiResponse<BuildObservationSummary>>, AppError> {
    user.require(&perms, Permission::IntelReportView).await?;
    let summary = FingerprintsService::new()
        .get_build_observations(&db, build_id)
        .await?;
    Ok(Json(ApiResponse::new(summary)))
}

/// Get the current meta for one side.
#[utoipa::path(
    get,
    path = "/api/fingerprints/meta",
    tag = "fingerprints",
    summary = "Get the current meta for one side",
    description = "Fingerprints ranked by observation count on just the requested `side` \
        (`\"friendly\"` or `\"enemy\"`, defaulting to `\"enemy\"`), descending, capped at `limit` \
        (default 20, max 100). A fingerprint with zero observations on the requested side never \
        appears — it is not part of that side's meta.",
    security(("session_cookie" = ["intel.report.view"])),
    params(MetaQuery),
    responses(
        (status = 200, description = "Meta entries retrieved successfully", body = ApiResponseMetaEntries),
        (status = 400, description = "Invalid side (must be 'friendly' or 'enemy')", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing the intel.report.view permission", body = ProblemDetails)
    )
)]
pub async fn meta(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Query(query): Query<MetaQuery>,
) -> Result<Json<ApiResponse<Vec<MetaEntry>>>, AppError> {
    user.require(&perms, Permission::IntelReportView).await?;
    let side = query.side.as_deref().unwrap_or("enemy");
    let entries = FingerprintsService::new()
        .meta(&db, side, query.limit())
        .await?;
    Ok(Json(ApiResponse::new(entries)))
}
