//! The events module's background loops: the fanout and mirror retry queues.
//!
//! The app registers them through [`registered_tasks`]; the runtime spawns and
//! supervises them like every other [`LoopTask`].

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;

use backend_core::errors::AppError;
use backend_runtime::tasks::{LoopTask, TaskContext};
use backend_runtime::wake::WakeTarget;

/// The events loops, in registration order.
#[must_use]
pub fn registered_tasks() -> Vec<Arc<dyn LoopTask>> {
    vec![Arc::new(EventFanout), Arc::new(EventMirrorRetry)]
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
        if let Err(error) =
            crate::events::fanout_worker::reconcile_missing_copies(&cx.control, &cx.registry).await
        {
            tracing::warn!(error = %error, "event fanout catch-up failed");
        }
        // Roster drift is rare and the scan reads every linked copy, so it runs on a slower cadence.
        if roster_reconcile_due() {
            match crate::events::sync::reconcile_rosters(&cx.control, &cx.registry).await {
                Ok(0) => {}
                Ok(added) => tracing::info!(added, "event rosters reconciled"),
                Err(error) => tracing::warn!(error = %error, "event roster reconcile failed"),
            }
        }
        // Participation changes whose forward to a linked copy failed, retried with backoff.
        if let Err(error) =
            crate::events::sync::process_due_forwards(&cx.control, &cx.registry).await
        {
            tracing::warn!(error = %error, "participation forward retry failed");
        }
        crate::events::fanout_worker::process_due_targets(&cx.control, &cx.registry)
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
        crate::events::mirror_retry::process_due(&cx.control, &cx.registry)
            .await
            .map(|_| ())
    }
}
