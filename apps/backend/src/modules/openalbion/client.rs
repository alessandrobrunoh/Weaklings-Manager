//! `OpenAlbion` public item database API client.
//!
//! Reusable, generic wrapper around the unauthenticated OpenAlbion REST API
//! (see <https://openalbion.com/>, base URL `https://api.openalbion.com/api/v3`). The upstream
//! API has no documented authentication or rate limiting. Every list endpoint wraps its
//! payload in a `{"data": [...]}` envelope, hence `OpenAlbionListResponse<T>`.

use crate::errors::AppError;
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use utoipa::ToSchema;

/// Base URL of the public OpenAlbion API.
const BASE_URL: &str = "https://api.openalbion.com/api/v3";

/// Base URL of Sandbox Interactive's public item render service.
const RENDER_ITEM_BASE_URL: &str = "https://render.albiononline.com/v1/item";

/// Generic `{"data": [...]}` list envelope used by every OpenAlbion list endpoint.
#[derive(Debug, Deserialize)]
struct OpenAlbionListResponse<T> {
    data: Vec<T>,
}

/// An item category (e.g. "Swords", "Bows"), optionally nested under a parent category type.
/// `subcategories` recurses to arbitrary depth (marked `no_recursion` in the OpenAPI schema only
/// to avoid an infinite schema definition — the actual JSON payload nests normally).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[schema(example = json!({
    "id": 1,
    "name": "Swords",
    "type": "weapon",
    "subcategories": [ { "id": 11, "name": "One-Handed Swords", "type": "weapon", "subcategories": [] } ]
}))]
pub struct OpenAlbionCategory {
    #[schema(example = 1)]
    pub id: i64,
    #[schema(example = "Swords")]
    pub name: String,
    /// Top-level branch this category belongs to, e.g. `"weapon"`, `"armor"`, `"accessory"`,
    /// `"consumable"`. Present on top-level categories; typically absent on nested subcategories.
    #[serde(rename = "type", default)]
    #[schema(example = "weapon")]
    pub category_type: Option<String>,
    /// Nested subcategories, if any (e.g. "Swords" -> "One-Handed Swords" / "Dual Swords" /
    /// "Claymores"). Empty for leaf categories.
    #[serde(default)]
    #[schema(no_recursion)]
    pub subcategories: Vec<OpenAlbionCategory>,
}

/// A single weapon entry as returned by `GET /openalbion/weapons`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[schema(example = json!({
    "id": 42,
    "name": "Broadsword",
    "tier": "4",
    "item_power": 900,
    "icon": "https://cdn.openalbion.com/icons/T4_MAIN_SWORD.png"
}))]
pub struct OpenAlbionWeapon {
    /// Pass this to `GET /openalbion/weapons/{id}/stats`.
    #[schema(example = 42)]
    pub id: i64,
    #[schema(example = "Broadsword")]
    pub name: String,
    /// Base tier as a string, e.g. `"4"` or `"4.1"` for tier 4 with 1 enchantment baked into the
    /// item name.
    #[serde(default)]
    #[schema(example = "4")]
    pub tier: Option<String>,
    #[serde(default)]
    #[schema(example = 900)]
    pub item_power: Option<i64>,
    #[serde(default)]
    #[schema(example = "https://cdn.openalbion.com/icons/T4_MAIN_SWORD.png")]
    pub icon: Option<String>,
}

/// A single named stat value (e.g. "Physical damage" -> 125) on a weapon quality tier. `value`
/// is untyped JSON because OpenAlbion mixes numbers and strings across different stat names.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[schema(example = json!({ "name": "Physical damage", "value": 125 }))]
pub struct OpenAlbionStatEntry {
    #[schema(example = "Physical damage")]
    pub name: String,
    #[schema(value_type = Object, example = json!(125))]
    pub value: serde_json::Value,
}

/// Stats for a single quality tier (Normal, Good, Outstanding, Excellent, Masterpiece) of a
/// weapon at a given enchantment level, as returned nested inside `OpenAlbionWeaponStats`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct OpenAlbionWeaponQualityStat {
    #[schema(example = 1)]
    pub id: i64,
    /// One of `"Normal"`, `"Good"`, `"Outstanding"`, `"Excellent"`, `"Masterpiece"`.
    #[serde(default)]
    #[schema(example = "Masterpiece")]
    pub quality: Option<String>,
    /// Enchantment level (0-4), matching the parent `OpenAlbionWeaponStats.enchantment`.
    #[serde(default)]
    #[schema(example = 3)]
    pub enchantment: Option<i64>,
    pub weapon: OpenAlbionWeapon,
    #[serde(default)]
    pub stats: Vec<OpenAlbionStatEntry>,
}

/// Full stats payload for one weapon at one enchantment level, as returned (as an array, one
/// entry per enchantment level 0-4) by `GET /openalbion/weapons/{id}/stats`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct OpenAlbionWeaponStats {
    #[serde(default)]
    #[schema(example = 3)]
    pub enchantment: Option<i64>,
    #[serde(default)]
    #[schema(example = "https://cdn.openalbion.com/icons/T4_MAIN_SWORD@3.png")]
    pub icon: Option<String>,
    #[serde(default)]
    pub stats: Vec<OpenAlbionWeaponQualityStat>,
}

/// Type of OpenAlbion item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum OpenAlbionItemType {
    /// Weapon item.
    Weapon,
    /// Armor item.
    Armor,
    /// Accessory item.
    Accessory,
    /// Consumable item.
    Consumable,
}

impl OpenAlbionItemType {
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Weapon => "weapon",
            Self::Armor => "armor",
            Self::Accessory => "accessory",
            Self::Consumable => "consumable",
        }
    }
}

impl FromStr for OpenAlbionItemType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "weapon" => Ok(Self::Weapon),
            "armor" => Ok(Self::Armor),
            "accessory" => Ok(Self::Accessory),
            "consumable" => Ok(Self::Consumable),
            other => Err(format!("unknown OpenAlbion item type: {other}")),
        }
    }
}

/// A unified item entry that can represent any of the 4 OpenAlbion item types.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[schema(example = json!({
    "id": 42,
    "name": "Broadsword",
    "tier": "4",
    "item_power": 900,
    "type": "weapon",
    "identifier": "T4_MAIN_SWORD",
    "icon": "https://render.albiononline.com/v1/item/T4_MAIN_SWORD.png?quality=1&size=64",
    "info": "Additional consumable info"
}))]
pub struct OpenAlbionItem {
    /// Pass this to detail endpoints (if any exist for the item type).
    #[schema(example = 42)]
    pub id: i64,
    #[schema(example = "Broadsword")]
    pub name: String,
    /// Base tier as a string, e.g. `"4"` or `"4.1"` for tier 4 with 1 enchantment.
    #[serde(default)]
    #[schema(example = "4")]
    pub tier: Option<String>,
    #[serde(default)]
    #[schema(example = 900)]
    pub item_power: Option<i64>,
    /// Item branch (`weapon`, `armor`, `accessory`, or `consumable`) used by build slots.
    #[serde(rename = "type", default)]
    #[schema(example = "weapon")]
    pub item_type: Option<String>,
    /// Item identifier unique string (present on armor, accessory, consumable).
    #[serde(default)]
    #[schema(example = "T4_MAIN_SWORD")]
    pub identifier: Option<String>,
    #[serde(default)]
    #[schema(example = "https://cdn.openalbion.com/icons/T4_MAIN_SWORD.png")]
    pub icon: Option<String>,
    /// Additional info string (present on consumables).
    #[serde(default)]
    #[schema(example = "Additional consumable info")]
    pub info: Option<String>,
}

/// Optional filters accepted by `/weapons`, `/armors`, `/accessories`, `/consumables`.
#[derive(Debug, Clone, Default)]
pub struct OpenAlbionWeaponFilters {
    pub category_id: Option<i64>,
    pub subcategory_id: Option<i64>,
    pub tier: Option<i64>,
}

/// Thin typed HTTP client for the public OpenAlbion item database API.
#[derive(Clone)]
pub struct OpenAlbionApiClient {
    http: reqwest::Client,
}

impl OpenAlbionApiClient {
    #[must_use]
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::new(),
        }
    }

    async fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T, AppError> {
        let url = format!("{BASE_URL}{path}");

        let response = self.http.get(&url).send().await.map_err(|e| {
            AppError::UpstreamService(format!("Failed to contact OpenAlbion API: {e}"))
        })?;

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(AppError::NotFound(format!(
                "OpenAlbion resource not found: {url}"
            )));
        }

        if !response.status().is_success() {
            return Err(AppError::UpstreamService(format!(
                "OpenAlbion API returned {} for {url}",
                response.status()
            )));
        }

        response.json::<T>().await.map_err(|e| {
            AppError::UpstreamService(format!(
                "Failed to parse OpenAlbion API response from {url}: {e}"
            ))
        })
    }

    /// Fetches item categories, optionally filtered by top-level type (e.g. "weapon", "armor").
    pub async fn get_categories(
        &self,
        category_type: Option<&str>,
    ) -> Result<Vec<OpenAlbionCategory>, AppError> {
        let path = match category_type {
            Some(t) => format!("/categories?type={}", urlencoding::encode(t)),
            None => "/categories".to_string(),
        };
        let res: OpenAlbionListResponse<OpenAlbionCategory> = self.get_json(&path).await?;
        Ok(res.data)
    }

    /// Fetches the full weapon catalog, optionally narrowed by category, subcategory, or tier.
    pub async fn get_weapons(
        &self,
        filters: &OpenAlbionWeaponFilters,
    ) -> Result<Vec<OpenAlbionWeapon>, AppError> {
        let mut query = Vec::new();
        if let Some(v) = filters.category_id {
            query.push(format!("category_id={v}"));
        }
        if let Some(v) = filters.subcategory_id {
            query.push(format!("subcategory_id={v}"));
        }
        if let Some(v) = filters.tier {
            query.push(format!("tier={v}"));
        }

        let path = if query.is_empty() {
            "/weapons".to_string()
        } else {
            format!("/weapons?{}", query.join("&"))
        };

        let res: OpenAlbionListResponse<OpenAlbionWeapon> = self.get_json(&path).await?;
        Ok(res.data.into_iter().map(normalize_weapon_icon).collect())
    }

    /// Fetches per-quality-tier stats for a single weapon by ID.
    pub async fn get_weapon_stats(
        &self,
        weapon_id: i64,
    ) -> Result<Vec<OpenAlbionWeaponStats>, AppError> {
        let res: OpenAlbionListResponse<OpenAlbionWeaponStats> = self
            .get_json(&format!("/weapon-stats/weapon/{weapon_id}"))
            .await?;
        Ok(res.data)
    }

    /// Fetches the full armor catalog, optionally narrowed by category, subcategory, or tier.
    pub async fn get_armors(
        &self,
        filters: &OpenAlbionWeaponFilters,
    ) -> Result<Vec<OpenAlbionItem>, AppError> {
        let mut query = Vec::new();
        if let Some(v) = filters.category_id {
            query.push(format!("category_id={v}"));
        }
        if let Some(v) = filters.subcategory_id {
            query.push(format!("subcategory_id={v}"));
        }
        if let Some(v) = filters.tier {
            query.push(format!("tier={v}"));
        }

        let path = if query.is_empty() {
            "/armors".to_string()
        } else {
            format!("/armors?{}", query.join("&"))
        };

        let res: OpenAlbionListResponse<OpenAlbionItem> = self.get_json(&path).await?;
        Ok(res
            .data
            .into_iter()
            .map(|item| normalize_item(item, "armor"))
            .collect())
    }

    /// Fetches the full accessory catalog, optionally narrowed by category, subcategory, or tier.
    pub async fn get_accessories(
        &self,
        filters: &OpenAlbionWeaponFilters,
    ) -> Result<Vec<OpenAlbionItem>, AppError> {
        let mut query = Vec::new();
        if let Some(v) = filters.category_id {
            query.push(format!("category_id={v}"));
        }
        if let Some(v) = filters.subcategory_id {
            query.push(format!("subcategory_id={v}"));
        }
        if let Some(v) = filters.tier {
            query.push(format!("tier={v}"));
        }

        let path = if query.is_empty() {
            "/accessories".to_string()
        } else {
            format!("/accessories?{}", query.join("&"))
        };

        let res: OpenAlbionListResponse<OpenAlbionItem> = self.get_json(&path).await?;
        Ok(res
            .data
            .into_iter()
            .map(|item| normalize_item(item, "accessory"))
            .collect())
    }

    /// Fetches the full consumable catalog, optionally narrowed by category, subcategory, or tier.
    pub async fn get_consumables(
        &self,
        filters: &OpenAlbionWeaponFilters,
    ) -> Result<Vec<OpenAlbionItem>, AppError> {
        let mut query = Vec::new();
        if let Some(v) = filters.category_id {
            query.push(format!("category_id={v}"));
        }
        if let Some(v) = filters.subcategory_id {
            query.push(format!("subcategory_id={v}"));
        }
        if let Some(v) = filters.tier {
            query.push(format!("tier={v}"));
        }

        let path = if query.is_empty() {
            "/consumables".to_string()
        } else {
            format!("/consumables?{}", query.join("&"))
        };

        let res: OpenAlbionListResponse<OpenAlbionItem> = self.get_json(&path).await?;
        Ok(res
            .data
            .into_iter()
            .map(|item| normalize_item(item, "consumable"))
            .collect())
    }

    /// Fetches weapons and maps them to `OpenAlbionItem` (identifier and info are `None`).
    async fn get_weapons_as_items(
        &self,
        filters: &OpenAlbionWeaponFilters,
    ) -> Result<Vec<OpenAlbionItem>, AppError> {
        let weapons = self.get_weapons(filters).await?;
        Ok(weapons
            .into_iter()
            .map(|w| OpenAlbionItem {
                id: w.id,
                name: w.name,
                tier: w.tier,
                item_power: w.item_power,
                item_type: Some("weapon".to_string()),
                identifier: item_identifier_from_icon(w.icon.as_deref()),
                icon: w.icon,
                info: None,
            })
            .collect())
    }

    /// Unified dispatch method to fetch any item type.
    pub fn get_items(
        &self,
        item_type: OpenAlbionItemType,
        filters: &OpenAlbionWeaponFilters,
    ) -> impl std::future::Future<Output = Result<Vec<OpenAlbionItem>, AppError>> + 'static {
        let client = self.clone();
        let filters = filters.clone();
        async move {
            match item_type {
                OpenAlbionItemType::Weapon => client.get_weapons_as_items(&filters).await,
                OpenAlbionItemType::Armor => client.get_armors(&filters).await,
                OpenAlbionItemType::Accessory => client.get_accessories(&filters).await,
                OpenAlbionItemType::Consumable => client.get_consumables(&filters).await,
            }
        }
    }
}

impl Default for OpenAlbionApiClient {
    fn default() -> Self {
        Self::new()
    }
}

fn normalize_weapon_icon(mut weapon: OpenAlbionWeapon) -> OpenAlbionWeapon {
    weapon.icon = render_icon_url_from_identifier_or_icon(None, weapon.icon.as_deref());
    weapon
}

fn normalize_item(mut item: OpenAlbionItem, fallback_item_type: &str) -> OpenAlbionItem {
    if item.item_type.is_none() {
        item.item_type = Some(fallback_item_type.to_string());
    }
    item.icon =
        render_icon_url_from_identifier_or_icon(item.identifier.as_deref(), item.icon.as_deref());
    item
}

fn render_icon_url_from_identifier_or_icon(
    identifier: Option<&str>,
    icon_url: Option<&str>,
) -> Option<String> {
    let item_id = identifier
        .filter(|value| !value.trim().is_empty())
        .map(str::trim)
        .map(ToString::to_string)
        .or_else(|| item_identifier_from_icon(icon_url));
    item_id.map(|value| {
        format!(
            "{RENDER_ITEM_BASE_URL}/{}.png?quality=1&size=64",
            urlencoding::encode(&value)
        )
    })
}

fn item_identifier_from_icon(icon_url: Option<&str>) -> Option<String> {
    let file_name = icon_url?.rsplit('/').next()?;
    let item_id = file_name
        .strip_suffix(".png")
        .unwrap_or(file_name)
        .split('?')
        .next()?
        .split('@')
        .next()?
        .trim();

    if item_id.is_empty() {
        None
    } else {
        Some(item_id.to_string())
    }
}
