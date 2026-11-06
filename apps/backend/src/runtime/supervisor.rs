//! Panic-supervised long-running tasks.
//!
//! A bare `tokio::spawn` loop dies silently on the first panic and the queue it
//! drained stops until the next deploy. [`spawn_supervised`] runs the loop in a
//! child task, and when the child panics it counts the restart, logs it, waits
//! a backoff and starts a fresh child.

use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use rand::Rng;
use tokio::task::JoinHandle;

use super::backoff::{BackoffPolicy, TASK_RESTART};

/// Tunables of the supervisor; tests shrink them.
#[derive(Debug, Clone, Copy)]
pub struct SupervisorSettings {
    /// Delay curve between a panic and the restart.
    pub restart: BackoffPolicy,
    /// Upper bound of the random delay before the first start, so loops do not
    /// all hit the database in the same instant at boot.
    pub start_jitter: Duration,
    /// A child that ran at least this long before panicking resets the
    /// consecutive-panic counter (the restart delay starts from its base again).
    pub healthy_after: Duration,
}

impl Default for SupervisorSettings {
    fn default() -> Self {
        Self {
            restart: TASK_RESTART,
            start_jitter: Duration::from_millis(1500),
            healthy_after: Duration::from_secs(60),
        }
    }
}

/// Counters of one supervised task. Shared with whoever wants to observe it.
#[derive(Debug, Default)]
pub struct TaskStats {
    restarts: AtomicU64,
    starts: AtomicU64,
}

impl TaskStats {
    /// Number of times the task was restarted after a panic.
    #[must_use]
    pub fn restarts(&self) -> u64 {
        self.restarts.load(Ordering::Relaxed)
    }

    /// Number of times the task body was started (first start included).
    #[must_use]
    pub fn starts(&self) -> u64 {
        self.starts.load(Ordering::Relaxed)
    }
}

/// Runs `make()` as a task and restarts it whenever it panics.
///
/// The supervisor returns when the body finishes normally or is cancelled; a
/// body that is meant to run forever therefore never ends it.
pub fn spawn_supervised<F, Fut>(
    name: &'static str,
    settings: SupervisorSettings,
    stats: Arc<TaskStats>,
    make: F,
) -> JoinHandle<()>
where
    F: Fn() -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        let start_delay = start_jitter(settings.start_jitter);
        if !start_delay.is_zero() {
            tokio::time::sleep(start_delay).await;
        }
        let mut consecutive: u32 = 0;
        loop {
            stats.starts.fetch_add(1, Ordering::Relaxed);
            let started = Instant::now();
            match tokio::spawn(make()).await {
                Ok(()) => {
                    tracing::info!(task = name, "supervised task finished");
                    return;
                }
                Err(error) if error.is_panic() => {
                    if started.elapsed() >= settings.healthy_after {
                        consecutive = 0;
                    }
                    stats.restarts.fetch_add(1, Ordering::Relaxed);
                    let delay = restart_delay(&settings.restart, consecutive);
                    consecutive = consecutive.saturating_add(1);
                    tracing::error!(
                        task = name,
                        restarts = stats.restarts(),
                        restart_in_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
                        "supervised task panicked; restarting"
                    );
                    tokio::time::sleep(delay).await;
                }
                Err(_) => {
                    tracing::warn!(task = name, "supervised task cancelled");
                    return;
                }
            }
        }
    })
}

fn start_jitter(max: Duration) -> Duration {
    if max.is_zero() {
        return Duration::ZERO;
    }
    max.mul_f64(rand::thread_rng().r#gen::<f64>())
}

fn restart_delay(policy: &BackoffPolicy, consecutive: u32) -> Duration {
    policy.delay(consecutive, &mut rand::thread_rng())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;

    fn fast() -> SupervisorSettings {
        SupervisorSettings {
            restart: BackoffPolicy {
                base: Duration::from_millis(2),
                cap: Duration::from_millis(20),
                max_exponent: 3,
                jitter: 0.0,
            },
            start_jitter: Duration::ZERO,
            healthy_after: Duration::from_secs(60),
        }
    }

    async fn wait_for(mut done: impl FnMut() -> bool) {
        for _ in 0..500 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("condition not reached in time");
    }

    #[tokio::test]
    async fn a_panicking_task_is_restarted_and_counted() {
        let stats = Arc::new(TaskStats::default());
        let runs = Arc::new(AtomicUsize::new(0));
        let healthy = Arc::new(AtomicUsize::new(0));
        let handle = spawn_supervised("test", fast(), stats.clone(), {
            let runs = runs.clone();
            let healthy = healthy.clone();
            move || {
                let runs = runs.clone();
                let healthy = healthy.clone();
                async move {
                    let n = runs.fetch_add(1, Ordering::SeqCst);
                    assert!(n >= 2, "boom on run {n}");
                    // Third run: healthy forever.
                    healthy.fetch_add(1, Ordering::SeqCst);
                    std::future::pending::<()>().await;
                }
            }
        });
        wait_for(|| healthy.load(Ordering::SeqCst) == 1).await;
        assert_eq!(stats.restarts(), 2);
        assert_eq!(stats.starts(), 3);
        assert_eq!(runs.load(Ordering::SeqCst), 3);
        handle.abort();
    }

    #[tokio::test]
    async fn a_task_that_returns_is_not_restarted() {
        let stats = Arc::new(TaskStats::default());
        let handle = spawn_supervised("once", fast(), stats.clone(), || async {});
        tokio::time::timeout(Duration::from_secs(1), handle)
            .await
            .expect("supervisor ends")
            .expect("join");
        assert_eq!(stats.restarts(), 0);
        assert_eq!(stats.starts(), 1);
    }

    #[test]
    fn restart_delay_grows_then_caps() {
        let policy = fast().restart;
        let delays: Vec<_> = (0..6).map(|n| restart_delay(&policy, n)).collect();
        assert_eq!(delays[0], Duration::from_millis(2));
        assert_eq!(delays[1], Duration::from_millis(4));
        assert_eq!(delays[3], Duration::from_millis(16));
        assert_eq!(delays[5], delays[3]);
    }

    #[test]
    fn start_jitter_is_bounded() {
        assert_eq!(start_jitter(Duration::ZERO), Duration::ZERO);
        for _ in 0..100 {
            assert!(start_jitter(Duration::from_secs(2)) < Duration::from_secs(2));
        }
    }
}
