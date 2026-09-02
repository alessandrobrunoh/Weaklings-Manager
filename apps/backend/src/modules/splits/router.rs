//! Split routing module.
//!
//! Exposes HTTP endpoints for requesting, managing, and closing loot splits.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::{get, post},
};

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::modules::bank::service::BankService;
use crate::pagination::{PaginatedSplitSummary, PaginationParams};
use crate::responses::{ApiResponse, ApiResponseMatchedParticipantList, ApiResponseSplitDetail};

use super::models::{
    CompleteSplitsBatchRequest, CompleteSplitsBatchResult, CreateIslandRequest,
    CreateIslandTabRequest, CreateSplitRequest, MatchParticipantsRequest, MatchedParticipant,
    SplitDetail, SplitFilters, SplitIslandView, SplitKpiSummary, UpdateIslandRequest,
    UpdateIslandTabRequest, UpdateSplitRequest, UpsertParticipantRequest,
};
use super::service::SplitService;

/// Router query parameters for listing splits, combining pagination and filtering.
///
/// The pagination fields are declared inline rather than via `#[serde(flatten)]` on
/// `PaginationParams`, since axum's `Query` extractor (backed by `serde_html_form`) cannot
/// deserialize non-string fields (e.g. `u64`) through a flattened struct from a query string.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct ListSplitsQuery {
    /// The page number to fetch (1-indexed). Defaults to 1.
    pub page: Option<u64>,
    /// The maximum number of items per page. Defaults to 10.
    pub limit: Option<u64>,
    /// Sort column. Allowed: `created_at` (default), `status`, `note`.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc` (default).
    pub order: Option<String>,
    /// The filter query parameters.
    #[serde(flatten)]
    pub filters: SplitFilters,
}

impl ListSplitsQuery {
    fn pagination(&self) -> PaginationParams {
        PaginationParams {
            page: self.page,
            limit: self.limit,
        }
    }
}

/// Creates the router for the splits module.
pub fn router() -> Router {
    Router::new()
        .route("/islands", get(list_islands).post(create_island))
        .route(
            "/islands/{id}",
            axum::routing::patch(update_island).delete(delete_island),
        )
        .route("/summary", get(split_kpi_summary))
        .route("/islands/{id}/tabs", post(add_island_tab))
        .route(
            "/islands/{id}/tabs/{tab_id}",
            axum::routing::patch(update_island_tab).delete(delete_island_tab),
        )
        .route("/", get(list_splits).post(create_split))
        .route(
            "/{id}",
            get(get_split).patch(update_split).delete(delete_split),
        )
        .route("/{id}/participants", post(add_or_update_participant))
        .route(
            "/{id}/participants/{user_id}",
            axum::routing::delete(remove_participant),
        )
        .route("/{id}/donate", post(donate_split_share))
        .route("/complete-batch", post(complete_splits_batch))
        .route("/{id}/complete", post(complete_split))
        .route("/{id}/not-completed", post(not_completed_split))
        .route("/{id}/lost", post(lost_split))
        .route("/match-participants", post(match_participants))
        .merge(super::discord_sync::router())
}

/// Guild-wide split KPI totals (not scoped to the current list page).
#[utoipa::path(
    get,
    path = "/api/splits/summary",
    tag = "splits",
    summary = "Guild-wide loot-split KPI totals",
    description = "Aggregates every split so list-page cards stay correct when the table is \
        filtered or paginated. Open to any authenticated member.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "KPI totals", body = crate::responses::ApiResponseSplitKpiSummary),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
pub async fn split_kpi_summary(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<SplitKpiSummary>>, AppError> {
    user.require(&perms, Permission::SplitsView).await?;
    let summary = SplitService::new().kpi_summary(&db).await?;
    Ok(Json(ApiResponse::new(summary)))
}

/// Request a new split together with its participants.
///
/// Any authenticated user can request a split. It starts in `"pending"` status; an officer must
/// close it out via `complete`, `not-completed`, or `lost`.
#[utoipa::path(
    post,
    path = "/api/splits",
    tag = "splits",
    summary = "Request a new loot split, with its participants, in one call",
    description = "Any authenticated member can call this — it is not officer-restricted. Unlike an \
        older version of this API, there is no separate \"create draft then add participants\" step: \
        `participants` is required up front (at least one entry, no duplicate `user_id`s, every \
        `weight` must be positive) and the split is created already fully formed. It starts in \
        `SplitStatus::Pending` for standalone loot, or `SplitStatus::AwaitingEvent` when linked to an \
        unfinished event. Linked splits stay payout-blocked until the event ends, while remaining \
        editable (via `POST/DELETE .../participants`) until an officer closes them out with one of `POST /splits/{id}/complete`, `.../not-completed`, or \
        `.../lost` — see the `splits` tag description for the full lifecycle. `net_value` is `null` \
        until completed; the preview formula the frontend can show before that is \
        `estimated_market_value - (estimated_market_value * fee / 100) - repair_value + bags_value`, with a default fee of 20%.",
    security(("session_cookie" = [])),
    request_body(content = CreateSplitRequest, description = "Loot values plus the full participant list up front."),
    responses(
        (status = 200, description = "Split requested successfully; status is \"pending\"", body = ApiResponseSplitDetail),
        (status = 400, description = "Validation error - participants is empty, contains a duplicate user_id, or a non-positive weight", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn create_split(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<CreateSplitRequest>,
) -> Result<Json<ApiResponse<SplitDetail>>, AppError> {
    user.require(&perms, Permission::SplitsCreate).await?;
    let service = SplitService::new();
    let split = service.create_split(&db, user.user_id, req).await?;
    Ok(Json(ApiResponse::new(split)))
}

/// List all splits with pagination and filtering.
///
/// # Errors
///
/// Returns `AppError::Database` if the query fails.
#[utoipa::path(
    get,
    path = "/api/splits",
    tag = "splits",
    summary = "List/search all loot splits",
    description = "Open to any authenticated member — there is no per-user scoping (unlike \
        `GET /bank/transactions`); everyone sees every split. Each item is a `SplitSummary` (no \
        participant list — call `GET /splits/{id}` for that). Filter with `?status=pending`, \
        `?status=completed`, `?status=not_completed`, or `?status=lost`; omit to get every status. \
        Standard `page`/`limit` pagination, default `limit=10`. Sort with `?sort=created_at|status|note` \
        and `?order=asc|desc` (default `created_at desc`). Unknown `sort` values return 400.",
    security(("session_cookie" = [])),
    params(ListSplitsQuery),
    responses(
        (status = 200, description = "List of splits retrieved successfully", body = PaginatedSplitSummary),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn list_splits(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(query): Query<ListSplitsQuery>,
) -> Result<Json<ApiResponse<PaginatedSplitSummary>>, AppError> {
    user.require(&perms, Permission::SplitsView).await?;
    let service = SplitService::new();
    let pagination = query.pagination();
    let paginated = service
        .list_splits_sorted(
            &db,
            &pagination,
            &query.filters,
            query.sort.as_deref(),
            query.order.as_deref(),
        )
        .await?;
    Ok(Json(ApiResponse::new(PaginatedSplitSummary::from(
        paginated,
    ))))
}

/// Get a single split's full detail, including participants.
///
/// # Errors
///
/// Returns `AppError::NotFound` if the split does not exist.
#[utoipa::path(
    get,
    path = "/api/splits/{id}",
    tag = "splits",
    summary = "Get one split's full detail, including participants and computed shares",
    description = "Use this after `POST /splits` (or when a user clicks a row from the \
        `GET /splits` list) to render the detail view. Each participant's `share_amount` is `null` \
        while the split is `pending`; once `completed`, it is the exact amount actually credited to \
        that participant (read back from the generated Guild Bank transactions, so it always sums \
        exactly to `net_value` even with rounding — don't recompute it client-side from `weight`).",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "The split id")),
    responses(
        (status = 200, description = "Split retrieved successfully", body = ApiResponseSplitDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "No split exists with this id", body = ProblemDetails)
    )
)]
async fn get_split(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<SplitDetail>>, AppError> {
    user.require(&perms, Permission::SplitsView).await?;
    let service = SplitService::new();
    let split = service.get_split(&db, id).await?;
    Ok(Json(ApiResponse::new(split)))
}

/// Edit mutable values on a pending split.
///
/// Requires the Admin or Officer role.
#[utoipa::path(
    patch,
    path = "/api/splits/{id}",
    tag = "splits",
    summary = "Edit a pending split's values and note (Officer/Admin only)",
    description = "Updates note, estimated_market_value, fee, repair_value, and bags_value while the split is still pending. Fee must be between 0 and 100 percent. Once completed/not_completed/lost, values are immutable.",
    security(("session_cookie" = ["splits.manage"])),
    params(("id" = i64, Path, description = "The split id")),
    request_body(content = UpdateSplitRequest, description = "Mutable split fields to update."),
    responses(
        (status = 200, description = "Split updated successfully", body = ApiResponseSplitDetail),
        (status = 403, description = "Forbidden - lacks administrator/officer role", body = ProblemDetails),
        (status = 400, description = "Validation error - split is not pending", body = ProblemDetails),
        (status = 404, description = "No split exists with this id", body = ProblemDetails)
    )
)]
async fn update_split(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateSplitRequest>,
) -> Result<Json<ApiResponse<SplitDetail>>, AppError> {
    user.require(&perms, Permission::SplitsEdit).await?;
    let service = SplitService::new();
    let split = service.update_split(&db, id, req).await?;
    Ok(Json(ApiResponse::new(split)))
}

/// Delete a split entirely.
///
/// Requires the Admin or Officer role.
#[utoipa::path(
    delete,
    path = "/api/splits/{id}",
    tag = "splits",
    summary = "Delete a split (Officer/Admin only)",
    description = "Deletes a split and its participants completely. Requires Admin or Officer role.",
    security(("session_cookie" = ["splits.manage"])),
    params(("id" = i64, Path, description = "The split id")),
    responses(
        (status = 204, description = "Split deleted successfully"),
        (status = 403, description = "Forbidden - lacks administrator/officer role", body = ProblemDetails),
        (status = 404, description = "No split exists with this id", body = ProblemDetails)
    )
)]
async fn delete_split(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<axum::response::Response, AppError> {
    user.require(&perms, Permission::SplitsDelete).await?;
    let service = SplitService::new();
    service.delete_split(&db, id).await?;
    Ok(axum::response::Response::builder()
        .status(axum::http::StatusCode::NO_CONTENT)
        .body(axum::body::Body::empty())
        .unwrap())
}

/// Add a new participant to a pending split, or update their weight if already present.
///
/// Requires the Admin or Officer role.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks the required role.
/// * Returns `AppError::Validation` if the split is not pending or the weight is invalid.
#[utoipa::path(
    post,
    path = "/api/splits/{id}/participants",
    tag = "splits",
    summary = "Add or adjust one participant on an already-pending split (Officer/Admin only)",
    description = "For fixing up the roster after `POST /splits` already created the split — e.g. \
        someone joined late, or a weight needs correcting. This is idempotent per user: if \
        `user_id` is already a participant, its `weight` is overwritten; otherwise a new participant \
        row is inserted. Only works while the split is `pending` — once `completed`/`not_completed`/ \
        `lost`, this always returns `400`. Requires the Admin or Officer role. Returns the full, \
        updated split detail (same shape as `GET /splits/{id}`).",
    security(("session_cookie" = ["splits.manage"])),
    params(("id" = i64, Path, description = "The split id")),
    request_body(content = UpsertParticipantRequest, description = "The user to add, and the weight to assign (or overwrite, if already a participant)."),
    responses(
        (status = 200, description = "Participant added/updated successfully", body = ApiResponseSplitDetail),
        (status = 403, description = "Forbidden - lacks administrator/officer role", body = ProblemDetails),
        (status = 400, description = "Validation error - the split isn't pending, or weight isn't positive", body = ProblemDetails),
        (status = 404, description = "No split exists with this id", body = ProblemDetails)
    )
)]
async fn add_or_update_participant(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
    Json(req): Json<UpsertParticipantRequest>,
) -> Result<Json<ApiResponse<SplitDetail>>, AppError> {
    user.require(&perms, Permission::SplitsEdit).await?;
    let service = SplitService::new();
    let split = service.add_or_update_participant(&db, id, req).await?;
    Ok(Json(ApiResponse::new(split)))
}

/// Remove a participant from a pending split.
///
/// Requires the Admin or Officer role.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks the required role.
/// * Returns `AppError::Validation` if the split is not pending.
#[utoipa::path(
    delete,
    path = "/api/splits/{id}/participants/{user_id}",
    tag = "splits",
    summary = "Remove one participant from a pending split (Officer/Admin only)",
    description = "Only works while the split is `pending`. No request body. Idempotent in effect \
        (removing a user who isn't a participant just leaves the roster unchanged and still returns \
        `200`) — it does not 404 if `user_id` wasn't present. Requires the Admin or Officer role.",
    security(("session_cookie" = ["splits.manage"])),
    params(
        ("id" = i64, Path, description = "The split id"),
        ("user_id" = i64, Path, description = "The participant's internal user id (from GET /users, not their Discord id)")
    ),
    responses(
        (status = 200, description = "Participant removed (or already absent); returns the updated split detail", body = ApiResponseSplitDetail),
        (status = 403, description = "Forbidden - lacks administrator/officer role", body = ProblemDetails),
        (status = 400, description = "Validation error - the split isn't pending", body = ProblemDetails),
        (status = 404, description = "No split exists with this id", body = ProblemDetails)
    )
)]
async fn remove_participant(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path((id, user_id)): Path<(i64, i64)>,
) -> Result<Json<ApiResponse<SplitDetail>>, AppError> {
    user.require(&perms, Permission::SplitsEdit).await?;
    let service = SplitService::new();
    let split = service.remove_participant(&db, id, user_id).await?;
    Ok(Json(ApiResponse::new(split)))
}

/// Complete a pending split, generating Guild Bank transactions for each participant.
///
/// Requires the Admin or Officer role.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks the required role.
/// * Returns `AppError::Validation` if the split is not pending, has no participants, or the net
///   value is not positive.
#[utoipa::path(
    post,
    path = "/api/splits/{id}/complete",
    tag = "splits",
    summary = "Close a pending split as completed — this is what actually pays people (Officer/Admin only)",
    description = "The one split-closing action that has a side effect beyond the split row itself: \
        computes `net_value = estimated_market_value - repair_value + bags_value` (must be strictly \
        positive), then creates one **new**, `pending`-status Guild Bank transaction per participant \
        (`type = \"split_credit\"`, linked back via `split_id`), splitting `net_value` proportionally \
        by weight with remainder correction on the last participant so the amounts sum exactly. Those \
        transactions then follow the normal two-step withdrawal flow (`bank` tag) independently of \
        this split. No request body. One-way door: only callable while `pending`; fails with `400` if \
        there are no participants or if it's already `completed`/`not_completed`/`lost`. Requires the \
        Admin or Officer role.",
    security(("session_cookie" = ["splits.manage"])),
    params(("id" = i64, Path, description = "The split id")),
    responses(
        (status = 200, description = "Split completed; status is now \"completed\", net_value and every participant's share_amount are set, and Guild Bank transactions were created", body = ApiResponseSplitDetail),
        (status = 403, description = "Forbidden - lacks administrator/officer role", body = ProblemDetails),
        (status = 400, description = "Validation error - the split isn't pending, has no participants, or net_value isn't positive", body = ProblemDetails),
        (status = 404, description = "No split exists with this id", body = ProblemDetails)
    )
)]
async fn complete_split(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<SplitDetail>>, AppError> {
    user.require(&perms, Permission::SplitsEdit).await?;
    let service = SplitService::new();
    let split = service.complete_split(&db, id, user.user_id).await?;
    Ok(Json(ApiResponse::new(split)))
}

/// Donate the caller's own requestable share from a completed split to the Guild Bank.
#[utoipa::path(
    post,
    path = "/api/splits/{id}/donate",
    tag = "splits",
    summary = "Donate the caller's split share to the Guild Bank",
    description = "Irreversibly marks the caller's own pending or rejected `split_credit` transaction as donated to the virtual Guild Bank. The operation never affects another participant's share and cannot be undone.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "The completed split id")),
    responses(
        (status = 200, description = "Share donated and split detail returned", body = ApiResponseSplitDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 409, description = "No requestable share is available for this user", body = ProblemDetails),
        (status = 404, description = "No split exists with this id", body = ProblemDetails)
    )
)]
pub async fn donate_split_share(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<SplitDetail>>, AppError> {
    BankService::new()
        .donate_split_share(&db, id, user.user_id)
        .await?;
    let split = SplitService::new().get_split(&db, id).await?;
    Ok(Json(ApiResponse::new(split)))
}

/// Mark a pending split as not completed (terminal, no transactions generated).
///
/// Requires the Admin or Officer role.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks the required role.
/// * Returns `AppError::Validation` if the split is not pending.
#[utoipa::path(
    post,
    path = "/api/splits/{id}/not-completed",
    tag = "splits",
    summary = "Close a pending split as \"not completed\" — no payout (Officer/Admin only)",
    description = "Use this when the split itself didn't happen or shouldn't be paid out (as opposed \
        to `.../lost`, which specifically means the loot was never picked up). Terminal: moves \
        straight to `SplitStatus::NotCompleted` with no Guild Bank transactions generated, and cannot \
        be reopened via this API afterward — every other closing/editing endpoint will then 400 on \
        this split. No request body. Requires the Admin or Officer role.",
    security(("session_cookie" = ["splits.manage"])),
    params(("id" = i64, Path, description = "The split id")),
    responses(
        (status = 200, description = "Split marked not completed; status is now \"not_completed\" (terminal)", body = ApiResponseSplitDetail),
        (status = 403, description = "Forbidden - lacks administrator/officer role", body = ProblemDetails),
        (status = 400, description = "Validation error - the split is not in pending status", body = ProblemDetails),
        (status = 404, description = "No split exists with this id", body = ProblemDetails)
    )
)]
async fn not_completed_split(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<SplitDetail>>, AppError> {
    user.require(&perms, Permission::SplitsEdit).await?;
    let service = SplitService::new();
    let split = service.mark_not_completed(&db, id).await?;
    Ok(Json(ApiResponse::new(split)))
}

/// Mark a pending split as lost — the loot was never recovered (terminal, no transactions
/// generated).
///
/// Requires the Admin or Officer role.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks the required role.
/// * Returns `AppError::Validation` if the split is not pending.
#[utoipa::path(
    post,
    path = "/api/splits/{id}/lost",
    tag = "splits",
    summary = "Close a pending split as \"lost\" — the loot was never recovered (Officer/Admin only)",
    description = "Use this specifically when the item(s) the split was tracking were never actually \
        obtained (e.g. died before looting, got sniped). Terminal: moves straight to \
        `SplitStatus::Lost` with no Guild Bank transactions generated, and cannot be reopened via \
        this API afterward. No request body. Requires the Admin or Officer role.",
    security(("session_cookie" = ["splits.manage"])),
    params(("id" = i64, Path, description = "The split id")),
    responses(
        (status = 200, description = "Split marked lost; status is now \"lost\" (terminal)", body = ApiResponseSplitDetail),
        (status = 403, description = "Forbidden - lacks administrator/officer role", body = ProblemDetails),
        (status = 400, description = "Validation error - the split is not in pending status", body = ProblemDetails),
        (status = 404, description = "No split exists with this id", body = ProblemDetails)
    )
)]
async fn lost_split(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<SplitDetail>>, AppError> {
    user.require(&perms, Permission::SplitsEdit).await?;
    let service = SplitService::new();
    let split = service.mark_lost(&db, id).await?;
    Ok(Json(ApiResponse::new(split)))
}

/// Match raw candidate names (e.g. OCR'd from a screenshot) against known linked players.
///
/// Any authenticated member can call this. Intended to power an "import participants from a
/// screenshot" flow together with `POST /utils/ocr`.
#[utoipa::path(
    post,
    path = "/api/splits/match-participants",
    tag = "splits",
    summary = "Match raw candidate names (e.g. OCR'd from a screenshot) against known linked players",
    description = "Any authenticated member can call this. Intended to power a \"import \
        participants from a screenshot\" flow: call `POST /utils/ocr` first to get raw text \
        lines from an uploaded image, then pass those lines here as `names`. Matching is \
        case-insensitive against each user's linked Albion Online character name \
        (`albion_links.albion_player_name`, set via `POST /albion/link`). Only names that \
        resolve all the way to an existing `users` row are returned — unmatched names, or names \
        linked to a Discord account that has never logged into this app, are silently dropped, \
        never surfaced as an error. Returned `user_id`s can be used directly as split \
        participants.",
    security(("session_cookie" = [])),
    request_body(content = MatchParticipantsRequest, description = "Candidate names to match, e.g. OCR output lines."),
    responses(
        (status = 200, description = "Matching completed (possibly with zero matches)", body = ApiResponseMatchedParticipantList),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn match_participants(
    _user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(body): Json<MatchParticipantsRequest>,
) -> Result<Json<ApiResponse<Vec<MatchedParticipant>>>, AppError> {
    let service = SplitService::new();
    let matched = service.match_participants(&db, &body.names).await?;
    Ok(Json(ApiResponse::new(matched)))
}

/// Completes several splits in one action.
///
/// # Errors
///
/// Returns `403 Forbidden` without `splits.manage`, or `400` if no ids were
/// supplied.
#[utoipa::path(
    post,
    path = "/api/splits/complete-batch",
    tag = "splits",
    summary = "Complete several splits at once",
    description = "Pays out each listed split and credits its participants. Splits are \
        processed independently: one that cannot be completed — already paid out, no \
        participants — is reported in `failed` while the rest still go through, so settling a \
        night's splits is not lost to a single bad entry.",
    security(("session_cookie" = ["splits.manage"])),
    request_body = CompleteSplitsBatchRequest,
    responses(
        (status = 200, description = "Batch processed", body = CompleteSplitsBatchResult),
        (status = 400, description = "No split ids supplied", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks splits.manage", body = ProblemDetails)
    )
)]
pub async fn complete_splits_batch(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(body): Json<CompleteSplitsBatchRequest>,
) -> Result<Json<ApiResponse<CompleteSplitsBatchResult>>, AppError> {
    user.require(&perms, Permission::SplitsEdit).await?;
    let result = SplitService::new()
        .complete_splits_batch(&db, &body.split_ids, user.user_id)
        .await?;
    Ok(Json(ApiResponse::new(result)))
}

/// Lists the island catalog, including nested tabs.
#[utoipa::path(
    get,
    path = "/api/splits/islands",
    tag = "splits",
    summary = "List guild islands and their tabs",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Island catalog", body = Vec<SplitIslandView>),
        (status = 401, description = "Unauthorized", body = ProblemDetails)
    )
)]
async fn list_islands(
    _user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<Vec<SplitIslandView>>>, AppError> {
    let islands = SplitService::new().list_islands(&db).await?;
    Ok(Json(ApiResponse::new(islands)))
}

/// Creates an island with its initial tabs. Admin only.
#[utoipa::path(
    post,
    path = "/api/splits/islands",
    tag = "splits",
    summary = "Create a guild island and its tabs",
    security(("session_cookie" = ["splits.islands.manage"])),
    request_body = CreateIslandRequest,
    responses(
        (status = 200, description = "Island created", body = SplitIslandView),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails)
    )
)]
async fn create_island(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<CreateIslandRequest>,
) -> Result<Json<ApiResponse<SplitIslandView>>, AppError> {
    user.require(&perms, Permission::SplitsIslandsManage)
        .await?;
    let island = SplitService::new().create_island(&db, req).await?;
    Ok(Json(ApiResponse::new(island)))
}

/// Renames an island or moves it to another city. Admin only.
#[utoipa::path(
    patch,
    path = "/api/splits/islands/{id}",
    tag = "splits",
    summary = "Update a guild island",
    security(("session_cookie" = ["splits.islands.manage"])),
    params(("id" = i64, Path, description = "Island id")),
    request_body = UpdateIslandRequest,
    responses(
        (status = 200, description = "Island updated", body = SplitIslandView),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Not found", body = ProblemDetails)
    )
)]
async fn update_island(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateIslandRequest>,
) -> Result<Json<ApiResponse<SplitIslandView>>, AppError> {
    user.require(&perms, Permission::SplitsIslandsManage)
        .await?;
    let island = SplitService::new().update_island(&db, id, req).await?;
    Ok(Json(ApiResponse::new(island)))
}

/// Deletes an island that no split still references. Admin only.
#[utoipa::path(
    delete,
    path = "/api/splits/islands/{id}",
    tag = "splits",
    summary = "Delete a guild island",
    security(("session_cookie" = ["splits.islands.manage"])),
    params(("id" = i64, Path, description = "Island id")),
    responses(
        (status = 204, description = "Island deleted"),
        (status = 400, description = "Still referenced by a split", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Not found", body = ProblemDetails)
    )
)]
async fn delete_island(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<axum::response::Response, AppError> {
    user.require(&perms, Permission::SplitsIslandsManage)
        .await?;
    SplitService::new().delete_island(&db, id).await?;
    Ok(axum::response::Response::builder()
        .status(axum::http::StatusCode::NO_CONTENT)
        .body(axum::body::Body::empty())
        .unwrap())
}

/// Adds a tab to an island. Admin only.
#[utoipa::path(
    post,
    path = "/api/splits/islands/{id}/tabs",
    tag = "splits",
    summary = "Add a tab to a guild island",
    security(("session_cookie" = ["splits.islands.manage"])),
    params(("id" = i64, Path, description = "Island id")),
    request_body = CreateIslandTabRequest,
    responses(
        (status = 200, description = "Tab added", body = SplitIslandView),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Not found", body = ProblemDetails)
    )
)]
async fn add_island_tab(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
    Json(req): Json<CreateIslandTabRequest>,
) -> Result<Json<ApiResponse<SplitIslandView>>, AppError> {
    user.require(&perms, Permission::SplitsIslandsManage)
        .await?;
    let island = SplitService::new().add_island_tab(&db, id, req).await?;
    Ok(Json(ApiResponse::new(island)))
}

/// Renames or reorders a tab. Admin only.
#[utoipa::path(
    patch,
    path = "/api/splits/islands/{id}/tabs/{tab_id}",
    tag = "splits",
    summary = "Update an island tab",
    security(("session_cookie" = ["splits.islands.manage"])),
    params(
        ("id" = i64, Path, description = "Island id"),
        ("tab_id" = i64, Path, description = "Tab id")
    ),
    request_body = UpdateIslandTabRequest,
    responses(
        (status = 200, description = "Tab updated", body = SplitIslandView),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Not found", body = ProblemDetails)
    )
)]
async fn update_island_tab(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path((id, tab_id)): Path<(i64, i64)>,
    Json(req): Json<UpdateIslandTabRequest>,
) -> Result<Json<ApiResponse<SplitIslandView>>, AppError> {
    user.require(&perms, Permission::SplitsIslandsManage)
        .await?;
    let island = SplitService::new()
        .update_island_tab(&db, id, tab_id, req)
        .await?;
    Ok(Json(ApiResponse::new(island)))
}

/// Deletes a tab that is not the last one and is unused. Admin only.
#[utoipa::path(
    delete,
    path = "/api/splits/islands/{id}/tabs/{tab_id}",
    tag = "splits",
    summary = "Delete an island tab",
    security(("session_cookie" = ["splits.islands.manage"])),
    params(
        ("id" = i64, Path, description = "Island id"),
        ("tab_id" = i64, Path, description = "Tab id")
    ),
    responses(
        (status = 200, description = "Tab deleted", body = SplitIslandView),
        (status = 400, description = "Last tab or still referenced", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Not found", body = ProblemDetails)
    )
)]
async fn delete_island_tab(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path((id, tab_id)): Path<(i64, i64)>,
) -> Result<Json<ApiResponse<SplitIslandView>>, AppError> {
    user.require(&perms, Permission::SplitsIslandsManage)
        .await?;
    let island = SplitService::new()
        .delete_island_tab(&db, id, tab_id)
        .await?;
    Ok(Json(ApiResponse::new(island)))
}
