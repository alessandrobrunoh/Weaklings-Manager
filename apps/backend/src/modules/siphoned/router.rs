//! Siphoned routing module.
//!
//! Exposes HTTP endpoints for the Guild Siphoned Energy ledger: bulk ingest of the Albion Online
//! export, raw entry listing with filters, per-player balances, and ingestion batch management.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::{delete, get, post, put},
};

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::pagination::{PaginatedEntryView, PaginationParams};
use crate::responses::{
    ApiResponse, ApiResponseBatchSummaryList, ApiResponseDeletedCount, ApiResponseEntryView,
    ApiResponseIngestResponse, ApiResponsePaginatedEntryView, ApiResponsePlayerBalanceDetail,
    ApiResponsePlayerBalanceList,
};

use super::models::{
    BalanceQuery, EntryFilters, EntryMutationRequest, IngestRequest, PlayerBalanceDetail,
};
use super::service::{DEFAULT_RECENT_ENTRIES, SiphonedService};

/// Router query parameters for listing entries, combining pagination and filtering.
///
/// The pagination fields are declared inline rather than via `#[serde(flatten)]` on
/// `PaginationParams`, since axum's `Query` extractor (backed by `serde_html_form`) cannot
/// deserialize non-string fields (e.g. `u64`) through a flattened struct from a query string.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct ListEntriesQuery {
    /// The page number to fetch (1-indexed). Defaults to 1.
    pub page: Option<u64>,
    /// The maximum number of items per page. Defaults to 10.
    pub limit: Option<u64>,
    /// The filter query parameters.
    #[serde(flatten)]
    pub filters: EntryFilters,
}

impl ListEntriesQuery {
    fn pagination(&self) -> PaginationParams {
        PaginationParams {
            page: self.page,
            limit: self.limit,
        }
    }
}

/// Query parameters for `GET /balances/{player_name}`.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct PlayerBalanceQuery {
    /// How many recent entries to return alongside the aggregate (default 20, max 100).
    pub recent: Option<u64>,
}

/// Creates the router for the siphoned module.
pub fn router() -> Router {
    Router::new()
        .route("/ingest", post(ingest))
        .route("/entries", get(list_entries).post(create_entry))
        .route(
            "/entries/{entry_id}",
            put(update_entry).delete(delete_entry),
        )
        .route("/balances", get(list_balances))
        .route("/balances/{player_name}", get(get_balance))
        .route("/batches", get(list_batches))
        .route("/batches/{batch_id}", delete(delete_batch))
}

/// Bulk-import an Albion export as ledger rows.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks the `siphoned.ingest` permission.
/// * Returns `AppError::Validation` if the payload is empty, too large, or any row is invalid.
#[utoipa::path(
    post,
    path = "/api/siphoned/ingest",
    tag = "siphoned",
    summary = "Bulk-import the Albion Online siphoned energy export",
    description = "Receives the rows pasted out of Albion Online (already normalized to UTC RFC3339 \
        by the frontend) and writes them as immutable ledger rows. Every row in one request is \
        tagged with the same freshly-generated `ingest_batch` UUID — `DELETE /batches/{batch_id}` \
        can later undo the whole import if the same export was pasted twice. Validation is \
        all-or-nothing: if any row fails (empty player_name, zero amount, etc.), no row is written \
        and the response is `400 Validation` with the offending row index in the detail string. \
        Requires the `siphoned.ingest` permission (Officer-or-above).",
    security(("session_cookie" = ["siphoned.ingest"])),
    request_body(content = IngestRequest, description = "The rows to import. `amount` is a string-encoded Decimal to preserve exact precision; withdrawals are negative, deposits positive."),
    responses(
        (status = 200, description = "Rows imported successfully", body = ApiResponseIngestResponse),
        (status = 400, description = "Validation error - empty payload, too many rows, or one or more rows have invalid fields", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks siphoned.ingest permission", body = ProblemDetails)
    )
)]
async fn ingest(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<IngestRequest>,
) -> Result<Json<ApiResponse<super::models::IngestResponse>>, AppError> {
    user.require(&perms, Permission::SiphonedIngest).await?;
    let service = SiphonedService::new();
    let response = service.ingest(&db, &req).await?;
    Ok(Json(ApiResponse::new(response)))
}

/// List the ledger entries with pagination and filters.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks the `siphoned.view` permission.
#[utoipa::path(
    get,
    path = "/api/siphoned/entries",
    tag = "siphoned",
    summary = "List/search the siphoned energy ledger",
    description = "Every row is one in-game event (deposit or withdrawal). Filters: `player_name` \
        (case-insensitive substring), `search` (case-insensitive substring on player name or reason), \
        `reason` (exact match, e.g. `Withdrawal`), `since`/`until` \
        (inclusive ISO8601 range on `occurred_at`), `batch_id` (restrict to one import batch). \
        Sort with `sort=occurred_at|player_name|amount|reason|ingested_at` and `order=asc|desc` \
        (default `occurred_at` desc). Standard `page`/`limit` pagination. Requires the \
        `siphoned.view` permission.",
    security(("session_cookie" = ["siphoned.view"])),
    params(ListEntriesQuery),
    responses(
        (status = 200, description = "Entries retrieved successfully", body = ApiResponsePaginatedEntryView),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks siphoned.view permission", body = ProblemDetails)
    )
)]
async fn list_entries(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(query): Query<ListEntriesQuery>,
) -> Result<Json<ApiResponse<PaginatedEntryView>>, AppError> {
    user.require(&perms, Permission::SiphonedView).await?;
    let service = SiphonedService::new();
    let pagination = query.pagination();
    let paginated = service
        .list_entries(&db, &pagination, &query.filters)
        .await?;
    Ok(Json(ApiResponse::new(PaginatedEntryView::from(paginated))))
}

/// Create one ledger entry manually.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks the `siphoned.ingest` permission.
/// * Returns `AppError::Validation` if any field is invalid.
#[utoipa::path(
    post,
    path = "/api/siphoned/entries",
    tag = "siphoned",
    summary = "Create one manual siphoned energy ledger entry",
    description = "Adds a single ledger row without an import batch. Intended for precise manual corrections between weekly Albion exports. Requires the `siphoned.ingest` permission.",
    security(("session_cookie" = ["siphoned.ingest"])),
    request_body(content = EntryMutationRequest),
    responses(
        (status = 200, description = "Entry created successfully", body = ApiResponseEntryView),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks siphoned.ingest permission", body = ProblemDetails)
    )
)]
pub async fn create_entry(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<EntryMutationRequest>,
) -> Result<Json<ApiResponse<super::models::EntryView>>, AppError> {
    user.require(&perms, Permission::SiphonedIngest).await?;
    let service = SiphonedService::new();
    let entry = service.create_entry(&db, &req).await?;
    Ok(Json(ApiResponse::new(entry)))
}

/// Update one ledger entry.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks the `siphoned.ingest` permission.
/// * Returns `AppError::NotFound` if `entry_id` does not exist.
/// * Returns `AppError::Validation` if any field is invalid.
#[utoipa::path(
    put,
    path = "/api/siphoned/entries/{entry_id}",
    tag = "siphoned",
    summary = "Update one siphoned energy ledger entry",
    description = "Corrects one existing ledger row in place. Requires the `siphoned.ingest` permission.",
    security(("session_cookie" = ["siphoned.ingest"])),
    params(("entry_id" = i64, Path, description = "The ledger entry id.")),
    request_body(content = EntryMutationRequest),
    responses(
        (status = 200, description = "Entry updated successfully", body = ApiResponseEntryView),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks siphoned.ingest permission", body = ProblemDetails),
        (status = 404, description = "No entry with that id", body = ProblemDetails)
    )
)]
pub async fn update_entry(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(entry_id): Path<i64>,
    Json(req): Json<EntryMutationRequest>,
) -> Result<Json<ApiResponse<super::models::EntryView>>, AppError> {
    user.require(&perms, Permission::SiphonedIngest).await?;
    let service = SiphonedService::new();
    let entry = service.update_entry(&db, entry_id, &req).await?;
    Ok(Json(ApiResponse::new(entry)))
}

/// Delete one ledger entry.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks the `siphoned.ingest` permission.
/// * Returns `AppError::NotFound` if `entry_id` does not exist.
#[utoipa::path(
    delete,
    path = "/api/siphoned/entries/{entry_id}",
    tag = "siphoned",
    summary = "Delete one siphoned energy ledger entry",
    description = "Removes one ledger row for precise corrections. Requires the `siphoned.ingest` permission.",
    security(("session_cookie" = ["siphoned.ingest"])),
    params(("entry_id" = i64, Path, description = "The ledger entry id.")),
    responses(
        (status = 200, description = "Entry deleted successfully", body = ApiResponseDeletedCount),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks siphoned.ingest permission", body = ProblemDetails),
        (status = 404, description = "No entry with that id", body = ProblemDetails)
    )
)]
pub async fn delete_entry(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(entry_id): Path<i64>,
) -> Result<Json<ApiResponse<super::models::DeletedCount>>, AppError> {
    user.require(&perms, Permission::SiphonedIngest).await?;
    let service = SiphonedService::new();
    let deleted = service.delete_entry(&db, entry_id).await?;
    Ok(Json(ApiResponse::new(deleted)))
}

/// Compute per-player aggregates across the whole ledger.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks the `siphoned.view` permission.
#[utoipa::path(
    get,
    path = "/api/siphoned/balances",
    tag = "siphoned",
    summary = "Per-player siphoned energy balances (deposits, withdrawals, net)",
    description = "Returns one row per distinct player (grouped case-insensitively by name). Each \
        row reports `total_deposited`, `total_withdrawn` (sign-flipped to a positive number), \
        `net` (negative means the player is in debt to the guild), entry count, and first/last \
        seen timestamps. Pass `min_debt=0` to see only debtors. Sort with `sort=net_asc` (default, \
        biggest debtors first), `sort=net_desc`, or `sort=name_asc`. Filter with `search` \
        (case-insensitive substring on player name). Requires the `siphoned.view` \
        permission.",
    security(("session_cookie" = ["siphoned.view"])),
    params(BalanceQuery),
    responses(
        (status = 200, description = "Balances computed successfully", body = ApiResponsePlayerBalanceList),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks siphoned.view permission", body = ProblemDetails)
    )
)]
async fn list_balances(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(query): Query<BalanceQuery>,
) -> Result<Json<ApiResponse<Vec<super::models::PlayerBalance>>>, AppError> {
    user.require(&perms, Permission::SiphonedView).await?;
    let service = SiphonedService::new();
    let sort = query.sort.unwrap_or_default();
    let balances = service
        .list_balances(&db, query.min_debt, sort, query.search.as_deref())
        .await?;
    Ok(Json(ApiResponse::new(balances)))
}

/// Get one player's balance plus their most recent entries.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks the `siphoned.view` permission.
/// * Returns `AppError::NotFound` if no row exists for `player_name`.
#[utoipa::path(
    get,
    path = "/api/siphoned/balances/{player_name}",
    tag = "siphoned",
    summary = "One player's siphoned energy balance and recent activity",
    description = "Same aggregation as `GET /balances`, restricted to a single player (matched \
        case-insensitively). Also returns up to `?recent=N` most-recent entries for that player \
        (default 20, capped at 100). `404 NotFound` if the player has no rows at all. Requires the \
        `siphoned.view` permission.",
    security(("session_cookie" = ["siphoned.view"])),
    params(
        ("player_name" = String, Path, description = "The Albion in-game player name. URL-encoded; matched case-insensitively."),
        PlayerBalanceQuery
    ),
    responses(
        (status = 200, description = "Balance and recent entries retrieved successfully", body = ApiResponsePlayerBalanceDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks siphoned.view permission", body = ProblemDetails),
        (status = 404, description = "No siphoned energy entries exist for that player name", body = ProblemDetails)
    )
)]
async fn get_balance(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(player_name): Path<String>,
    Query(query): Query<PlayerBalanceQuery>,
) -> Result<Json<ApiResponse<PlayerBalanceDetail>>, AppError> {
    user.require(&perms, Permission::SiphonedView).await?;
    let service = SiphonedService::new();
    let recent = query.recent.unwrap_or(DEFAULT_RECENT_ENTRIES);
    let detail = service.get_balance(&db, &player_name, recent).await?;
    Ok(Json(ApiResponse::new(detail)))
}

/// List ingestion batches with their row counts.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks the `siphoned.view` permission.
#[utoipa::path(
    get,
    path = "/api/siphoned/batches",
    tag = "siphoned",
    summary = "List ingestion batches",
    description = "Every successful `POST /ingest` produces one batch (a shared UUID stamped on \
        every imported row). This endpoint lists them with their row counts, newest-first. Used by \
        the frontend's \"undo last import\" view. Requires the `siphoned.view` permission.",
    security(("session_cookie" = ["siphoned.view"])),
    responses(
        (status = 200, description = "Batches retrieved successfully", body = ApiResponseBatchSummaryList),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks siphoned.view permission", body = ProblemDetails)
    )
)]
async fn list_batches(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<Vec<super::models::BatchSummary>>>, AppError> {
    user.require(&perms, Permission::SiphonedView).await?;
    let service = SiphonedService::new();
    let batches = service.list_batches(&db).await?;
    Ok(Json(ApiResponse::new(batches)))
}

/// Delete every row tagged with the given batch UUID.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks the `siphoned.ingest` permission.
/// * Returns `AppError::NotFound` if no row matches (no such batch).
#[utoipa::path(
    delete,
    path = "/api/siphoned/batches/{batch_id}",
    tag = "siphoned",
    summary = "Delete an entire ingestion batch (officer safety valve for double-pastes)",
    description = "Removes every row tagged with the given `ingest_batch` UUID. Intended use: an \
        officer pasted the same export twice and wants to undo the second import. For isolated \
        corrections use `DELETE /entries/{entry_id}`. Requires the `siphoned.ingest` permission.",
    security(("session_cookie" = ["siphoned.ingest"])),
    params(
        ("batch_id" = String, Path, description = "The UUID of the batch to delete.")
    ),
    responses(
        (status = 200, description = "Batch deleted successfully", body = ApiResponseDeletedCount),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks siphoned.ingest permission", body = ProblemDetails),
        (status = 404, description = "No batch with that id", body = ProblemDetails)
    )
)]
async fn delete_batch(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(batch_id): Path<String>,
) -> Result<Json<ApiResponse<super::models::DeletedCount>>, AppError> {
    user.require(&perms, Permission::SiphonedIngest).await?;
    let service = SiphonedService::new();
    let deleted = service.delete_batch(&db, &batch_id).await?;
    Ok(Json(ApiResponse::new(deleted)))
}
