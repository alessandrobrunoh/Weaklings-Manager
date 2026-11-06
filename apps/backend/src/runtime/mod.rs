//! Background runtime: the single place where server loops are spawned.
//!
//! * [`spawn_all`] starts every registered [`LoopTask`] under a panic
//!   supervisor with a per-loop start jitter, and returns a [`Runtime`].
//! * [`Runtime::kick`] wakes loops right after a commit that produced work for
//!   them. This is a latency optimisation for the single-replica deployment;
//!   correctness depends only on leases, fencing, conditional updates and the
//!   short polls of each loop (no advisory lock, no `LISTEN/NOTIFY`).
//! * [`backoff`], [`LeaseFence`] and [`state::next_state`] are the pieces every
//!   durable queue (fanout, mirror retry, the sync engine) shares.

pub mod backoff;
pub mod fence;
pub mod state;
pub mod supervisor;
pub mod tasks;
pub mod wake;

use std::{collections::HashMap, sync::Arc};

use sea_orm::DatabaseConnection;

pub use supervisor::{SupervisorSettings, TaskStats, spawn_supervised};
pub use tasks::{LoopTask, TaskContext};
pub use wake::{Wake, WakeSet, WakeTarget};

use crate::tenant::TenantRegistry;

/// What `spawn_all` needs besides the connections.
pub struct RuntimeDeps {
    /// Supervisor tunables.
    pub settings: SupervisorSettings,
    /// Loops to run.
    pub tasks: Vec<Arc<dyn LoopTask>>,
}

impl RuntimeDeps {
    /// The production set: every loop in [`tasks::registered_tasks`].
    #[must_use]
    pub fn production() -> Self {
        Self {
            settings: SupervisorSettings::default(),
            tasks: tasks::registered_tasks(),
        }
    }
}

/// Handle to the running loops; cheap to clone and shared through an
/// `Extension` so request handlers can kick loops after commit.
#[derive(Clone, Default)]
pub struct Runtime {
    wakes: Arc<HashMap<WakeTarget, Wake>>,
    stats: Arc<HashMap<&'static str, Arc<TaskStats>>>,
}

impl Runtime {
    /// A runtime with wake channels but no loops (unit tests, `World`).
    #[must_use]
    pub fn detached() -> Self {
        Self {
            wakes: Arc::new(
                WakeTarget::ALL
                    .into_iter()
                    .map(|target| (target, Wake::new()))
                    .collect(),
            ),
            stats: Arc::default(),
        }
    }

    /// Wakes every loop in `set`. Call after the transaction that produced the
    /// work has committed. Unknown targets are ignored.
    pub fn kick(&self, set: impl Into<WakeSet>) {
        for target in set.into().iter() {
            if let Some(wake) = self.wakes.get(&target) {
                wake.kick();
            }
        }
    }

    /// The wake channel of `target`, when a loop listens on it.
    #[must_use]
    pub fn wake(&self, target: WakeTarget) -> Option<Wake> {
        self.wakes.get(&target).cloned()
    }

    /// Counters of the task called `name`.
    #[must_use]
    pub fn stats(&self, name: &str) -> Option<Arc<TaskStats>> {
        self.stats.get(name).cloned()
    }

    /// Number of panic restarts of the task called `name` (0 when unknown).
    #[must_use]
    pub fn restart_count(&self, name: &str) -> u64 {
        self.stats(name).map_or(0, |stats| stats.restarts())
    }
}

/// Starts every background loop. This is the only place the server spawns
/// periodic work.
pub fn spawn_all(
    control: DatabaseConnection,
    registry: TenantRegistry,
    deps: RuntimeDeps,
) -> Runtime {
    let cx = TaskContext { control, registry };
    let mut wakes: HashMap<WakeTarget, Wake> = WakeTarget::ALL
        .into_iter()
        .map(|target| (target, Wake::new()))
        .collect();
    let mut stats: HashMap<&'static str, Arc<TaskStats>> = HashMap::new();

    for task in deps.tasks {
        let name = task.name();
        let wake = match task.wake_target() {
            Some(target) => wakes.entry(target).or_default().clone(),
            None => Wake::new(),
        };
        let task_stats = Arc::new(TaskStats::default());
        let previous = stats.insert(name, task_stats.clone());
        assert!(previous.is_none(), "duplicate background task name {name}");
        let cx = cx.clone();
        spawn_supervised(name, deps.settings, task_stats, move || {
            tasks::run_loop(task.clone(), cx.clone(), wake.clone())
        });
    }

    Runtime {
        wakes: Arc::new(wakes),
        stats: Arc::new(stats),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };

    use async_trait::async_trait;

    use super::*;
    use crate::errors::AppError;
    use backoff::BackoffPolicy;

    /// Panics on its first two runs, then counts runs.
    struct Flaky {
        runs: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl LoopTask for Flaky {
        fn name(&self) -> &'static str {
            "flaky"
        }
        fn tick(&self) -> Duration {
            Duration::from_millis(5)
        }
        async fn run_once(&self, _cx: &TaskContext) -> Result<(), AppError> {
            let n = self.runs.fetch_add(1, Ordering::SeqCst);
            assert!(n >= 2, "injected panic {n}");
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_panic_in_a_loop_restarts_it_and_bumps_the_counter() {
        let control = sea_orm::Database::connect("sqlite::memory:")
            .await
            .expect("sqlite");
        let registry = TenantRegistry::new("sqlite::memory:".into(), control.clone());
        let runs = Arc::new(AtomicUsize::new(0));
        let runtime = spawn_all(
            control,
            registry,
            RuntimeDeps {
                settings: SupervisorSettings {
                    restart: BackoffPolicy {
                        base: Duration::from_millis(2),
                        cap: Duration::from_millis(10),
                        max_exponent: 2,
                        jitter: 0.0,
                    },
                    start_jitter: Duration::ZERO,
                    healthy_after: Duration::from_secs(60),
                },
                tasks: vec![Arc::new(Flaky { runs: runs.clone() })],
            },
        );
        for _ in 0..400 {
            if runs.load(Ordering::SeqCst) >= 5 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(
            runs.load(Ordering::SeqCst) >= 5,
            "the loop kept running after the panics"
        );
        assert_eq!(runtime.restart_count("flaky"), 2);
        assert_eq!(runtime.restart_count("no_such_task"), 0);
    }

    #[test]
    fn kick_reaches_only_the_requested_loops() {
        let runtime = Runtime::detached();
        runtime.kick(WakeTarget::Fanout);
        let fanout = runtime.wake(WakeTarget::Fanout).expect("fanout wake");
        let mirror = runtime.wake(WakeTarget::MirrorRetry).expect("mirror wake");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("rt");
        rt.block_on(async {
            tokio::time::timeout(Duration::from_millis(100), fanout.notified())
                .await
                .expect("fanout kicked");
            assert!(
                tokio::time::timeout(Duration::from_millis(30), mirror.notified())
                    .await
                    .is_err(),
                "mirror retry must not be woken"
            );
        });
    }
}
