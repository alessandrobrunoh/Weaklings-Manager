//! Admin routing module.
//!
//! Endpoints for administrative operations: reading and editing the
//! role → permission matrix, and reloading the in-memory cache that serves it.
//!
//! This is the real authorization control surface. Discord still owns who holds
//! a Discord role; here an administrator creates gestionale roles, links them to
//! Discord snowflakes, and decides what each linked role is allowed to do.

use crate::config::Config;
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
    AutoRoleSettingsView, CreateRoleRequest, DiscordChannelView, DiscordRoleView,
    GuildSettingsView, PermissionMatrix, UpdateAutoRoleRequest, UpdateGuildSettingsRequest,
    UpdateRolePermissionsRequest, UpdateRoleRequest,
};
use super::service::AdminService;
use crate::modules::auth::entities::{role, role_permission};

/// Creates the router for the admin module.
pub fn router() -> Router {
    Router::new()
        .route("/permissions", get(get_permission_matrix))
        .route("/permissions/reload", post(reload_permissions))
        .route("/roles", post(create_role))
        .route(
            "/roles/{role_id}",
            axum::routing::patch(update_role).delete(delete_role),
        )
        .route("/roles/{role_id}/permissions", put(update_role_permissions))
        .route("/discord/roles", get(list_guild_discord_roles))
        .route("/discord/channels", get(list_guild_discord_channels))
        .route(
            "/settings",
            get(get_guild_settings).put(update_guild_settings),
        )
        .route("/autorole", get(get_autorole).put(update_autorole))
        .route("/autorole/roles", get(list_discord_roles))
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
    let matrix = AdminService::permission_matrix(&db).await?;
    Ok(Json(ApiResponse::new(matrix)))
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
    params(("role_id" = String, Path, description = "Internal role id")),
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

    let matrix = AdminService::permission_matrix(&db).await?;
    Ok(Json(ApiResponse::new(matrix)))
}

/// Create a gestionale role, optionally linked to a Discord snowflake.
#[utoipa::path(
    post,
    path = "/api/admin/roles",
    tag = "admin",
    summary = "Create a gestionale role",
    description = "Creates a role the RBAC matrix can grant permissions to. Pass a Discord snowflake \
        in `discord_role_id` to link it: members holding that Discord role then receive this role's \
        permissions on login and on `GET /api/auth/me`. Requires `roles.manage`.",
    security(("session_cookie" = ["roles.manage"])),
    request_body = CreateRoleRequest,
    responses(
        (status = 200, description = "Role created", body = PermissionMatrix),
        (status = 400, description = "Invalid name or Discord snowflake", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks roles.manage", body = ProblemDetails),
        (status = 409, description = "Name or Discord link already taken", body = ProblemDetails)
    )
)]
pub async fn create_role(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(body): Json<CreateRoleRequest>,
) -> Result<Json<ApiResponse<PermissionMatrix>>, AppError> {
    user.require(&perms, Permission::RolesManage).await?;
    let matrix = AdminService::create_role(&db, user.user_id, &body).await?;
    perms.reload(&db).await?;
    Ok(Json(ApiResponse::new(matrix)))
}

/// Update a gestionale role's name, priority, Discord link, or default flag.
#[utoipa::path(
    patch,
    path = "/api/admin/roles/{role_id}",
    tag = "admin",
    summary = "Update a gestionale role",
    description = "Partial update. Send `discord_role_id` as an empty string to unlink. Requires \
        `roles.manage`.",
    security(("session_cookie" = ["roles.manage"])),
    params(("role_id" = String, Path, description = "Internal role id")),
    request_body = UpdateRoleRequest,
    responses(
        (status = 200, description = "Role updated", body = PermissionMatrix),
        (status = 400, description = "Invalid name or Discord snowflake", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks roles.manage", body = ProblemDetails),
        (status = 404, description = "Role not found", body = ProblemDetails),
        (status = 409, description = "Name or Discord link already taken", body = ProblemDetails)
    )
)]
pub async fn update_role(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(role_id): Path<String>,
    Json(body): Json<UpdateRoleRequest>,
) -> Result<Json<ApiResponse<PermissionMatrix>>, AppError> {
    user.require(&perms, Permission::RolesManage).await?;
    let matrix = AdminService::update_role(&db, user.user_id, &role_id, &body).await?;
    perms.reload(&db).await?;
    Ok(Json(ApiResponse::new(matrix)))
}

/// Delete a gestionale role.
#[utoipa::path(
    delete,
    path = "/api/admin/roles/{role_id}",
    tag = "admin",
    summary = "Delete a gestionale role",
    description = "Cascade-deletes its permission rows. The default fallback role cannot be deleted. \
        Deleting the last role that grants `roles.manage` is rejected unless the caller is \
        super-admin. Requires `roles.manage`.",
    security(("session_cookie" = ["roles.manage"])),
    params(("role_id" = String, Path, description = "Internal role id")),
    responses(
        (status = 200, description = "Role deleted", body = PermissionMatrix),
        (status = 403, description = "Forbidden - lacks roles.manage", body = ProblemDetails),
        (status = 404, description = "Role not found", body = ProblemDetails),
        (status = 409, description = "Protected default or last roles.manage grant", body = ProblemDetails)
    )
)]
pub async fn delete_role(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(role_id): Path<String>,
) -> Result<Json<ApiResponse<PermissionMatrix>>, AppError> {
    user.require(&perms, Permission::RolesManage).await?;
    let matrix =
        AdminService::delete_role(&db, user.user_id, &role_id, user.is_superadmin()).await?;
    perms.reload(&db).await?;
    Ok(Json(ApiResponse::new(matrix)))
}

/// Discord roles in the configured guild, for linking from the RBAC panel.
#[utoipa::path(
    get,
    path = "/api/admin/discord/roles",
    tag = "admin",
    summary = "List Discord guild roles for searchable pickers",
    description = "Returns non-managed guild roles (excludes @everyone and bot/integration roles), \
        highest Discord position first. Allowed for officers who can manage roles, autorole, \
        Discord settings, events, or progression settings. Missing bot token yields 502.",
    security(("session_cookie" = ["roles.manage"])),
    responses(
        (status = 200, description = "Discord roles retrieved", body = [DiscordRoleView]),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 502, description = "Discord API unavailable or bot token missing", body = ProblemDetails)
    )
)]
pub async fn list_guild_discord_roles(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(cfg): Extension<Config>,
) -> Result<Json<ApiResponse<Vec<DiscordRoleView>>>, AppError> {
    require_discord_catalog(&user, &perms).await?;
    Ok(Json(ApiResponse::new(
        AdminService::discord_roles(&cfg).await?,
    )))
}

/// Discord channels in the configured guild, for searchable pickers.
#[utoipa::path(
    get,
    path = "/api/admin/discord/channels",
    tag = "admin",
    summary = "List Discord guild channels for searchable pickers",
    description = "Returns text, voice, category, and forum channels (threads omitted), with \
        forum tags attached to forum channels. Same permission set as `/api/admin/discord/roles`.",
    security(("session_cookie" = ["admin.settings.manage"])),
    responses(
        (status = 200, description = "Discord channels retrieved", body = [DiscordChannelView]),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 502, description = "Discord API unavailable or bot token missing", body = ProblemDetails)
    )
)]
pub async fn list_guild_discord_channels(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(cfg): Extension<Config>,
) -> Result<Json<ApiResponse<Vec<DiscordChannelView>>>, AppError> {
    require_discord_catalog(&user, &perms).await?;
    Ok(Json(ApiResponse::new(
        AdminService::discord_channels(&cfg).await?,
    )))
}

async fn require_discord_catalog(user: &UserContext, perms: &Permissions) -> Result<(), AppError> {
    let allowed = [
        Permission::RolesManage,
        Permission::AutoroleManage,
        Permission::AdminSettingsManage,
        Permission::ProgressionSettingsManage,
        Permission::ProgressionSettingsEdit,
        Permission::EventsManage,
        Permission::EventsCreate,
        Permission::EventsEdit,
    ];
    for perm in allowed {
        if perms.check(user.is_superadmin(), &user.roles, perm).await {
            return Ok(());
        }
    }
    Err(AppError::Forbidden(
        "Missing permission to list Discord channels and roles".to_string(),
    ))
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
    summary = "Read the guild's integration and split settings",
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
pub async fn get_guild_settings(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<GuildSettingsView>>, AppError> {
    user.require(&perms, Permission::AdminSettingsManage)
        .await?;
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
    summary = "Update the guild's integration and split settings",
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
pub async fn update_guild_settings(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<UpdateGuildSettingsRequest>,
) -> Result<Json<ApiResponse<GuildSettingsView>>, AppError> {
    user.require(&perms, Permission::AdminSettingsManage)
        .await?;
    let settings = AdminService::update_guild_settings(&db, user.user_id, &req).await?;
    Ok(Json(ApiResponse::new(settings)))
}

/// Read the AutoRole configuration.
#[utoipa::path(
    get,
    path = "/api/admin/autorole",
    tag = "admin",
    summary = "Read the Discord AutoRole configuration",
    security(("session_cookie" = ["autorole.manage"])),
    responses(
        (status = 200, description = "AutoRole configuration retrieved", body = AutoRoleSettingsView),
        (status = 403, description = "Forbidden - lacks autorole.manage", body = ProblemDetails)
    )
)]
pub async fn get_autorole(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<AutoRoleSettingsView>>, AppError> {
    user.require(&perms, Permission::AutoroleManage).await?;
    Ok(Json(ApiResponse::new(
        AdminService::get_autorole_settings(&db).await?,
    )))
}

/// List assignable Discord roles for the configured guild.
#[utoipa::path(
    get,
    path = "/api/admin/autorole/roles",
    tag = "admin",
    summary = "List Discord roles available for AutoRole",
    security(("session_cookie" = ["autorole.manage"])),
    responses(
        (status = 200, description = "Discord roles retrieved", body = [DiscordRoleView]),
        (status = 403, description = "Forbidden - lacks autorole.manage", body = ProblemDetails),
        (status = 502, description = "Discord API unavailable", body = ProblemDetails)
    )
)]
pub async fn list_discord_roles(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(cfg): Extension<Config>,
) -> Result<Json<ApiResponse<Vec<DiscordRoleView>>>, AppError> {
    user.require(&perms, Permission::AutoroleManage).await?;
    Ok(Json(ApiResponse::new(
        AdminService::discord_roles(&cfg).await?,
    )))
}

/// Update or disable AutoRole.
#[utoipa::path(
    put,
    path = "/api/admin/autorole",
    tag = "admin",
    summary = "Configure the Discord AutoRole",
    description = "Stores one Discord role for automatic assignment to human members joining the guild. Send an empty string to disable it.",
    security(("session_cookie" = ["autorole.manage"])),
    request_body = UpdateAutoRoleRequest,
    responses(
        (status = 200, description = "AutoRole updated", body = AutoRoleSettingsView),
        (status = 400, description = "Role is invalid or cannot be assigned", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks autorole.manage", body = ProblemDetails),
        (status = 502, description = "Discord API unavailable", body = ProblemDetails)
    )
)]
pub async fn update_autorole(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Json(body): Json<UpdateAutoRoleRequest>,
) -> Result<Json<ApiResponse<AutoRoleSettingsView>>, AppError> {
    user.require(&perms, Permission::AutoroleManage).await?;
    Ok(Json(ApiResponse::new(
        AdminService::update_autorole(&db, user.user_id, &cfg, &body.discord_auto_role_id).await?,
    )))
}
