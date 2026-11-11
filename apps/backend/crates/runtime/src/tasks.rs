//! The periodic background loop abstraction.
//!
//! A [`LoopTask`] is one unit of polling work: `run_once` drains whatever is
//! due, and the loop around it (see [`run_loop`]) repeats it every `tick`, or
//! sooner when its [`Wake`] is kicked. New queues register by adding one entry
//! to the app's `app_runtime::registered_tasks`; there is no other spawn point.

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use sea_orm::DatabaseConnection;

use super::wake::{Wake, WakeTarget};
use backend_core::errors::AppError;
use backend_identity::tenant::TenantRegistry;

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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

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
