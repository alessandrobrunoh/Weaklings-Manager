//! HTTP routes of the Albion bank log, merged into the bank router under `/log`.
//!
//! Guild tenants only: an alliance has no in-game guild bank of its own.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::{delete, get, post},
};
use serde::Serialize;
use utoipa::ToSchema;

use backend_core::errors::{AppError, ProblemDetails};
use backend_core::pagination::PaginatedData;
use backend_core::responses::ApiResponse;
use backend_identity::auth::{Permission, Permissions, UserContext};
use backend_identity::tenant::{CurrentTenantId, TenantRegistry};

use super::models::{
    BankLogBatchView, BankLogCandidateView, BankLogCreateEntryTransactionRequest,
    BankLogCreateLinkRequest, BankLogDeleteBatchResult, BankLogEntryQuery, BankLogEntryView,
    BankLogImportRequest, BankLogImportResult, BankLogLinkView, BankLogPeriodQuery,
    BankLogRefreshResult, BankLogSummary, BankLogUpdateEntryRequest,
};
use super::service::BankLogService;
use crate::alliance;

/// `OpenAPI` wrapper: `{ status, data: BankLogImportResult }`.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBankLogImportResult {
    #[schema(example = "success")]
    pub status: String,
    pub data: BankLogImportResult,
}

/// `OpenAPI` wrapper: `{ status, data: BankLogEntryView }`.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBankLogEntryView {
    #[schema(example = "success")]
    pub status: String,
    pub data: BankLogEntryView,
}

/// `OpenAPI` wrapper: `{ status, data: { items: BankLogEntryView[], ... } }`.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedBankLogEntryView {
    #[schema(example = "success")]
    pub status: String,
    pub data: PaginatedBankLogEntryView,
}

/// A page of log rows.
#[derive(Debug, Serialize, ToSchema)]
pub struct PaginatedBankLogEntryView {
    pub items: Vec<BankLogEntryView>,
    pub total_items: u64,
    pub total_pages: u64,
    pub current_page: u64,
    pub limit: u64,
}

/// `OpenAPI` wrapper: `{ status, data: BankLogLinkView }`.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBankLogLinkView {
    #[schema(example = "success")]
    pub status: String,
    pub data: BankLogLinkView,
}

/// `OpenAPI` wrapper: `{ status, data: BankLogSummary }`.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBankLogSummary {
    #[schema(example = "success")]
    pub status: String,
    pub data: BankLogSummary,
}

/// `OpenAPI` wrapper: `{ status, data: BankLogBatchView[] }`.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBankLogBatchViewList {
    #[schema(example = "success")]
    pub status: String,
    pub data: Vec<BankLogBatchView>,
}

/// `OpenAPI` wrapper: `{ status, data: BankLogCandidateView[] }`.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBankLogCandidateViewList {
    #[schema(example = "success")]
    pub status: String,
    pub data: Vec<BankLogCandidateView>,
}

/// `OpenAPI` wrapper: `{ status, data: BankLogRefreshResult }`.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBankLogRefreshResult {
    #[schema(example = "success")]
    pub status: String,
    pub data: BankLogRefreshResult,
}

/// `OpenAPI` wrapper: `{ status, data: BankLogDeleteBatchResult }`.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBankLogDeleteBatchResult {
    #[schema(example = "success")]
    pub status: String,
    pub data: BankLogDeleteBatchResult,
}

/// The bank log routes, relative to `/api/bank`.
pub fn router() -> Router {
    Router::new()
        .route("/log/import", post(bank_log_import))
        .route("/log/suggestions/refresh", post(bank_log_refresh_suggestions))
        .route("/log/entries", get(bank_log_list_entries))
        .route("/log/entries/{id}", get(bank_log_get_entry).patch(bank_log_update_entry))
        .route("/log/entries/{id}/candidates", get(bank_log_candidates))
        .route("/log/entries/{id}/transaction", post(bank_log_create_transaction))
        .route("/log/links", post(bank_log_create_link))
        .route("/log/links/{id}/confirm", post(bank_log_confirm_link))
        .route("/log/links/{id}", delete(bank_log_delete_link))
        .route("/log/summary", get(bank_log_summary))
        .route("/log/batches", get(bank_log_batches))
        .route("/log/batches/{batch_id}", delete(bank_log_delete_batch))
}

/// Refuses alliance tenants, then checks `permission`.
async fn guard(
    user: &UserContext,
    perms: &Permissions,
    registry: &TenantRegistry,
    tenant: &CurrentTenantId,
    permission: Permission,
) -> Result<(), AppError> {
    if alliance::tenant_is_alliance(registry, &tenant.0).await? {
        return Err(AppError::Forbidden(
            "the bank log belongs to a guild; an alliance has no in-game bank".to_string(),
        ));
    }
    user.require(perms, permission).await?;
    Ok(())
}

/// Import the Albion guild bank silver log.
#[utoipa::path(
    post,
    path = "/api/bank/log/import",
    tag = "bank",
    summary = "Import the Albion guild bank log",
    description = "Stores the lines of the in-game JSON export (`Date`, `Player`, `Reason`, \
        `Amount`; UTC). Identical lines in one export are numbered, so re-importing an \
        overlapping export adds only the new lines while a real second identical movement is \
        kept. Rows whose reason is not Deposit/Withdrawal are guild expenses, explained \
        automatically. Suggestions are recomputed afterwards.",
    security(("session_cookie" = ["bank.log.manage"])),
    request_body(content = BankLogImportRequest, description = "The export lines."),
    responses(
        (status = 200, description = "Import counts", body = ApiResponseBankLogImportResult),
        (status = 400, description = "A line cannot be read", body = ProblemDetails),
        (status = 403, description = "Requires bank.log.manage on a guild", body = ProblemDetails),
        (status = 409, description = "A concurrent import stored the same rows", body = ProblemDetails)
    )
)]
pub async fn bank_log_import(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(tenant): Extension<CurrentTenantId>,
    Json(req): Json<BankLogImportRequest>,
) -> Result<Json<ApiResponse<BankLogImportResult>>, AppError> {
    guard(&user, &perms, &registry, &tenant, Permission::BankLogManage).await?;
    let result = BankLogService::new()
        .import(&db, &req.rows, user.user_id)
        .await?;
    Ok(Json(ApiResponse::new(result)))
}

/// Recompute the bank log suggestions.
#[utoipa::path(
    post,
    path = "/api/bank/log/suggestions/refresh",
    tag = "bank",
    summary = "Recompute bank log suggestions",
    description = "Drops every unconfirmed link and proposes new ones for the rows that are \
        neither linked nor explained. Confirmed links are kept.",
    security(("session_cookie" = ["bank.log.manage"])),
    responses(
        (status = 200, description = "Suggestions proposed", body = ApiResponseBankLogRefreshResult),
        (status = 403, description = "Requires bank.log.manage on a guild", body = ProblemDetails)
    )
)]
pub async fn bank_log_refresh_suggestions(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(tenant): Extension<CurrentTenantId>,
) -> Result<Json<ApiResponse<BankLogRefreshResult>>, AppError> {
    guard(&user, &perms, &registry, &tenant, Permission::BankLogManage).await?;
    let suggestions = BankLogService::new()
        .refresh_suggestions(&db, user.user_id)
        .await?;
    Ok(Json(ApiResponse::new(BankLogRefreshResult { suggestions })))
}

/// List bank log rows.
#[utoipa::path(
    get,
    path = "/api/bank/log/entries",
    tag = "bank",
    summary = "List bank log rows",
    description = "Newest first, with each row's confirmed links and suggestions. Filters: UTC \
        day range, status, category, player or reason text.",
    params(BankLogEntryQuery),
    security(("session_cookie" = ["bank.log.view"])),
    responses(
        (status = 200, description = "A page of rows", body = ApiResponsePaginatedBankLogEntryView),
        (status = 400, description = "Unknown filter value", body = ProblemDetails),
        (status = 403, description = "Requires bank.log.view on a guild", body = ProblemDetails)
    )
)]
pub async fn bank_log_list_entries(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(tenant): Extension<CurrentTenantId>,
    Query(query): Query<BankLogEntryQuery>,
) -> Result<Json<ApiResponse<PaginatedData<BankLogEntryView>>>, AppError> {
    guard(&user, &perms, &registry, &tenant, Permission::BankLogView).await?;
    let page = BankLogService::new().list_entries(&db, &query).await?;
    Ok(Json(ApiResponse::new(page)))
}

/// Get one bank log row.
#[utoipa::path(
    get,
    path = "/api/bank/log/entries/{id}",
    tag = "bank",
    summary = "Get a bank log row",
    params(("id" = i64, Path, description = "Row id")),
    security(("session_cookie" = ["bank.log.view"])),
    responses(
        (status = 200, description = "The row", body = ApiResponseBankLogEntryView),
        (status = 403, description = "Requires bank.log.view on a guild", body = ProblemDetails),
        (status = 404, description = "No such row", body = ProblemDetails)
    )
)]
pub async fn bank_log_get_entry(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<BankLogEntryView>>, AppError> {
    guard(&user, &perms, &registry, &tenant, Permission::BankLogView).await?;
    let entry = BankLogService::new().get_entry(&db, id).await?;
    Ok(Json(ApiResponse::new(entry)))
}

/// Change a row's category, note or explanation.
#[utoipa::path(
    patch,
    path = "/api/bank/log/entries/{id}",
    tag = "bank",
    summary = "Update a bank log row",
    description = "`explained: true` needs a note. Clearing the note of an officer-explained \
        row un-explains it.",
    params(("id" = i64, Path, description = "Row id")),
    security(("session_cookie" = ["bank.log.manage"])),
    request_body(content = BankLogUpdateEntryRequest, description = "Fields to change."),
    responses(
        (status = 200, description = "The updated row", body = ApiResponseBankLogEntryView),
        (status = 400, description = "Unknown category or missing note", body = ProblemDetails),
        (status = 403, description = "Requires bank.log.manage on a guild", body = ProblemDetails),
        (status = 404, description = "No such row", body = ProblemDetails)
    )
)]
pub async fn bank_log_update_entry(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
    Json(req): Json<BankLogUpdateEntryRequest>,
) -> Result<Json<ApiResponse<BankLogEntryView>>, AppError> {
    guard(&user, &perms, &registry, &tenant, Permission::BankLogManage).await?;
    let entry = BankLogService::new()
        .update_entry(&db, id, &req, user.user_id)
        .await?;
    Ok(Json(ApiResponse::new(entry)))
}

/// Manager records a row can be linked to by hand.
#[utoipa::path(
    get,
    path = "/api/bank/log/entries/{id}/candidates",
    tag = "bank",
    summary = "Link candidates for a bank log row",
    description = "For a withdrawal: payouts within 10 days, closest amount first. For a \
        deposit: splits created up to 60 days before, with bags value and expected sale.",
    params(("id" = i64, Path, description = "Row id")),
    security(("session_cookie" = ["bank.log.view"])),
    responses(
        (status = 200, description = "Candidates", body = ApiResponseBankLogCandidateViewList),
        (status = 403, description = "Requires bank.log.view on a guild", body = ProblemDetails),
        (status = 404, description = "No such row", body = ProblemDetails)
    )
)]
pub async fn bank_log_candidates(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<Vec<BankLogCandidateView>>>, AppError> {
    guard(&user, &perms, &registry, &tenant, Permission::BankLogView).await?;
    let list = BankLogService::new().candidates(&db, id).await?;
    Ok(Json(ApiResponse::new(list)))
}

/// Create the bank transaction a row stands for.
#[utoipa::path(
    post,
    path = "/api/bank/log/entries/{id}/transaction",
    tag = "bank",
    summary = "Create a transaction from a bank log row",
    description = "A withdrawal row becomes a paid-out row for the member; a deposit row becomes \
        the member's donation. The row is linked to it. A row creates at most one transaction, \
        also after that transaction is deleted.",
    params(("id" = i64, Path, description = "Row id")),
    security(("session_cookie" = ["bank.log.manage", "bank.transactions.create"])),
    request_body(content = BankLogCreateEntryTransactionRequest, description = "Member and amount."),
    responses(
        (status = 200, description = "The linked row", body = ApiResponseBankLogEntryView),
        (status = 403, description = "Requires bank.log.manage and bank.transactions.create", body = ProblemDetails),
        (status = 404, description = "No such row or member", body = ProblemDetails),
        (status = 409, description = "The row already created a transaction or is linked", body = ProblemDetails)
    )
)]
pub async fn bank_log_create_transaction(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
    Json(req): Json<BankLogCreateEntryTransactionRequest>,
) -> Result<Json<ApiResponse<BankLogEntryView>>, AppError> {
    guard(&user, &perms, &registry, &tenant, Permission::BankLogManage).await?;
    user.require(&perms, Permission::BankTransactionsCreate)
        .await?;
    let entry = BankLogService::new()
        .create_transaction(&db, id, &req, user.user_id)
        .await?;
    Ok(Json(ApiResponse::new(entry)))
}

/// Link rows to Manager records by hand.
#[utoipa::path(
    post,
    path = "/api/bank/log/links",
    tag = "bank",
    summary = "Link bank log rows by hand",
    description = "Creates a confirmed link between one or more rows and transactions and/or \
        splits. Suggestions that share a row or a transaction are dropped.",
    security(("session_cookie" = ["bank.log.manage"])),
    request_body(content = BankLogCreateLinkRequest, description = "Rows and records."),
    responses(
        (status = 200, description = "The link", body = ApiResponseBankLogLinkView),
        (status = 400, description = "Empty link or unknown kind", body = ProblemDetails),
        (status = 403, description = "Requires bank.log.manage on a guild", body = ProblemDetails),
        (status = 404, description = "A row or record does not exist", body = ProblemDetails),
        (status = 409, description = "A row or transaction is already linked", body = ProblemDetails)
    )
)]
pub async fn bank_log_create_link(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(tenant): Extension<CurrentTenantId>,
    Json(req): Json<BankLogCreateLinkRequest>,
) -> Result<Json<ApiResponse<BankLogLinkView>>, AppError> {
    guard(&user, &perms, &registry, &tenant, Permission::BankLogManage).await?;
    let link = BankLogService::new()
        .create_link(&db, &req, user.user_id)
        .await?;
    Ok(Json(ApiResponse::new(link)))
}

/// Confirm a suggestion.
#[utoipa::path(
    post,
    path = "/api/bank/log/links/{id}/confirm",
    tag = "bank",
    summary = "Confirm a bank log suggestion",
    params(("id" = i64, Path, description = "Link id")),
    security(("session_cookie" = ["bank.log.manage"])),
    responses(
        (status = 200, description = "The confirmed link", body = ApiResponseBankLogLinkView),
        (status = 403, description = "Requires bank.log.manage on a guild", body = ProblemDetails),
        (status = 404, description = "No such link", body = ProblemDetails),
        (status = 409, description = "Already confirmed, or a row or transaction is linked elsewhere", body = ProblemDetails)
    )
)]
pub async fn bank_log_confirm_link(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<BankLogLinkView>>, AppError> {
    guard(&user, &perms, &registry, &tenant, Permission::BankLogManage).await?;
    let link = BankLogService::new()
        .confirm_link(&db, id, user.user_id)
        .await?;
    Ok(Json(ApiResponse::new(link)))
}

/// Remove a link or reject a suggestion.
#[utoipa::path(
    delete,
    path = "/api/bank/log/links/{id}",
    tag = "bank",
    summary = "Remove a bank log link",
    params(("id" = i64, Path, description = "Link id")),
    security(("session_cookie" = ["bank.log.manage"])),
    responses(
        (status = 200, description = "Removed"),
        (status = 403, description = "Requires bank.log.manage on a guild", body = ProblemDetails),
        (status = 404, description = "No such link", body = ProblemDetails)
    )
)]
pub async fn bank_log_delete_link(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    guard(&user, &perms, &registry, &tenant, Permission::BankLogManage).await?;
    BankLogService::new()
        .delete_link(&db, id, user.user_id)
        .await?;
    Ok(Json(ApiResponse::new(())))
}

/// Period totals and import status.
#[utoipa::path(
    get,
    path = "/api/bank/log/summary",
    tag = "bank",
    summary = "Bank log period summary",
    description = "Per category: game total, linked, explained and open. Also the Manager's own \
        payout total for the period and the import/reminder status. Defaults to the last 28 \
        UTC days.",
    params(BankLogPeriodQuery),
    security(("session_cookie" = ["bank.log.view"])),
    responses(
        (status = 200, description = "Summary", body = ApiResponseBankLogSummary),
        (status = 400, description = "Bad day", body = ProblemDetails),
        (status = 403, description = "Requires bank.log.view on a guild", body = ProblemDetails)
    )
)]
pub async fn bank_log_summary(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(tenant): Extension<CurrentTenantId>,
    Query(query): Query<BankLogPeriodQuery>,
) -> Result<Json<ApiResponse<BankLogSummary>>, AppError> {
    guard(&user, &perms, &registry, &tenant, Permission::BankLogView).await?;
    let summary = BankLogService::new().summary(&db, &query).await?;
    Ok(Json(ApiResponse::new(summary)))
}

/// List imports.
#[utoipa::path(
    get,
    path = "/api/bank/log/batches",
    tag = "bank",
    summary = "List bank log imports",
    security(("session_cookie" = ["bank.log.view"])),
    responses(
        (status = 200, description = "Imports, newest first", body = ApiResponseBankLogBatchViewList),
        (status = 403, description = "Requires bank.log.view on a guild", body = ProblemDetails)
    )
)]
pub async fn bank_log_batches(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(tenant): Extension<CurrentTenantId>,
) -> Result<Json<ApiResponse<Vec<BankLogBatchView>>>, AppError> {
    guard(&user, &perms, &registry, &tenant, Permission::BankLogView).await?;
    let list = BankLogService::new().batches(&db).await?;
    Ok(Json(ApiResponse::new(list)))
}

/// Delete the rows an import stored.
#[utoipa::path(
    delete,
    path = "/api/bank/log/batches/{batch_id}",
    tag = "bank",
    summary = "Delete a bank log import",
    description = "Deletes the rows that import stored and their links. Refused when one of them \
        created a transaction. The reminder clock follows the remaining imports.",
    params(("batch_id" = String, Path, description = "Import id")),
    security(("session_cookie" = ["bank.log.manage"])),
    responses(
        (status = 200, description = "Rows deleted", body = ApiResponseBankLogDeleteBatchResult),
        (status = 403, description = "Requires bank.log.manage on a guild", body = ProblemDetails),
        (status = 404, description = "No such import", body = ProblemDetails),
        (status = 409, description = "A row created a transaction", body = ProblemDetails)
    )
)]
pub async fn bank_log_delete_batch(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path(batch_id): Path<String>,
) -> Result<Json<ApiResponse<BankLogDeleteBatchResult>>, AppError> {
    guard(&user, &perms, &registry, &tenant, Permission::BankLogManage).await?;
    let deleted = BankLogService::new()
        .delete_batch(&db, &batch_id, user.user_id)
        .await?;
    Ok(Json(ApiResponse::new(BankLogDeleteBatchResult { deleted })))
}
