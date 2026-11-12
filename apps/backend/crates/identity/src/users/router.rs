//! User routing module.
//!
//! Exposes HTTP endpoints for interacting with user resources.

use super::member_roles::{
    AssignUserRoleRequest, UserRolesView, add_user_role, list_user_roles, remove_user_role,
};
use super::service::{
    CreateLinkedMember, CreateUserRequest, UserFilters, UserProfile, UserService,
};
use crate::auth::{Permission, Permissions, UserContext};
use crate::tenant::{ControlDb, CurrentTenantId, CurrentTenantKind};
use crate::users::schemas::{ApiResponseUserMetrics, ApiResponseUserProfile, PaginatedUserProfile};
use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::{delete, get, post},
};
use backend_core::config::Config;
use backend_core::errors::{AppError, ProblemDetails};
use backend_core::pagination::PaginationParams;
use backend_core::platform_admins::PlatformAdmins;
use backend_core::responses::ApiResponse;
use sea_orm::EntityTrait;

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
    /// `true` lists only blocked members, `false` only members who are not blocked. Ignored for
    /// callers without `roles.manage`. Declared inline for the same reason as `page`/`limit`.
    pub blocked: Option<bool>,
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
        .route("/{user_id}/roles", get(get_user_roles).post(post_user_role))
        .route("/{user_id}/roles/{role_id}", delete(delete_user_role))
        .route("/{user_id}/block", post(block_user).delete(unblock_user))
}

/// Whether `user` may read other members' emails: `users.create` (provisioning) or
/// `roles.manage` holders, the tenant owner and platform admins included.
async fn can_see_member_emails(user: &UserContext, perms: &Permissions) -> bool {
    user.has_permission(perms, Permission::UsersCreate).await
        || user.has_permission(perms, Permission::RolesManage).await
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
    let username = crate::users::display_name::resolve_by_id(&db, user.user_id).await?;
    let profile = UserProfile {
        id: user.user_id as u64,
        username,
        email: user.email,
        role: user.highest_role,
        blocked: false,
        blocked_at: None,
        blocked_by: None,
        blocked_reason: None,
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
) -> Result<Json<ApiResponse<crate::users::service::UserMetrics>>, AppError> {
    let service = UserService::new();
    let metrics = service
        .get_metrics(&db, user.user_id as u64, &user.id)
        .await?;
    Ok(Json(ApiResponse::new(metrics)))
}

/// List all user profiles with pagination and filtering.
///
/// Open to any authenticated user (needed to pick guild members as split participants), but
/// emails are only returned to the caller's own row and to `users.create`/`roles.manage` holders.
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
        Supports filtering by `username`/display name (case-insensitive substring; linked Albion \
        character names are included), or exact `role`, plus \
        standard `page`/`limit` pagination (default `limit=10`). Page through results rather than \
        requesting an oversized `limit`. Sort with `sort=username|role` and `order=asc|desc`; \
        unknown `sort` values return 400. `email` is omitted from each item except the caller's \
        own and for callers holding `users.create` or `roles.manage`; there is no email filter.",
    security(("session_cookie" = [])),
    params(
        ListUsersQuery
    ),
    responses(
        (status = 200, description = "List of users retrieved successfully", body = ApiResponse<PaginatedUserProfile>),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn list_users(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(query): Query<ListUsersQuery>,
) -> Result<Json<ApiResponse<PaginatedUserProfile>>, AppError> {
    let service = UserService::new();
    let pagination = query.pagination();
    let can_manage_members = user.has_permission(&perms, Permission::RolesManage).await;
    let mut filters = query.filters;
    // Who is blocked is only for the officers who can block.
    filters.blocked = query.blocked.filter(|_| can_manage_members);
    let mut paginated = service.list_users(&db, &pagination, &filters).await?;
    let can_see_emails = can_see_member_emails(&user, &perms).await;
    paginated.items = paginated
        .items
        .into_iter()
        .map(|profile| {
            let profile = profile.redacted_for(user.user_id, can_see_emails);
            if can_manage_members {
                profile
            } else {
                profile.without_block_details()
            }
        })
        .collect();
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
        authenticated user so member detail pages can load without a full roster dump. `email` is \
        included only for the caller's own profile and for callers holding `users.create` or \
        `roles.manage`.",
    security(("session_cookie" = [])),
    params(("user_id" = u64, Path, description = "Internal user id")),
    responses(
        (status = 200, description = "Profile retrieved successfully", body = ApiResponseUserProfile),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "User not found", body = ProblemDetails)
    )
)]
pub async fn get_user(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(user_id): Path<u64>,
) -> Result<Json<ApiResponse<UserProfile>>, AppError> {
    let service = UserService::new();
    let profile = service
        .get_profile(&db, user_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("user {user_id} not found")))?;
    let profile = profile.redacted_for(user.user_id, can_see_member_emails(&user, &perms).await);
    let profile = if user.has_permission(&perms, Permission::RolesManage).await {
        profile
    } else {
        profile.without_block_details()
    };
    Ok(Json(ApiResponse::new(profile)))
}

/// List a member's Discord-linked gestionale roles.
#[utoipa::path(
    get,
    path = "/api/users/{user_id}/roles",
    tag = "users",
    summary = "List a member's gestionale roles as held on Discord",
    description = "Returns every gestionale role with `held` reflecting the member's current \
        Discord roles, using the links configured on `/roles`. The unique generic staff role is \
        not assignable: it is applied automatically to staff-eligible roles. Open to any \
        authenticated user, matching `GET /api/users/{user_id}`.",
    security(("session_cookie" = [])),
    params(("user_id" = u64, Path, description = "Internal user id")),
    responses(
        (status = 200, description = "Roles retrieved", body = ApiResponse<UserRolesView>),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "User not found", body = ProblemDetails),
        (status = 502, description = "Discord API unavailable", body = ProblemDetails)
    )
)]
pub async fn get_user_roles(
    _user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path(user_id): Path<u64>,
) -> Result<Json<ApiResponse<UserRolesView>>, AppError> {
    let discord = super::member_roles::LiveDiscord::for_guild(&cfg, &tenant.0)?;
    Ok(Json(ApiResponse::new(
        list_user_roles(&db, &discord, user_id).await?,
    )))
}

/// Add a linked gestionale role to a member on Discord.
#[utoipa::path(
    post,
    path = "/api/users/{user_id}/roles",
    tag = "users",
    summary = "Add a gestionale role to a member and sync it to Discord",
    description = "Assigns the Discord role linked to the given gestionale role. If that role is \
        staff-eligible, the unique generic staff Discord role is also assigned so `@staff` \
        reaches them. Requires `roles.manage`. Cannot assign a role above the caller's own \
        priority, except for the super-admin.",
    security(("session_cookie" = ["roles.manage"])),
    params(("user_id" = u64, Path, description = "Internal user id")),
    request_body = AssignUserRoleRequest,
    responses(
        (status = 200, description = "Role assigned", body = ApiResponse<UserRolesView>),
        (status = 400, description = "Role is unlinked, is the generic staff role, or the member has no Discord id", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "User or role not found", body = ProblemDetails),
        (status = 502, description = "Discord API unavailable", body = ProblemDetails)
    )
)]
pub async fn post_user_role(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path(user_id): Path<u64>,
    Json(body): Json<AssignUserRoleRequest>,
) -> Result<Json<ApiResponse<UserRolesView>>, AppError> {
    user.require(&perms, Permission::RolesManage).await?;
    let discord = super::member_roles::LiveDiscord::for_guild(&cfg, &tenant.0)?;
    Ok(Json(ApiResponse::new(
        add_user_role(
            &db,
            &discord,
            user.user_id,
            user.bypasses_priority(),
            &user.roles,
            user_id,
            &body.role_id,
        )
        .await?,
    )))
}

/// Remove a linked gestionale role from a member on Discord.
#[utoipa::path(
    delete,
    path = "/api/users/{user_id}/roles/{role_id}",
    tag = "users",
    summary = "Remove a gestionale role from a member and sync it to Discord",
    description = "Revokes the Discord role linked to the given gestionale role. If the member \
        no longer holds any staff-eligible role, the generic staff Discord role is also removed. \
        Requires `roles.manage`.",
    security(("session_cookie" = ["roles.manage"])),
    params(
        ("user_id" = u64, Path, description = "Internal user id"),
        ("role_id" = String, Path, description = "Internal role id")
    ),
    responses(
        (status = 200, description = "Role removed", body = ApiResponse<UserRolesView>),
        (status = 400, description = "Role is unlinked or is the generic staff role", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "User or role not found", body = ProblemDetails),
        (status = 502, description = "Discord API unavailable", body = ProblemDetails)
    )
)]
pub async fn delete_user_role(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path((user_id, role_id)): Path<(u64, String)>,
) -> Result<Json<ApiResponse<UserRolesView>>, AppError> {
    user.require(&perms, Permission::RolesManage).await?;
    let discord = super::member_roles::LiveDiscord::for_guild(&cfg, &tenant.0)?;
    Ok(Json(ApiResponse::new(
        remove_user_role(
            &db,
            &discord,
            user.user_id,
            user.bypasses_priority(),
            &user.roles,
            user_id,
            &role_id,
        )
        .await?,
    )))
}

/// Create a local user from a Discord guild member and link an Albion character.
///
/// Requires `users.create`.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks `users.create`.
/// * Returns `AppError::Validation` if the Discord member is missing or not in the guild.
/// * Returns `AppError::Conflict` if the Discord member or Albion character is already provisioned.
#[utoipa::path(
    post,
    path = "/api/users",
    tag = "users",
    summary = "Provision a Discord member and link an Albion character",
    description = "Creates a `users` row for a Discord guild member who is not yet in the directory, \
        then links the selected Albion character: looked up in the configured guild roster first, then \
        in Albion at large, so a character outside the guild can be linked too. The Discord \
        snowflake is the stable identity: later OAuth login reuses this row (see `AuthService::upsert_user`). \
        Email is stored as a placeholder until first login. Requires `users.create`.",
    security(("session_cookie" = ["users.create"])),
    request_body(content = CreateUserRequest),
    responses(
        (status = 200, description = "Member created and linked", body = ApiResponseUserProfile),
        (status = 400, description = "Validation error — missing Discord/Albion identity or member not in guild", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks users.create", body = ProblemDetails),
        (status = 404, description = "No Albion character exists for the given id or name", body = ProblemDetails),
        (status = 409, description = "Discord member or Albion character already provisioned", body = ProblemDetails)
    )
)]
#[allow(clippy::too_many_arguments)]
async fn create_user(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Extension(control): Extension<crate::tenant::ControlDb>,
    Extension(tenant): Extension<CurrentTenantId>,
    Extension(kind): Extension<CurrentTenantKind>,
    Json(body): Json<CreateUserRequest>,
) -> Result<Json<ApiResponse<UserProfile>>, AppError> {
    user.require(&perms, Permission::UsersCreate).await?;

    let discord_id = body.discord_id.trim();
    if discord_id.is_empty() {
        return Err(AppError::Validation("discord_id is required".to_owned()));
    }

    let (member, role_ids) =
        crate::admin::service::AdminService::discord_member(&cfg, &tenant.0, discord_id).await?;
    let db_roles = backend_entities::auth::role::Entity::find()
        .all(&db)
        .await?;
    let (_, highest) = crate::auth::service::resolve_linked_roles(&role_ids, &db_roles);

    let albion_scope = crate::albion_scope::load_albion_scope(&control.0, &tenant.0)
        .await
        .map_err(AppError::from)?;
    let albion = crate::albion::service::AlbionService::new(
        crate::albion::client::AlbionRegion::from_env_str(&albion_scope.region),
        albion_scope.guild_id.clone(),
    );
    // Guild roster first, then any Albion player: a recruit may not be in the guild yet.
    let player = albion
        .resolve_link_target(
            body.albion_player_id.as_deref(),
            body.albion_player_name.as_deref(),
        )
        .await?;

    let created = UserService::new()
        .create_linked_member(
            &db,
            CreateLinkedMember {
                discord_id: member.id.clone(),
                username: member.display_name.clone(),
                role: highest,
                albion_player_id: player.id.clone(),
                albion_player_name: player.name.clone(),
                actor_user_id: Some(user.user_id),
            },
        )
        .await?;

    crate::albion::discord_nick::sync_guild_nickname(&cfg, &tenant.0, &member.id, &player.name)
        .await;
    if kind.0 != "alliance"
        && crate::albion::discord_guild_role::belongs_to_configured_guild(
            player.guild_id.as_deref(),
            &albion_scope.guild_id,
        )
    {
        crate::albion::discord_guild_role::assign_guild_role(&db, &cfg, &tenant.0, &member.id)
            .await;
    }

    Ok(Json(ApiResponse::new(created)))
}

/// Body of `POST /api/users/{user_id}/block`.
#[derive(Debug, Default, serde::Deserialize, utoipa::ToSchema)]
pub struct BlockUserRequest {
    /// Why the member is blocked (at most 500 characters). Optional; shown to `roles.manage`
    /// holders only, never to the blocked member.
    #[schema(example = "Spamming the loot channel")]
    pub reason: Option<String>,
}

/// Whether `actor` may block `target`. Pure so the rules can be tested without a database.
///
/// Nobody blocks themselves, the tenant owner or a platform admin, and an actor who does not
/// bypass role priority cannot block a member whose role outranks their own (the rule that
/// already guards role assignment).
fn ensure_blockable(
    actor: &UserContext,
    target: &backend_entities::users::Model,
    target_is_tenant_owner: bool,
    target_is_platform_admin: bool,
    db_roles: &[backend_entities::auth::role::Model],
) -> Result<(), AppError> {
    if target.id == actor.user_id {
        return Err(AppError::Forbidden("you cannot block yourself".to_owned()));
    }
    if target_is_platform_admin {
        return Err(AppError::Forbidden(
            "a platform admin cannot be blocked".to_owned(),
        ));
    }
    if target_is_tenant_owner {
        return Err(AppError::Forbidden(
            "the server owner cannot be blocked".to_owned(),
        ));
    }
    if !actor.bypasses_priority() {
        let actor_max = super::member_roles::max_priority_for_names(&actor.roles, db_roles);
        let target_max =
            super::member_roles::max_priority_for_names(&[target.role.clone()], db_roles);
        if target_max > actor_max {
            return Err(AppError::Forbidden(
                "you cannot block a member whose role is above your own".to_owned(),
            ));
        }
    }
    Ok(())
}

/// Block a member from the manager.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` without `roles.manage`, or for a protected target.
/// * Returns `AppError::NotFound` if the member does not exist.
/// * Returns `AppError::Validation` if the reason is longer than 500 characters.
#[utoipa::path(
    post,
    path = "/api/users/{user_id}/block",
    tag = "users",
    summary = "Block a member from the manager",
    description = "Requires `roles.manage`. A blocked member cannot log in and every authenticated \
        request of theirs (web session or Discord bot interaction) is refused with \
        `403 account_blocked`; the web app then shows an \"access blocked\" screen. The block is \
        scoped to this server (tenant) and takes effect on the member's next request, even on a \
        live session. Nothing changes on Discord: the member is not kicked, banned or stripped of \
        roles. Cannot target yourself, the server owner or a platform admin, nor a member whose \
        role is above your own (unless you are the owner or a platform admin). Idempotent: \
        blocking a blocked member keeps the first block. Audited as `USER_BLOCK`.",
    security(("session_cookie" = ["roles.manage"])),
    params(("user_id" = u64, Path, description = "Internal user id")),
    request_body(content = BlockUserRequest),
    responses(
        (status = 200, description = "Member blocked; the body is their profile with the block details", body = ApiResponseUserProfile),
        (status = 400, description = "Reason too long", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks roles.manage, or the target is protected", body = ProblemDetails),
        (status = 404, description = "User not found", body = ProblemDetails)
    )
)]
#[allow(clippy::too_many_arguments)]
pub async fn block_user(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(admins): Extension<PlatformAdmins>,
    Extension(control): Extension<ControlDb>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path(user_id): Path<u64>,
    Json(body): Json<BlockUserRequest>,
) -> Result<Json<ApiResponse<UserProfile>>, AppError> {
    user.require(&perms, Permission::RolesManage).await?;
    let target = backend_entities::users::Entity::find_by_id(user_id as i64)
        .one(&db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("user {user_id} not found")))?;
    let (is_owner, is_admin) = match target.discord_id.as_deref() {
        Some(discord_id) => (
            crate::platform::service::PlatformService::is_tenant_owner(
                &control.0, &tenant.0, discord_id,
            )
            .await?,
            admins.contains(discord_id),
        ),
        None => (false, false),
    };
    let db_roles = backend_entities::auth::role::Entity::find()
        .all(&db)
        .await?;
    ensure_blockable(&user, &target, is_owner, is_admin, &db_roles)?;
    let reason = super::block::normalize_reason(body.reason)?;
    super::block::block_member(&db, user.user_id, target.id, reason).await?;
    block_state_response(&db, user_id).await
}

/// Lift a member's block.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` without `roles.manage`.
/// * Returns `AppError::NotFound` if the member does not exist.
#[utoipa::path(
    delete,
    path = "/api/users/{user_id}/block",
    tag = "users",
    summary = "Unblock a member",
    description = "Requires `roles.manage`. The member can log in and use the manager again on \
        their next request. Idempotent: unblocking a member who is not blocked changes nothing. \
        Audited as `USER_UNBLOCK`.",
    security(("session_cookie" = ["roles.manage"])),
    params(("user_id" = u64, Path, description = "Internal user id")),
    responses(
        (status = 200, description = "Member unblocked; the body is their profile", body = ApiResponseUserProfile),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks roles.manage", body = ProblemDetails),
        (status = 404, description = "User not found", body = ProblemDetails)
    )
)]
pub async fn unblock_user(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(user_id): Path<u64>,
) -> Result<Json<ApiResponse<UserProfile>>, AppError> {
    user.require(&perms, Permission::RolesManage).await?;
    super::block::unblock_member(&db, user.user_id, user_id as i64).await?;
    block_state_response(&db, user_id).await
}

/// The member's profile after a block or unblock, with the block details the caller may see.
async fn block_state_response(
    db: &sea_orm::DatabaseConnection,
    user_id: u64,
) -> Result<Json<ApiResponse<UserProfile>>, AppError> {
    let profile = UserService::new()
        .get_profile(db, user_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("user {user_id} not found")))?;
    Ok(Json(ApiResponse::new(profile)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use backend_entities::auth::role;

    fn actor(user_id: i64, roles: &[&str], is_tenant_owner: bool) -> UserContext {
        UserContext {
            id: format!("discord_{user_id}"),
            username: "actor".to_owned(),
            email: None,
            avatar: None,
            roles: roles.iter().map(|name| (*name).to_owned()).collect(),
            highest_role: roles.first().copied().unwrap_or("User").to_owned(),
            user_id,
            super_admin_id: None,
            is_tenant_owner,
        }
    }

    fn target(id: i64, role: &str) -> backend_entities::users::Model {
        backend_entities::users::Model {
            id,
            username: format!("user-{id}"),
            email: format!("user-{id}@example.test"),
            role: role.to_owned(),
            discord_id: Some(format!("discord_{id}")),
            created_at: chrono::Utc::now().fixed_offset(),
            active: true,
            left_at: None,
            left_reason: None,
            discord_role_ids: "[]".to_owned(),
            roles_checked_at: None,
            member_event_at: None,
            provisioned_via: "web".to_owned(),
            last_link_change_at: None,
            blocked_at: None,
            blocked_by: None,
            blocked_reason: None,
        }
    }

    fn role_row(name: &str, priority: i32) -> role::Model {
        role::Model {
            id: name.to_lowercase(),
            name: name.to_owned(),
            priority,
            discord_role_id: None,
            is_default: false,
            is_staff: false,
            grants_staff: false,
        }
    }

    #[test]
    fn nobody_blocks_themselves() {
        let me = actor(5, &["Admin"], false);
        let err = ensure_blockable(&me, &target(5, "Admin"), false, false, &[]).unwrap_err();
        assert!(matches!(err, AppError::Forbidden(_)));
    }

    #[test]
    fn the_owner_and_platform_admins_are_protected() {
        let me = actor(1, &["Admin"], true);
        assert!(matches!(
            ensure_blockable(&me, &target(2, "User"), true, false, &[]),
            Err(AppError::Forbidden(_))
        ));
        assert!(matches!(
            ensure_blockable(&me, &target(2, "User"), false, true, &[]),
            Err(AppError::Forbidden(_))
        ));
    }

    #[test]
    fn an_officer_cannot_block_a_higher_role() {
        let roles = [
            role_row("Admin", 100),
            role_row("Officer", 50),
            role_row("User", 0),
        ];
        let officer = actor(1, &["Officer"], false);
        assert!(ensure_blockable(&officer, &target(2, "User"), false, false, &roles).is_ok());
        assert!(ensure_blockable(&officer, &target(2, "Officer"), false, false, &roles).is_ok());
        assert!(matches!(
            ensure_blockable(&officer, &target(2, "Admin"), false, false, &roles),
            Err(AppError::Forbidden(_))
        ));
        // The owner bypasses the priority rule.
        let owner = actor(1, &[], true);
        assert!(ensure_blockable(&owner, &target(2, "Admin"), false, false, &roles).is_ok());
    }
}
