//! Albion Data service layer.
//!
//! Keeps validation and normalization outside the router so future consumers can reuse market and
//! render helpers without going through HTTP extraction types.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use super::client::{AlbionDataApiClient, AlbionDataItemIcon, AlbionDataMarketPrice};
use backend_core::errors::AppError;
use backend_core::ttl_cache::TtlCache;

const DEFAULT_ICON_QUALITY: u8 = 1;
const DEFAULT_ICON_SIZE: u16 = 64;
const MAX_ITEM_IDS_PER_PRICE_REQUEST: usize = 120;
/// Market prices move slowly relative to how often battles and comps are priced,
/// so one item's rows are reused for this long across all callers.
const PRICE_CACHE_TTL: Duration = Duration::from_mins(10);
const PRICE_CACHE_MAX_ENTRIES: usize = 10_000;

/// One item's market rows for one server and one location/quality filter.
#[derive(Clone, PartialEq, Eq, Hash)]
struct PriceKey {
    server: String,
    item_id: String,
    locations: Option<String>,
    qualities: Option<String>,
}

/// Application-facing facade for Albion Online Data and Render Service operations.
///
/// The service owns the default server so callers can omit a server in normal app flows while still
/// allowing explicit overrides for admin/debug tools.
///
/// # Example
/// ```rust,ignore
/// # use backend_albion_data::albiondata::service::AlbionDataService;
/// let service = AlbionDataService::new("europe".to_string(), None);
/// let icon = service.item_icon("T4_BAG", None, None).expect("valid icon request");
/// assert_eq!(icon.size, 64);
/// ```
#[derive(Clone)]
pub struct AlbionDataService {
    client: AlbionDataApiClient,
    default_server: String,
    default_icon_quality: u8,
    default_icon_size: u16,
    /// Shared by every clone, so tenant-scoped copies reuse each other's prices.
    price_cache: Arc<TtlCache<PriceKey, Vec<AlbionDataMarketPrice>>>,
}

impl AlbionDataService {
    /// Creates a service with an app-level default server.
    ///
    /// The default should normally come from `Config::albion_api_region` so market requests follow
    /// the same region as guild/player lookups.
    ///
    /// # Example
    /// ```rust,ignore
    /// # use backend_albion_data::albiondata::service::AlbionDataService;
    /// let service = AlbionDataService::new("europe".to_string(), Some(15));
    /// ```
    #[must_use]
    pub fn new(default_server: String, timeout_secs: Option<u64>) -> Self {
        Self {
            client: AlbionDataApiClient::new(timeout_secs),
            default_server,
            default_icon_quality: DEFAULT_ICON_QUALITY,
            default_icon_size: DEFAULT_ICON_SIZE,
            price_cache: Arc::new(TtlCache::new(PRICE_CACHE_MAX_ENTRIES)),
        }
    }

    /// Same client, with the tenant's region as the default server.
    #[must_use]
    pub fn with_default_server(&self, default_server: String) -> Self {
        let mut cloned = self.clone();
        cloned.default_server = default_server;
        cloned
    }

    /// Returns current market prices for a validated item list.
    ///
    /// Empty item ids are rejected before calling the public API because Albion Online Data would
    /// otherwise return confusing empty responses. The limit protects us from the API's documented
    /// 4096-character URL cap while still allowing bulk queries.
    ///
    /// Each item is cached per server and location/quality filter for ten minutes. Only the items
    /// missing from the cache are requested upstream, in one call. Failed requests are not cached.
    ///
    /// # Example
    /// ```rust,ignore
    /// # use backend_albion_data::albiondata::service::AlbionDataService;
    /// # async fn example() -> Result<(), backend_core::errors::AppError> {
    /// let service = AlbionDataService::new("europe".to_string(), None);
    /// let prices = service
    ///     .prices(Some("europe"), "T4_BAG,T5_BAG", Some("Caerleon"), Some("1"))
    ///     .await?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # Errors
    /// Returns validation errors for empty or too-large item lists and upstream errors for API
    /// failures.
    pub async fn prices(
        &self,
        server: Option<&str>,
        items: &str,
        locations: Option<&str>,
        qualities: Option<&str>,
    ) -> Result<Vec<AlbionDataMarketPrice>, AppError> {
        let item_ids = parse_item_ids(items)?;
        let selected_server = server.unwrap_or(&self.default_server).to_string();
        let key_for = |item_id: &str| PriceKey {
            server: selected_server.clone(),
            item_id: item_id.to_string(),
            locations: locations.map(str::to_string),
            qualities: qualities.map(str::to_string),
        };

        let mut rows = Vec::new();
        let mut missing = Vec::new();
        for item_id in &item_ids {
            match self.price_cache.get(&key_for(item_id)) {
                Some(cached) => rows.extend(cached),
                None => missing.push(item_id.clone()),
            }
        }
        if missing.is_empty() {
            return Ok(rows);
        }

        let fetched = self
            .client
            .get_prices(&selected_server, &missing, locations, qualities)
            .await?;
        let mut by_item: HashMap<String, Vec<AlbionDataMarketPrice>> = missing
            .iter()
            .map(|item_id| (item_id.clone(), Vec::new()))
            .collect();
        for row in fetched {
            match by_item.get_mut(&row.item_id) {
                Some(bucket) => bucket.push(row),
                // Upstream named an item we did not ask for: return it, do not cache it.
                None => rows.push(row),
            }
        }
        for (item_id, bucket) in by_item {
            self.price_cache
                .insert(key_for(&item_id), bucket.clone(), PRICE_CACHE_TTL);
            rows.extend(bucket);
        }
        Ok(rows)
    }

    /// Creates a render-service URL for one item identifier.
    ///
    /// Quality and size default to the values currently used by the build UI. The method performs no
    /// network I/O; the returned URL is meant to be used as an `<img src>`.
    ///
    /// # Example
    /// ```rust,ignore
    /// # use backend_albion_data::albiondata::service::AlbionDataService;
    /// let service = AlbionDataService::new("europe".to_string(), None);
    /// let icon = service.item_icon("T4_HEAD_PLATE_SET1", Some(1), Some(64)).expect("valid icon");
    /// assert!(icon.url.ends_with("quality=1&size=64"));
    /// ```
    ///
    /// # Errors
    /// Returns a validation error when the item id is blank or the requested size is zero.
    pub fn item_icon(
        &self,
        item_id: &str,
        quality: Option<u8>,
        size: Option<u16>,
    ) -> Result<AlbionDataItemIcon, AppError> {
        let item_id = item_id.trim();
        if item_id.is_empty() {
            return Err(AppError::Validation(
                "Albion item id cannot be empty".to_string(),
            ));
        }

        let size = size.unwrap_or(self.default_icon_size);
        if size == 0 {
            return Err(AppError::Validation(
                "Icon size must be greater than zero".to_string(),
            ));
        }

        Ok(AlbionDataItemIcon::new(
            item_id,
            quality.unwrap_or(self.default_icon_quality),
            size,
        ))
    }
}

impl Default for AlbionDataService {
    fn default() -> Self {
        Self::new("europe".to_string(), None)
    }
}

/// Picks the cheapest positive sell price per item id, preferring `configured_city` over
/// `fallback` when both carry a price for the same item.
///
/// Shared between `regear::pricing` (kill-feed loadout pricing) and `comps::pricing` (build/comp
/// market pricing) — both need "cheapest listing per item id, city-preferred with cross-city
/// fallback", so the logic lives here once rather than being duplicated per caller.
#[must_use]
pub fn cheapest_price_index(
    configured_city: &[AlbionDataMarketPrice],
    fallback: &[AlbionDataMarketPrice],
) -> HashMap<String, i64> {
    let mut index = HashMap::new();
    let insert_cheapest = |prices: &[AlbionDataMarketPrice], index: &mut HashMap<String, i64>| {
        for price in prices {
            let candidate = [price.sell_price_min, price.sell_price_max]
                .into_iter()
                .filter(|p| *p > 0)
                .min()
                .unwrap_or(0);
            if candidate > 0 {
                index
                    .entry(price.item_id.clone())
                    .and_modify(|existing| {
                        if candidate < *existing {
                            *existing = candidate;
                        }
                    })
                    .or_insert(candidate);
            }
        }
    };
    insert_cheapest(fallback, &mut index);
    insert_cheapest(configured_city, &mut index);
    index
}

fn parse_item_ids(items: &str) -> Result<Vec<String>, AppError> {
    let item_ids = items
        .split(',')
        .map(str::trim)
        .filter(|item_id| !item_id.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();

    if item_ids.is_empty() {
        return Err(AppError::Validation(
            "At least one Albion item id is required".to_string(),
        ));
    }

    if item_ids.len() > MAX_ITEM_IDS_PER_PRICE_REQUEST {
        return Err(AppError::Validation(format!(
            "A maximum of {MAX_ITEM_IDS_PER_PRICE_REQUEST} item ids can be queried at once"
        )));
    }

    Ok(item_ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::albionbb::test_support::{json_ok, serve};

    fn price_row(item_id: &str) -> String {
        format!(
            r#"{{"item_id": "{item_id}", "city": "Caerleon", "quality": 1, "sell_price_min": 100, "sell_price_max": 120, "buy_price_min": 90, "buy_price_max": 95}}"#
        )
    }

    #[tokio::test]
    async fn cached_items_are_not_requested_again() {
        let upstream = serve(vec![
            json_ok(&format!("[{}]", price_row("T4_BAG"))),
            json_ok(&format!("[{}]", price_row("T5_BAG"))),
        ])
        .await;
        let service = AlbionDataService {
            client: AlbionDataApiClient::new(None).with_base_url(upstream.base_url.clone()),
            ..AlbionDataService::new("europe".to_string(), None)
        };

        let first = service
            .prices(Some("europe"), "T4_BAG", Some("Caerleon"), None)
            .await
            .expect("first lookup");
        assert_eq!(first.len(), 1);

        let second = service
            .prices(Some("europe"), "T4_BAG,T5_BAG", Some("Caerleon"), None)
            .await
            .expect("mixed lookup");
        assert_eq!(second.len(), 2);

        let requests = upstream.requests.lock().expect("requests").clone();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].contains("/api/v2/stats/prices/T5_BAG.json"));
        assert!(!requests[1].contains("T4_BAG"));

        // Everything is cached now: no third request.
        service
            .prices(Some("europe"), "T4_BAG,T5_BAG", Some("Caerleon"), None)
            .await
            .expect("cached lookup");
        assert_eq!(upstream.request_count(), 2);
    }

    #[tokio::test]
    async fn different_location_filters_are_cached_separately() {
        let upstream = serve(vec![json_ok("[]"), json_ok("[]")]).await;
        let service = AlbionDataService {
            client: AlbionDataApiClient::new(None).with_base_url(upstream.base_url.clone()),
            ..AlbionDataService::new("europe".to_string(), None)
        };

        service
            .prices(Some("europe"), "T4_BAG", Some("Caerleon"), None)
            .await
            .expect("caerleon");
        service
            .prices(Some("europe"), "T4_BAG", Some("Martlock"), None)
            .await
            .expect("martlock");

        assert_eq!(upstream.request_count(), 2);
    }
}
