//! Per-guild outgoing rate limit for the bot token.
//!
//! A token bucket per guild: capacity 4, refilled at 4 tokens per second. A `429` answer blocks
//! the guild until its `Retry-After` has passed. The buckets are process-wide, so every client
//! built in this process shares them. A second replica has its own buckets (documented).

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

/// Requests per second allowed per guild.
pub const RATE_PER_SECOND: f64 = 4.0;

/// Bucket capacity: the burst allowed after a quiet period.
pub const BURST: f64 = 4.0;

struct Bucket {
    tokens: f64,
    refilled_at: Instant,
    blocked_until: Option<Instant>,
}

fn buckets() -> MutexGuard<'static, HashMap<String, Bucket>> {
    static BUCKETS: OnceLock<Mutex<HashMap<String, Bucket>>> = OnceLock::new();
    BUCKETS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// Longest a request waits on its guild's bucket or `Retry-After` before it fails. Request paths
/// (login, role checks, admin and albion handlers) must not hang behind a blocked guild.
pub const REQUEST_WAIT_BUDGET: Duration = Duration::from_secs(1);

/// Waits until one request may be sent to `guild_id`. When the wait needed would push the total
/// past `budget`, returns that wait without sleeping, so the caller can fail with `RateLimited`.
pub async fn acquire(guild_id: &str, budget: Duration) -> Result<(), Duration> {
    let mut waited = Duration::ZERO;
    loop {
        let Some(wait) = take_token(guild_id, Instant::now()) else {
            return Ok(());
        };
        if waited.saturating_add(wait) > budget {
            return Err(wait);
        }
        tokio::time::sleep(wait).await;
        waited = waited.saturating_add(wait);
    }
}

/// Keeps `guild_id` quiet for `retry_after` after a `429`.
pub fn block(guild_id: &str, retry_after: Duration) {
    block_at(guild_id, retry_after, Instant::now());
}

/// Takes one token at `now`, or returns how long to wait for the next one.
fn take_token(guild_id: &str, now: Instant) -> Option<Duration> {
    let mut map = buckets();
    let bucket = map.entry(guild_id.to_owned()).or_insert_with(|| Bucket {
        tokens: BURST,
        refilled_at: now,
        blocked_until: None,
    });
    if let Some(until) = bucket.blocked_until {
        if until > now {
            return Some(until - now);
        }
        bucket.blocked_until = None;
    }
    let elapsed = now
        .saturating_duration_since(bucket.refilled_at)
        .as_secs_f64();
    bucket.tokens = (bucket.tokens + elapsed * RATE_PER_SECOND).min(BURST);
    bucket.refilled_at = now;
    if bucket.tokens >= 1.0 {
        bucket.tokens -= 1.0;
        None
    } else {
        Some(Duration::from_secs_f64(
            (1.0 - bucket.tokens) / RATE_PER_SECOND,
        ))
    }
}

fn block_at(guild_id: &str, retry_after: Duration, now: Instant) {
    let until = now + retry_after;
    let mut map = buckets();
    let bucket = map.entry(guild_id.to_owned()).or_insert_with(|| Bucket {
        tokens: BURST,
        refilled_at: now,
        blocked_until: None,
    });
    bucket.blocked_until = Some(
        bucket
            .blocked_until
            .map_or(until, |current| current.max(until)),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(actual: Duration, expected_ms: u64) -> bool {
        let actual = actual.as_millis();
        let expected = u128::from(expected_ms);
        actual.abs_diff(expected) <= 5
    }

    #[test]
    fn a_fresh_guild_gets_a_burst_of_four_then_waits_a_quarter_second() {
        let guild = "limiter-burst";
        let start = Instant::now();
        for _ in 0..4 {
            assert_eq!(take_token(guild, start), None);
        }
        let wait = take_token(guild, start).expect("fifth request waits");
        assert!(near(wait, 250), "wait was {wait:?}");
    }

    #[test]
    fn tokens_refill_at_four_per_second() {
        let guild = "limiter-refill";
        let start = Instant::now();
        for _ in 0..4 {
            assert_eq!(take_token(guild, start), None);
        }
        let later = start + Duration::from_millis(500);
        assert_eq!(take_token(guild, later), None);
        assert_eq!(take_token(guild, later), None);
        assert!(take_token(guild, later).is_some());
    }

    #[test]
    fn guilds_do_not_share_a_bucket() {
        let start = Instant::now();
        for _ in 0..4 {
            assert_eq!(take_token("limiter-guild-a", start), None);
        }
        assert_eq!(take_token("limiter-guild-b", start), None);
    }

    #[test]
    fn a_429_blocks_the_guild_for_retry_after() {
        let guild = "limiter-blocked";
        let start = Instant::now();
        block_at(guild, Duration::from_secs(2), start);
        let wait = take_token(guild, start).expect("blocked");
        assert!(near(wait, 2000), "wait was {wait:?}");
        assert_eq!(take_token(guild, start + Duration::from_millis(2100)), None);
    }

    #[tokio::test]
    async fn a_long_block_fails_fast_instead_of_sleeping() {
        let guild = "limiter-long-block-fast";
        block(guild, Duration::from_secs(3600));
        let started = Instant::now();
        let wait = acquire(guild, REQUEST_WAIT_BUDGET)
            .await
            .expect_err("blocked beyond the budget");
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(wait > Duration::from_secs(3500), "wait was {wait:?}");
    }

    #[tokio::test]
    async fn a_short_block_is_waited_out_within_the_budget() {
        let guild = "limiter-short-block-wait";
        block(guild, Duration::from_millis(200));
        acquire(guild, REQUEST_WAIT_BUDGET)
            .await
            .expect("a 200 ms block is within the budget");
    }

    #[test]
    fn a_shorter_block_never_shortens_an_existing_one() {
        let guild = "limiter-longest-block";
        let start = Instant::now();
        block_at(guild, Duration::from_secs(3), start);
        block_at(guild, Duration::from_secs(1), start);
        let wait = take_token(guild, start).expect("blocked");
        assert!(near(wait, 3000), "wait was {wait:?}");
    }
}
