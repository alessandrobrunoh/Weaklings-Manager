//! Albion Data service layer.
//!
//! Keeps validation and normalization outside the router so future consumers can reuse market and
//! render helpers without going through HTTP extraction types.

use super::client::{AlbionDataApiClient, AlbionDataItemIcon, AlbionDataMarketPrice};
use crate::errors::AppError;

const DEFAULT_ICON_QUALITY: u8 = 1;
const DEFAULT_ICON_SIZE: u16 = 64;
const MAX_ITEM_IDS_PER_PRICE_REQUEST: usize = 120;

/// Application-facing facade for Albion Online Data and Render Service operations.
///
/// The service owns the default server so callers can omit a server in normal app flows while still
/// allowing explicit overrides for admin/debug tools.
///
/// # Example
/// ```rust
/// # use backend::modules::albiondata::service::AlbionDataService;
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
}

impl AlbionDataService {
    /// Creates a service with an app-level default server.
    ///
    /// The default should normally come from `Config::albion_api_region` so market requests follow
    /// the same region as guild/player lookups.
    ///
    /// # Example
    /// ```rust
    /// # use backend::modules::albiondata::service::AlbionDataService;
    /// let service = AlbionDataService::new("europe".to_string(), Some(15));
    /// ```
    #[must_use]
    pub fn new(default_server: String, timeout_secs: Option<u64>) -> Self {
        Self {
            client: AlbionDataApiClient::new(timeout_secs),
            default_server,
            default_icon_quality: DEFAULT_ICON_QUALITY,
            default_icon_size: DEFAULT_ICON_SIZE,
        }
    }

    /// Returns current market prices for a validated item list.
    ///
    /// Empty item ids are rejected before calling the public API because Albion Online Data would
    /// otherwise return confusing empty responses. The limit protects us from the API's documented
    /// 4096-character URL cap while still allowing bulk queries.
    ///
    /// # Example
    /// ```rust,no_run
    /// # use backend::modules::albiondata::service::AlbionDataService;
    /// # async fn example() -> Result<(), backend::errors::AppError> {
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
        let selected_server = server.unwrap_or(&self.default_server);
        self.client
            .get_prices(selected_server, &item_ids, locations, qualities)
            .await
    }

    /// Creates a render-service URL for one item identifier.
    ///
    /// Quality and size default to the values currently used by the build UI. The method performs no
    /// network I/O; the returned URL is meant to be used as an `<img src>`.
    ///
    /// # Example
    /// ```rust
    /// # use backend::modules::albiondata::service::AlbionDataService;
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
