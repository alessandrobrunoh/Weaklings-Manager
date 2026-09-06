//! HTTP routes for `/api/platform`.

use axum::{
    Extension, Json, Router,
    extract::Path,
    routing::{delete, get, post},
};

use crate::errors::{AppError, ProblemDetails};
use crate::platform_admins::PlatformAdmins;
use crate::responses::ApiResponse;
use crate::tenant::{ControlDb, TenantRegistry};

use super::PlatformAdmin;
use super::models::{
    AssignAdminRequest, CreateTenantRequest, PatchTenantRequest, PlatformAdminView,
    PutTenantFeaturesRequest, TenantFeaturesView, TenantView,
};
use super::service::PlatformService;

/// Control-plane router (no tenant `search_path`).
pub fn router() -> Router {
    Router::new()
        .route("/tenants", get(list_tenants).post(create_tenant))
        .route("/tenants/{id}", axum::routing::patch(patch_tenant))
        .route(
            "/tenants/{id}/features",
            get(get_features).put(put_features),
        )
        .route("/admins", get(list_admins).post(assign_admin))
        .route("/admins/{discord_id}", delete(revoke_admin))
        .route("/admins/reload", post(reload_admins))
}

/// List every registered tenant.
#[utoipa::path(
    get,
    path = "/api/platform/tenants",
    tag = "platform",
    responses(
        (status = 200, description = "Tenant list"),
        (status = 403, description = "Not a platform admin", body = ProblemDetails)
    )
)]
pub async fn list_tenants(
    _admin: PlatformAdmin,
    Extension(control): Extension<ControlDb>,
) -> Result<Json<ApiResponse<Vec<TenantView>>>, AppError> {
    Ok(Json(ApiResponse::new(
        PlatformService::list_tenants(&control.0).await?,
    )))
}

/// Provision a new tenant.
#[utoipa::path(
    post,
    path = "/api/platform/tenants",
    tag = "platform",
    responses(
        (status = 200, description = "Tenant created"),
        (status = 409, description = "Already exists", body = ProblemDetails)
    )
)]
pub async fn create_tenant(
    admin: PlatformAdmin,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Json(body): Json<CreateTenantRequest>,
) -> Result<Json<ApiResponse<TenantView>>, AppError> {
    Ok(Json(ApiResponse::new(
        PlatformService::create_tenant(&control.0, &registry, body, &admin.discord_id).await?,
    )))
}

/// Suspend, resume, or rename a tenant.
#[utoipa::path(
    patch,
    path = "/api/platform/tenants/{id}",
    tag = "platform",
    params(("id" = String, Path, description = "Tenant / Discord guild id")),
    responses((status = 200, description = "Updated tenant"))
)]
pub async fn patch_tenant(
    _admin: PlatformAdmin,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Path(id): Path<String>,
    Json(body): Json<PatchTenantRequest>,
) -> Result<Json<ApiResponse<TenantView>>, AppError> {
    Ok(Json(ApiResponse::new(
        PlatformService::patch_tenant(&control.0, &registry, &id, body).await?,
    )))
}

/// Feature catalog plus flags for one tenant.
#[utoipa::path(
    get,
    path = "/api/platform/tenants/{id}/features",
    tag = "platform",
    params(("id" = String, Path, description = "Tenant id")),
    responses((status = 200, description = "Feature flags"))
)]
pub async fn get_features(
    _admin: PlatformAdmin,
    Extension(control): Extension<ControlDb>,
    Path(id): Path<String>,
) -> Result<Json<ApiResponse<TenantFeaturesView>>, AppError> {
    Ok(Json(ApiResponse::new(
        PlatformService::get_features(&control.0, &id).await?,
    )))
}

/// Toggle feature flags for one tenant.
#[utoipa::path(
    put,
    path = "/api/platform/tenants/{id}/features",
    tag = "platform",
    params(("id" = String, Path, description = "Tenant id")),
    responses((status = 200, description = "Updated flags"))
)]
pub async fn put_features(
    admin: PlatformAdmin,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Path(id): Path<String>,
    Json(body): Json<PutTenantFeaturesRequest>,
) -> Result<Json<ApiResponse<TenantFeaturesView>>, AppError> {
    Ok(Json(ApiResponse::new(
        PlatformService::put_features(&control.0, &registry, &id, body, &admin.discord_id).await?,
    )))
}

/// List platform admins.
#[utoipa::path(
    get,
    path = "/api/platform/admins",
    tag = "platform",
    responses((status = 200, description = "Platform admins"))
)]
pub async fn list_admins(
    _admin: PlatformAdmin,
    Extension(control): Extension<ControlDb>,
) -> Result<Json<ApiResponse<Vec<PlatformAdminView>>>, AppError> {
    Ok(Json(ApiResponse::new(
        PlatformService::list_admins(&control.0).await?,
    )))
}

/// Grant SuperAdmin.
#[utoipa::path(
    post,
    path = "/api/platform/admins",
    tag = "platform",
    responses((status = 200, description = "Assignment saved"))
)]
pub async fn assign_admin(
    admin: PlatformAdmin,
    Extension(control): Extension<ControlDb>,
    Extension(cache): Extension<PlatformAdmins>,
    Json(body): Json<AssignAdminRequest>,
) -> Result<Json<ApiResponse<PlatformAdminView>>, AppError> {
    let view = PlatformService::assign_admin(&control.0, body, &admin.discord_id).await?;
    cache.reload(&control.0, None).await?;
    Ok(Json(ApiResponse::new(view)))
}

/// Revoke platform roles from a Discord user.
#[utoipa::path(
    delete,
    path = "/api/platform/admins/{discord_id}",
    tag = "platform",
    params(("discord_id" = String, Path, description = "Discord snowflake")),
    responses((status = 200, description = "Assignment removed"))
)]
pub async fn revoke_admin(
    admin: PlatformAdmin,
    Extension(control): Extension<ControlDb>,
    Extension(cache): Extension<PlatformAdmins>,
    Path(discord_id): Path<String>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    if discord_id == admin.discord_id {
        return Err(AppError::Validation(
            "cannot revoke your own platform role".to_owned(),
        ));
    }
    PlatformService::revoke_admin(&control.0, &discord_id).await?;
    cache.reload(&control.0, None).await?;
    Ok(Json(ApiResponse::new(())))
}

/// Reload the in-memory platform-admin set from the control-plane.
#[utoipa::path(
    post,
    path = "/api/platform/admins/reload",
    tag = "platform",
    responses((status = 200, description = "Cache reloaded"))
)]
pub async fn reload_admins(
    _admin: PlatformAdmin,
    Extension(cache): Extension<PlatformAdmins>,
    Extension(control): Extension<ControlDb>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    cache.reload(&control.0, None).await?;
    Ok(Json(ApiResponse::new(())))
}
