//! HTTP routes for publishing guild artifacts into the alliance tenant.

use axum::{
    Extension, Json, Router,
    extract::Path,
    http::StatusCode,
    routing::{get, post},
};
use sea_orm::DatabaseConnection;

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::responses::ApiResponse;
use crate::tenant::{ControlDb, CurrentTenantId, TenantRegistry};

use super::models::{
    AllianceShareStatusView, AllianceShareView, ArtifactType, CreateAllianceShareRequest,
};
use super::service::{AllianceShareService, ShareActor, ShareParams};

/// Router for `/api/alliance`.
pub fn router() -> Router {
    Router::new()
        .route("/shares", post(create_share))
        .route(
            "/shares/build/{id}",
            get(get_build_share).delete(unshare_build),
        )
        .route(
            "/shares/comp/{id}",
            get(get_comp_share).delete(unshare_comp),
        )
        .route(
            "/shares/split/{id}",
            get(get_split_share).delete(unshare_split),
        )
}

/// Publish a guild artifact snapshot into the alliance tenant schema.
#[utoipa::path(
    post,
    path = "/api/alliance/shares",
    tag = "alliance",
    request_body = CreateAllianceShareRequest,
    responses(
        (status = 200, description = "Snapshot published (or updated in place)", body = AllianceShareView),
        (status = 400, description = "Called from an alliance tenant", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Missing alliance.share", body = ProblemDetails),
        (status = 404, description = "Source artifact not found", body = ProblemDetails),
        (status = 409, description = "Guild is not an active alliance member", body = ProblemDetails)
    ),
    security(("session_cookie" = ["alliance.share"]))
)]
async fn create_share(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Json(req): Json<CreateAllianceShareRequest>,
) -> Result<Json<ApiResponse<AllianceShareView>>, AppError> {
    let authorized = user.has_permission(&perms, Permission::AllianceShare).await;
    let ctx = registry.get_or_load(&tenant_id).await?;
    let actor = ShareActor::from_user(&user);
    let params = ShareParams {
        source_tenant_id: &tenant_id,
        source_kind: &ctx.kind,
        actor: &actor,
        authorized,
    };
    let share = match req.artifact_type {
        ArtifactType::Build => {
            AllianceShareService::share_build(&control.0, &registry, &db, params, req).await?
        }
        ArtifactType::Comp => {
            AllianceShareService::share_comp(&control.0, &registry, &db, params, req).await?
        }
        ArtifactType::Split => {
            AllianceShareService::share_split(&control.0, &registry, &db, params, req).await?
        }
    };
    Ok(Json(ApiResponse::new(share)))
}

/// Whether this guild build is currently published into the alliance.
#[utoipa::path(
    get,
    path = "/api/alliance/shares/build/{id}",
    tag = "alliance",
    params(("id" = i64, Path, description = "Source build id")),
    responses(
        (status = 200, description = "Share status", body = AllianceShareStatusView),
        (status = 401, description = "Unauthorized", body = ProblemDetails)
    ),
    security(("session_cookie" = []))
)]
async fn get_build_share(
    _user: UserContext,
    Extension(control): Extension<ControlDb>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<AllianceShareStatusView>>, AppError> {
    Ok(Json(ApiResponse::new(
        AllianceShareService::build_share_status(&control.0, &tenant_id, id).await?,
    )))
}

/// Whether this guild composition is currently published into the alliance.
#[utoipa::path(
    get,
    path = "/api/alliance/shares/comp/{id}",
    tag = "alliance",
    params(("id" = i64, Path, description = "Source comp id")),
    responses(
        (status = 200, description = "Share status", body = AllianceShareStatusView),
        (status = 401, description = "Unauthorized", body = ProblemDetails)
    ),
    security(("session_cookie" = []))
)]
async fn get_comp_share(
    _user: UserContext,
    Extension(control): Extension<ControlDb>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<AllianceShareStatusView>>, AppError> {
    Ok(Json(ApiResponse::new(
        AllianceShareService::comp_share_status(&control.0, &tenant_id, id).await?,
    )))
}

/// Remove the published copy from the alliance schema and drop the mapping row.
#[utoipa::path(
    delete,
    path = "/api/alliance/shares/build/{id}",
    tag = "alliance",
    params(("id" = i64, Path, description = "Source build id")),
    responses(
        (status = 204, description = "Unshared"),
        (status = 400, description = "Called from an alliance tenant", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Missing alliance.share", body = ProblemDetails),
        (status = 404, description = "Share not found", body = ProblemDetails)
    ),
    security(("session_cookie" = ["alliance.share"]))
)]
async fn unshare_build(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let authorized = user.has_permission(&perms, Permission::AllianceShare).await;
    let ctx = registry.get_or_load(&tenant_id).await?;
    AllianceShareService::unshare_build(
        &control.0,
        &registry,
        ShareParams {
            source_tenant_id: &tenant_id,
            source_kind: &ctx.kind,
            actor: &ShareActor::from_user(&user),
            authorized,
        },
        id,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Remove the published composition from the alliance schema and drop the mapping row.
///
/// Previously shared referenced builds stay in the alliance schema.
#[utoipa::path(
    delete,
    path = "/api/alliance/shares/comp/{id}",
    tag = "alliance",
    params(("id" = i64, Path, description = "Source comp id")),
    responses(
        (status = 204, description = "Unshared"),
        (status = 400, description = "Called from an alliance tenant", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Missing alliance.share", body = ProblemDetails),
        (status = 404, description = "Share not found", body = ProblemDetails)
    ),
    security(("session_cookie" = ["alliance.share"]))
)]
async fn unshare_comp(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let authorized = user.has_permission(&perms, Permission::AllianceShare).await;
    let ctx = registry.get_or_load(&tenant_id).await?;
    AllianceShareService::unshare_comp(
        &control.0,
        &registry,
        ShareParams {
            source_tenant_id: &tenant_id,
            source_kind: &ctx.kind,
            actor: &ShareActor::from_user(&user),
            authorized,
        },
        id,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
/// Whether this guild split is currently published into the alliance.
#[utoipa::path(
    get,
    path = "/api/alliance/shares/split/{id}",
    tag = "alliance",
    params(("id" = i64, Path, description = "Source split id")),
    responses(
        (status = 200, description = "Share status", body = AllianceShareStatusView),
        (status = 401, description = "Unauthorized", body = ProblemDetails)
    ),
    security(("session_cookie" = []))
)]
async fn get_split_share(
    _user: UserContext,
    Extension(control): Extension<ControlDb>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<AllianceShareStatusView>>, AppError> {
    Ok(Json(ApiResponse::new(
        AllianceShareService::split_share_status(&control.0, &tenant_id, id).await?,
    )))
}

/// Remove the published split copy from the alliance schema and drop the mapping row.
#[utoipa::path(
    delete,
    path = "/api/alliance/shares/split/{id}",
    tag = "alliance",
    params(("id" = i64, Path, description = "Source split id")),
    responses(
        (status = 204, description = "Unshared"),
        (status = 400, description = "Called from an alliance tenant", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Missing alliance.share", body = ProblemDetails),
        (status = 404, description = "Share not found", body = ProblemDetails)
    ),
    security(("session_cookie" = ["alliance.share"]))
)]
async fn unshare_split(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let authorized = user.has_permission(&perms, Permission::AllianceShare).await;
    let ctx = registry.get_or_load(&tenant_id).await?;
    AllianceShareService::unshare_split(
        &control.0,
        &registry,
        ShareParams {
            source_tenant_id: &tenant_id,
            source_kind: &ctx.kind,
            actor: &ShareActor::from_user(&user),
            authorized,
        },
        id,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
