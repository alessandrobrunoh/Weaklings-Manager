//! Short-lived in-process cache for the guild report.
//!
//! The report is expensive by nature: it folds a dozen tables into one answer.
//! It is also read a handful of times a day by a handful of officers, and its
//! inputs change on a two-minute worker tick, so serving a few-minute-old copy
//! costs nothing in accuracy and saves the whole computation on every repeat
//! view and tab switch.
//!
//! Deliberately in-process and unshared: there is no cache infrastructure in
//! this service, and introducing one for a dashboard read would be a larger
//! change than the feature. A restart simply recomputes.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use crate::modules::intel::report::{DateRange, GuildReport};

/// How long a computed report stays fresh.
const TTL: Duration = Duration::from_secs(300);

/// Cache key: the window, truncated to the hour.
///
/// Truncation is what makes the cache actually hit. The default window is
/// "the last 30 days ending now", so without it every request would carry a
/// slightly different `to` and miss.
type Key = (i64, i64);

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

    fn key(range: DateRange) -> Key {
        const HOUR: i64 = 3600;
        (
            range.from.timestamp() / HOUR,
            range.to.timestamp() / HOUR,
        )
    }

    /// Returns a cached report when one is still fresh.
    ///
    /// A poisoned lock is treated as a miss rather than a panic: a failed
    /// cache should degrade to recomputation, never take the endpoint down.
    #[must_use]
    pub fn get(&self, range: DateRange) -> Option<GuildReport> {
        let guard = self.entries.read().ok()?;
        let (stored_at, report) = guard.get(&Self::key(range))?;
        (stored_at.elapsed() < TTL).then(|| report.clone())
    }

    /// Stores a freshly computed report.
    pub fn put(&self, range: DateRange, report: &GuildReport) {
        let Ok(mut guard) = self.entries.write() else {
            return;
        };
        // Drop anything already stale so the map cannot grow without bound
        // across many distinct windows.
        guard.retain(|_, (stored_at, _)| stored_at.elapsed() < TTL);
        guard.insert(Self::key(range), (Instant::now(), report.clone()));
    }

    /// Drops every cached report, forcing the next read to recompute.
    pub fn invalidate(&self) {
        if let Ok(mut guard) = self.entries.write() {
            guard.clear();
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
        assert_eq!(ReportCache::key(a), ReportCache::key(b));
    }

    #[test]
    fn different_hours_do_not_collide() {
        let a = range("2026-08-01T00:00:00Z", "2026-08-30T12:00:00Z");
        let b = range("2026-08-01T00:00:00Z", "2026-08-30T13:00:00Z");
        assert_ne!(ReportCache::key(a), ReportCache::key(b));
    }

    #[test]
    fn stores_and_returns_a_report() {
        let cache = ReportCache::new();
        let r = range("2026-08-01T00:00:00Z", "2026-08-30T00:00:00Z");
        assert!(cache.get(r).is_none());
        cache.put(r, &GuildReport::default());
        assert!(cache.get(r).is_some());
    }

    #[test]
    fn invalidate_clears_everything() {
        let cache = ReportCache::new();
        let r = range("2026-08-01T00:00:00Z", "2026-08-30T00:00:00Z");
        cache.put(r, &GuildReport::default());
        cache.invalidate();
        assert!(cache.get(r).is_none());
    }
}
