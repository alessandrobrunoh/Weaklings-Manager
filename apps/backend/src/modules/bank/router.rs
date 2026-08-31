//! Bank routing module.
//!
//! Exposes HTTP endpoints for the Guild Bank ledger: balance, transactions, withdrawal requests,
//! and officer acceptance/payout of those requests.

use axum::{
    Extension, Json, Router,
    extract::Query,
    routing::{get, post},
};

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::pagination::{PaginatedTransactionView, PaginationParams};
use crate::responses::{
    ApiResponse, ApiResponseBalanceSummary, ApiResponseBankAnalyticsSummary,
    ApiResponseGuildBankSummary, ApiResponseTransactionViewList,
};

use super::models::{
    AcceptWithdrawalRequest, RejectWithdrawalRequest, TransactionFilters, TransactionView,
    WithdrawRequest,
};
use super::service::BankService;

/// Router query parameters for the balance endpoint.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct BalanceQuery {
    /// Optional user id to view another user's balance; requires administrator privileges.
    pub user_id: Option<i64>,
}

/// Router query parameters for listing transactions, combining pagination and filtering.
///
/// The pagination fields are declared inline rather than via `#[serde(flatten)]` on
/// `PaginationParams`, since axum's `Query` extractor (backed by `serde_html_form`) cannot
/// deserialize non-string fields (e.g. `u64`) through a flattened struct from a query string.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct ListTransactionsQuery {
    /// The page number to fetch (1-indexed). Defaults to 1.
    pub page: Option<u64>,
    /// The maximum number of items per page. Defaults to 10.
    pub limit: Option<u64>,
    /// The filter query parameters.
    #[serde(flatten)]
    pub filters: TransactionFilters,
    /// Optional user id to view another user's transactions; requires administrator privileges.
    pub user_id: Option<i64>,
    /// If `true`, returns transactions for all users. Requires administrator privileges.
    pub global: Option<bool>,
}

impl ListTransactionsQuery {
    fn pagination(&self) -> PaginationParams {
        PaginationParams {
            page: self.page,
            limit: self.limit,
        }
    }
}

/// Creates the router for the bank module.
pub fn router() -> Router {
    Router::new()
        .route("/balance", get(get_balance))
        .route("/guild/summary", get(get_guild_summary))
        .route("/admin/summary", get(get_admin_summary))
        .route("/transactions", get(list_transactions))
        .route("/transactions/withdraw", post(withdraw))
        .route("/transactions/withdraw/accept", post(accept_withdrawal))
        .route("/transactions/withdraw/reject", post(reject_withdrawal))
}

/// Resolves which user's ledger to act on, honoring the admin override query param.
///
/// If `requested` is `Some(id)` different from the caller's own id, the caller
/// must hold the `BankViewOthers` permission.
async fn resolve_target_user(
    user: &UserContext,
    perms: &Permissions,
    requested: Option<i64>,
) -> Result<i64, AppError> {
    match requested {
        Some(id) if id != user.user_id => {
            user.require(perms, Permission::BankViewOthers).await?;
            Ok(id)
        }
        _ => Ok(user.user_id),
    }
}

/// Retrieve the caller's derived Guild Bank balance (or another user's, for administrators).
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if a non-administrator requests another user's balance.
#[utoipa::path(
    get,
    path = "/api/bank/balance",
    tag = "bank",
    summary = "Get the caller's Guild Bank balance (pending vs. already-requested)",
    description = "Returns two independent totals, computed live from the `transactions` table (there \
        is no stored balance column): `pending_total`/`pending_count` — owed but not yet asked for — \
        and `requested_total`/`requested_count` — asked for via `POST /transactions/withdraw` but not \
        yet paid out by an officer. Money that has been `withdrawn` is excluded from both; fetch \
        `GET /transactions?status=withdrawn` for payout history. Pass `?user_id=<id>` to view another \
        member's balance — only administrators may do this; everyone else may only omit it (defaults \
        to their own balance) or pass their own id. Rejected withdrawals are counted as pending \
        balance because the member must explicitly request them again before payout.",
    security(("session_cookie" = [])),
    params(BalanceQuery),
    responses(
        (status = 200, description = "Balance retrieved successfully", body = ApiResponseBalanceSummary),
        (status = 403, description = "Forbidden - only administrators can view another user's balance", body = ProblemDetails)
    )
)]
async fn get_balance(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(perms): Extension<Permissions>,
    Query(query): Query<BalanceQuery>,
) -> Result<Json<ApiResponse<super::models::BalanceSummary>>, AppError> {
    let target = resolve_target_user(&user, &perms, query.user_id).await?;
    let service = BankService::new();
    let balance = service.get_balance(&db, target).await?;
    Ok(Json(ApiResponse::new(balance)))
}

/// Retrieve the guild-wide aggregate of all settled Guild Bank payouts.
///
/// Returns only the aggregate `paid_total`/`paid_count` (sum over every member's
/// `withdrawn` transactions), so it does not expose any per-member data and is safe
/// to surface on every authenticated member's dashboard.
#[utoipa::path(
    get,
    path = "/api/bank/guild/summary",
    tag = "bank",
    summary = "Get the guild-wide total the Guild Bank has paid out",
    description = "Computes the sum and count of every `withdrawn` transaction across the entire \n        guild — i.e. silver the officers have already settled. `BalanceSummary` only exposes the \n        `pending`/`requested` totals per user, so this endpoint exists for the dashboard's \n        \"how much the guild has paid in total\" metric. Returns an aggregate; no individual \n        member balances leak through, so any authenticated member may call it.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Guild summary retrieved successfully", body = ApiResponseGuildBankSummary)
    )
)]
async fn get_guild_summary(
    _user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<super::models::GuildBankSummary>>, AppError> {
    let service = BankService::new();
    let summary = service.get_guild_summary(&db).await?;
    Ok(Json(ApiResponse::new(summary)))
}

/// Retrieve guild-wide bank analytics for the administrator panel.
#[utoipa::path(
    get,
    path = "/api/bank/admin/summary",
    tag = "bank",
    summary = "Get guild-wide Guild Bank money-flow analytics",
    description = "Returns totals and grouped source, destination, and transaction-type breakdowns for every ledger row. Requires `bank.view_others` because the response includes guild-wide member-level labels.",
    security(("session_cookie" = ["bank.view_others"])),
    responses(
        (status = 200, description = "Bank analytics retrieved successfully", body = ApiResponseBankAnalyticsSummary),
        (status = 403, description = "Forbidden - requires bank.view_others", body = ProblemDetails)
    )
)]
pub async fn get_admin_summary(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<super::models::BankAnalyticsSummary>>, AppError> {
    user.require(&perms, Permission::BankViewOthers).await?;
    let summary = BankService::new().get_analytics_summary(&db).await?;
    Ok(Json(ApiResponse::new(summary)))
}

/// List the caller's transactions with pagination and optional status filtering.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if a non-administrator requests another user's transactions.
#[utoipa::path(
    get,
    path = "/api/bank/transactions",
    tag = "bank",
    summary = "List/search the caller's Guild Bank transaction history",
    description = "Every row is a single Guild Bank ledger entry owed to the caller, in any status. \
        `from_label` is a display-ready string: `\"Guild Bank\"` while `status` is `pending` or \
        `requested`, or the paying officer's user id once `status` is `withdrawn`. Filter with \
        `?status=pending`, `?status=requested`, `?status=rejected`, or `?status=withdrawn` (see \
        `TransactionStatus`); omit it to get every status. Search recipients with `search` \
        (case-insensitive username substring). Sort with `sort=created_at|amount|status|to_username` \
        and `order=asc|desc` (default `created_at` desc). Standard `page`/`limit` pagination. Pass `?user_id=<id>` to view \
        another member's transactions — administrator-only, same rule as `GET /bank/balance`.",
    security(("session_cookie" = [])),
    params(ListTransactionsQuery),
    responses(
        (status = 200, description = "Transactions retrieved successfully", body = PaginatedTransactionView),
        (status = 403, description = "Forbidden - only administrators can view another user's transactions", body = ProblemDetails)
    )
)]
async fn list_transactions(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(perms): Extension<Permissions>,
    Query(query): Query<ListTransactionsQuery>,
) -> Result<Json<ApiResponse<PaginatedTransactionView>>, AppError> {
    let target = if query.global.unwrap_or(false) {
        user.require(&perms, Permission::BankViewOthers).await?;
        None
    } else {
        Some(resolve_target_user(&user, &perms, query.user_id).await?)
    };

    let service = BankService::new();
    let pagination = query.pagination();
    let paginated = service
        .list_transactions(&db, target, &pagination, &query.filters)
        .await?;
    Ok(Json(ApiResponse::new(PaginatedTransactionView::from(
        paginated,
    ))))
}

/// Request withdrawal of one, several, or all of the caller's requestable transactions.
///
/// This does not pay them out — it moves them to `"requested"` status, awaiting an officer to
/// accept via `POST /api/bank/transactions/withdraw/accept`. Always acts on the caller's own
/// ledger — there is no admin-requests-for-others feature.
///
/// # Errors
///
/// * Returns `AppError::Validation` if the request selects transactions that aren't the caller's
///   or aren't pending.
#[utoipa::path(
    post,
    path = "/api/bank/transactions/withdraw",
    tag = "bank",
    summary = "Step 1 of 2: request a withdrawal (does not pay out)",
    description = "Self-service only — always acts on the caller's own ledger, there is no \
        \"request on behalf of another user\" option. Moves the selected `pending` or `rejected` \
        transactions to `requested` status and stamps `requested_at`; `from_user_id`/`from_label` stay as the Guild \
        Bank until an officer completes step 2. Provide either `transaction_ids` (specific rows — \
        each must belong to the caller and currently be `pending` or `rejected`, or the whole call fails with no \
        partial effect) or `all: true` (every one of the caller's currently-requestable transactions, \
        which may be an empty list — that's not an error). After this call, the amounts move from \
        `pending_total` to `requested_total` in `GET /bank/balance`; nothing is payable to the member \
        yet. See `POST /transactions/withdraw/accept` for the officer side.",
    security(("session_cookie" = [])),
    request_body(content = WithdrawRequest, description = "Either `transaction_ids` (specific rows) or `all: true`; provide exactly one of the two."),
    responses(
        (status = 200, description = "The transactions that were moved to \"requested\" status (may be an empty list)", body = ApiResponseTransactionViewList),
        (status = 400, description = "Validation error - neither transaction_ids nor all=true was provided, or a selected transaction isn't the caller's / isn't requestable", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn withdraw(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<WithdrawRequest>,
) -> Result<Json<ApiResponse<Vec<TransactionView>>>, AppError> {
    let service = BankService::new();
    let requested = service.request_withdrawal(&db, user.user_id, &req).await?;
    Ok(Json(ApiResponse::new(requested)))
}

/// Accept (and pay out) one, several, or all currently-requested withdrawals.
///
/// Requires the Admin or Officer role. The accepting officer is recorded as the payer.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks the required role.
/// * Returns `AppError::Validation` if the request selects transactions that aren't currently
///   requested.
#[utoipa::path(
    post,
    path = "/api/bank/transactions/withdraw/accept",
    tag = "bank",
    summary = "Step 2 of 2: accept and pay out requested withdrawals (Officer/Admin only)",
    description = "This is the only endpoint that ever sets a transaction's `from_user_id` — it is \
        stamped with **the caller's own** user id, recording this officer as the one who physically \
        paid the member. Moves the selected `requested` transactions to `withdrawn` and stamps \
        `withdrawn_at`. Unlike `POST /transactions/withdraw`, `all: true` here is guild-wide: it \
        accepts every currently-`requested` transaction across every member, not just the caller's \
        own (officers don't have a personal Guild Bank balance to withdraw in the normal case). \
        Provide either `transaction_ids` (each must currently be `requested`, or the whole call fails \
        with no partial effect) or `all: true`. Requires the Admin or Officer role.",
    security(("session_cookie" = ["bank.withdraw.accept"])),
    request_body(content = AcceptWithdrawalRequest, description = "Either `transaction_ids` (specific rows, any member) or `all: true` for every currently-requested transaction guild-wide; provide exactly one of the two."),
    responses(
        (status = 200, description = "The transactions that were accepted and paid out (may be an empty list)", body = ApiResponseTransactionViewList),
        (status = 403, description = "Forbidden - lacks administrator/officer role", body = ProblemDetails),
        (status = 400, description = "Validation error - neither transaction_ids nor all=true was provided, or a selected transaction isn't currently requested", body = ProblemDetails)
    )
)]
async fn accept_withdrawal(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<AcceptWithdrawalRequest>,
) -> Result<Json<ApiResponse<Vec<TransactionView>>>, AppError> {
    user.require(&perms, Permission::BankWithdrawAccept).await?;
    let service = BankService::new();
    let accepted = service.accept_withdrawal(&db, user.user_id, &req).await?;
    Ok(Json(ApiResponse::new(accepted)))
}

/// Reject one, several, or all currently-requested withdrawals, requiring a fresh request later.
///
/// Requires the Admin or Officer role.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks the required role.
/// * Returns `AppError::Validation` if the request selects transactions that aren't currently
///   requested.
#[utoipa::path(
    post,
    path = "/api/bank/transactions/withdraw/reject",
    tag = "bank",
    summary = "Reject requested withdrawals (Officer/Admin only)",
    description = "Moves the selected `requested` transactions to `rejected`. Rejected transactions \
        remain part of the member's requestable balance but cannot be accepted until the member \
        submits a fresh withdrawal request. Provide either `transaction_ids` (specific rows, any \
        member) or `all: true` for every currently-requested transaction guild-wide. Requires the \
        Admin or Officer role.",
    security(("session_cookie" = ["bank.withdraw.accept"])),
    request_body(content = RejectWithdrawalRequest, description = "Either `transaction_ids` or `all: true`."),
    responses(
        (status = 200, description = "The transactions that were rejected (may be an empty list)", body = ApiResponseTransactionViewList),
        (status = 403, description = "Forbidden - lacks administrator/officer role", body = ProblemDetails),
        (status = 400, description = "Validation error", body = ProblemDetails)
    )
)]
async fn reject_withdrawal(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<RejectWithdrawalRequest>,
) -> Result<Json<ApiResponse<Vec<TransactionView>>>, AppError> {
    user.require(&perms, Permission::BankWithdrawAccept).await?;
    let service = BankService::new();
    let rejected = service.reject_withdrawal(&db, user.user_id, &req).await?;
    Ok(Json(ApiResponse::new(rejected)))
}
