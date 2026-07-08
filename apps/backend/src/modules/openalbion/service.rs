//! `OpenAlbion` service logic module.
//!
//! `OpenAlbionService` wraps the generic OpenAlbion API client and adds an in-memory cache of
//! the full weapon catalog (reference data that changes only on Albion Online patches) plus
//! local name/tier filtering and pagination, mirroring `AlbionService`'s guild roster search.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use crate::errors::AppError;
use crate::pagination::{PaginatedData, PaginationParams};
use super::client::{
    OpenAlbionApiClient, OpenAlbionCategory, OpenAlbionItem, OpenAlbionItemType,
    OpenAlbionWeapon, OpenAlbionWeaponFilters, OpenAlbionWeaponStats,
};

/// How long cached item catalogs are considered fresh before being refetched.
const WEAPON_CACHE_TTL: Duration = Duration::from_secs(60 * 60);

/// The cached weapon catalog together with the instant it was fetched.
type WeaponCache = Arc<RwLock<Option<(Instant, Vec<OpenAlbionWeapon>)>>>;

/// The cached item catalog (per item type) together with the instant it was fetched.
type ItemCache = Arc<RwLock<HashMap<OpenAlbionItemType, (Instant, Vec<OpenAlbionItem>)>>>;

/// Service exposing OpenAlbion item database operations, with a cached weapon catalog.
#[derive(Clone)]
pub struct OpenAlbionService {
    client: OpenAlbionApiClient,
    weapon_cache: WeaponCache,
    item_cache: ItemCache,
}

impl OpenAlbionService {
    #[must_use]
    pub fn new() -> Self {
        Self {
            client: OpenAlbionApiClient::new(),
            weapon_cache: Arc::new(RwLock::new(None)),
            item_cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Returns the full weapon catalog, serving from cache when fresh.
    async fn get_all_weapons_cached(&self) -> Result<Vec<OpenAlbionWeapon>, AppError> {
        if let Some((fetched_at, weapons)) = self.weapon_cache.read().await.as_ref()
            && fetched_at.elapsed() < WEAPON_CACHE_TTL
        {
            return Ok(weapons.clone());
        }

        let weapons = self.client.get_weapons(&OpenAlbionWeaponFilters::default()).await?;
        *self.weapon_cache.write().await = Some((Instant::now(), weapons.clone()));
        Ok(weapons)
    }

    /// Lists weapons, optionally filtered by category/subcategory/tier and a name substring,
    /// paginated locally. Category/subcategory filters bypass the cache and hit the upstream
    /// API directly, since the cached catalog doesn't carry category membership per weapon.
    pub async fn list_weapons(
        &self,
        filters: &OpenAlbionWeaponFilters,
        query: Option<&str>,
        pagination: &PaginationParams,
    ) -> Result<PaginatedData<OpenAlbionWeapon>, AppError> {
        let mut weapons = if filters.category_id.is_some() || filters.subcategory_id.is_some() {
            self.client.get_weapons(filters).await?
        } else {
            self.get_all_weapons_cached().await?
        };

        if let Some(tier) = filters.tier {
            let needle = tier.to_string();
            weapons.retain(|w| w.tier.as_deref().is_some_and(|t| t.starts_with(&needle)));
        }

        if let Some(q) = query.filter(|q| !q.trim().is_empty()) {
            let needle = q.to_lowercase();
            weapons.retain(|w| w.name.to_lowercase().contains(&needle));
        }

        let total_items = weapons.len() as u64;
        let limit = pagination.limit();
        let page = pagination.offset_page();
        let total_pages = if limit == 0 { 0 } else { total_items.div_ceil(limit) };

        let start = (page * limit) as usize;
        let items = weapons.into_iter().skip(start).take(limit as usize).collect();

        Ok(PaginatedData::new(items, total_items, total_pages, page + 1, limit))
    }

    /// Fetches item categories, optionally filtered by top-level type (e.g. "weapon").
    pub async fn list_categories(&self, category_type: Option<&str>) -> Result<Vec<OpenAlbionCategory>, AppError> {
        self.client.get_categories(category_type).await
    }

    /// Returns the full catalog for a given item type, serving from cache when fresh.
    async fn get_all_items_cached(&self, item_type: OpenAlbionItemType) -> Result<Vec<OpenAlbionItem>, AppError> {
        if let Some((fetched_at, items)) = self.item_cache.read().await.get(&item_type)
            && fetched_at.elapsed() < WEAPON_CACHE_TTL
        {
            return Ok(items.clone());
        }

        let items = self
            .client
            .get_items(item_type, &OpenAlbionWeaponFilters::default())
            .await?;
        self.item_cache
            .write()
            .await
            .insert(item_type, (Instant::now(), items.clone()));
        Ok(items)
    }

    /// Lists items of any type (weapon/armor/accessory/consumable), optionally filtered
    /// by category/subcategory/tier and a name substring, paginated locally.
    /// Category/subcategory filters bypass the cache and hit the upstream API directly.
    pub async fn list_items(
        &self,
        item_type: OpenAlbionItemType,
        filters: &OpenAlbionWeaponFilters,
        query: Option<&str>,
        pagination: &PaginationParams,
    ) -> Result<PaginatedData<OpenAlbionItem>, AppError> {
        let mut items = if filters.category_id.is_some() || filters.subcategory_id.is_some() {
            self.client
                .get_items(item_type, filters)
                .await?
        } else {
            self.get_all_items_cached(item_type).await?
        };

        if let Some(tier) = filters.tier {
            let needle = tier.to_string();
            items.retain(|w| w.tier.as_deref().is_some_and(|t| t.starts_with(&needle)));
        }

        if let Some(q) = query.filter(|q| !q.trim().is_empty()) {
            let needle = q.to_lowercase();
            items.retain(|w| w.name.to_lowercase().contains(&needle));
        }

        let total_items = items.len() as u64;
        let limit = pagination.limit();
        let page = pagination.offset_page();
        let total_pages = if limit == 0 { 0 } else { total_items.div_ceil(limit) };

        let start = (page * limit) as usize;
        let items = items.into_iter().skip(start).take(limit as usize).collect();

        Ok(PaginatedData::new(items, total_items, total_pages, page + 1, limit))
    }

    /// Fetches per-quality-tier stats for a single weapon by ID.
    pub async fn get_weapon_stats(&self, weapon_id: i64) -> Result<Vec<OpenAlbionWeaponStats>, AppError> {
        self.client.get_weapon_stats(weapon_id).await
    }
}

impl Default for OpenAlbionService {
    fn default() -> Self {
        Self::new()
    }
}
