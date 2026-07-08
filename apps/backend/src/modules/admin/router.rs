//! Admin routing module.
//!
//! Endpoints for administrative operations: currently just the permission
//! cache reload, which applies `role_permissions` changes without a redeploy.

use axum::{routing::post, Extension, Json, Router};
use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::responses::ApiResponse;

/// Creates the router for the admin module.
pub fn router() -> Router {
    Router::new().route("/permissions/reload", post(reload_permissions))
}

/// Reload the in-memory permission cache from the `role_permissions` table.
///
/// Call this after inserting/updating/deleting rows in `role_permissions` to
/// apply the change immediately without restarting the backend. Requires the
/// `permissions.reload` permission (granted to Admin by default).
#[utoipa::path(
    post,
    path = "/api/admin/permissions/reload",
    tag = "admin",
    summary = "Reload the permission cache from the database",
    description = "Applies changes made to the `role_permissions` table without a backend restart. \
        Call this after granting or revoking a permission to a role. Requires the \
        `permissions.reload` permission (held by Admin).",
    security(("session_cookie" = ["permissions.reload"])),
    responses(
        (status = 200, description = "Cache reloaded successfully; data is a confirmation message"),
        (status = 403, description = "Forbidden - lacks the permissions.reload permission", body = ProblemDetails)
    )
)]
async fn reload_permissions(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<&'static str>>, AppError> {
    user.require(&perms, Permission::PermissionsReload).await?;
    perms
        .reload(&db)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to reload permissions: {e}")))?;
    Ok(Json(ApiResponse::new("Permission cache reloaded")))
}
