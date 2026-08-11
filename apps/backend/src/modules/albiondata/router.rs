//! Albion Data routing module.
//!
//! Exposes self-owned item utility endpoints for render URLs and market prices, avoiding runtime
//! dependencies on OpenAlbion for these concerns.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::get,
};
use serde::Deserialize;
use utoipa::IntoParams;

use super::client::{AlbionDataItemIcon, AlbionDataMarketPrice};
use super::service::AlbionDataService;
use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::UserContext;
use crate::responses::ApiResponse;

/// Creates the router for the Albion Data module.
///
/// The endpoints are read-only but still protected by the same session cookie as the rest of the
/// app because they are part of the internal guild manager API.
///
/// # Example
/// ```rust
/// # use backend::modules::albiondata::router::router;
/// let router = router();
/// ```
#[must_use]
pub fn router() -> Router {
    Router::new()
        .route("/prices", get(get_prices))
        .route("/items/{item_id}/icon", get(get_item_icon))
}

/// Query parameters for current market prices.
#[derive(Debug, Deserialize, IntoParams)]
pub struct PricesQuery {
    /// Comma-separated Albion item identifiers, e.g. `T4_BAG,T5_BAG`.
    pub items: String,
    /// Optional market server (`europe`, `americas`/`west`, `asia`/`east`). Defaults to app config.
    pub server: Option<String>,
    /// Optional comma-separated cities, e.g. `Caerleon,Bridgewatch`.
    pub locations: Option<String>,
    /// Optional comma-separated quality ids (`1` normal through `5` masterpiece).
    pub qualities: Option<String>,
}

/// Current market prices for one or more Albion item identifiers.
#[utoipa::path(
    get,
    path = "/api/albiondata/prices",
    tag = "albiondata",
    summary = "Get current Albion Online market prices",
    description = "Fetches live/current prices from Albion Online Data. `items` is required and is a comma-separated list of Albion item identifiers such as `T4_BAG` or `T4_HEAD_PLATE_SET1`. Optional `locations` and `qualities` are passed through to Albion Online Data. The endpoint returns one row per item/city/quality combination.",
    security(("session_cookie" = [])),
    params(PricesQuery),
    responses(
        (status = 200, description = "Market prices retrieved successfully", body = crate::responses::ApiResponseAlbionDataMarketPriceList),
        (status = 400, description = "Invalid item list or query", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 502, description = "Upstream Albion Online Data API error", body = ProblemDetails)
    )
)]
pub async fn get_prices(
    _user: UserContext,
    Extension(service): Extension<AlbionDataService>,
    Query(query): Query<PricesQuery>,
) -> Result<Json<ApiResponse<Vec<AlbionDataMarketPrice>>>, AppError> {
    let prices = service
        .prices(
            query.server.as_deref(),
            &query.items,
            query.locations.as_deref(),
            query.qualities.as_deref(),
        )
        .await?;
    Ok(Json(ApiResponse::new(prices)))
}

/// Query parameters for render-service item icon URLs.
#[derive(Debug, Deserialize, IntoParams)]
pub struct ItemIconQuery {
    /// Albion item quality (`1` normal through `5` masterpiece). Defaults to `1`.
    pub quality: Option<u8>,
    /// Output image size in pixels. Defaults to `64`.
    pub size: Option<u16>,
}

/// Browser-ready render-service URL for one Albion item identifier.
#[utoipa::path(
    get,
    path = "/api/albiondata/items/{item_id}/icon",
    tag = "albiondata",
    summary = "Build an Albion render-service item icon URL",
    description = "Returns the deterministic `https://render.albiononline.com/v1/item/...` URL for an Albion item identifier. This does not call OpenAlbion and does not proxy image bytes; clients can use `data.url` directly as an image source.",
    security(("session_cookie" = [])),
    params(
        ("item_id" = String, Path, description = "Albion item identifier, e.g. `T4_HEAD_PLATE_SET1`"),
        ItemIconQuery,
    ),
    responses(
        (status = 200, description = "Item icon URL resolved successfully", body = crate::responses::ApiResponseAlbionDataItemIcon),
        (status = 400, description = "Invalid item id, quality, or size", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
pub async fn get_item_icon(
    _user: UserContext,
    Extension(service): Extension<AlbionDataService>,
    Path(item_id): Path<String>,
    Query(query): Query<ItemIconQuery>,
) -> Result<Json<ApiResponse<AlbionDataItemIcon>>, AppError> {
    Ok(Json(ApiResponse::new(service.item_icon(
        &item_id,
        query.quality,
        query.size,
    )?)))
}
