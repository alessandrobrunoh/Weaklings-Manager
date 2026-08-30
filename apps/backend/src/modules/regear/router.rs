//! Regear routing module.
//!
//! Exposes HTTP endpoints for the Call-To-Arms gear reimbursement workflow: list/get deaths,
//! member-initiated requests, officer adjudication, settings management, and manual extraction.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::{get, post, put},
};

use crate::errors::{AppError, ProblemDetails};
use crate::modules::albiondata::service::AlbionDataService;
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::pagination::PaginationParams;
use crate::responses::ApiResponse;

use super::extractor::ExtractionGuildContext;
use super::models::{
    AcceptRegearRequest, DeathFilters, ExtractionReport, RegearBudgetSummary, RegearSettingsView,
    RejectRegearRequest, UpdateRegearSettingsRequest,
};
use super::service::RegearService;

/// Query parameters for `GET /deaths`, combining pagination and filtering.
///
/// The pagination fields are declared inline rather than via `#[serde(flatten)]` on
/// `PaginationParams`, since axum's `Query` extractor (backed by `serde_html_form`) cannot
/// deserialize non-string fields (e.g. `u64`) through a flattened struct from a query string.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct ListDeathsQuery {
    /// The page number to fetch (1-indexed). Defaults to 1.
    pub page: Option<u64>,
    /// The maximum number of items per page. Defaults to 10.
    pub limit: Option<u64>,
    /// The filter query parameters.
    #[serde(flatten)]
    pub filters: DeathFilters,
}

impl ListDeathsQuery {
    fn pagination(&self) -> PaginationParams {
        PaginationParams {
            page: self.page,
            limit: self.limit,
        }
    }
}

/// Query parameters for `POST /admin/run-extraction`.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct RunExtractionQuery {
    /// The event id to extract deaths for.
    pub event_id: i64,
}

/// Wraps the configured guild id + server required by the extractor.
///
/// Built once at router build time from `Config`; passed via `Extension` so handlers don't have to
/// thread it through every signature.
#[derive(Clone)]
pub struct RegearGuildContext {
    /// AlbionBB guild id of the configured guild.
    pub guild_id: String,
    /// AlbionBB server region.
    pub server: String,
}

impl RegearGuildContext {
    /// Converts to the extractor's view of the same data.
    fn to_extraction_context(&self) -> ExtractionGuildContext {
        ExtractionGuildContext {
            guild_id: self.guild_id.clone(),
            server: if self.server.is_empty() {
                None
            } else {
                Some(self.server.clone())
            },
        }
    }
}

/// Creates the router for the regear module.
pub fn router() -> Router {
    Router::new()
        .route("/deaths", get(list_deaths))
        .route("/deaths/{death_id}", get(get_death))
        .route("/deaths/{death_id}/request", post(request_regear))
        .route("/requests", get(list_pending_requests))
        .route("/requests/{death_id}/accept", post(accept_request))
        .route("/requests/{death_id}/reject", post(reject_request))
        .route("/events/{event_id}/deaths", get(list_event_deaths))
        .route("/admin/run-extraction", post(run_extraction))
        .route("/settings", get(get_settings).put(update_settings))
        .route("/me/summary", get(get_my_summary))
}

/// Paginated list of deaths visible to the caller.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks the `regear.view` permission, or if they pass
/// `global=true` without `regear.adjudicate`.
#[utoipa::path(
    get,
    path = "/api/regear/deaths",
    tag = "regear",
    summary = "List regear deaths visible to the caller",
    description = "Without `global=true`, returns only the caller's own deaths. With `global=true` \
        (requires `regear.adjudicate`), returns all deaths guild-wide. Standard `page`/`limit` \
        pagination; default sort is `killed_at` descending. Filters: `event_id`, `status`, `user_id`, \
        `bank_transaction_id`, `search` (player name substring). `history=true` restricts to \
        approved/rejected when `status` is omitted. Sort whitelist: `killed_at`, `status`, \
        `player_name`; unknown `sort` values return 400.",
    security(("session_cookie" = ["regear.view"])),
    params(ListDeathsQuery),
    responses(
        (status = 200, description = "Deaths retrieved successfully", body = crate::pagination::PaginatedDeathView),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks regear.view, or used global without regear.adjudicate", body = ProblemDetails)
    )
)]
async fn list_deaths(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(query): Query<ListDeathsQuery>,
) -> Result<Json<ApiResponse<crate::pagination::PaginatedDeathView>>, AppError> {
    user.require(&perms, Permission::RegearView).await?;
    let global = query.filters.global.unwrap_or(false);
    if global {
        user.require(&perms, Permission::RegearAdjudicate).await?;
    }
    let service = RegearService::new();
    let paginated = service
        .list_deaths(
            &db,
            user.user_id,
            global,
            &query.pagination(),
            &query.filters,
        )
        .await?;
    Ok(Json(ApiResponse::new(
        crate::pagination::PaginatedDeathView::from(paginated),
    )))
}

/// Fetch one death row by id.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks `regear.view`. Returns `404 Not Found` if the
/// death does not exist.
#[utoipa::path(
    get,
    path = "/api/regear/deaths/{death_id}",
    tag = "regear",
    summary = "Get one regear death row",
    description = "Returns the full death view, including the frozen loadout JSON and the \
        auto-estimate breakdown. Available to any user with `regear.view`; the router does not \
        additionally scope by user id (callers who can see the queue can see any row).",
    security(("session_cookie" = ["regear.view"])),
    responses(
        (status = 200, description = "Death retrieved successfully", body = crate::modules::regear::models::DeathView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks regear.view", body = ProblemDetails),
        (status = 404, description = "Death not found", body = ProblemDetails)
    )
)]
async fn get_death(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(death_id): Path<i64>,
) -> Result<Json<ApiResponse<crate::modules::regear::models::DeathView>>, AppError> {
    user.require(&perms, Permission::RegearView).await?;
    let service = RegearService::new();
    let death = service.get_death(&db, death_id).await?;
    Ok(Json(ApiResponse::new(death)))
}

/// Member requests regear for one of their deaths. Single-shot, no bulk action.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller is not the victim or lacks `regear.request`. Returns
/// `409 Conflict` if the death is not in the `available` status.
#[utoipa::path(
    post,
    path = "/api/regear/deaths/{death_id}/request",
    tag = "regear",
    summary = "Request regear for one death",
    description = "Moves a death from `available` to `pending`. The caller must be the victim and \
        must not have exceeded the per-event or per-month regear caps. There is no bulk action — \
        the member must click per death. Rejected deaths can never be re-requested.",
    security(("session_cookie" = ["regear.request"])),
    responses(
        (status = 200, description = "Death moved to pending", body = crate::modules::regear::models::DeathView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden - not your death or lacks permission", body = ProblemDetails),
        (status = 404, description = "Death not found", body = ProblemDetails),
        (status = 409, description = "Death is not available", body = ProblemDetails)
    )
)]
async fn request_regear(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(death_id): Path<i64>,
) -> Result<Json<ApiResponse<crate::modules::regear::models::DeathView>>, AppError> {
    user.require(&perms, Permission::RegearRequest).await?;
    let service = RegearService::new();
    let death = service.request_regear(&db, user.user_id, death_id).await?;
    Ok(Json(ApiResponse::new(death)))
}

/// Officer queue: every `pending` death across the guild.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks `regear.adjudicate`.
#[utoipa::path(
    get,
    path = "/api/regear/requests",
    tag = "regear",
    summary = "Officer queue: list pending regear requests",
    description = "Returns every death currently in the `pending` status across all members, \
        newest-requested first. Requires `regear.adjudicate`.",
    security(("session_cookie" = ["regear.adjudicate"])),
    params(ListDeathsQuery),
    responses(
        (status = 200, description = "Pending requests retrieved", body = crate::pagination::PaginatedDeathView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks regear.adjudicate", body = ProblemDetails)
    )
)]
async fn list_pending_requests(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(query): Query<ListDeathsQuery>,
) -> Result<Json<ApiResponse<crate::pagination::PaginatedDeathView>>, AppError> {
    user.require(&perms, Permission::RegearAdjudicate).await?;
    let mut filters = query.filters.clone();
    // Force the status filter to pending; ignore whatever the client sent.
    filters.status = Some(super::status::RegearStatus::Pending);
    let service = RegearService::new();
    let paginated = service
        .list_deaths(&db, user.user_id, true, &query.pagination(), &filters)
        .await?;
    Ok(Json(ApiResponse::new(
        crate::pagination::PaginatedDeathView::from(paginated),
    )))
}

/// Officer accepts a pending regear. The body carries the officer-edited breakdown and total.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks `regear.adjudicate`. Returns `409 Conflict` if the
/// death is not `pending`. Returns `400 Validation` if the breakdown does not sum to
/// `final_amount`.
#[utoipa::path(
    post,
    path = "/api/regear/requests/{death_id}/accept",
    tag = "regear",
    summary = "Accept (and credit) a pending regear request",
    description = "Locks the officer-edited breakdown, inserts a Guild Bank `regear_credit` \
        transaction in `pending` status for the victim, and marks the death `approved` (terminal). \
        The bank row stays `pending` so the victim still has to withdraw it through the normal \
        bank flow. The total is recomputed server-side from the breakdown — never trust the \
        client-supplied sum.",
    security(("session_cookie" = ["regear.adjudicate"])),
    request_body(content = AcceptRegearRequest, description = "The officer-edited breakdown and the accepted total. The total must equal the sum of `unit_price * quantity` for included rows."),
    responses(
        (status = 200, description = "Request accepted; bank row credited", body = crate::modules::regear::models::DeathView),
        (status = 400, description = "Breakdown does not sum to final_amount", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Death not found", body = ProblemDetails),
        (status = 409, description = "Death is not pending", body = ProblemDetails)
    )
)]
async fn accept_request(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(death_id): Path<i64>,
    Json(req): Json<AcceptRegearRequest>,
) -> Result<Json<ApiResponse<crate::modules::regear::models::DeathView>>, AppError> {
    user.require(&perms, Permission::RegearAdjudicate).await?;
    let service = RegearService::new();
    let death = service
        .accept_request(&db, user.user_id, death_id, &req)
        .await?;
    Ok(Json(ApiResponse::new(death)))
}

/// Officer rejects a pending regear. Terminal — the death can never be re-requested.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks `regear.adjudicate`. Returns `400 Validation` if
/// the note is missing or > 500 chars.
#[utoipa::path(
    post,
    path = "/api/regear/requests/{death_id}/reject",
    tag = "regear",
    summary = "Reject a pending regear request (terminal)",
    description = "Marks the death `rejected`. The note is mandatory (1..=500 chars). Once \
        rejected, the death can never be re-requested.",
    security(("session_cookie" = ["regear.adjudicate"])),
    request_body(content = RejectRegearRequest, description = "The mandatory rejection note."),
    responses(
        (status = 200, description = "Request rejected (terminal)", body = crate::modules::regear::models::DeathView),
        (status = 400, description = "Note missing or too long", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Death not found", body = ProblemDetails),
        (status = 409, description = "Death is not pending", body = ProblemDetails)
    )
)]
async fn reject_request(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(death_id): Path<i64>,
    Json(req): Json<RejectRegearRequest>,
) -> Result<Json<ApiResponse<crate::modules::regear::models::DeathView>>, AppError> {
    user.require(&perms, Permission::RegearAdjudicate).await?;
    let service = RegearService::new();
    let death = service
        .reject_request(&db, user.user_id, death_id, &req)
        .await?;
    Ok(Json(ApiResponse::new(death)))
}

/// Per-event breakdown of deaths.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks `regear.view`.
#[utoipa::path(
    get,
    path = "/api/regear/events/{event_id}/deaths",
    tag = "regear",
    summary = "List regear deaths for one event",
    description = "Returns every death extracted from the event's battles. Without \
        `regear.adjudicate` the list is scoped to the caller's own deaths.",
    security(("session_cookie" = ["regear.view"])),
    params(ListDeathsQuery),
    responses(
        (status = 200, description = "Deaths retrieved", body = crate::pagination::PaginatedDeathView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn list_event_deaths(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(event_id): Path<i64>,
    Query(query): Query<ListDeathsQuery>,
) -> Result<Json<ApiResponse<crate::pagination::PaginatedDeathView>>, AppError> {
    user.require(&perms, Permission::RegearView).await?;
    let global = query.filters.global.unwrap_or(false);
    if global {
        user.require(&perms, Permission::RegearAdjudicate).await?;
    }
    let mut filters = query.filters.clone();
    filters.event_id = Some(event_id);
    let service = RegearService::new();
    let paginated = service
        .list_deaths(&db, user.user_id, global, &query.pagination(), &filters)
        .await?;
    Ok(Json(ApiResponse::new(
        crate::pagination::PaginatedDeathView::from(paginated),
    )))
}

/// Manually trigger extraction for one event.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks `regear.adjudicate`. Returns `404 Not Found` if
/// the event does not exist. Returns `400 Validation` if the event is not a `call_to_arms` event.
#[utoipa::path(
    post,
    path = "/api/regear/admin/run-extraction",
    tag = "regear",
    summary = "Manually trigger regear extraction for one event",
    description = "Walks the event's linked battles, extracts guild-member deaths, prices their \
        loadouts via Albion Online Data, and inserts new `regear_deaths` rows. Idempotent: \
        re-running on the same event inserts only newly discovered deaths. Useful when AlbionBB \
        ingested late battles after the auto-stop worker's first run.",
    security(("session_cookie" = ["regear.adjudicate"])),
    params(RunExtractionQuery),
    responses(
        (status = 200, description = "Extraction completed", body = ExtractionReport),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails)
    )
)]
async fn run_extraction(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(albiondata): Extension<AlbionDataService>,
    Extension(guild_ctx): Extension<RegearGuildContext>,
    Query(query): Query<RunExtractionQuery>,
) -> Result<Json<ApiResponse<ExtractionReport>>, AppError> {
    user.require(&perms, Permission::RegearAdjudicate).await?;
    let service = RegearService::new();
    let report = service
        .run_extraction(
            &db,
            &albiondata,
            guild_ctx.to_extraction_context(),
            query.event_id,
        )
        .await?;
    Ok(Json(ApiResponse::new(report)))
}

/// Read the singleton settings row.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks `regear.view`.
#[utoipa::path(
    get,
    path = "/api/regear/settings",
    tag = "regear",
    summary = "Read guild-wide regear settings",
    description = "Returns the singleton `regear_settings` row (caps, slot mask, pricing).",
    security(("session_cookie" = ["regear.view"])),
    responses(
        (status = 200, description = "Settings retrieved", body = RegearSettingsView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn get_settings(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<RegearSettingsView>>, AppError> {
    user.require(&perms, Permission::RegearView).await?;
    let service = RegearService::new();
    let settings = service.get_settings(&db).await?;
    Ok(Json(ApiResponse::new(settings)))
}

/// Update the singleton settings row.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks `regear.settings.manage`. Returns `400 Validation`
/// for negative caps or invalid strategy strings.
#[utoipa::path(
    put,
    path = "/api/regear/settings",
    tag = "regear",
    summary = "Update guild-wide regear settings",
    description = "Partial update: only the fields present in the body are changed. The slot mask \
        takes effect on the next extraction run.",
    security(("session_cookie" = ["regear.settings.manage"])),
    request_body(content = UpdateRegearSettingsRequest, description = "Fields to update. All fields are optional; absent fields are left unchanged."),
    responses(
        (status = 200, description = "Settings updated", body = RegearSettingsView),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn update_settings(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<UpdateRegearSettingsRequest>,
) -> Result<Json<ApiResponse<RegearSettingsView>>, AppError> {
    user.require(&perms, Permission::RegearSettingsManage)
        .await?;
    let service = RegearService::new();
    let settings = service.update_settings(&db, user.user_id, &req).await?;
    Ok(Json(ApiResponse::new(settings)))
}

/// Per-user budget usage.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks `regear.view`.
#[utoipa::path(
    get,
    path = "/api/regear/me/summary",
    tag = "regear",
    summary = "Get the caller's regear budget usage",
    description = "Returns how many regears the caller has used for the most recent CTA event and \
        in the rolling 30-day window, alongside the configured caps. Powers the budget badge.",
    security(("session_cookie" = ["regear.view"])),
    responses(
        (status = 200, description = "Summary retrieved", body = RegearBudgetSummary),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn get_my_summary(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<RegearBudgetSummary>>, AppError> {
    user.require(&perms, Permission::RegearView).await?;
    let service = RegearService::new();
    let summary = service.get_my_summary(&db, user.user_id).await?;
    Ok(Json(ApiResponse::new(summary)))
}
