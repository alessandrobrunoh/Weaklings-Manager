//! Short-lived in-process cache for comp/build market prices.
//!
//! Modeled directly on `intel::cache::ReportCache`: pricing a build or comp means at least one
//! live call to the Albion Online Data Project, and a comp/build detail page can be opened
//! repeatedly in quick succession (tab switches, multiple officers) without the underlying
//! market actually moving in that window, so serving a few-minutes-old price costs nothing in
//! accuracy and saves a network round trip on every repeat view.
//!
//! One cache is shared by every tenant (registered once, globally, exactly like
//! `ReportCache`), so the tenant id is the first component of each key — without it, one guild's
//! prices (and its chosen `pricing_location`) would leak into another's identical lookup.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use super::models::{BuildPriceView, CompPriceView};

/// How long a computed price stays fresh.
const TTL: Duration = Duration::from_secs(300);

/// Cache key: tenant, pricing location (prices differ by city), and the build or comp id.
type Key = (String, String, i64);

/// Thread-safe price cache. Cloning shares the same storage.
#[derive(Debug, Clone, Default)]
pub struct PriceCache {
    builds: Arc<RwLock<HashMap<Key, (Instant, BuildPriceView)>>>,
    comps: Arc<RwLock<HashMap<Key, (Instant, CompPriceView)>>>,
}

impl PriceCache {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns a cached build price for `tenant_id`/`pricing_location` when still fresh.
    ///
    /// A poisoned lock is treated as a miss rather than a panic: a failed cache should degrade to
    /// recomputation, never take the endpoint down.
    #[must_use]
    pub fn get_build(
        &self,
        tenant_id: &str,
        pricing_location: &str,
        build_id: i64,
    ) -> Option<BuildPriceView> {
        let guard = self.builds.read().ok()?;
        let (stored_at, view) =
            guard.get(&(tenant_id.to_owned(), pricing_location.to_owned(), build_id))?;
        (stored_at.elapsed() < TTL).then(|| view.clone())
    }

    /// Stores a freshly computed build price.
    pub fn put_build(
        &self,
        tenant_id: &str,
        pricing_location: &str,
        build_id: i64,
        view: &BuildPriceView,
    ) {
        let Ok(mut guard) = self.builds.write() else {
            return;
        };
        guard.retain(|_, (stored_at, _)| stored_at.elapsed() < TTL);
        guard.insert(
            (tenant_id.to_owned(), pricing_location.to_owned(), build_id),
            (Instant::now(), view.clone()),
        );
    }

    /// Returns a cached comp price for `tenant_id`/`pricing_location` when still fresh.
    #[must_use]
    pub fn get_comp(
        &self,
        tenant_id: &str,
        pricing_location: &str,
        comp_id: i64,
    ) -> Option<CompPriceView> {
        let guard = self.comps.read().ok()?;
        let (stored_at, view) =
            guard.get(&(tenant_id.to_owned(), pricing_location.to_owned(), comp_id))?;
        (stored_at.elapsed() < TTL).then(|| view.clone())
    }

    /// Stores a freshly computed comp price.
    pub fn put_comp(
        &self,
        tenant_id: &str,
        pricing_location: &str,
        comp_id: i64,
        view: &CompPriceView,
    ) {
        let Ok(mut guard) = self.comps.write() else {
            return;
        };
        guard.retain(|_, (stored_at, _)| stored_at.elapsed() < TTL);
        guard.insert(
            (tenant_id.to_owned(), pricing_location.to_owned(), comp_id),
            (Instant::now(), view.clone()),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::prelude::Decimal;

    fn build_view(id: i64) -> BuildPriceView {
        BuildPriceView {
            build_id: id,
            items: Vec::new(),
            total: Decimal::ZERO,
            priced_at: "2026-09-08T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn stores_and_returns_a_build_price() {
        let cache = PriceCache::new();
        assert!(cache.get_build("t1", "Caerleon", 1).is_none());
        cache.put_build("t1", "Caerleon", 1, &build_view(1));
        assert!(cache.get_build("t1", "Caerleon", 1).is_some());
    }

    #[test]
    fn different_tenants_do_not_collide() {
        let cache = PriceCache::new();
        cache.put_build("guild-a", "Caerleon", 1, &build_view(1));
        assert!(cache.get_build("guild-b", "Caerleon", 1).is_none());
        assert!(cache.get_build("guild-a", "Caerleon", 1).is_some());
    }

    #[test]
    fn different_pricing_locations_do_not_collide() {
        let cache = PriceCache::new();
        cache.put_build("t1", "Caerleon", 1, &build_view(1));
        assert!(cache.get_build("t1", "Bridgewatch", 1).is_none());
    }

    #[test]
    fn build_and_comp_caches_are_independent() {
        let cache = PriceCache::new();
        cache.put_build("t1", "Caerleon", 5, &build_view(5));
        assert!(cache.get_comp("t1", "Caerleon", 5).is_none());
    }
}
