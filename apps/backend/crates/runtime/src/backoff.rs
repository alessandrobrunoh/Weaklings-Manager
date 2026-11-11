//! Retry backoff shared by every queue (fanout, mirror retry, sync jobs, ...).
//!
//! The delay is `min(cap, base * 2^min(attempt, max_exponent))`, optionally
//! multiplied by a random factor in `[1 - jitter, 1 + jitter)` so a burst of
//! failing targets does not retry in lockstep. The unjittered value is what the
//! pre-runtime `retry_delay_seconds` helpers returned (`15 * 2^n`, capped at
//! one hour, exponent capped at 8), and they now delegate here unchanged.

use std::time::Duration;

use rand::Rng;

/// Parameters of an exponential backoff curve.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BackoffPolicy {
    /// Delay of attempt 0.
    pub base: Duration,
    /// Upper bound of the unjittered delay.
    pub cap: Duration,
    /// The exponent stops growing here (`2^max_exponent` is the last doubling).
    pub max_exponent: u32,
    /// Relative jitter in `[0, 1)`: `0.2` scales the delay by `0.8..1.2`.
    pub jitter: f64,
}

/// Retry curve of durable queue jobs: `min(3600, 15 * 2^min(n, 8))` seconds
/// with +-20 % jitter.
pub const JOB_RETRY: BackoffPolicy = BackoffPolicy {
    base: Duration::from_secs(15),
    cap: Duration::from_secs(3600),
    max_exponent: 8,
    jitter: 0.2,
};

/// Restart curve of a supervised task after a panic: 1 s doubling up to 60 s.
pub const TASK_RESTART: BackoffPolicy = BackoffPolicy {
    base: Duration::from_secs(1),
    cap: Duration::from_secs(60),
    max_exponent: 6,
    jitter: 0.2,
};

impl BackoffPolicy {
    /// Deterministic delay for `attempt` (0-based), without jitter.
    #[must_use]
    pub fn base_delay(&self, attempt: u32) -> Duration {
        // `1u32 << 31` is still representable; larger exponents never matter
        // because the cap is reached long before.
        let exponent = attempt.min(self.max_exponent).min(31);
        self.base.saturating_mul(1u32 << exponent).min(self.cap)
    }

    /// Delay for `attempt` with jitter drawn from `rng`.
    ///
    /// The result lies in `[base_delay * (1 - jitter), base_delay * (1 + jitter))`.
    #[must_use]
    pub fn delay(&self, attempt: u32, rng: &mut impl Rng) -> Duration {
        let base = self.base_delay(attempt);
        let jitter = self.jitter.clamp(0.0, 0.99);
        if jitter == 0.0 {
            return base;
        }
        let factor = 1.0 - jitter + 2.0 * jitter * rng.r#gen::<f64>();
        base.mul_f64(factor)
    }
}

/// Jittered retry delay of a queue job after `attempt` attempts.
///
/// `attempt` is the number of attempts already consumed (the claim query
/// increments it before the handler runs, exactly as the legacy queues do).
#[must_use]
pub fn backoff(attempt: i32, rng: &mut impl Rng) -> Duration {
    JOB_RETRY.delay(clamp_attempt(attempt), rng)
}

/// Unjittered retry delay in whole seconds: the exact value the legacy
/// `retry_delay_seconds` helpers of the fanout and mirror queues returned.
#[must_use]
pub fn retry_delay_seconds(attempt: i32) -> i64 {
    i64::try_from(JOB_RETRY.base_delay(clamp_attempt(attempt)).as_secs()).unwrap_or(i64::MAX)
}

fn clamp_attempt(attempt: i32) -> u32 {
    u32::try_from(attempt.max(0)).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{SeedableRng, rngs::StdRng};

    /// Fixed `rng.gen::<f64>()` outputs: lowest, highest and middle of `[0, 1)`.
    struct Fixed(u64);

    impl rand::RngCore for Fixed {
        fn next_u32(&mut self) -> u32 {
            (self.0 >> 32) as u32
        }
        fn next_u64(&mut self) -> u64 {
            self.0
        }
        fn fill_bytes(&mut self, dest: &mut [u8]) {
            for chunk in dest.chunks_mut(8) {
                chunk.copy_from_slice(&self.0.to_le_bytes()[..chunk.len()]);
            }
        }
        fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand::Error> {
            self.fill_bytes(dest);
            Ok(())
        }
    }

    #[test]
    fn legacy_curve_is_preserved() {
        // The values the old `15 * 2^clamp(attempt, 0, 8)` min 3600 returned.
        let expected = [15, 30, 60, 120, 240, 480, 960, 1920, 3600, 3600, 3600];
        for (attempt, want) in expected.iter().enumerate() {
            assert_eq!(
                retry_delay_seconds(i32::try_from(attempt).unwrap()),
                *want,
                "attempt {attempt}"
            );
        }
    }

    #[test]
    fn negative_and_huge_attempts_are_clamped() {
        assert_eq!(retry_delay_seconds(-5), 15);
        assert_eq!(retry_delay_seconds(i32::MAX), 3600);
        assert_eq!(JOB_RETRY.base_delay(u32::MAX), Duration::from_secs(3600));
    }

    #[test]
    fn jitter_stays_within_bounds_for_every_attempt() {
        let mut rng = StdRng::seed_from_u64(7);
        for attempt in 0..12 {
            let base = JOB_RETRY.base_delay(attempt).as_secs_f64();
            for _ in 0..200 {
                let delay = JOB_RETRY.delay(attempt, &mut rng).as_secs_f64();
                assert!(
                    delay >= base * 0.8 - 1e-9 && delay < base * 1.2 + 1e-9,
                    "attempt {attempt}: {delay} outside [{}, {})",
                    base * 0.8,
                    base * 1.2
                );
            }
        }
    }

    #[test]
    fn jitter_extremes_hit_both_edges() {
        let low = JOB_RETRY.delay(2, &mut Fixed(0)).as_secs_f64();
        assert!((low - 60.0 * 0.8).abs() < 1e-6, "low edge {low}");
        let high = JOB_RETRY.delay(2, &mut Fixed(u64::MAX)).as_secs_f64();
        assert!(
            high > 60.0 * 1.19 && high < 60.0 * 1.2 + 1e-6,
            "high edge {high}"
        );
    }

    #[test]
    fn jitter_actually_varies_and_is_seed_deterministic() {
        let mut a = StdRng::seed_from_u64(1);
        let mut b = StdRng::seed_from_u64(1);
        let first: Vec<_> = (0..8).map(|_| backoff(3, &mut a)).collect();
        let second: Vec<_> = (0..8).map(|_| backoff(3, &mut b)).collect();
        assert_eq!(first, second);
        assert!(first.windows(2).any(|pair| pair[0] != pair[1]));
    }

    #[test]
    fn zero_jitter_is_exactly_the_base_delay() {
        let policy = BackoffPolicy {
            jitter: 0.0,
            ..JOB_RETRY
        };
        let mut rng = StdRng::seed_from_u64(3);
        assert_eq!(policy.delay(4, &mut rng), policy.base_delay(4));
    }

    #[test]
    fn restart_policy_is_capped_at_a_minute() {
        assert_eq!(TASK_RESTART.base_delay(0), Duration::from_secs(1));
        assert_eq!(TASK_RESTART.base_delay(5), Duration::from_secs(32));
        assert_eq!(TASK_RESTART.base_delay(6), Duration::from_secs(60));
        assert_eq!(TASK_RESTART.base_delay(40), Duration::from_secs(60));
    }
}
