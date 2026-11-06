//! Process-wide TTL cache with per-key single-flight.
//!
//! Shared upstream lookups (`AlbionBB` battles and guilds, Albion Online Data
//! prices) live in one of these caches, held behind an `Arc` by the service
//! that owns the upstream client. Every clone of that service shares the same
//! entries, so a short-lived service built per request or per sync tick still
//! hits the cache.
//!
//! * Each entry carries its own TTL, so finished and in-progress upstream
//!   facts can be cached for different lengths of time.
//! * [`TtlCache::get_or_fetch`] runs at most one fetch per key at a time:
//!   concurrent misses wait for that fetch and share its outcome. A failed
//!   fetch is not cached and is not repeated by its waiters; they all receive
//!   the failure, and the next call after the flight retries.
//! * The map is bounded: expired entries are dropped first, then the oldest.

use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use tokio::sync::OnceCell;

use crate::errors::AppError;

struct Entry<V> {
    value: V,
    stored_at: Instant,
    ttl: Duration,
}

impl<V> Entry<V> {
    fn is_fresh(&self) -> bool {
        self.stored_at.elapsed() < self.ttl
    }
}

/// One fetch in flight for a key. Every caller that joins it awaits the same
/// cell, so the fetch runs once and all of them observe its outcome. A failure
/// is stored as its message because `AppError` is not `Clone`.
struct Flight<V> {
    outcome: OnceCell<Result<V, String>>,
}

/// Bounded TTL map with per-key single-flight fetches.
pub struct TtlCache<K, V> {
    entries: Mutex<HashMap<K, Entry<V>>>,
    /// The fetch currently running for each key, if any.
    flights: Mutex<HashMap<K, Arc<Flight<V>>>>,
    max_entries: usize,
}

impl<K, V> TtlCache<K, V>
where
    K: Eq + Hash + Clone,
    V: Clone + Send + Sync,
{
    #[must_use]
    pub fn new(max_entries: usize) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            flights: Mutex::new(HashMap::new()),
            max_entries: max_entries.max(1),
        }
    }

    /// Returns the cached value when it is still fresh.
    pub fn get(&self, key: &K) -> Option<V> {
        let entries = lock(&self.entries);
        entries
            .get(key)
            .filter(|entry| entry.is_fresh())
            .map(|entry| entry.value.clone())
    }

    /// Stores `value` for `ttl`, replacing any previous entry for `key`.
    pub fn insert(&self, key: K, value: V, ttl: Duration) {
        let mut entries = lock(&self.entries);
        if !entries.contains_key(&key) && entries.len() >= self.max_entries {
            entries.retain(|_, entry| entry.is_fresh());
            if entries.len() >= self.max_entries
                && let Some(oldest) = entries
                    .iter()
                    .min_by_key(|(_, entry)| entry.stored_at)
                    .map(|(oldest_key, _)| oldest_key.clone())
            {
                entries.remove(&oldest);
            }
        }
        entries.insert(
            key,
            Entry {
                value,
                stored_at: Instant::now(),
                ttl,
            },
        );
    }

    /// Returns the cached value, or runs `fetch` once per key and caches the
    /// `(value, ttl)` it returns. Concurrent callers for the same key wait for
    /// the single running fetch and share its outcome instead of issuing their
    /// own. The caller that ran `fetch` gets its original error; waiters of a
    /// failed fetch get an [`AppError::UpstreamService`] carrying its message.
    ///
    /// # Errors
    /// Propagates the error of `fetch`; nothing is cached in that case.
    pub async fn get_or_fetch<F, Fut>(&self, key: K, fetch: F) -> Result<V, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<(V, Duration), AppError>>,
    {
        if let Some(value) = self.get(&key) {
            return Ok(value);
        }

        let flight = {
            let mut flights = lock(&self.flights);
            Arc::clone(flights.entry(key.clone()).or_insert_with(|| {
                Arc::new(Flight {
                    outcome: OnceCell::new(),
                })
            }))
        };

        let mut leader_error = None;
        let outcome = flight
            .outcome
            .get_or_init(|| async {
                match fetch().await {
                    Ok((value, ttl)) => {
                        self.insert(key.clone(), value.clone(), ttl);
                        Ok(value)
                    }
                    Err(error) => {
                        let message = error.to_string();
                        leader_error = Some(error);
                        Err(message)
                    }
                }
            })
            .await;

        {
            let mut flights = lock(&self.flights);
            if flights
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &flight))
            {
                flights.remove(&key);
            }
        }

        match outcome {
            Ok(value) => Ok(value.clone()),
            Err(message) => {
                Err(leader_error.unwrap_or_else(|| AppError::UpstreamService(message.clone())))
            }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const LONG: Duration = Duration::from_secs(60);

    #[tokio::test]
    async fn second_lookup_is_served_from_cache() {
        let cache: TtlCache<&str, u32> = TtlCache::new(8);
        let fetches = AtomicUsize::new(0);
        for _ in 0..3 {
            let value = cache
                .get_or_fetch("a", || async {
                    fetches.fetch_add(1, Ordering::SeqCst);
                    Ok((7, LONG))
                })
                .await
                .unwrap();
            assert_eq!(value, 7);
        }
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn expired_entry_is_fetched_again() {
        let cache: TtlCache<&str, u32> = TtlCache::new(8);
        let fetches = AtomicUsize::new(0);
        for _ in 0..2 {
            cache
                .get_or_fetch("a", || async {
                    fetches.fetch_add(1, Ordering::SeqCst);
                    Ok((1, Duration::from_millis(1)))
                })
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(fetches.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn concurrent_misses_share_one_fetch() {
        let cache: Arc<TtlCache<&'static str, u32>> = Arc::new(TtlCache::new(8));
        let fetches = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..16 {
            let cache = Arc::clone(&cache);
            let fetches = Arc::clone(&fetches);
            tasks.push(tokio::spawn(async move {
                cache
                    .get_or_fetch("hot", || async move {
                        fetches.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        Ok((9, LONG))
                    })
                    .await
                    .unwrap()
            }));
        }
        for task in tasks {
            assert_eq!(task.await.unwrap(), 9);
        }
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn concurrent_failures_share_one_fetch_and_one_fetch_time() {
        let cache: Arc<TtlCache<&'static str, u32>> = Arc::new(TtlCache::new(8));
        let fetches = Arc::new(AtomicUsize::new(0));
        let started = Instant::now();
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let cache = Arc::clone(&cache);
            let fetches = Arc::clone(&fetches);
            tasks.push(tokio::spawn(async move {
                cache
                    .get_or_fetch("hot", || async move {
                        fetches.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        Err(AppError::UpstreamService("boom".to_string()))
                    })
                    .await
            }));
        }
        for task in tasks {
            assert!(task.await.unwrap().is_err());
        }
        // Waiters share the leader's failure: one upstream attempt in total,
        // finished in roughly one fetch duration rather than eight in turn.
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
        assert!(started.elapsed() < Duration::from_millis(400));
        assert!(cache.get(&"hot").is_none());
    }

    #[tokio::test]
    async fn failed_fetch_is_not_cached() {
        let cache: TtlCache<&str, u32> = TtlCache::new(8);
        let failed = cache
            .get_or_fetch("a", || async {
                Err(AppError::UpstreamService("boom".to_string()))
            })
            .await;
        assert!(failed.is_err());
        assert!(cache.get(&"a").is_none());
        let value = cache
            .get_or_fetch("a", || async { Ok((3, LONG)) })
            .await
            .unwrap();
        assert_eq!(value, 3);
    }

    #[test]
    fn size_is_bounded_by_evicting_the_oldest_entry() {
        let cache: TtlCache<u32, u32> = TtlCache::new(2);
        cache.insert(1, 10, LONG);
        cache.insert(2, 20, LONG);
        cache.insert(3, 30, LONG);
        assert!(cache.get(&1).is_none());
        assert_eq!(cache.get(&2), Some(20));
        assert_eq!(cache.get(&3), Some(30));
    }
}
