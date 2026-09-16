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

use super::models::{AllianceShareStatusView, AllianceShareView, CreateAllianceShareRequest};
use super::service::{AllianceShareService, ShareActor, ShareParams};

/// Router for `/api/alliance`.
pub fn router() -> Router {
    Router::new().route("/shares", post(create_share)).route(
        "/shares/build/{id}",
        get(get_build_share).delete(unshare_build),
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
        (status = 400, description = "Called from an alliance tenant, or unsupported type", body = ProblemDetails),
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
    let share = AllianceShareService::share_build(
        &control.0,
        &registry,
        &db,
        ShareParams {
            source_tenant_id: &tenant_id,
            source_kind: &ctx.kind,
            actor: &ShareActor::from_user(&user),
            authorized,
        },
        req,
    )
    .await?;
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
