//! Short-lived in-process cache for the guild report.
//!
//! The report is expensive by nature: it folds a dozen tables into one answer.
//! It is also read a handful of times a day by a handful of officers, and its
//! inputs change on a two-minute worker tick, so serving a few-minute-old copy
//! costs nothing in accuracy and saves the whole computation on every repeat
//! view and tab switch.
//!
//! Deliberately in-process: there is no cache infrastructure in this service,
//! and introducing one for a dashboard read would be a larger change than the
//! feature. A restart simply recomputes.
//!
//! One `ReportCache` is shared by every tenant, so the tenant id is the first
//! component of [`Key`]. It has to be: the default window is "the last 30 days
//! ending now" truncated to the hour, which is identical for everyone, so a
//! key without the tenant would hand the first caller's report to every other
//! guild for the next [`TTL`].

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use crate::modules::intel::report::{DateRange, GuildReport};

/// How long a computed report stays fresh.
const TTL: Duration = Duration::from_secs(300);

/// Cache key: the tenant, then the window truncated to the hour, plus a
/// granularity flag (0 = week, 1 = day).
///
/// Truncation is what makes the cache actually hit. The default window is
/// "the last 30 days ending now", so without it every request would carry a
/// slightly different `to` and miss. The tenant id is what keeps that hit from
/// crossing a guild boundary.
type Key = (String, i64, i64, u8);

/// Thread-safe report cache. Cloning shares the same storage.
#[derive(Debug, Clone, Default)]
pub struct ReportCache {
    entries: Arc<RwLock<HashMap<Key, (Instant, GuildReport)>>>,
}

impl ReportCache {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn key(tenant_id: &str, range: DateRange, granularity: &str) -> Key {
        const HOUR: i64 = 3600;
        let g = if granularity.eq_ignore_ascii_case("day") {
            1
        } else {
            0
        };
        (
            tenant_id.to_owned(),
            range.from.timestamp() / HOUR,
            range.to.timestamp() / HOUR,
            g,
        )
    }

    /// Returns a cached report for `tenant_id` when one is still fresh.
    ///
    /// A poisoned lock is treated as a miss rather than a panic: a failed
    /// cache should degrade to recomputation, never take the endpoint down.
    #[must_use]
    pub fn get(&self, tenant_id: &str, range: DateRange, granularity: &str) -> Option<GuildReport> {
        let guard = self.entries.read().ok()?;
        let (stored_at, report) = guard.get(&Self::key(tenant_id, range, granularity))?;
        (stored_at.elapsed() < TTL).then(|| report.clone())
    }

    /// Stores a freshly computed report under `tenant_id`.
    pub fn put(&self, tenant_id: &str, range: DateRange, granularity: &str, report: &GuildReport) {
        let Ok(mut guard) = self.entries.write() else {
            return;
        };
        // Drop anything already stale so the map cannot grow without bound
        // across many distinct windows and tenants.
        guard.retain(|_, (stored_at, _)| stored_at.elapsed() < TTL);
        guard.insert(
            Self::key(tenant_id, range, granularity),
            (Instant::now(), report.clone()),
        );
    }

    /// Drops `tenant_id`'s cached reports, forcing its next read to recompute.
    ///
    /// Scoped to one tenant on purpose: a manual refresh in one guild is not a
    /// reason to throw away every other guild's computation.
    pub fn invalidate(&self, tenant_id: &str) {
        if let Ok(mut guard) = self.entries.write() {
            guard.retain(|(cached_tenant, ..), _| cached_tenant != tenant_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn range(from: &str, to: &str) -> DateRange {
        DateRange::resolve(Some(from), Some(to)).unwrap()
    }

    #[test]
    fn windows_within_the_same_hour_share_a_key() {
        let a = range("2026-08-01T00:10:00Z", "2026-08-30T12:05:00Z");
        let b = range("2026-08-01T00:50:00Z", "2026-08-30T12:55:00Z");
        assert_eq!(
            ReportCache::key("t1", a, "week"),
            ReportCache::key("t1", b, "week")
        );
    }

    #[test]
    fn different_hours_do_not_collide() {
        let a = range("2026-08-01T00:00:00Z", "2026-08-30T12:00:00Z");
        let b = range("2026-08-01T00:00:00Z", "2026-08-30T13:00:00Z");
        assert_ne!(
            ReportCache::key("t1", a, "week"),
            ReportCache::key("t1", b, "week")
        );
    }

    #[test]
    fn different_granularities_do_not_collide() {
        let a = range("2026-08-01T00:00:00Z", "2026-08-30T12:00:00Z");
        assert_ne!(
            ReportCache::key("t1", a, "day"),
            ReportCache::key("t1", a, "week")
        );
    }

    #[test]
    fn different_tenants_do_not_collide() {
        let a = range("2026-08-01T00:00:00Z", "2026-08-30T12:00:00Z");
        assert_ne!(
            ReportCache::key("t1", a, "week"),
            ReportCache::key("t2", a, "week")
        );
    }

    #[test]
    fn stores_and_returns_a_report() {
        let cache = ReportCache::new();
        let r = range("2026-08-01T00:00:00Z", "2026-08-30T00:00:00Z");
        assert!(cache.get("t1", r, "week").is_none());
        cache.put("t1", r, "week", &GuildReport::default());
        assert!(cache.get("t1", r, "week").is_some());
        assert!(cache.get("t1", r, "day").is_none());
    }

    /// The leak this key shape exists to prevent: the default window is the
    /// same for every guild, so one tenant's report must never satisfy
    /// another's identical lookup.
    #[test]
    fn a_tenants_report_never_answers_another_tenants_lookup() {
        let cache = ReportCache::new();
        let r = range("2026-08-01T00:00:00Z", "2026-08-30T00:00:00Z");
        cache.put("guild-a", r, "week", &GuildReport::default());
        assert!(cache.get("guild-b", r, "week").is_none());
        assert!(cache.get("guild-a", r, "week").is_some());
    }

    #[test]
    fn invalidate_clears_only_that_tenant() {
        let cache = ReportCache::new();
        let r = range("2026-08-01T00:00:00Z", "2026-08-30T00:00:00Z");
        cache.put("guild-a", r, "week", &GuildReport::default());
        cache.put("guild-b", r, "week", &GuildReport::default());
        cache.invalidate("guild-a");
        assert!(cache.get("guild-a", r, "week").is_none());
        assert!(cache.get("guild-b", r, "week").is_some());
    }
}
