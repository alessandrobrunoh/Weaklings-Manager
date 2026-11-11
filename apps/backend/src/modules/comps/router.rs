//! Comp routing module.
//!
//! Exposes HTTP endpoints for managing build categories, comp categories, builds,
//! and comps (compositions of builds).

use axum::http::StatusCode;
use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::{get, patch, post, put},
};
use serde::Deserialize;
use std::str::FromStr;
use utoipa::IntoParams;

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::modules::comps::schemas::{
    ApiResponseBuildCategoryList, ApiResponseBuildDetail, ApiResponseCompCategoryList,
    ApiResponseCompDetail, ApiResponsePaginatedBuilds, ApiResponsePaginatedComps,
    PaginatedBuildSummary, PaginatedCompSummary,
};
use crate::modules::events::schemas::ApiResponseCompPerformance;
use crate::pagination::PaginationParams;
use crate::responses::ApiResponse;

use super::authority::{Authored, require_author_or_manage};
use super::models::{
    AddCompBuildRequest, BuildFilters, BuildItemSpells, CompFilters, CreateBuildCategoryRequest,
    CreateBuildRequest, CreateCompCategoryRequest, CreateCompRequest, UpdateBuildCategoryRequest,
    UpdateBuildRequest, UpdateCompBuildQuantityRequest, UpdateCompCategoryRequest,
    UpdateCompRequest, UpsertBuildItemRequest,
};
use super::price_cache::PriceCache;
use super::pricing::{cached_build_price, cached_comp_price, evict_build_prices};
use super::service::CompService;
use crate::modules::albiondata::service::AlbionDataService;
use crate::modules::combat::models::BuildItemPowerParams;
use crate::tenant::CurrentTenantId;

/// Selects which loadout of a build an item operation targets.
///
/// Omitting the parameter means the main loadout, so clients written before swaps existed keep
/// working unchanged.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
pub struct BuildItemLoadoutQuery {
    /// `main` (the default) or `swap`.
    pub loadout: Option<String>,
}

impl BuildItemLoadoutQuery {
    /// Resolves the requested loadout, rejecting a value the enum does not know.
    fn resolve(&self) -> Result<crate::modules::comps::status::BuildLoadout, AppError> {
        match self.loadout.as_deref() {
            None => Ok(crate::modules::comps::status::BuildLoadout::default()),
            Some(raw) => crate::modules::comps::status::BuildLoadout::from_str(raw)
                .map_err(AppError::Validation),
        }
    }
}

/// Router query parameters for listing builds, combining pagination and filtering.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct ListBuildsQuery {
    /// The page number to fetch (1-indexed). Defaults to 1.
    pub page: Option<u64>,
    /// The maximum number of items per page. Defaults to 10.
    pub limit: Option<u64>,
    /// The filter query parameters.
    #[serde(flatten)]
    pub filters: BuildFilters,
}

impl ListBuildsQuery {
    fn pagination(&self) -> PaginationParams {
        PaginationParams {
            page: self.page,
            limit: self.limit,
        }
    }
}

/// Router query parameters for listing comps, combining pagination and filtering.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct ListCompsQuery {
    /// The page number to fetch (1-indexed). Defaults to 1.
    pub page: Option<u64>,
    /// The maximum number of items per page. Defaults to 10.
    pub limit: Option<u64>,
    /// The filter query parameters.
    #[serde(flatten)]
    pub filters: CompFilters,
}

impl ListCompsQuery {
    fn pagination(&self) -> PaginationParams {
        PaginationParams {
            page: self.page,
            limit: self.limit,
        }
    }
}

/// Pins `created_by` to the current user when the query asked for `mine=true`.
fn apply_build_mine_filter(mut filters: BuildFilters, user_id: i64) -> BuildFilters {
    if filters.mine.unwrap_or(false) {
        filters.created_by = Some(user_id);
    }
    filters
}

/// Pins `created_by` to the current user when the query asked for `mine=true`.
fn apply_comp_mine_filter(mut filters: CompFilters, user_id: i64) -> CompFilters {
    if filters.mine.unwrap_or(false) {
        filters.created_by = Some(user_id);
    }
    filters
}

/// Creates the router for the comps module.
pub fn router() -> Router {
    Router::new()
        // Build categories
        .route(
            "/build-categories",
            get(list_build_categories).post(create_build_category),
        )
        .route(
            "/build-categories/{id}",
            patch(update_build_category).delete(delete_build_category),
        )
        // Comp categories
        .route(
            "/comp-categories",
            get(list_comp_categories).post(create_comp_category),
        )
        .route(
            "/comp-categories/{id}",
            patch(update_comp_category).delete(delete_comp_category),
        )
        // Builds
        .route("/builds", get(list_builds).post(create_build))
        .route(
            "/builds/{id}",
            get(get_build).patch(update_build).delete(delete_build),
        )
        .route(
            "/builds/{id}/items/{slot}",
            put(upsert_build_item).delete(remove_build_item),
        )
        .route(
            "/builds/{id}/items/{slot}/spells",
            put(set_build_item_spells),
        )
        .route("/builds/{id}/versions", post(create_build_version))
        .route("/builds/{id}/performance", get(get_build_performance))
        .route("/builds/{id}/item-power", get(get_build_item_power))
        .route("/builds/{id}/roster-fit", get(get_build_roster_fit))
        .route("/builds/{id}/price", get(get_build_price))
        .route("/{id}/readiness", get(get_comp_readiness))
        .route("/{id}/price", get(get_comp_price))
        .route("/builds/{id}/archive", post(archive_build))
        .route("/builds/{id}/unarchive", post(unarchive_build))
        // Comps
        .route("/", get(list_comps).post(create_comp))
        .route(
            "/{id}",
            get(get_comp).patch(update_comp).delete(delete_comp),
        )
        .route("/{id}/performance", get(get_comp_performance))
        .route("/{id}/versions", post(create_comp_version))
        .route("/{id}/archive", post(archive_comp))
        .route("/{id}/unarchive", post(unarchive_comp))
        .route("/{id}/builds", post(add_comp_build))
        .route(
            "/{id}/builds/{build_id}",
            patch(update_comp_build_quantity).delete(remove_comp_build),
        )
}

// ===== Build Categories =====

/// Lists all build categories.
///
/// Any authenticated user can list build categories.
#[utoipa::path(
    get,
    path = "/api/comps/build-categories",
    tag = "comps",
    summary = "List all build categories",
    description = "Returns a list of all build categories (DB-creatable groupings for builds). Any authenticated user can call this.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Build categories listed successfully", body = ApiResponseBuildCategoryList),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn list_build_categories(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<Vec<crate::modules::comps::models::BuildCategoryView>>>, AppError> {
    user.require(&perms, Permission::CompsBuildCategoriesView)
        .await?;
    let service = CompService::new();
    let categories = service.list_build_categories(&db).await?;
    Ok(Json(ApiResponse::new(categories)))
}

/// Creates a new build category.
///
/// Requires `comps.build_categories.manage` permission.
#[utoipa::path(
    post,
    path = "/api/comps/build-categories",
    tag = "comps",
    summary = "Create a new build category",
    description = "Creates a new build category. Requires `comps.build_categories.manage` permission.",
    security(("session_cookie" = [])),
    request_body(content = CreateBuildCategoryRequest, description = "Build category details"),
    responses(
        (status = 200, description = "Build category created successfully", body = ApiResponseBuildCategoryList),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks comps.build_categories.manage permission", body = ProblemDetails)
    )
)]
async fn create_build_category(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<CreateBuildCategoryRequest>,
) -> Result<Json<ApiResponse<Vec<crate::modules::comps::models::BuildCategoryView>>>, AppError> {
    user.require(&perms, Permission::CompsBuildCategoriesCreate)
        .await?;
    let service = CompService::new();
    let category = service.create_build_category(&db, req).await?;
    Ok(Json(ApiResponse::new(vec![category])))
}

/// Updates a build category.
///
/// Requires `comps.build_categories.manage` permission.
#[utoipa::path(
    patch,
    path = "/api/comps/build-categories/{id}",
    tag = "comps",
    summary = "Update a build category",
    description = "Updates an existing build category. Requires `comps.build_categories.manage` permission.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Build category ID")
    ),
    request_body(content = UpdateBuildCategoryRequest, description = "Updated build category details"),
    responses(
        (status = 200, description = "Build category updated successfully", body = ApiResponseBuildCategoryList),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks comps.build_categories.manage permission", body = ProblemDetails),
        (status = 404, description = "Build category not found", body = ProblemDetails)
    )
)]
async fn update_build_category(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<UpdateBuildCategoryRequest>,
) -> Result<Json<ApiResponse<Vec<crate::modules::comps::models::BuildCategoryView>>>, AppError> {
    user.require(&perms, Permission::CompsBuildCategoriesEdit)
        .await?;
    let service = CompService::new();
    let category = service.update_build_category(&db, id, req).await?;
    Ok(Json(ApiResponse::new(vec![category])))
}

/// Deletes a build category.
///
/// Requires `comps.build_categories.manage` permission.
/// Fails with 409 Conflict if any builds reference this category.
#[utoipa::path(
    delete,
    path = "/api/comps/build-categories/{id}",
    tag = "comps",
    summary = "Delete a build category",
    description = "Deletes a build category. Fails with 409 Conflict if any builds reference this category. Requires `comps.build_categories.manage` permission.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Build category ID")
    ),
    responses(
        (status = 204, description = "Build category deleted successfully"),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks comps.build_categories.manage permission", body = ProblemDetails),
        (status = 404, description = "Build category not found", body = ProblemDetails),
        (status = 409, description = "Conflict - builds reference this category", body = ProblemDetails)
    )
)]
async fn delete_build_category(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<StatusCode, AppError> {
    user.require(&perms, Permission::CompsBuildCategoriesDelete)
        .await?;
    let service = CompService::new();
    service.delete_build_category(&db, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ===== Comp Categories =====

/// Lists all comp categories.
///
/// Any authenticated user can list comp categories.
#[utoipa::path(
    get,
    path = "/api/comps/comp-categories",
    tag = "comps",
    summary = "List all comp categories",
    description = "Returns a list of all comp categories (DB-creatable groupings for comps). Any authenticated user can call this.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Comp categories listed successfully", body = ApiResponseCompCategoryList),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn list_comp_categories(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<Vec<crate::modules::comps::models::CompCategoryView>>>, AppError> {
    user.require(&perms, Permission::CompsCompCategoriesView)
        .await?;
    let service = CompService::new();
    let categories = service.list_comp_categories(&db).await?;
    Ok(Json(ApiResponse::new(categories)))
}

/// Creates a new comp category.
///
/// Requires `comps.comp_categories.manage` permission.
#[utoipa::path(
    post,
    path = "/api/comps/comp-categories",
    tag = "comps",
    summary = "Create a new comp category",
    description = "Creates a new comp category. Requires `comps.comp_categories.manage` permission.",
    security(("session_cookie" = [])),
    request_body(content = CreateCompCategoryRequest, description = "Comp category details"),
    responses(
        (status = 200, description = "Comp category created successfully", body = ApiResponseCompCategoryList),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks comps.comp_categories.manage permission", body = ProblemDetails)
    )
)]
async fn create_comp_category(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<CreateCompCategoryRequest>,
) -> Result<Json<ApiResponse<Vec<crate::modules::comps::models::CompCategoryView>>>, AppError> {
    user.require(&perms, Permission::CompsCompCategoriesCreate)
        .await?;
    let service = CompService::new();
    let category = service.create_comp_category(&db, req).await?;
    Ok(Json(ApiResponse::new(vec![category])))
}

/// Updates a comp category.
///
/// Requires `comps.comp_categories.manage` permission.
#[utoipa::path(
    patch,
    path = "/api/comps/comp-categories/{id}",
    tag = "comps",
    summary = "Update a comp category",
    description = "Updates an existing comp category. Requires `comps.comp_categories.manage` permission.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Comp category ID")
    ),
    request_body(content = UpdateCompCategoryRequest, description = "Updated comp category details"),
    responses(
        (status = 200, description = "Comp category updated successfully", body = ApiResponseCompCategoryList),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks comps.comp_categories.manage permission", body = ProblemDetails),
        (status = 404, description = "Comp category not found", body = ProblemDetails)
    )
)]
async fn update_comp_category(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<UpdateCompCategoryRequest>,
) -> Result<Json<ApiResponse<Vec<crate::modules::comps::models::CompCategoryView>>>, AppError> {
    user.require(&perms, Permission::CompsCompCategoriesEdit)
        .await?;
    let service = CompService::new();
    let category = service.update_comp_category(&db, id, req).await?;
    Ok(Json(ApiResponse::new(vec![category])))
}

/// Deletes a comp category.
///
/// Requires `comps.comp_categories.manage` permission.
/// Fails with 409 Conflict if any comps reference this category.
#[utoipa::path(
    delete,
    path = "/api/comps/comp-categories/{id}",
    tag = "comps",
    summary = "Delete a comp category",
    description = "Deletes a comp category. Fails with 409 Conflict if any comps reference this category. Requires `comps.comp_categories.manage` permission.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Comp category ID")
    ),
    responses(
        (status = 204, description = "Comp category deleted successfully"),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks comps.comp_categories.manage permission", body = ProblemDetails),
        (status = 404, description = "Comp category not found", body = ProblemDetails),
        (status = 409, description = "Conflict - comps reference this category", body = ProblemDetails)
    )
)]
async fn delete_comp_category(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<StatusCode, AppError> {
    user.require(&perms, Permission::CompsCompCategoriesDelete)
        .await?;
    let service = CompService::new();
    service.delete_comp_category(&db, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ===== Builds =====

/// Lists builds with pagination and filtering.
///
/// Any authenticated user can list builds.
#[utoipa::path(
    get,
    path = "/api/comps/builds",
    tag = "comps",
    summary = "List builds",
    description = "Returns a paginated list of builds with optional filtering by role, category, and name, plus sort (`name`, `role`, `created_at`) and order (`asc`|`desc`). Pass `mine=true` to restrict the list to builds created by the current user. Any authenticated user can call this.",
    security(("session_cookie" = [])),
    params(ListBuildsQuery),
    responses(
        (status = 200, description = "Builds listed successfully", body = ApiResponsePaginatedBuilds),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn list_builds(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(query): Query<ListBuildsQuery>,
) -> Result<Json<ApiResponse<PaginatedBuildSummary>>, AppError> {
    user.require(&perms, Permission::CompsBuildsView).await?;
    let service = CompService::new();
    let pagination = query.pagination();
    let filters = apply_build_mine_filter(query.filters.clone(), user.user_id);
    let paginated = service.list_builds(&db, filters, pagination).await?;
    Ok(Json(ApiResponse::new(paginated.into())))
}

/// Creates a new build.
///
/// Requires `comps.builds.create` permission.
#[utoipa::path(
    post,
    path = "/api/comps/builds",
    tag = "comps",
    summary = "Create a new build",
    description = "Creates a new build with optional items. Requires `comps.builds.create` permission.",
    security(("session_cookie" = [])),
    request_body(content = CreateBuildRequest, description = "Build details"),
    responses(
        (status = 200, description = "Build created successfully", body = ApiResponseBuildDetail),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks comps.builds.create permission", body = ProblemDetails),
        (status = 404, description = "Build category not found", body = ProblemDetails)
    )
)]
async fn create_build(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<CreateBuildRequest>,
) -> Result<Json<ApiResponse<crate::modules::comps::models::BuildDetail>>, AppError> {
    user.require(&perms, Permission::CompsBuildsCreate).await?;
    let service = CompService::new();
    let build = service.create_build(&db, user.user_id, req).await?;
    Ok(Json(ApiResponse::new(build)))
}

/// Gets a build by ID.
///
/// Any authenticated user can get a build.
#[utoipa::path(
    get,
    path = "/api/comps/builds/{id}",
    tag = "comps",
    summary = "Get a build",
    description = "Returns the full details of a build including its items. Any authenticated user can call this.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Build ID")
    ),
    responses(
        (status = 200, description = "Build retrieved successfully", body = ApiResponseBuildDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Build not found", body = ProblemDetails)
    )
)]
async fn get_build(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<crate::modules::comps::models::BuildDetail>>, AppError> {
    user.require(&perms, Permission::CompsBuildsView).await?;
    let service = CompService::new();
    let build = service.get_build(&db, id).await?;
    Ok(Json(ApiResponse::new(build)))
}

/// Updates a build.
///
/// Requires `comps.builds.edit` on a row you authored, or `comps.builds.manage` for anyone's.
#[utoipa::path(
    patch,
    path = "/api/comps/builds/{id}",
    tag = "comps",
    summary = "Update a build",
    description = "Updates an existing build. Requires `comps.builds.edit` on a row you authored, or `comps.builds.manage` for anyone's.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Build ID")
    ),
    request_body(content = UpdateBuildRequest, description = "Updated build details"),
    responses(
        (status = 200, description = "Build updated successfully", body = ApiResponseBuildDetail),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - not the author with comps.builds.edit, and lacks comps.builds.manage", body = ProblemDetails),
        (status = 404, description = "Build not found", body = ProblemDetails)
    )
)]
async fn update_build(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<UpdateBuildRequest>,
) -> Result<Json<ApiResponse<crate::modules::comps::models::BuildDetail>>, AppError> {
    require_author_or_manage(
        &user,
        &perms,
        &db,
        Authored::Build,
        id,
        Permission::CompsBuildsEdit,
    )
    .await?;
    let service = CompService::new();
    let build = service.update_build(&db, id, req).await?;
    Ok(Json(ApiResponse::new(build)))
}

/// Deletes a build.
///
/// Requires `comps.builds.delete` on a row you authored, or `comps.builds.manage` for anyone's.
/// Fails with 409 Conflict if any `comp_builds` reference this build.
#[utoipa::path(
    delete,
    path = "/api/comps/builds/{id}",
    tag = "comps",
    summary = "Delete a build",
    description = "Deletes a build. Fails with 409 Conflict if any comps, event rosters, or event participations still reference this build. Requires `comps.builds.delete` on a row you authored, or `comps.builds.manage` for anyone's.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Build ID")
    ),
    responses(
        (status = 204, description = "Build deleted successfully"),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - not the author with comps.builds.delete, and lacks comps.builds.manage", body = ProblemDetails),
        (status = 404, description = "Build not found", body = ProblemDetails),
        (status = 409, description = "Conflict - comp_builds reference this build", body = ProblemDetails)
    )
)]
async fn delete_build(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cache): Extension<PriceCache>,
    Extension(tenant): Extension<CurrentTenantId>,
) -> Result<StatusCode, AppError> {
    require_author_or_manage(
        &user,
        &perms,
        &db,
        Authored::Build,
        id,
        Permission::CompsBuildsDelete,
    )
    .await?;
    let service = CompService::new();
    service.delete_build(&db, id).await?;
    cache.invalidate_build(&tenant.0, id);
    Ok(StatusCode::NO_CONTENT)
}

/// Upserts a build item (insert or update on slot).
///
/// Requires `comps.builds.edit` on a row you authored, or `comps.builds.manage` for anyone's.
#[utoipa::path(
    put,
    path = "/api/comps/builds/{id}/items/{slot}",
    tag = "comps",
    summary = "Upsert a build item",
    description = "Inserts or updates a build item for a specific slot. Requires `comps.builds.edit` on a row you authored, or `comps.builds.manage` for anyone's.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Build ID"),
        ("slot" = crate::modules::comps::status::BuildSlot, Path, description = "Equipment slot"),
        BuildItemLoadoutQuery
    ),
    request_body(content = UpsertBuildItemRequest, description = "Item details"),
    responses(
        (status = 200, description = "Build item upserted successfully", body = ApiResponseBuildDetail),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - not the author with comps.builds.edit, and lacks comps.builds.manage", body = ProblemDetails),
        (status = 404, description = "Build not found", body = ProblemDetails)
    )
)]
#[allow(clippy::too_many_arguments)]
async fn upsert_build_item(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path((id, slot)): Path<(i64, String)>,
    Query(loadout): Query<BuildItemLoadoutQuery>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cache): Extension<PriceCache>,
    Extension(tenant): Extension<CurrentTenantId>,
    Json(req): Json<UpsertBuildItemRequest>,
) -> Result<Json<ApiResponse<crate::modules::comps::models::BuildDetail>>, AppError> {
    require_author_or_manage(
        &user,
        &perms,
        &db,
        Authored::Build,
        id,
        Permission::CompsBuildsEdit,
    )
    .await?;
    let slot =
        crate::modules::comps::status::BuildSlot::from_str(&slot).map_err(AppError::Validation)?;
    let loadout = loadout.resolve()?;
    let service = CompService::new();
    let result = service.upsert_build_item(&db, id, loadout, slot, req).await;
    evict_build_prices(&cache, &db, &tenant.0, id).await;
    Ok(Json(ApiResponse::new(result?)))
}

/// Removes a build item.
///
/// Requires `comps.builds.edit` on a row you authored, or `comps.builds.manage` for anyone's.
#[utoipa::path(
    delete,
    path = "/api/comps/builds/{id}/items/{slot}",
    tag = "comps",
    summary = "Remove a build item",
    description = "Removes a build item from a specific slot. Requires `comps.builds.edit` on a row you authored, or `comps.builds.manage` for anyone's.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Build ID"),
        ("slot" = crate::modules::comps::status::BuildSlot, Path, description = "Equipment slot"),
        BuildItemLoadoutQuery
    ),
    responses(
        (status = 204, description = "Build item removed successfully"),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - not the author with comps.builds.edit, and lacks comps.builds.manage", body = ProblemDetails)
    )
)]
async fn remove_build_item(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path((id, slot)): Path<(i64, String)>,
    Query(loadout): Query<BuildItemLoadoutQuery>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cache): Extension<PriceCache>,
    Extension(tenant): Extension<CurrentTenantId>,
) -> Result<StatusCode, AppError> {
    require_author_or_manage(
        &user,
        &perms,
        &db,
        Authored::Build,
        id,
        Permission::CompsBuildsEdit,
    )
    .await?;
    let slot =
        crate::modules::comps::status::BuildSlot::from_str(&slot).map_err(AppError::Validation)?;
    let loadout = loadout.resolve()?;
    let service = CompService::new();
    let result = service.remove_build_item(&db, id, loadout, slot).await;
    evict_build_prices(&cache, &db, &tenant.0, id).await;
    result?;
    Ok(StatusCode::NO_CONTENT)
}

/// Replaces the abilities chosen on one equipped item.
///
/// Requires `comps.builds.edit` on a row you authored, or `comps.builds.manage` for anyone's.
#[utoipa::path(
    put,
    path = "/api/comps/builds/{id}/items/{slot}/spells",
    tag = "comps",
    summary = "Set the abilities on a build item",
    description = "Replaces every ability chosen on the item in this slot. A slot the body omits is \
                   cleared, so the result is atomic. Each choice is validated against what the \
                   equipped item actually offers — see `GET /api/openalbion/abilities`. Requires \
                   Requires `comps.builds.edit` on a row you authored, or `comps.builds.manage` for anyone's.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Build ID"),
        ("slot" = crate::modules::comps::status::BuildSlot, Path, description = "Equipment slot"),
        BuildItemLoadoutQuery
    ),
    request_body = BuildItemSpells,
    responses(
        (status = 200, description = "Abilities saved", body = ApiResponseBuildDetail),
        (status = 400, description = "An ability the item does not offer", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - not the author with comps.builds.edit, and lacks comps.builds.manage", body = ProblemDetails),
        (status = 404, description = "The slot holds no item", body = ProblemDetails)
    )
)]
#[allow(clippy::too_many_arguments)]
async fn set_build_item_spells(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path((id, slot)): Path<(i64, String)>,
    Query(loadout): Query<BuildItemLoadoutQuery>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cache): Extension<PriceCache>,
    Extension(tenant): Extension<CurrentTenantId>,
    Json(req): Json<BuildItemSpells>,
) -> Result<Json<ApiResponse<crate::modules::comps::models::BuildDetail>>, AppError> {
    require_author_or_manage(
        &user,
        &perms,
        &db,
        Authored::Build,
        id,
        Permission::CompsBuildsEdit,
    )
    .await?;
    let slot =
        crate::modules::comps::status::BuildSlot::from_str(&slot).map_err(AppError::Validation)?;
    let loadout = loadout.resolve()?;
    let service = CompService::new();
    let result = service
        .set_build_item_spells(&db, id, loadout, slot, req)
        .await;
    evict_build_prices(&cache, &db, &tenant.0, id).await;
    Ok(Json(ApiResponse::new(result?)))
}

/// Creates the next version of a build.
///
/// Requires `comps.builds.create` and authorship of the source (a version joins its author's version group), or `comps.builds.manage` for anyone's.
#[utoipa::path(
    post,
    path = "/api/comps/builds/{id}/versions",
    tag = "comps",
    summary = "Create the next version of a build",
    description = "Copies the build — both loadouts, every item and every ability choice — into a \
                   new version that can be edited independently. Name and category are inherited, \
                   since they identify the version group. Requires `comps.builds.create` and authorship of the source (a version joins its author's version group), or `comps.builds.manage` for anyone's.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "The build version to copy")),
    responses(
        (status = 200, description = "The new version", body = ApiResponseBuildDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - not the source's author with comps.builds.create, and lacks comps.builds.manage", body = ProblemDetails),
        (status = 404, description = "Build not found", body = ProblemDetails),
        (status = 409, description = "A concurrent request claimed the version number", body = ProblemDetails)
    )
)]
async fn create_build_version(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<crate::modules::comps::models::BuildDetail>>, AppError> {
    require_author_or_manage(
        &user,
        &perms,
        &db,
        Authored::Build,
        id,
        Permission::CompsBuildsCreate,
    )
    .await?;
    let service = CompService::new();
    let build = service.create_build_version(&db, id, user.user_id).await?;
    Ok(Json(ApiResponse::new(build)))
}

/// Archives a build, taking it out of pickers without touching anything that already uses it.
///
/// Requires `comps.builds.delete` on a row you authored, or `comps.builds.manage` for anyone's.
#[utoipa::path(
    post,
    path = "/api/comps/builds/{id}/archive",
    tag = "comps",
    summary = "Archive a build",
    description = "Marks a build archived: it drops out of the default `list_builds` results and \
                   every picker, but the row and everything already referencing it (comps, event \
                   rosters, past participations) is untouched. Unlike delete, this never fails on \
                   references. Requires `comps.builds.delete` on a row you authored, or `comps.builds.manage` for anyone's.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Build ID")),
    responses(
        (status = 200, description = "Build archived successfully", body = ApiResponseBuildDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - not the author with comps.builds.delete, and lacks comps.builds.manage", body = ProblemDetails),
        (status = 404, description = "Build not found", body = ProblemDetails)
    )
)]
pub(crate) async fn archive_build(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<crate::modules::comps::models::BuildDetail>>, AppError> {
    require_author_or_manage(
        &user,
        &perms,
        &db,
        Authored::Build,
        id,
        Permission::CompsBuildsDelete,
    )
    .await?;
    let service = CompService::new();
    let build = service.archive_build(&db, id).await?;
    Ok(Json(ApiResponse::new(build)))
}

/// Unarchives a build, making it selectable again.
///
/// Requires `comps.builds.delete` on a row you authored, or `comps.builds.manage` for anyone's.
#[utoipa::path(
    post,
    path = "/api/comps/builds/{id}/unarchive",
    tag = "comps",
    summary = "Unarchive a build",
    description = "Reverses archiving: the build reappears in `list_builds` and every picker. \
                   Requires `comps.builds.delete` on a row you authored, or `comps.builds.manage` for anyone's.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Build ID")),
    responses(
        (status = 200, description = "Build unarchived successfully", body = ApiResponseBuildDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - not the author with comps.builds.delete, and lacks comps.builds.manage", body = ProblemDetails),
        (status = 404, description = "Build not found", body = ProblemDetails)
    )
)]
pub(crate) async fn unarchive_build(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<crate::modules::comps::models::BuildDetail>>, AppError> {
    require_author_or_manage(
        &user,
        &perms,
        &db,
        Authored::Build,
        id,
        Permission::CompsBuildsDelete,
    )
    .await?;
    let service = CompService::new();
    let build = service.unarchive_build(&db, id).await?;
    Ok(Json(ApiResponse::new(build)))
}

// ===== Comps =====

/// Lists comps with pagination and filtering.
///
/// Any authenticated user can list comps.
#[utoipa::path(
    get,
    path = "/api/comps",
    tag = "comps",
    summary = "List comps",
    description = "Returns a paginated list of comps with optional filtering by category and name, plus sort (`name`, `created_at`, `category`) and order (`asc`|`desc`). Pass `mine=true` to restrict the list to comps created by the current user. Any authenticated user can call this.",
    security(("session_cookie" = [])),
    params(ListCompsQuery),
    responses(
        (status = 200, description = "Comps listed successfully", body = ApiResponsePaginatedComps),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn list_comps(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(query): Query<ListCompsQuery>,
) -> Result<Json<ApiResponse<PaginatedCompSummary>>, AppError> {
    user.require(&perms, Permission::CompsCompsView).await?;
    let service = CompService::new();
    let pagination = query.pagination();
    let filters = apply_comp_mine_filter(query.filters.clone(), user.user_id);
    let paginated = service.list_comps(&db, filters, pagination).await?;
    Ok(Json(ApiResponse::new(paginated.into())))
}

/// Creates a new comp.
///
/// Requires `comps.comps.create` permission.
#[utoipa::path(
    post,
    path = "/api/comps",
    tag = "comps",
    summary = "Create a new comp",
    description = "Creates a new comp with its associated builds. Requires `comps.comps.create` permission.",
    security(("session_cookie" = [])),
    request_body(content = CreateCompRequest, description = "Comp details"),
    responses(
        (status = 200, description = "Comp created successfully", body = ApiResponseCompDetail),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks comps.comps.create permission", body = ProblemDetails),
        (status = 404, description = "Comp category or build not found", body = ProblemDetails)
    )
)]
async fn create_comp(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(req): Json<CreateCompRequest>,
) -> Result<Json<ApiResponse<crate::modules::comps::models::CompDetail>>, AppError> {
    user.require(&perms, Permission::CompsCompsCreate).await?;
    let service = CompService::new();
    let comp = service.create_comp(&db, user.user_id, req).await?;
    Ok(Json(ApiResponse::new(comp)))
}

/// Gets a comp by ID.
///
/// Any authenticated user can get a comp.
#[utoipa::path(
    get,
    path = "/api/comps/{id}",
    tag = "comps",
    summary = "Get a comp",
    description = "Returns the full details of a comp including its builds. Any authenticated user can call this.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Comp ID")
    ),
    responses(
        (status = 200, description = "Comp retrieved successfully", body = ApiResponseCompDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Comp not found", body = ProblemDetails)
    )
)]
async fn get_comp(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<crate::modules::comps::models::CompDetail>>, AppError> {
    user.require(&perms, Permission::CompsCompsView).await?;
    let service = CompService::new();
    let comp = service.get_comp(&db, id).await?;
    Ok(Json(ApiResponse::new(comp)))
}

/// Gets linked-event performance for a comp.
///
/// Any authenticated user can inspect these analytics because they are derived
/// from event and battle data already visible to guild members.
#[utoipa::path(
    get,
    path = "/api/comps/{id}/performance",
    tag = "comps",
    summary = "Get comp performance analytics",
    description = "Aggregates win/loss, K/D, kill fame and opponent performance from battles linked to events using this comp.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Comp ID")),
    responses(
        (status = 200, description = "Comp performance retrieved successfully", body = ApiResponseCompPerformance),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Comp not found", body = ProblemDetails)
    )
)]
async fn get_comp_performance(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<crate::modules::events::models::CompPerformanceView>>, AppError> {
    user.require(&perms, Permission::CompsCompsView).await?;
    let service = crate::modules::events::service::EventService::new();
    let performance = service.get_comp_performance(&db, id).await?;
    Ok(Json(ApiResponse::new(performance)))
}

/// Updates a comp.
///
/// Requires `comps.comps.edit` on a row you authored, or `comps.comps.manage` for anyone's.
#[utoipa::path(
    patch,
    path = "/api/comps/{id}",
    tag = "comps",
    summary = "Update a comp",
    description = "Updates an existing comp. Requires `comps.comps.edit` on a row you authored, or `comps.comps.manage` for anyone's.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Comp ID")
    ),
    request_body(content = UpdateCompRequest, description = "Updated comp details"),
    responses(
        (status = 200, description = "Comp updated successfully", body = ApiResponseCompDetail),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - not the author with comps.comps.edit, and lacks comps.comps.manage", body = ProblemDetails),
        (status = 404, description = "Comp not found", body = ProblemDetails)
    )
)]
async fn update_comp(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cache): Extension<PriceCache>,
    Extension(tenant): Extension<CurrentTenantId>,
    Json(req): Json<UpdateCompRequest>,
) -> Result<Json<ApiResponse<crate::modules::comps::models::CompDetail>>, AppError> {
    require_author_or_manage(
        &user,
        &perms,
        &db,
        Authored::Comp,
        id,
        Permission::CompsCompsEdit,
    )
    .await?;
    let service = CompService::new();
    let result = service.update_comp(&db, id, req).await;
    cache.invalidate_comp(&tenant.0, id);
    Ok(Json(ApiResponse::new(result?)))
}

/// Deletes a comp (cascades to `comp_builds` via FK).
///
/// Requires `comps.comps.delete` on a row you authored, or `comps.comps.manage` for anyone's.
#[utoipa::path(
    delete,
    path = "/api/comps/{id}",
    tag = "comps",
    summary = "Delete a comp",
    description = "Deletes a comp. Cascades to comp_builds via FK. Requires `comps.comps.delete` on a row you authored, or `comps.comps.manage` for anyone's.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Comp ID")
    ),
    responses(
        (status = 204, description = "Comp deleted successfully"),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - not the author with comps.comps.delete, and lacks comps.comps.manage", body = ProblemDetails),
        (status = 404, description = "Comp not found", body = ProblemDetails),
        (status = 409, description = "Comp is still linked to one or more events", body = ProblemDetails)
    )
)]
async fn delete_comp(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cache): Extension<PriceCache>,
    Extension(tenant): Extension<CurrentTenantId>,
) -> Result<StatusCode, AppError> {
    require_author_or_manage(
        &user,
        &perms,
        &db,
        Authored::Comp,
        id,
        Permission::CompsCompsDelete,
    )
    .await?;
    let service = CompService::new();
    service.delete_comp(&db, id).await?;
    cache.invalidate_comp(&tenant.0, id);
    Ok(StatusCode::NO_CONTENT)
}

/// Adds a build to a comp (upsert on (`comp_id`, `build_id`)).
///
/// Requires `comps.comps.edit` on a row you authored, or `comps.comps.manage` for anyone's.
/// If the build already exists in the comp, its quantity is updated to the new value.
#[utoipa::path(
    post,
    path = "/api/comps/{id}/builds",
    tag = "comps",
    summary = "Add a build to a comp",
    description = "Adds a build to a comp. If the build already exists, its quantity is updated to the new value. Requires `comps.comps.edit` on a row you authored, or `comps.comps.manage` for anyone's.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Comp ID")
    ),
    request_body(content = AddCompBuildRequest, description = "Build to add with quantity"),
    responses(
        (status = 200, description = "Build added successfully", body = ApiResponseCompDetail),
        (status = 400, description = "Validation error - quantity must be >= 1", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - not the author with comps.comps.edit, and lacks comps.comps.manage", body = ProblemDetails),
        (status = 404, description = "Comp or build not found", body = ProblemDetails)
    )
)]
async fn add_comp_build(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cache): Extension<PriceCache>,
    Extension(tenant): Extension<CurrentTenantId>,
    Json(req): Json<AddCompBuildRequest>,
) -> Result<Json<ApiResponse<crate::modules::comps::models::CompDetail>>, AppError> {
    require_author_or_manage(
        &user,
        &perms,
        &db,
        Authored::Comp,
        id,
        Permission::CompsCompsEdit,
    )
    .await?;
    let service = CompService::new();
    let result = service.add_comp_build(&db, id, req).await;
    cache.invalidate_comp(&tenant.0, id);
    Ok(Json(ApiResponse::new(result?)))
}

/// Updates a comp build quantity.
///
/// Requires `comps.comps.edit` on a row you authored, or `comps.comps.manage` for anyone's.
#[utoipa::path(
    patch,
    path = "/api/comps/{id}/builds/{build_id}",
    tag = "comps",
    summary = "Update comp build quantity",
    description = "Updates the quantity of a build within a comp. Requires `comps.comps.edit` on a row you authored, or `comps.comps.manage` for anyone's.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Comp ID"),
        ("build_id" = i64, Path, description = "Build ID")
    ),
    request_body(content = UpdateCompBuildQuantityRequest, description = "New quantity"),
    responses(
        (status = 200, description = "Quantity updated successfully", body = ApiResponseCompDetail),
        (status = 400, description = "Validation error - quantity must be >= 1", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - not the author with comps.comps.edit, and lacks comps.comps.manage", body = ProblemDetails),
        (status = 404, description = "Comp build not found", body = ProblemDetails)
    )
)]
async fn update_comp_build_quantity(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path((id, build_id)): Path<(i64, i64)>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cache): Extension<PriceCache>,
    Extension(tenant): Extension<CurrentTenantId>,
    Json(req): Json<UpdateCompBuildQuantityRequest>,
) -> Result<Json<ApiResponse<crate::modules::comps::models::CompDetail>>, AppError> {
    require_author_or_manage(
        &user,
        &perms,
        &db,
        Authored::Comp,
        id,
        Permission::CompsCompsEdit,
    )
    .await?;
    let service = CompService::new();
    let result = service
        .update_comp_build_quantity(&db, id, build_id, req)
        .await;
    cache.invalidate_comp(&tenant.0, id);
    Ok(Json(ApiResponse::new(result?)))
}

/// Removes a build from a comp.
///
/// Requires `comps.comps.edit` on a row you authored, or `comps.comps.manage` for anyone's.
#[utoipa::path(
    delete,
    path = "/api/comps/{id}/builds/{build_id}",
    tag = "comps",
    summary = "Remove a build from a comp",
    description = "Removes a build from a comp. Requires `comps.comps.edit` on a row you authored, or `comps.comps.manage` for anyone's.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Comp ID"),
        ("build_id" = i64, Path, description = "Build ID")
    ),
    responses(
        (status = 204, description = "Build removed successfully"),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - not the author with comps.comps.edit, and lacks comps.comps.manage", body = ProblemDetails),
        (status = 404, description = "Comp build not found", body = ProblemDetails)
    )
)]
async fn remove_comp_build(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path((id, build_id)): Path<(i64, i64)>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cache): Extension<PriceCache>,
    Extension(tenant): Extension<CurrentTenantId>,
) -> Result<StatusCode, AppError> {
    require_author_or_manage(
        &user,
        &perms,
        &db,
        Authored::Comp,
        id,
        Permission::CompsCompsEdit,
    )
    .await?;
    let service = CompService::new();
    let result = service.remove_comp_build(&db, id, build_id).await;
    cache.invalidate_comp(&tenant.0, id);
    result?;
    Ok(StatusCode::NO_CONTENT)
}

/// Creates the next version of a comp.
///
/// Requires `comps.comps.create` and authorship of the source (a version joins its author's version group), or `comps.comps.manage` for anyone's.
#[utoipa::path(
    post,
    path = "/api/comps/{id}/versions",
    tag = "comps",
    summary = "Create the next version of a composition",
    description = "Copies the composition and every build entry with its quantity into a new \
                   version that can be edited independently. `parent_id` is preserved, so a \
                   version of a variant stays a variant of the same parent. Each version's \
                   statistics come from `GET /api/comps/{id}/performance` for that version's id. \
                   Requires `comps.comps.create` and authorship of the source (a version joins its author's version group), or `comps.comps.manage` for anyone's.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "The comp version to copy")),
    responses(
        (status = 200, description = "The new version", body = ApiResponseCompDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - not the source's author with comps.comps.create, and lacks comps.comps.manage", body = ProblemDetails),
        (status = 404, description = "Comp not found", body = ProblemDetails),
        (status = 409, description = "A concurrent request claimed the version number", body = ProblemDetails)
    )
)]
async fn create_comp_version(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<crate::modules::comps::models::CompDetail>>, AppError> {
    require_author_or_manage(
        &user,
        &perms,
        &db,
        Authored::Comp,
        id,
        Permission::CompsCompsCreate,
    )
    .await?;
    let service = CompService::new();
    let comp = service.create_comp_version(&db, id, user.user_id).await?;
    Ok(Json(ApiResponse::new(comp)))
}

/// Archives a comp, taking it out of pickers without touching anything that already uses it.
///
/// Requires `comps.comps.delete` on a row you authored, or `comps.comps.manage` for anyone's.
#[utoipa::path(
    post,
    path = "/api/comps/{id}/archive",
    tag = "comps",
    summary = "Archive a comp",
    description = "Marks a comp archived: it drops out of the default `list_comps` results and \
                   every picker, but the row and everything already referencing it (events, child \
                   variants) is untouched. Unlike delete, this never fails on references. Requires \
                   Requires `comps.comps.delete` on a row you authored, or `comps.comps.manage` for anyone's.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Comp ID")),
    responses(
        (status = 200, description = "Comp archived successfully", body = ApiResponseCompDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - not the author with comps.comps.delete, and lacks comps.comps.manage", body = ProblemDetails),
        (status = 404, description = "Comp not found", body = ProblemDetails)
    )
)]
pub(crate) async fn archive_comp(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<crate::modules::comps::models::CompDetail>>, AppError> {
    require_author_or_manage(
        &user,
        &perms,
        &db,
        Authored::Comp,
        id,
        Permission::CompsCompsDelete,
    )
    .await?;
    let service = CompService::new();
    let comp = service.archive_comp(&db, id).await?;
    Ok(Json(ApiResponse::new(comp)))
}

/// Unarchives a comp, making it selectable again.
///
/// Requires `comps.comps.delete` on a row you authored, or `comps.comps.manage` for anyone's.
#[utoipa::path(
    post,
    path = "/api/comps/{id}/unarchive",
    tag = "comps",
    summary = "Unarchive a comp",
    description = "Reverses archiving: the comp reappears in `list_comps` and every picker. \
                   Requires `comps.comps.delete` on a row you authored, or `comps.comps.manage` for anyone's.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Comp ID")),
    responses(
        (status = 200, description = "Comp unarchived successfully", body = ApiResponseCompDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - not the author with comps.comps.delete, and lacks comps.comps.manage", body = ProblemDetails),
        (status = 404, description = "Comp not found", body = ProblemDetails)
    )
)]
pub(crate) async fn unarchive_comp(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<crate::modules::comps::models::CompDetail>>, AppError> {
    require_author_or_manage(
        &user,
        &perms,
        &db,
        Authored::Comp,
        id,
        Permission::CompsCompsDelete,
    )
    .await?;
    let service = CompService::new();
    let comp = service.unarchive_comp(&db, id).await?;
    Ok(Json(ApiResponse::new(comp)))
}

/// Query parameters for a comp's readiness roll-up.
#[derive(Debug, Clone, Default, serde::Deserialize, IntoParams)]
pub struct CompReadinessParams {
    /// Score against this event's participants rather than every specialised member.
    #[serde(default)]
    pub event_id: Option<i64>,
}

/// Reports whether a composition can actually be fielded, and where it is weakest.
#[utoipa::path(
    get,
    path = "/api/comps/{id}/readiness",
    tag = "comps",
    summary = "Get a composition's readiness roll-up",
    description = "For every seat the comp defines, finds the best-scoring candidate in the pool \
                   and rolls the result up to comp level: average Item Power now vs. at the \
                   ceiling, the weakest seats, per-build bench depth, and which seats nobody can \
                   currently fill. Pass `event_id` to score against that event's sign-ups instead \
                   of every specialised member in the guild. When `event_id` is given and that \
                   event's fights have a computed analytics rollup, the response also carries \
                   `observed`: the average Item Power the roster that actually fought turned out \
                   to have, and its delta against the prediction. `observed` is `None` — not an \
                   error — when no `event_id` was given, or that event has no analyzed fights yet.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Comp ID"), CompReadinessParams),
    responses(
        (status = 200, description = "Readiness roll-up", body = crate::modules::combat::schemas::ApiResponseCompReadinessView),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing combat.readiness.view", body = ProblemDetails),
        (status = 404, description = "Comp not found", body = ProblemDetails)
    )
)]
async fn get_comp_readiness(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Query(params): Query<CompReadinessParams>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<crate::modules::combat::models::CompReadinessView>>, AppError> {
    user.require(&perms, Permission::CombatReadinessView)
        .await?;
    let readiness = crate::modules::combat::service::CombatService::new()
        .comp_readiness(&db, id, params.event_id)
        .await?;
    Ok(Json(ApiResponse::new(readiness)))
}

/// Returns the Item Power of a build, optionally scored with one member's specialization.
///
/// Reading a build is enough: the figure is a property of the build plus whichever levels the
/// caller asks for, and both are already visible to anyone who can open the build.
#[utoipa::path(
    get,
    path = "/api/comps/builds/{id}/item-power",
    tag = "comps",
    summary = "Calculate a build's Item Power",
    description = "Item Power = base(tier, enchantment) + quality bonus + Destiny Board bonuses. \
                   Pass `spec=max` for the build's ceiling, `spec=current` with a `user_id` for \
                   what one member would actually field, or `spec=fixed` with a `level` to compare \
                   builds rather than people. Every contribution is itemised, so each point traces \
                   back to the node that granted it.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Build version ID"), BuildItemPowerParams),
    responses(
        (status = 200, description = "Item Power breakdown", body = crate::modules::combat::schemas::ApiResponseItemPower),
        (status = 400, description = "Unusable specialization source", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Build not found", body = ProblemDetails)
    )
)]
async fn get_build_item_power(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Query(params): Query<BuildItemPowerParams>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<crate::modules::combat::models::ItemPowerView>>, AppError> {
    user.require(&perms, Permission::CompsBuildsView).await?;
    let loadout = crate::modules::combat::service::parse_loadout(params.loadout.as_deref())?;
    let view = crate::modules::combat::service::CombatService::new()
        .build_item_power(
            &db,
            id,
            loadout,
            params.spec.unwrap_or_default(),
            params.user_id,
            params.level,
        )
        .await?;
    Ok(Json(ApiResponse::new(view)))
}

/// Scores every member with a recorded specialization against one build, best first.
///
/// Gated on the readiness permission rather than on build viewing: it reports on the whole guild
/// at once, which is a different thing from a member working out their own Item Power.
#[utoipa::path(
    get,
    path = "/api/comps/builds/{id}/roster-fit",
    tag = "comps",
    summary = "Rank the roster against a build",
    description = "Returns every member with any recorded Destiny Board level, scored on this \
                   build and sorted by Item Power descending — the answer to \"who should fly \
                   this?\". `blocking_nodes` names, per member, the specializations that would \
                   gain them the most Item Power, so the list doubles as a training plan.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Build version ID"), BuildItemPowerParams),
    responses(
        (status = 200, description = "Members ranked against the build", body = crate::modules::combat::schemas::ApiResponseBuildRosterFit),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing combat.readiness.view", body = ProblemDetails),
        (status = 404, description = "Build not found", body = ProblemDetails)
    )
)]
async fn get_build_roster_fit(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Query(params): Query<BuildItemPowerParams>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<crate::modules::combat::models::BuildRosterFitView>>, AppError> {
    user.require(&perms, Permission::CombatReadinessView)
        .await?;
    let loadout = crate::modules::combat::service::parse_loadout(params.loadout.as_deref())?;
    let view = crate::modules::combat::service::CombatService::new()
        .build_roster_fit(&db, id, loadout)
        .await?;
    Ok(Json(ApiResponse::new(view)))
}

/// Returns how one build version has performed.
///
/// Any authenticated user can read build performance.
#[utoipa::path(
    get,
    path = "/api/comps/builds/{id}/performance",
    tag = "comps",
    summary = "Get a build version's battle performance",
    description = "Attributes battle numbers to the players who actually ran this build version, \
                   by matching sign-ups to the per-player rows in the stored battle snapshots \
                   through their linked Albion character name. `stats` is null — not zeroed — when \
                   the version has no battle data, so 'never used' stays distinguishable from \
                   'lost every time'. `players_without_an_albion_link` and \
                   `stats.matched_players` report the coverage behind the numbers.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Build version ID")),
    responses(
        (status = 200, description = "Build performance", body = crate::modules::events::schemas::ApiResponseBuildPerformance),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Build not found", body = ProblemDetails)
    )
)]
async fn get_build_performance(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<crate::modules::events::models::BuildPerformanceView>>, AppError> {
    user.require(&perms, Permission::CompsBuildsView).await?;
    let service = crate::modules::events::service::EventService::new();
    let performance = service.get_build_performance(&db, id).await?;
    Ok(Json(ApiResponse::new(performance)))
}

/// Returns a build's total market price, computed live from Albion Online Data.
///
/// Served from a short-lived cache (see `comps::price_cache`) since pricing means a live call to
/// a third-party market API — a repeat view within the cache window is served without refetching.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks `comps.builds.view`. Returns `404 Not Found` if
/// the build does not exist.
#[utoipa::path(
    get,
    path = "/api/comps/builds/{id}/price",
    tag = "comps",
    summary = "Get a build's total market price",
    description = "Prices the build's main-loadout items live from Albion Online Data, using the \
        guild's configured `pricing_location`/`pricing_fallback_strategy` (the same knobs the \
        regear admin panel exposes). Prices ignore item quality (cheapest listing of the tier and \
        enchantment), and `unpriced_item_count` reports items with no listing. A market outage is \
        returned as an error and never cached; edits to the build evict its cached price.",
    security(("session_cookie" = ["comps.builds.view"])),
    params(("id" = i64, Path, description = "Build ID")),
    responses(
        (status = 200, description = "Build price computed", body = ApiResponse<crate::modules::comps::models::BuildPriceView>),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks comps.builds.view", body = ProblemDetails),
        (status = 404, description = "Build not found", body = ProblemDetails)
    )
)]
async fn get_build_price(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(albiondata): Extension<AlbionDataService>,
    Extension(cache): Extension<PriceCache>,
    Extension(tenant): Extension<CurrentTenantId>,
) -> Result<Json<ApiResponse<crate::modules::comps::models::BuildPriceView>>, AppError> {
    user.require(&perms, Permission::CompsBuildsView).await?;
    let settings = crate::modules::regear::entities::load_settings(&db).await?;
    let view = cached_build_price(&cache, &tenant.0, &db, &albiondata, id, &settings).await?;
    Ok(Json(ApiResponse::new(view)))
}

/// Returns a comp's total market price, computed live from Albion Online Data.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks `comps.comps.view`. Returns `404 Not Found` if the
/// comp does not exist.
#[utoipa::path(
    get,
    path = "/api/comps/{id}/price",
    tag = "comps",
    summary = "Get a comp's total market price",
    description = "Prices every build in the comp in one combined Albion Online Data query \
        (Σ build price × quantity). `unpriced_item_count` reports item slots with no listing. A market \
        outage is returned as an error and never cached; edits to the comp or its builds evict \
        its cached price.",
    security(("session_cookie" = ["comps.comps.view"])),
    params(("id" = i64, Path, description = "Comp ID")),
    responses(
        (status = 200, description = "Comp price computed", body = ApiResponse<crate::modules::comps::models::CompPriceView>),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks comps.comps.view", body = ProblemDetails),
        (status = 404, description = "Comp not found", body = ProblemDetails)
    )
)]
async fn get_comp_price(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(albiondata): Extension<AlbionDataService>,
    Extension(cache): Extension<PriceCache>,
    Extension(tenant): Extension<CurrentTenantId>,
) -> Result<Json<ApiResponse<crate::modules::comps::models::CompPriceView>>, AppError> {
    user.require(&perms, Permission::CompsCompsView).await?;
    let settings = crate::modules::regear::entities::load_settings(&db).await?;
    let view = cached_comp_price(&cache, &tenant.0, &db, &albiondata, id, &settings).await?;
    Ok(Json(ApiResponse::new(view)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::comps::authority::test_support::{AUTHOR, NOBODY, OTHER, caller, fixture};
    use crate::modules::comps::models::AddCompBuildRequest;

    const OWN_ROWS: &[&str] = &[
        "comps.builds.create",
        "comps.builds.edit",
        "comps.builds.delete",
        "comps.comps.create",
        "comps.comps.edit",
        "comps.comps.delete",
    ];

    fn rename(name: &str) -> UpdateBuildRequest {
        UpdateBuildRequest {
            name: Some(name.to_string()),
            description: None,
            role: None,
            category_id: None,
        }
    }

    #[tokio::test]
    async fn update_build_is_author_or_manage() {
        let (db, perms) = fixture(&[
            ("Member", OWN_ROWS),
            ("Manager", &["comps.builds.manage"]),
            ("Viewer", &["comps.builds.view"]),
        ])
        .await;

        let call = |user: UserContext, name: &'static str| {
            let (db, perms) = (db.clone(), perms.clone());
            async move {
                update_build(
                    user,
                    Extension(perms),
                    Path(10),
                    Extension(db),
                    Json(rename(name)),
                )
                .await
            }
        };

        let renamed = call(caller(AUTHOR, "Member"), "By author")
            .await
            .expect("the author edits their own build");
        assert_eq!(renamed.0.data.summary.name, "By author");
        assert!(matches!(
            call(caller(OTHER, "Member"), "By other").await,
            Err(AppError::Forbidden(_))
        ));
        let renamed = call(caller(OTHER, "Manager"), "By manager")
            .await
            .expect("a manager edits anyone's build");
        assert_eq!(renamed.0.data.summary.name, "By manager");
        assert!(matches!(
            call(caller(AUTHOR, "Viewer"), "By viewer").await,
            Err(AppError::Forbidden(_))
        ));
    }

    #[tokio::test]
    async fn delete_comp_is_author_or_manage() {
        let (db, perms) =
            fixture(&[("Member", OWN_ROWS), ("Manager", &["comps.comps.manage"])]).await;
        let delete = |user: UserContext| {
            let (db, perms) = (db.clone(), perms.clone());
            async move {
                delete_comp(
                    user,
                    Extension(perms),
                    Path(20),
                    Extension(db),
                    Extension(PriceCache::new()),
                    Extension(CurrentTenantId("tenant".to_string())),
                )
                .await
            }
        };

        assert!(matches!(
            delete(caller(NOBODY, "Member")).await,
            Err(AppError::Forbidden(_))
        ));
        assert_eq!(
            delete(caller(OTHER, "Manager")).await.expect("manager"),
            StatusCode::NO_CONTENT
        );
        // Gone now, so the author gets a 404 rather than a silent success.
        assert!(matches!(
            delete(caller(AUTHOR, "Member")).await,
            Err(AppError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn sub_resource_and_archive_routes_apply_the_same_rule() {
        let (db, perms) = fixture(&[("Member", OWN_ROWS)]).await;
        let other = caller(OTHER, "Member");

        let add = add_comp_build(
            other.clone(),
            Extension(perms.clone()),
            Path(20),
            Extension(db.clone()),
            Extension(PriceCache::new()),
            Extension(CurrentTenantId("tenant".to_string())),
            Json(AddCompBuildRequest {
                build_id: 10,
                quantity: 1,
            }),
        )
        .await;
        assert!(matches!(add, Err(AppError::Forbidden(_))));

        let archive = archive_build(
            other.clone(),
            Extension(perms.clone()),
            Path(10),
            Extension(db.clone()),
        )
        .await;
        assert!(matches!(archive, Err(AppError::Forbidden(_))));

        let version = create_comp_version(other, Extension(perms), Path(20), Extension(db)).await;
        assert!(matches!(version, Err(AppError::Forbidden(_))));
    }

    #[tokio::test]
    async fn create_build_requires_the_create_permission() {
        let (db, perms) = fixture(&[("Editor", &["comps.builds.edit"])]).await;
        let request: CreateBuildRequest = serde_json::from_value(serde_json::json!({
            "name": "New", "role": "tank", "category_id": 1
        }))
        .expect("create build request");
        let created = create_build(
            caller(AUTHOR, "Editor"),
            Extension(perms),
            Extension(db),
            Json(request),
        )
        .await;
        assert!(matches!(created, Err(AppError::Forbidden(_))));
    }
}
