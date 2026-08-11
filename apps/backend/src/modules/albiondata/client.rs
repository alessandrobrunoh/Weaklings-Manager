//! Albion Online Data and Render Service client.
//!
//! Provides the small, self-owned integration surface that does not depend on `OpenAlbion`:
//! current market prices from Albion Online Data and deterministic item image URLs from
//! Sandbox Interactive's render service.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::errors::AppError;

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const RENDER_ITEM_BASE_URL: &str = "https://render.albiononline.com/v1/item";

/// Current market values returned by Albion Online Data.
///
/// Uses optional timestamps because the upstream emits empty strings when no order is available for
/// a city/quality pair. Keeping those rows lets the UI distinguish "no order" from "row missing".
///
/// # Example
/// ```rust
/// # use backend::modules::albiondata::client::AlbionDataMarketPrice;
/// let price = AlbionDataMarketPrice {
///     item_id: "T4_BAG".to_string(),
///     city: "Caerleon".to_string(),
///     quality: 1,
///     sell_price_min: 1200,
///     sell_price_min_date: None,
///     sell_price_max: 1400,
///     sell_price_max_date: None,
///     buy_price_min: 900,
///     buy_price_min_date: None,
///     buy_price_max: 1000,
///     buy_price_max_date: None,
/// };
/// assert_eq!(price.item_id, "T4_BAG");
/// ```
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AlbionDataMarketPrice {
    #[schema(example = "T4_BAG")]
    pub item_id: String,
    #[schema(example = "Caerleon")]
    pub city: String,
    #[schema(example = 1)]
    pub quality: i64,
    #[schema(example = 1200)]
    pub sell_price_min: i64,
    #[serde(default)]
    #[schema(example = "2026-08-11T10:00:00")]
    pub sell_price_min_date: Option<String>,
    #[schema(example = 1400)]
    pub sell_price_max: i64,
    #[serde(default)]
    #[schema(example = "2026-08-11T10:00:00")]
    pub sell_price_max_date: Option<String>,
    #[schema(example = 900)]
    pub buy_price_min: i64,
    #[serde(default)]
    #[schema(example = "2026-08-11T10:00:00")]
    pub buy_price_min_date: Option<String>,
    #[schema(example = 1000)]
    pub buy_price_max: i64,
    #[serde(default)]
    #[schema(example = "2026-08-11T10:00:00")]
    pub buy_price_max_date: Option<String>,
}

/// Resolved image URL for an Albion item identifier.
///
/// The render service is deterministic and unauthenticated, so the backend returns the URL instead
/// of proxying the image bytes. This keeps API responses small and lets browsers cache images.
///
/// # Example
/// ```rust
/// # use backend::modules::albiondata::client::AlbionDataItemIcon;
/// let icon = AlbionDataItemIcon::new("T4_HEAD_PLATE_SET1", 1, 64);
/// assert!(icon.url.contains("T4_HEAD_PLATE_SET1.png"));
/// ```
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AlbionDataItemIcon {
    #[schema(example = "T4_HEAD_PLATE_SET1")]
    pub item_id: String,
    #[schema(example = 1)]
    pub quality: u8,
    #[schema(example = 64)]
    pub size: u16,
    #[schema(
        example = "https://render.albiononline.com/v1/item/T4_HEAD_PLATE_SET1.png?quality=1&size=64"
    )]
    pub url: String,
}

impl AlbionDataItemIcon {
    /// Builds a stable render URL without making an HTTP request.
    ///
    /// Albion's render service handles the actual image lookup. Keeping URL construction local
    /// avoids a network dependency when the caller only needs a browser-ready image source.
    ///
    /// # Example
    /// ```rust
    /// # use backend::modules::albiondata::client::AlbionDataItemIcon;
    /// let icon = AlbionDataItemIcon::new("T4_BAG", 1, 64);
    /// assert_eq!(icon.quality, 1);
    /// ```
    #[must_use]
    pub fn new(item_id: &str, quality: u8, size: u16) -> Self {
        let encoded_item_id = urlencoding::encode(item_id);
        Self {
            item_id: item_id.to_string(),
            quality,
            size,
            url: format!(
                "{RENDER_ITEM_BASE_URL}/{encoded_item_id}.png?quality={quality}&size={size}"
            ),
        }
    }
}

/// Region-aware HTTP client for Albion Online Data.
#[derive(Clone)]
pub struct AlbionDataApiClient {
    http: reqwest::Client,
}

impl AlbionDataApiClient {
    /// Creates a client with a bounded request timeout.
    ///
    /// The public API is rate-limited, so calls should fail fast rather than holding backend
    /// workers indefinitely during upstream incidents.
    ///
    /// # Example
    /// ```rust
    /// # use backend::modules::albiondata::client::AlbionDataApiClient;
    /// let client = AlbionDataApiClient::new(Some(10));
    /// ```
    #[must_use]
    pub fn new(timeout_secs: Option<u64>) -> Self {
        let timeout = Duration::from_secs(timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS));
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { http }
    }

    /// Fetches current prices for one or more item identifiers.
    ///
    /// Albion Online Data supports comma-separated item identifiers and optional comma-separated
    /// filters for locations and qualities. The API returns one row per item/location/quality.
    ///
    /// # Example
    /// ```rust,no_run
    /// # use backend::modules::albiondata::client::AlbionDataApiClient;
    /// # async fn example() -> Result<(), backend::errors::AppError> {
    /// let client = AlbionDataApiClient::default();
    /// let prices = client
    ///     .get_prices("europe", &["T4_BAG".to_string()], Some("Caerleon"), Some("1"))
    ///     .await?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # Errors
    /// Returns `AppError::UpstreamService` when the market API cannot be reached or parsed.
    pub async fn get_prices(
        &self,
        server: &str,
        item_ids: &[String],
        locations: Option<&str>,
        qualities: Option<&str>,
    ) -> Result<Vec<AlbionDataMarketPrice>, AppError> {
        if item_ids.is_empty() {
            return Err(AppError::Validation(
                "At least one Albion item id is required".to_string(),
            ));
        }

        let base_url = market_base_url(server);
        let encoded_items = item_ids
            .iter()
            .map(|item_id| urlencoding::encode(item_id).into_owned())
            .collect::<Vec<_>>()
            .join(",");
        let query = build_market_query(locations, qualities);
        let url = format!("{base_url}/api/v2/stats/prices/{encoded_items}.json{query}");
        self.get_json(&url).await
    }

    async fn get_json<T: for<'de> Deserialize<'de>>(&self, url: &str) -> Result<T, AppError> {
        let response = self.http.get(url).send().await.map_err(|error| {
            AppError::UpstreamService(format!("Failed to contact Albion Online Data API: {error}"))
        })?;

        if !response.status().is_success() {
            return Err(AppError::UpstreamService(format!(
                "Albion Online Data API returned {} for {url}",
                response.status()
            )));
        }

        response.json::<T>().await.map_err(|error| {
            AppError::UpstreamService(format!(
                "Failed to parse Albion Online Data response from {url}: {error}"
            ))
        })
    }
}

impl Default for AlbionDataApiClient {
    fn default() -> Self {
        Self::new(None)
    }
}

/// Selects the correct Albion Online Data host for a configured game server.
///
/// Accepts both app-level region names (`europe`, `americas`, `asia`) and short server aliases
/// (`eu`, `west`, `east`). Unknown values intentionally fall back to Europe, matching the app's
/// current default Albion region.
///
/// # Example
/// ```rust
/// # use backend::modules::albiondata::client::market_base_url;
/// assert_eq!(market_base_url("europe"), "https://europe.albion-online-data.com");
/// ```
#[must_use]
pub fn market_base_url(server: &str) -> &'static str {
    match server.to_ascii_lowercase().as_str() {
        "americas" | "america" | "us" | "west" | "na" => "https://west.albion-online-data.com",
        "asia" | "sgp" | "east" => "https://east.albion-online-data.com",
        _ => "https://europe.albion-online-data.com",
    }
}

fn build_market_query(locations: Option<&str>, qualities: Option<&str>) -> String {
    let mut params = Vec::new();
    if let Some(locations) = locations.filter(|value| !value.trim().is_empty()) {
        params.push(format!("locations={}", urlencoding::encode(locations)));
    }
    if let Some(qualities) = qualities.filter(|value| !value.trim().is_empty()) {
        params.push(format!("qualities={}", urlencoding::encode(qualities)));
    }

    if params.is_empty() {
        String::new()
    } else {
        format!("?{}", params.join("&"))
    }
}
