//! The events module's background loops: the link fanout and mirror retry queues, and the
//! maintenance that keeps event links honest.
//!
//! The app registers them through [`registered_tasks`]; the runtime spawns and
//! supervises them like every other [`LoopTask`].

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};

use backend_core::errors::AppError;
use backend_identity::tenant::TenantRegistry;
use backend_runtime::tasks::{LoopTask, TaskContext};
use backend_runtime::wake::WakeTarget;

/// The events loops, in registration order.
#[must_use]
pub fn registered_tasks() -> Vec<Arc<dyn LoopTask>> {
    vec![Arc::new(EventFanout), Arc::new(EventMirrorRetry)]
}

/// Retry queue of Alliance-to-Guild event links.
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
        // Queue the links a guild missed (it joined later, or a publish was lost) before
        // draining, so they go out in this tick.
        if let Err(error) =
            crate::events::fanout_worker::reconcile_missing_copies(&cx.control, &cx.registry).await
        {
            tracing::warn!(error = %error, "event fanout catch-up failed");
        }
        if due(&LAST_LEGACY_CONVERSION, LEGACY_CONVERSION_SECS) {
            // The synchronized copies of the previous model become links, once at start and
            // then as a safety net for anything that was still being written during a deploy.
            match crate::events::links::convert_legacy_copies(&cx.control, &cx.registry).await {
                Ok(0) => {}
                Ok(converted) => tracing::info!(converted, "legacy event copies converted to links"),
                Err(error) => tracing::warn!(error = %error, "legacy event copy conversion failed"),
            }
        }
        if due(&LAST_LINK_RECONCILE, LINK_RECONCILE_SECS) {
            // Alliance tenants run no per-tenant session worker, so their live events would
            // never auto-stop; the guild ones stop in their own workers. Either way the links
            // learn about it here.
            if let Err(error) = auto_stop_alliance_sessions(&cx.control, &cx.registry).await {
                tracing::warn!(error = %error, "alliance event auto-stop failed");
            }
            match crate::events::links::reconcile_link_state(&cx.control, &cx.registry).await {
                Ok(0) => {}
                Ok(changed) => tracing::info!(changed, "event links reconciled"),
                Err(error) => tracing::warn!(error = %error, "event link reconcile failed"),
            }
        }
        crate::events::fanout_worker::process_due_targets(&cx.control, &cx.registry)
            .await
            .map(|_| ())
    }
}

/// Seconds between two link reconcile passes, however often the fanout loop ticks.
const LINK_RECONCILE_SECS: i64 = 60;
/// Seconds between two legacy-copy conversion passes (the first runs on the first tick).
const LEGACY_CONVERSION_SECS: i64 = 3600;

static LAST_LINK_RECONCILE: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
static LAST_LEGACY_CONVERSION: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// True at most once per `every_secs`, however often the loop ticks.
fn due(last: &std::sync::atomic::AtomicI64, every_secs: i64) -> bool {
    use std::sync::atomic::Ordering;
    let now = chrono::Utc::now().timestamp();
    let previous = last.load(Ordering::Relaxed);
    now - previous >= every_secs
        && last
            .compare_exchange(previous, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
}

/// Auto-stops expired live events of every active alliance tenant.
async fn auto_stop_alliance_sessions(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
) -> Result<(), AppError> {
    let rows = control
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT id FROM tenants WHERE kind = 'alliance' AND status = 'active'",
            [],
        ))
        .await?;
    for row in rows {
        let tenant_id: String = row.try_get_by_index(0)?;
        match registry.get_or_load(&tenant_id).await {
            Ok(context) => {
                if let Err(error) = crate::events::auto_stop::auto_stop_expired_sessions(
                    &context.db,
                    &crate::events::service::EventService::new(),
                )
                .await
                {
                    tracing::warn!(tenant_id, error = %error, "alliance auto-stop pass failed");
                }
            }
            Err(error) => {
                tracing::warn!(tenant_id, error = %error, "alliance tenant could not be loaded for auto-stop");
            }
        }
    }
    Ok(())
}

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
