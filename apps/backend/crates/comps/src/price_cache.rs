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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use super::models::{BuildPriceView, CompPriceView};

/// How long a computed price stays fresh.
const TTL: Duration = Duration::from_secs(300);

/// Cache key: tenant, pricing location (prices differ by city), and the build or comp id.
type Key = (String, String, i64);

/// Thread-safe price cache. Cloning shares the same storage.
///
/// Only successful prices are ever stored (callers must not `put` a failure), and an edit to a
/// build or comp evicts its entries through the `invalidate_*` methods. Each eviction also bumps
/// an epoch: a price computed from data read *before* the edit carries the old epoch and is
/// refused by `put_*`, so a slow in-flight request cannot re-insert a stale total after the
/// eviction.
#[derive(Debug, Clone, Default)]
pub struct PriceCache {
    builds: Arc<RwLock<HashMap<Key, (Instant, BuildPriceView)>>>,
    comps: Arc<RwLock<HashMap<Key, (Instant, CompPriceView)>>>,
    epoch: Arc<AtomicU64>,
}

impl PriceCache {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The current eviction epoch. Read it *before* loading the data a price is computed from and
    /// hand it back to `put_build`/`put_comp`.
    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// Evicts every cached price of one build (all pricing locations) for `tenant_id`.
    pub fn invalidate_build(&self, tenant_id: &str, build_id: i64) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut guard) = self.builds.write() {
            guard.retain(|(tenant, _, id), _| !(tenant == tenant_id && *id == build_id));
        }
    }

    /// Evicts every cached price of one comp (all pricing locations) for `tenant_id`.
    pub fn invalidate_comp(&self, tenant_id: &str, comp_id: i64) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut guard) = self.comps.write() {
            guard.retain(|(tenant, _, id), _| !(tenant == tenant_id && *id == comp_id));
        }
    }

    /// Evicts every cached comp price for `tenant_id`; the fallback when the comps that contain
    /// an edited build cannot be looked up.
    pub fn invalidate_all_comps(&self, tenant_id: &str) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut guard) = self.comps.write() {
            guard.retain(|(tenant, _, _), _| tenant != tenant_id);
        }
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

    /// Stores a freshly computed build price, unless an eviction happened since `epoch` was read.
    pub fn put_build(
        &self,
        epoch: u64,
        tenant_id: &str,
        pricing_location: &str,
        build_id: i64,
        view: &BuildPriceView,
    ) {
        let Ok(mut guard) = self.builds.write() else {
            return;
        };
        if self.epoch() != epoch {
            return;
        }
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

    /// Stores a freshly computed comp price, unless an eviction happened since `epoch` was read.
    pub fn put_comp(
        &self,
        epoch: u64,
        tenant_id: &str,
        pricing_location: &str,
        comp_id: i64,
        view: &CompPriceView,
    ) {
        let Ok(mut guard) = self.comps.write() else {
            return;
        };
        if self.epoch() != epoch {
            return;
        }
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
            unpriced_item_count: 0,
            priced_at: "2026-09-08T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn stores_and_returns_a_build_price() {
        let cache = PriceCache::new();
        assert!(cache.get_build("t1", "Caerleon", 1).is_none());
        cache.put_build(cache.epoch(), "t1", "Caerleon", 1, &build_view(1));
        assert!(cache.get_build("t1", "Caerleon", 1).is_some());
    }

    #[test]
    fn different_tenants_do_not_collide() {
        let cache = PriceCache::new();
        cache.put_build(cache.epoch(), "guild-a", "Caerleon", 1, &build_view(1));
        assert!(cache.get_build("guild-b", "Caerleon", 1).is_none());
        assert!(cache.get_build("guild-a", "Caerleon", 1).is_some());
    }

    #[test]
    fn different_pricing_locations_do_not_collide() {
        let cache = PriceCache::new();
        cache.put_build(cache.epoch(), "t1", "Caerleon", 1, &build_view(1));
        assert!(cache.get_build("t1", "Bridgewatch", 1).is_none());
    }

    #[test]
    fn build_and_comp_caches_are_independent() {
        let cache = PriceCache::new();
        cache.put_build(cache.epoch(), "t1", "Caerleon", 5, &build_view(5));
        assert!(cache.get_comp("t1", "Caerleon", 5).is_none());
    }

    fn comp_view(id: i64) -> CompPriceView {
        CompPriceView {
            comp_id: id,
            builds: Vec::new(),
            total: Decimal::ZERO,
            unpriced_item_count: 0,
            priced_at: "2026-09-08T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn invalidating_a_build_evicts_every_location_but_only_that_build_and_tenant() {
        let cache = PriceCache::new();
        cache.put_build(cache.epoch(), "t1", "Caerleon", 1, &build_view(1));
        cache.put_build(cache.epoch(), "t1", "Bridgewatch", 1, &build_view(1));
        cache.put_build(cache.epoch(), "t1", "Caerleon", 2, &build_view(2));
        cache.put_build(cache.epoch(), "t2", "Caerleon", 1, &build_view(1));

        cache.invalidate_build("t1", 1);

        assert!(cache.get_build("t1", "Caerleon", 1).is_none());
        assert!(cache.get_build("t1", "Bridgewatch", 1).is_none());
        assert!(cache.get_build("t1", "Caerleon", 2).is_some());
        assert!(cache.get_build("t2", "Caerleon", 1).is_some());
    }

    #[test]
    fn invalidating_a_comp_evicts_only_that_comp() {
        let cache = PriceCache::new();
        cache.put_comp(cache.epoch(), "t1", "Caerleon", 1, &comp_view(1));
        cache.put_comp(cache.epoch(), "t1", "Caerleon", 2, &comp_view(2));

        cache.invalidate_comp("t1", 1);

        assert!(cache.get_comp("t1", "Caerleon", 1).is_none());
        assert!(cache.get_comp("t1", "Caerleon", 2).is_some());

        cache.invalidate_all_comps("t1");
        assert!(cache.get_comp("t1", "Caerleon", 2).is_none());
    }

    #[test]
    fn a_price_computed_before_an_eviction_is_not_stored() {
        let cache = PriceCache::new();
        let epoch_before_read = cache.epoch();
        // An edit lands while the price is still being computed.
        cache.invalidate_build("t1", 1);
        cache.put_build(epoch_before_read, "t1", "Caerleon", 1, &build_view(1));
        assert!(cache.get_build("t1", "Caerleon", 1).is_none());

        cache.put_build(cache.epoch(), "t1", "Caerleon", 1, &build_view(1));
        assert!(cache.get_build("t1", "Caerleon", 1).is_some());
    }
}
