//! Admin routing module.
//!
//! Endpoints for administrative operations: reading and editing the
//! role → permission matrix, and reloading the in-memory cache that serves it.
//!
//! This is the real authorization control surface. Roles themselves are owned
//! by Discord — every login overwrites `users.role` from the member's Discord
//! roles — so what an administrator can meaningfully change is not who holds a
//! role, but what a role is allowed to do.

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::responses::ApiResponse;
use axum::{
    Extension, Json, Router,
    extract::Path,
    routing::{get, post, put},
};
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, Set, TransactionTrait};

use super::models::{
    GuildSettingsView, PermissionMatrix, RolePermissionsView, UpdateGuildSettingsRequest,
    UpdateRolePermissionsRequest,
};
use super::service::AdminService;
use crate::modules::auth::entities::{role, role_permission};

/// Creates the router for the admin module.
pub fn router() -> Router {
    Router::new()
        .route("/permissions", get(get_permission_matrix))
        .route("/permissions/reload", post(reload_permissions))
        .route("/roles/{role_id}/permissions", put(update_role_permissions))
        .route("/settings", get(get_guild_settings).put(update_guild_settings))
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

/// The full role → permission matrix.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks `permissions.reload`.
#[utoipa::path(
    get,
    path = "/api/admin/permissions",
    tag = "admin",
    summary = "Read the role and permission matrix",
    description = "Returns every role with the permissions granted to it, plus the complete \
        list of permission keys the backend can gate on — so the grid shows what *could* be \
        granted, not only what already is. Requires `permissions.reload`.",
    security(("session_cookie" = ["permissions.reload"])),
    responses(
        (status = 200, description = "Matrix retrieved", body = PermissionMatrix),
        (status = 403, description = "Forbidden - lacks permissions.reload", body = ProblemDetails)
    )
)]
pub async fn get_permission_matrix(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<PermissionMatrix>>, AppError> {
    user.require(&perms, Permission::PermissionsReload).await?;

    let roles = role::Entity::find().all(&db).await?;
    let mappings = role_permission::Entity::find().all(&db).await?;

    let mut views: Vec<RolePermissionsView> = roles
        .into_iter()
        .map(|r| {
            let mut permissions: Vec<String> = mappings
                .iter()
                .filter(|m| m.role_id == r.id)
                .map(|m| m.permission.clone())
                .collect();
            permissions.sort();
            RolePermissionsView {
                role_id: r.id,
                role_name: r.name,
                priority: r.priority,
                permissions,
            }
        })
        .collect();
    views.sort_by(|a, b| b.priority.cmp(&a.priority).then_with(|| a.role_name.cmp(&b.role_name)));

    let mut available_permissions: Vec<String> = Permission::all()
        .iter()
        .map(|p| p.as_str().to_string())
        .collect();
    available_permissions.sort();

    Ok(Json(ApiResponse::new(PermissionMatrix {
        roles: views,
        available_permissions,
    })))
}

/// Replaces one role's permission set and applies it immediately.
///
/// # Errors
///
/// Returns `403 Forbidden` without `permissions.reload`, `404` if the role is
/// unknown, or `400` if a permission key is not one the backend recognises.
#[utoipa::path(
    put,
    path = "/api/admin/roles/{role_id}/permissions",
    tag = "admin",
    summary = "Set the permissions granted to a role",
    description = "Replaces the role's permission set with the one supplied and reloads the \
        cache, so the change takes effect at once rather than needing a separate reload. \
        Unknown permission keys are rejected rather than stored, since a typo would otherwise \
        sit in the table granting nothing and look like it worked. Requires \
        `permissions.reload`.",
    security(("session_cookie" = ["permissions.reload"])),
    params(("role_id" = String, Path, description = "Discord role id")),
    request_body = UpdateRolePermissionsRequest,
    responses(
        (status = 200, description = "Permissions updated", body = PermissionMatrix),
        (status = 400, description = "Unknown permission key", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks permissions.reload", body = ProblemDetails),
        (status = 404, description = "Role not found", body = ProblemDetails)
    )
)]
pub async fn update_role_permissions(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(role_id): Path<String>,
    Json(body): Json<UpdateRolePermissionsRequest>,
) -> Result<Json<ApiResponse<PermissionMatrix>>, AppError> {
    user.require(&perms, Permission::PermissionsReload).await?;

    if role::Entity::find_by_id(role_id.clone())
        .one(&db)
        .await?
        .is_none()
    {
        return Err(AppError::NotFound(format!("role {role_id} not found")));
    }

    // Reject unknown keys rather than storing them: a typo would otherwise sit
    // in the table granting nothing while looking like it had been applied.
    let mut wanted: Vec<String> = Vec::new();
    for key in &body.permissions {
        let parsed = Permission::from_str(key)
            .ok_or_else(|| AppError::Validation(format!("unknown permission: {key}")))?;
        wanted.push(parsed.as_str().to_string());
    }
    wanted.sort();
    wanted.dedup();

    let txn = db.begin().await?;
    role_permission::Entity::delete_many()
        .filter(role_permission::Column::RoleId.eq(role_id.clone()))
        .exec(&txn)
        .await?;
    for permission in &wanted {
        role_permission::ActiveModel {
            role_id: Set(role_id.clone()),
            permission: Set(permission.clone()),
        }
        .insert(&txn)
        .await?;
    }
    txn.commit().await?;

    // Apply immediately: an authorization change that needs a second, separate
    // action to take effect is a change an administrator will forget to finish.
    perms.reload(&db).await?;

    get_permission_matrix(user, Extension(perms), Extension(db)).await
}


/// Read the guild's Discord integration settings.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks `admin.settings.manage`.
#[utoipa::path(
    get,
    path = "/api/admin/settings",
    tag = "admin",
    summary = "Read the guild's Discord integration settings",
    description = "Returns the singleton `guild_settings` row: the channel/role IDs that used to \
        live only in deployment env vars (events/battles/CTA/audit-log/transaction-spam channels, \
        and the event-ping role). The bot reads this same endpoint at startup and on a refresh \
        interval, so an edit here takes effect without redeploying the bot. Requires \
        `admin.settings.manage`.",
    security(("session_cookie" = ["admin.settings.manage"])),
    responses(
        (status = 200, description = "Settings retrieved", body = GuildSettingsView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks admin.settings.manage", body = ProblemDetails)
    )
)]
async fn get_guild_settings(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<GuildSettingsView>>, AppError> {
    user.require(&perms, Permission::AdminSettingsManage).await?;
    let settings = AdminService::get_guild_settings(&db).await?;
    Ok(Json(ApiResponse::new(settings)))
}

/// Update the guild's Discord integration settings.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks `admin.settings.manage`.
#[utoipa::path(
    put,
    path = "/api/admin/settings",
    tag = "admin",
    summary = "Update the guild's Discord integration settings",
    description = "Partial update: only the fields present in the body are changed; a present but \
        empty string clears that field. Requires `admin.settings.manage`.",
    security(("session_cookie" = ["admin.settings.manage"])),
    request_body(content = UpdateGuildSettingsRequest, description = "Fields to update. All fields are optional; absent fields are left unchanged, empty strings clear."),
    responses(
        (status = 200, description = "Settings updated", body = GuildSettingsView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks admin.settings.manage", body = ProblemDetails)
    )
)]
async fn update_guild_settings(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<UpdateGuildSettingsRequest>,
) -> Result<Json<ApiResponse<GuildSettingsView>>, AppError> {
    user.require(&perms, Permission::AdminSettingsManage).await?;
    let settings = AdminService::update_guild_settings(&db, user.user_id, &req).await?;
    Ok(Json(ApiResponse::new(settings)))
}
