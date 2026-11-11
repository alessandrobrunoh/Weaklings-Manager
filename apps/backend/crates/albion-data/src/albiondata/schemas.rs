//! `OpenAPI` response schemas for the `albiondata` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

/// `OpenAPI` schema wrapper for Albion Online Data market prices.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAlbionDataMarketPriceList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The current market rows returned by Albion Online Data.
    pub data: Vec<crate::albiondata::client::AlbionDataMarketPrice>,
}

/// `OpenAPI` schema wrapper for an Albion render-service item icon URL.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAlbionDataItemIcon {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The resolved render-service URL payload.
    pub data: crate::albiondata::client::AlbionDataItemIcon,
}
