//! User routing module.
//!
//! Exposes HTTP endpoints for interacting with user resources.

use super::service::{UserFilters, UserProfile, UserService};
use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::pagination::{PaginatedUserProfile, PaginationParams};
use crate::responses::{ApiResponse, ApiResponseUserMetrics, ApiResponseUserProfile};
use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::get,
};

/// Router query parameters for listing users, combining pagination and filtering.
///
/// The pagination fields are declared inline rather than via `#[serde(flatten)]` on
/// `PaginationParams`, since axum's `Query` extractor (backed by `serde_html_form`) cannot
/// deserialize non-string fields (e.g. `u64`) through a flattened struct from a query string.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct ListUsersQuery {
    /// The page number to fetch (1-indexed). Defaults to 1.
    pub page: Option<u64>,
    /// The maximum number of items per page. Defaults to 10.
    pub limit: Option<u64>,
    /// The filter query parameters.
    #[serde(flatten)]
    pub filters: UserFilters,
}

impl ListUsersQuery {
    fn pagination(&self) -> PaginationParams {
        PaginationParams {
            page: self.page,
            limit: self.limit,
        }
    }
}

/// Creates the router for the user module.
///
/// This router nests all user-related endpoints.
pub fn router() -> Router {
    Router::new()
        .route("/me", get(get_my_profile))
        .route("/me/metrics", get(get_my_metrics))
        .route("/", get(list_users).post(create_user))
        .route("/{user_id}", get(get_user))
}

/// Retrieve the profile of the currently authenticated user.
///
/// Returns user profile details wrapped in a success envelope.
///
/// # Errors
///
/// * Returns `AppError::Unauthorized` if the session is missing or invalid.
#[utoipa::path(
    get,
    path = "/api/users/me",
    tag = "users",
    summary = "Get the caller's local user profile (id, username, email, role)",
    description = "Similar to `GET /api/auth/me`, but returns the local `users` table row shape \
        (`UserProfile`: numeric `id`, `username`, `email`, resolved `role` string) instead of the raw \
        Discord profile. Use this when you need the internal integer user id — e.g. to compare \
        against a split participant's `user_id` or a transaction's `to_user_id`.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Profile retrieved successfully", body = ApiResponseUserProfile),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn get_my_profile(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<UserProfile>>, AppError> {
    let username = crate::modules::users::display_name::resolve_by_id(&db, user.user_id).await?;
    let profile = UserProfile {
        id: user.user_id as u64,
        username,
        email: user.email.unwrap_or_default(),
        role: user.highest_role,
    };
    Ok(Json(ApiResponse::new(profile)))
}

/// Retrieve the profile metrics of the currently authenticated user.
#[utoipa::path(
    get,
    path = "/api/users/me/metrics",
    tag = "users",
    summary = "Get the caller's user metrics",
    description = "Returns aggregated metrics like most played build, events attended, and estimated losses.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Metrics retrieved successfully", body = ApiResponseUserMetrics),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn get_my_metrics(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<crate::modules::users::service::UserMetrics>>, AppError> {
    let service = UserService::new();
    let metrics = service
        .get_metrics(&db, user.user_id as u64, &user.id)
        .await?;
    Ok(Json(ApiResponse::new(metrics)))
}

/// List all user profiles with pagination and filtering.
///
/// Open to any authenticated user (needed to pick guild members as split participants).
///
/// # Errors
///
/// * Returns `AppError::Unauthorized` if there is no active session.
/// * Returns `AppError::Database` if database query fails.
#[utoipa::path(
    get,
    path = "/api/users",
    tag = "users",
    summary = "List/search guild members — the guild member directory",
    description = "Open to any authenticated user (not just admins): this is the endpoint the split \
        request form uses to populate its participant picker, and the only way to resolve a \
        username to the internal `user_id` needed by `POST /splits` or `POST /splits/{id}/participants`. \
        Supports filtering by `username` (case-insensitive substring), exact `email`, or `role`, plus \
        standard `page`/`limit` pagination (default `limit=10`). Page through results rather than \
        requesting an oversized `limit`. Sort with `sort=username|role` and `order=asc|desc`; \
        unknown `sort` values return 400.",
    security(("session_cookie" = [])),
    params(
        ListUsersQuery
    ),
    responses(
        (status = 200, description = "List of users retrieved successfully", body = PaginatedUserProfile),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn list_users(
    _user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(query): Query<ListUsersQuery>,
) -> Result<Json<ApiResponse<PaginatedUserProfile>>, AppError> {
    let service = UserService::new();
    let pagination = query.pagination();
    let paginated = service.list_users(&db, &pagination, &query.filters).await?;
    let response_data = PaginatedUserProfile::from(paginated);

    Ok(Json(ApiResponse::new(response_data)))
}

/// Fetch one user profile by internal id.
///
/// Open to any authenticated user, matching [`list_users`].
///
/// # Errors
///
/// * Returns `AppError::Unauthorized` if there is no active session.
/// * Returns `AppError::NotFound` if the user does not exist.
#[utoipa::path(
    get,
    path = "/api/users/{user_id}",
    tag = "users",
    summary = "Get one guild member by internal id",
    description = "Returns the same `UserProfile` shape as `GET /api/users`. Open to any \
        authenticated user so member detail pages can load without a full roster dump.",
    security(("session_cookie" = [])),
    params(("user_id" = u64, Path, description = "Internal user id")),
    responses(
        (status = 200, description = "Profile retrieved successfully", body = ApiResponseUserProfile),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "User not found", body = ProblemDetails)
    )
)]
pub async fn get_user(
    _user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(user_id): Path<u64>,
) -> Result<Json<ApiResponse<UserProfile>>, AppError> {
    let service = UserService::new();
    let profile = service
        .get_profile(&db, user_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("user {user_id} not found")))?;
    Ok(Json(ApiResponse::new(profile)))
}

/// Create a new user profile.
///
/// Requires the Admin role.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the user is not an administrator.
#[utoipa::path(
    post,
    path = "/api/users",
    tag = "users",
    summary = "(Stub — not wired to persistence yet) Create a user profile",
    description = "**Frontend integrators: do not build against this endpoint yet.** It currently \
        ignores the request body entirely and always returns the same hardcoded mock `UserProfile` \
        (id 99, username \"new_user\") without writing anything to the database — it exists only to \
        reserve the route and exercise the Admin-role check. Real user rows are created exclusively \
        as a side effect of `GET /api/auth/discord/callback` (first login upserts a `users` row). \
        Requires the Admin role.",
    security(("session_cookie" = ["users.create"])),
    responses(
        (status = 200, description = "Returns a mock UserProfile; no database write occurs", body = ApiResponseUserProfile),
        (status = 403, description = "Forbidden - lacks administrator role", body = ProblemDetails)
    )
)]
async fn create_user(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
) -> Result<Json<ApiResponse<UserProfile>>, AppError> {
    user.require(&perms, Permission::UsersCreate).await?;
    // Return a mock created user for testing purposes
    let mock_created = UserProfile {
        id: 99,
        username: "new_user".to_string(),
        email: "new@example.com".to_string(),
        role: "User".to_string(),
    };

    Ok(Json(ApiResponse::new(mock_created)))
}
