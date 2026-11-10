//! The periodic background loops and their registry.
//!
//! A [`LoopTask`] is one unit of polling work: `run_once` drains whatever is
//! due, and the loop around it (see [`run_loop`]) repeats it every `tick`, or
//! sooner when its [`Wake`] is kicked. New queues register by adding one entry
//! to [`registered_tasks`]; there is no other spawn point.

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use sea_orm::DatabaseConnection;

use super::wake::{Wake, WakeTarget};
use crate::{errors::AppError, tenant::TenantRegistry};

/// Handles a loop body needs. Cloning is cheap (connections and the registry
/// are reference-counted).
#[derive(Clone)]
pub struct TaskContext {
    /// Control-plane connection.
    pub control: DatabaseConnection,
    /// Tenant registry, to reach any tenant database.
    pub registry: TenantRegistry,
}

/// One polled background loop.
#[async_trait]
pub trait LoopTask: Send + Sync + 'static {
    /// Stable name used in logs and restart counters.
    fn name(&self) -> &'static str;

    /// Poll interval; also the worst-case latency of a lost wake-up.
    fn tick(&self) -> Duration;

    /// The wake channel that cuts the wait short, when the loop has one.
    fn wake_target(&self) -> Option<WakeTarget> {
        None
    }

    /// Drains the work that is due now.
    ///
    /// # Errors
    ///
    /// Any failure; the loop logs it and tries again on the next pass.
    async fn run_once(&self, cx: &TaskContext) -> Result<(), AppError>;
}

/// Repeats `task.run_once` until the future is dropped or aborted.
pub async fn run_loop(task: Arc<dyn LoopTask>, cx: TaskContext, wake: Wake) {
    loop {
        if let Err(error) = task.run_once(&cx).await {
            tracing::error!(task = task.name(), error = %error, "background cycle failed");
        }
        tokio::select! {
            () = tokio::time::sleep(task.tick()) => {}
            () = wake.notified() => {}
        }
    }
}

/// Retry queue of Alliance-to-Guild event copies.
struct EventFanout;

#[async_trait]
impl LoopTask for EventFanout {
    fn name(&self) -> &'static str {
        "event_fanout"
    }

    fn tick(&self) -> Duration {
        Duration::from_secs(15)
    }

    fn wake_target(&self) -> Option<WakeTarget> {
        Some(WakeTarget::Fanout)
    }

    async fn run_once(&self, cx: &TaskContext) -> Result<(), AppError> {
        // Queue the copies a guild missed (it joined later, or a publish was lost) before
        // draining, so they go out in this tick.
        if let Err(error) = crate::modules::events::fanout_worker::reconcile_missing_copies(
            &cx.control,
            &cx.registry,
        )
        .await
        {
            tracing::warn!(error = %error, "event fanout catch-up failed");
        }
        // Roster drift is rare and the scan reads every linked copy, so it runs on a slower cadence.
        if roster_reconcile_due() {
            match crate::modules::events::sync::reconcile_rosters(&cx.control, &cx.registry).await {
                Ok(0) => {}
                Ok(added) => tracing::info!(added, "event rosters reconciled"),
                Err(error) => tracing::warn!(error = %error, "event roster reconcile failed"),
            }
        }
        crate::modules::events::fanout_worker::process_due_targets(&cx.control, &cx.registry)
            .await
            .map(|_| ())
    }
}

/// True at most once per [`ROSTER_RECONCILE_SECS`], however often the fanout loop ticks.
fn roster_reconcile_due() -> bool {
    use std::sync::atomic::{AtomicI64, Ordering};
    static LAST: AtomicI64 = AtomicI64::new(0);
    let now = chrono::Utc::now().timestamp();
    let last = LAST.load(Ordering::Relaxed);
    now - last >= ROSTER_RECONCILE_SECS
        && LAST
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
}

const ROSTER_RECONCILE_SECS: i64 = 300;

/// Retry queue of alliance event mirrors.
struct EventMirrorRetry;

#[async_trait]
impl LoopTask for EventMirrorRetry {
    fn name(&self) -> &'static str {
        "event_mirror_retry"
    }

    fn tick(&self) -> Duration {
        Duration::from_secs(15)
    }

    fn wake_target(&self) -> Option<WakeTarget> {
        Some(WakeTarget::MirrorRetry)
    }

    async fn run_once(&self, cx: &TaskContext) -> Result<(), AppError> {
        crate::modules::events::mirror_retry::process_due(&cx.control, &cx.registry)
            .await
            .map(|_| ())
    }
}

/// Every loop the server runs. Owner slices append their loop here.
#[must_use]
pub fn registered_tasks() -> Vec<Arc<dyn LoopTask>> {
    let mut tasks: Vec<Arc<dyn LoopTask>> = vec![Arc::new(EventFanout), Arc::new(EventMirrorRetry)];
    tasks.extend(crate::modules::sync::engine::registered_tasks());
    tasks
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[test]
    fn registered_tasks_have_unique_names_and_wake_targets() {
        let tasks = registered_tasks();
        let mut names: Vec<_> = tasks.iter().map(|t| t.name()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), tasks.len());
        let mut targets: Vec<_> = tasks.iter().filter_map(|t| t.wake_target()).collect();
        let before = targets.len();
        targets.dedup();
        assert_eq!(before, targets.len());
        // Both legacy loops keep their 15 s cadence; the sync loops have their own.
        assert!(
            tasks
                .iter()
                .filter(|t| !t.name().starts_with("sync_"))
                .all(|t| t.tick() == Duration::from_secs(15))
        );
    }

    struct Counting(Arc<AtomicUsize>);

    #[async_trait]
    impl LoopTask for Counting {
        fn name(&self) -> &'static str {
            "counting"
        }
        fn tick(&self) -> Duration {
            Duration::from_secs(3600)
        }
        async fn run_once(&self, _cx: &TaskContext) -> Result<(), AppError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    async fn context() -> TaskContext {
        let control = sea_orm::Database::connect("sqlite::memory:")
            .await
            .expect("sqlite");
        TaskContext {
            registry: TenantRegistry::new("sqlite::memory:".into(), control.clone()),
            control,
        }
    }

    #[tokio::test]
    async fn a_kick_cuts_the_tick_short() {
        let runs = Arc::new(AtomicUsize::new(0));
        let wake = Wake::new();
        let handle = tokio::spawn(run_loop(
            Arc::new(Counting(runs.clone())),
            context().await,
            wake.clone(),
        ));
        for _ in 0..200 {
            if runs.load(Ordering::SeqCst) == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        wake.kick();
        for _ in 0..200 {
            if runs.load(Ordering::SeqCst) == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(
            runs.load(Ordering::SeqCst),
            2,
            "tick is an hour; only the kick can run it"
        );
        handle.abort();
    }
}
