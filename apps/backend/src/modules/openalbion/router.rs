//! Local Albion catalog routing module.
//!
//! Exposes the historical `/api/openalbion/*` endpoints for compatibility. Their data is served
//! from the bundled manual catalog and never fetched from the third-party OpenAlbion service.

use super::catalog::{
    OpenAlbionCategory, OpenAlbionItem, OpenAlbionItemType, OpenAlbionWeaponFilters,
    OpenAlbionWeaponStats,
};
use super::service::OpenAlbionService;
use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::UserContext;
use crate::pagination::{PaginatedOpenAlbionWeapon, PaginationParams};
use crate::responses::{ApiResponse, ApiResponsePaginatedOpenAlbionWeapons};
use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::get,
};
use serde::Deserialize;
use std::str::FromStr;

/// Creates the router for the `OpenAlbion` module.
pub fn router() -> Router {
    Router::new()
        .route("/weapons", get(list_weapons))
        .route("/weapons/{id}/stats", get(get_weapon_stats))
        .route("/categories", get(list_categories))
        .route("/items", get(list_items))
        .route("/catalog", get(get_catalog))
        .route("/abilities", get(get_abilities))
}

/// Query parameters for browsing the weapon catalog.
///
/// Pagination fields are declared inline rather than via `#[serde(flatten)]` on
/// `PaginationParams`, since axum's `Query` extractor (backed by `serde_html_form`) cannot
/// deserialize non-string fields (e.g. `u64`) through a flattened struct from a query string.
#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct WeaponListQuery {
    /// Optional case-insensitive substring filter on weapon name.
    pub q: Option<String>,
    /// Optional category ID filter (see `/categories`).
    pub category_id: Option<i64>,
    /// Optional subcategory ID filter (see `/categories`).
    pub subcategory_id: Option<i64>,
    /// Optional tier filter (e.g. `4` for T4 weapons).
    pub tier: Option<i64>,
    /// The page number to fetch (1-indexed). Defaults to 1.
    pub page: Option<u64>,
    /// The maximum number of items per page. Defaults to 10.
    pub limit: Option<u64>,
}

impl WeaponListQuery {
    fn pagination(&self) -> PaginationParams {
        PaginationParams {
            page: self.page,
            limit: self.limit,
        }
    }

    fn filters(&self) -> OpenAlbionWeaponFilters {
        OpenAlbionWeaponFilters {
            category_id: self.category_id,
            subcategory_id: self.subcategory_id,
            tier: self.tier,
        }
    }
}

/// List the full local Albion weapon catalog, optionally filtered and paginated.
#[utoipa::path(
    get,
    path = "/api/openalbion/weapons",
    tag = "openalbion",
    summary = "Browse/search the weapon catalog (for the comp/loadout builder)",
    description = "Static reference data from the bundled manual catalog, not live game state. `q` filters by name substring (case-insensitive), `tier` matches weapons whose tier string starts with the given number (e.g. `tier=4` matches both `4` and `4.1`). Every weapon's `id` is what you pass to `GET /openalbion/weapons/{id}/stats`. Standard `page`/`limit` pagination.",
    security(("session_cookie" = [])),
    params(WeaponListQuery),
    responses(
        (status = 200, description = "Weapons retrieved successfully", body = ApiResponsePaginatedOpenAlbionWeapons),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 500, description = "Bundled catalog error", body = ProblemDetails)
    )
)]
pub async fn list_weapons(
    _user: UserContext,
    Extension(service): Extension<OpenAlbionService>,
    Query(query): Query<WeaponListQuery>,
) -> Result<Json<ApiResponse<PaginatedOpenAlbionWeapon>>, AppError> {
    let pagination = query.pagination();
    let filters = query.filters();
    let paginated = service
        .list_weapons(&filters, query.q.as_deref(), &pagination)
        .await?;

    Ok(Json(ApiResponse::new(PaginatedOpenAlbionWeapon::from(
        paginated,
    ))))
}

/// Fetch per-quality-tier stats for a single weapon by ID.
#[utoipa::path(
    get,
    path = "/api/openalbion/weapons/{id}/stats",
    tag = "openalbion",
    summary = "Get per-enchantment, per-quality-tier combat stats for one weapon",
    description = "**Not wrapped in the usual `{status, data}` envelope** — the response body IS the \
        JSON array directly (`response.json()` gives you the array itself, not `response.json().data`). \
        This is the one exception; see the API-wide description. The array has one entry per \
        enchantment level (0/1/2/3/4), each containing per-quality-tier (Normal, Good, Outstanding, \
        Excellent, Masterpiece) stat blocks — a weapon's full stat table is the union of all entries. \
        The local catalog does not currently include stat tables, so known weapons return an empty compatible array. `id` comes from \
        `GET /openalbion/weapons`.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "OpenAlbion weapon ID, from GET /openalbion/weapons")),
    responses(
        (status = 200, description = "Weapon stats retrieved successfully — raw JSON array, NOT wrapped in {status, data}", body = Vec<OpenAlbionWeaponStats>),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "No weapon exists with this id", body = ProblemDetails),
        (status = 500, description = "Bundled catalog error", body = ProblemDetails)
    )
)]
pub async fn get_weapon_stats(
    _user: UserContext,
    Extension(service): Extension<OpenAlbionService>,
    Path(id): Path<i64>,
) -> Result<Json<Vec<OpenAlbionWeaponStats>>, AppError> {
    Ok(Json(service.get_weapon_stats(id).await?))
}

/// Query parameters for browsing the unified item catalog.
///
/// Pagination fields are declared inline rather than via `#[serde(flatten)]` on
/// `PaginationParams`, since axum's `Query` extractor (backed by `serde_html_form`) cannot
/// deserialize non-string fields (e.g. `u64`) through a flattened struct from a query string.
#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct ItemListQuery {
    /// Optional case-insensitive substring filter on item name.
    pub q: Option<String>,
    /// Optional category ID filter (see `/categories`).
    pub category_id: Option<i64>,
    /// Optional subcategory ID filter (see `/categories`).
    pub subcategory_id: Option<i64>,
    /// Optional tier filter (e.g. `4` for T4 items).
    pub tier: Option<i64>,
    /// The item type to list (defaults to `weapon` if omitted).
    #[serde(rename = "type")]
    pub item_type: Option<String>,
    /// The page number to fetch (1-indexed). Defaults to 1.
    pub page: Option<u64>,
    /// The maximum number of items per page. Defaults to 10.
    pub limit: Option<u64>,
}

impl ItemListQuery {
    fn parsed_item_type(&self) -> Result<OpenAlbionItemType, AppError> {
        let type_str = self.item_type.as_deref().unwrap_or("weapon");
        OpenAlbionItemType::from_str(type_str).map_err(AppError::Validation)
    }

    fn pagination(&self) -> PaginationParams {
        PaginationParams {
            page: self.page,
            limit: self.limit,
        }
    }

    fn filters(&self) -> OpenAlbionWeaponFilters {
        OpenAlbionWeaponFilters {
            category_id: self.category_id,
            subcategory_id: self.subcategory_id,
            tier: self.tier,
        }
    }
}

/// List the full Albion Online item catalog for any type (weapon/armor/accessory/consumable).
#[utoipa::path(
    get,
    path = "/api/openalbion/items",
    tag = "openalbion",
    summary = "Browse/search the unified item catalog (for the comp/loadout builder)",
    description = "Static reference data from the bundled manual catalog, not live game state. `q` filters by name substring (case-insensitive), `tier` matches items whose tier string starts with the given number (e.g. `tier=4` matches both `4` and `4.1`). `type` selects the item type (`weapon`, `armor`, `accessory`, `consumable`; defaults to `weapon`). Standard `page`/`limit` pagination.",
    security(("session_cookie" = [])),
    params(ItemListQuery),
    responses(
        (status = 200, description = "Items retrieved successfully", body = crate::responses::ApiResponsePaginatedOpenAlbionItems),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 500, description = "Bundled catalog error", body = ProblemDetails)
    )
)]
pub async fn list_items(
    _user: UserContext,
    Extension(service): Extension<OpenAlbionService>,
    Query(query): Query<ItemListQuery>,
) -> Result<Json<ApiResponse<crate::pagination::PaginatedOpenAlbionItem>>, AppError> {
    let item_type = query.parsed_item_type()?;
    let pagination = query.pagination();
    let filters = query.filters();
    let paginated = service
        .list_items(item_type, &filters, query.q.as_deref(), &pagination)
        .await?;

    Ok(Json(ApiResponse::new(
        crate::pagination::PaginatedOpenAlbionItem::from(paginated),
    )))
}

/// Return the manually curated catalog bundled with the application.
#[utoipa::path(
    get,
    path = "/api/openalbion/catalog",
    tag = "openalbion",
    summary = "Get the complete Albion item catalog",
    description = "Returns the manually curated catalog for weapons, armor, accessories and consumables bundled with the application. This endpoint is served entirely from local application data.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Complete item catalog", body = crate::responses::ApiResponseOpenAlbionCatalog),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 500, description = "The bundled catalog is invalid", body = ProblemDetails)
    )
)]
pub async fn get_catalog(
    _user: UserContext,
    Extension(service): Extension<OpenAlbionService>,
) -> Result<Json<ApiResponse<Vec<OpenAlbionItem>>>, AppError> {
    Ok(Json(ApiResponse::new(service.list_catalog().await?)))
}

/// Query parameters for browsing item categories.
#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct CategoryListQuery {
    /// Optional top-level category type filter (e.g. `weapon`, `armor`, `accessory`, `consumable`).
    #[serde(rename = "type")]
    pub category_type: Option<String>,
}

/// List item categories, optionally filtered by top-level type.
#[utoipa::path(
    get,
    path = "/api/openalbion/categories",
    tag = "openalbion",
    summary = "List item categories (for the weapon catalog's category/subcategory filters)",
    description = "**Not wrapped in the usual `{status, data}` envelope** — the response body IS the \
        JSON array directly, same exception as `GET /openalbion/weapons/{id}/stats`. Each \
        `OpenAlbionCategory` may recursively nest `subcategories` (its own array of the same shape); \
        the ids from here — top-level `id` or a nested `subcategories[].id` — are what you pass as \
        `category_id`/`subcategory_id` to `GET /openalbion/weapons`. Filter with `?type=weapon` (or \
        `armor`/`accessory`/`consumable`) to narrow to one top-level branch; omit for everything. \
        Results come from the bundled manual catalog.",
    security(("session_cookie" = [])),
    params(CategoryListQuery),
    responses(
        (status = 200, description = "Categories retrieved successfully — raw JSON array, NOT wrapped in {status, data}", body = Vec<OpenAlbionCategory>),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 500, description = "Bundled catalog error", body = ProblemDetails)
    )
)]
pub async fn list_categories(
    _user: UserContext,
    Extension(service): Extension<OpenAlbionService>,
    Query(query): Query<CategoryListQuery>,
) -> Result<Json<Vec<OpenAlbionCategory>>, AppError> {
    Ok(Json(
        service
            .list_categories(query.category_type.as_deref())
            .await?,
    ))
}

/// Returns the bundled Albion ability catalog.
///
/// Keyed by tier-stripped base identifier (`MAIN_SWORD`), because every tier of an item offers the
/// same spells. Served from local application data; regenerated by
/// `scripts/generate_albion_abilities.py` when Albion patches.
#[utoipa::path(
    get,
    path = "/api/openalbion/abilities",
    tag = "openalbion",
    summary = "Get the selectable abilities for every weapon and armor family",
    description = "Returns, per item family, how many active and passive ability slots it has and \
                   which spells each slot accepts. Active slots 1/2/3 are the player's Q/W/E on a \
                   weapon; armor pieces have one active slot, bound to D (head), R (chest) or F \
                   (shoes). Icons live at `https://render.albiononline.com/v1/spell/{id}.png`. \
                   Served entirely from local application data.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Ability catalog", body = crate::responses::ApiResponseOpenAlbionAbilities),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
pub async fn get_abilities(
    _user: UserContext,
) -> Json<
    ApiResponse<
        &'static std::collections::HashMap<String, super::catalog::OpenAlbionItemAbilities>,
    >,
> {
    Json(ApiResponse::new(super::service::ability_catalog()))
}
