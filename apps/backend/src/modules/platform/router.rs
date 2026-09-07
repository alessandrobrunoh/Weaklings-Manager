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
    AssignAdminRequest, CreateRankRequest, CreateTenantRequest, FeatureCatalogItem,
    PatchRankRequest, PatchTenantRequest, PlatformAdminView, PutRankFeaturesRequest,
    PutTenantFeaturesRequest, TenantFeaturesView, TenantRankView, TenantView,
};
use super::service::PlatformService;

/// Control-plane router (no tenant `search_path`).
pub fn router() -> Router {
    Router::new()
        .route("/tenants", get(list_tenants).post(create_tenant))
        .route("/tenants/{id}", get(get_tenant).patch(patch_tenant))
        .route(
            "/tenants/{id}/features",
            get(get_features).put(put_features),
        )
        .route("/features", get(list_catalog))
        .route("/ranks", get(list_ranks).post(create_rank))
        .route(
            "/ranks/{id}",
            axum::routing::patch(patch_rank).delete(delete_rank),
        )
        .route(
            "/ranks/{id}/features",
            axum::routing::put(put_rank_features),
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

/// One tenant by Discord guild id.
#[utoipa::path(
    get,
    path = "/api/platform/tenants/{id}",
    tag = "platform",
    params(("id" = String, Path, description = "Tenant / Discord guild id")),
    responses(
        (status = 200, description = "Tenant"),
        (status = 404, description = "Not found", body = ProblemDetails)
    )
)]
pub async fn get_tenant(
    _admin: PlatformAdmin,
    Extension(control): Extension<ControlDb>,
    Path(id): Path<String>,
) -> Result<Json<ApiResponse<TenantView>>, AppError> {
    PlatformService::get_tenant(&control.0, &id)
        .await?
        .map(|row| Json(ApiResponse::new(row)))
        .ok_or_else(|| AppError::NotFound(format!("tenant {id} not found")))
}

/// Suspend, resume, rename, or edit tenant metadata.
#[utoipa::path(
    patch,
    path = "/api/platform/tenants/{id}",
    tag = "platform",
    params(("id" = String, Path, description = "Tenant / Discord guild id")),
    responses((status = 200, description = "Updated tenant"))
)]
pub async fn patch_tenant(
    admin: PlatformAdmin,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Path(id): Path<String>,
    Json(body): Json<PatchTenantRequest>,
) -> Result<Json<ApiResponse<TenantView>>, AppError> {
    Ok(Json(ApiResponse::new(
        PlatformService::patch_tenant(&control.0, &registry, &id, body, &admin.discord_id).await?,
    )))
}

/// Feature catalog (optional modules).
#[utoipa::path(
    get,
    path = "/api/platform/features",
    tag = "platform",
    responses((status = 200, description = "Feature catalog"))
)]
pub async fn list_catalog(
    _admin: PlatformAdmin,
    Extension(control): Extension<ControlDb>,
) -> Result<Json<ApiResponse<Vec<FeatureCatalogItem>>>, AppError> {
    Ok(Json(ApiResponse::new(
        PlatformService::list_catalog(&control.0).await?,
    )))
}

/// List platform-created tenant ranks.
#[utoipa::path(
    get,
    path = "/api/platform/ranks",
    tag = "platform",
    responses((status = 200, description = "Rank list"))
)]
pub async fn list_ranks(
    _admin: PlatformAdmin,
    Extension(control): Extension<ControlDb>,
) -> Result<Json<ApiResponse<Vec<TenantRankView>>>, AppError> {
    Ok(Json(ApiResponse::new(
        PlatformService::list_ranks(&control.0).await?,
    )))
}

/// Create a tenant rank with no features.
#[utoipa::path(
    post,
    path = "/api/platform/ranks",
    tag = "platform",
    responses((status = 200, description = "Rank created"))
)]
pub async fn create_rank(
    _admin: PlatformAdmin,
    Extension(control): Extension<ControlDb>,
    Json(body): Json<CreateRankRequest>,
) -> Result<Json<ApiResponse<TenantRankView>>, AppError> {
    Ok(Json(ApiResponse::new(
        PlatformService::create_rank(&control.0, body).await?,
    )))
}

/// Rename a tenant rank.
#[utoipa::path(
    patch,
    path = "/api/platform/ranks/{id}",
    tag = "platform",
    params(("id" = String, Path, description = "Rank id")),
    responses((status = 200, description = "Updated rank"))
)]
pub async fn patch_rank(
    _admin: PlatformAdmin,
    Extension(control): Extension<ControlDb>,
    Path(id): Path<String>,
    Json(body): Json<PatchRankRequest>,
) -> Result<Json<ApiResponse<TenantRankView>>, AppError> {
    Ok(Json(ApiResponse::new(
        PlatformService::patch_rank(&control.0, &id, body).await?,
    )))
}

/// Delete a tenant rank that is not assigned.
#[utoipa::path(
    delete,
    path = "/api/platform/ranks/{id}",
    tag = "platform",
    params(("id" = String, Path, description = "Rank id")),
    responses((status = 200, description = "Deleted"))
)]
pub async fn delete_rank(
    _admin: PlatformAdmin,
    Extension(control): Extension<ControlDb>,
    Path(id): Path<String>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    PlatformService::delete_rank(&control.0, &id).await?;
    Ok(Json(ApiResponse::new(())))
}

/// Replace the feature allowlist of a rank.
#[utoipa::path(
    put,
    path = "/api/platform/ranks/{id}/features",
    tag = "platform",
    params(("id" = String, Path, description = "Rank id")),
    responses((status = 200, description = "Updated rank"))
)]
pub async fn put_rank_features(
    admin: PlatformAdmin,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Path(id): Path<String>,
    Json(body): Json<PutRankFeaturesRequest>,
) -> Result<Json<ApiResponse<TenantRankView>>, AppError> {
    Ok(Json(ApiResponse::new(
        PlatformService::put_rank_features(&control.0, &registry, &id, body, &admin.discord_id)
            .await?,
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
        PlatformService::put_features(&control.0, &registry, &id, body, &admin.discord_id, false)
            .await?,
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
