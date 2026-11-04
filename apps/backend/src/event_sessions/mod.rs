//! Background worker for event sessions.
//!
//! The worker runs on a fixed cadence and delegates to two focused passes:
//! 1. [`auto_stop_expired_sessions`] — auto-stop live sessions past their deadline.
//! 2. [`refresh_pending_links`] — keep polling AlbionBB until battles are linked.
//!
//! The AlbionBB upstream can take ~30 minutes to ingest a battle, so each
//! session is polled repeatedly until either the post-stop grace period elapses
//! or the listing stabilises (same row count two ticks in a row).

pub mod auto_stop;
pub mod battle_linker;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sea_orm::{ConnectionTrait, DatabaseConnection, Statement};
use tokio::time::interval;

use crate::modules::giveaways::GiveawayService;
use auto_stop::auto_stop_expired_sessions;
use battle_linker::refresh_pending_links;

use crate::albion_scope::{self, AlbionScope};
use crate::errors::AppError;
use crate::modules::albionbb::service::AlbionBbService;
use crate::modules::albiondata::service::AlbionDataService;
use crate::modules::events::service::EventService;
use crate::modules::regear::extractor::ExtractionGuildContext;

/// Tick interval for the worker. Short enough that auto-stop latency stays
/// within tens of seconds, long enough not to hammer the DB.
const TICK_INTERVAL: Duration = Duration::from_secs(30);

/// Spawns the event-sessions worker on the current runtime. Returns immediately;
/// the task runs until the process exits.
///
/// # Example
/// ```ignore
/// event_sessions::spawn(db.clone(), albionbb.clone(), cfg.clone());
/// ```
pub fn spawn(
    db: DatabaseConnection,
    albionbb: AlbionBbService,
    albiondata: AlbionDataService,
    tenant_id: String,
    control: DatabaseConnection,
    stop: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        let mut ticker = interval(TICK_INTERVAL);
        loop {
            ticker.tick().await;
            if stop.load(Ordering::Relaxed) {
                tracing::info!(tenant_id, "event-sessions worker stopped");
                break;
            }
            if let Err(error) = EventService::new()
                .retry_pending_event_completion_xp(&db)
                .await
            {
                tracing::warn!(tenant_id, error = %error, "event completion XP retry cycle failed");
            }
            match prepare_cycle(&control, &tenant_id).await {
                Ok(None) => {}
                Ok(Some(scope)) if stop.load(Ordering::Relaxed) => {
                    tracing::info!(tenant_id, "event-sessions worker stopped");
                    break;
                }
                Ok(Some(scope)) => {
                    let albiondata = albiondata.with_default_server(scope.region.clone());
                    if let Err(e) =
                        run_cycle(&db, &control, &tenant_id, &albionbb, &albiondata, &scope).await
                    {
                        tracing::error!(tenant_id, error = %e, "event-sessions worker cycle failed");
                    }
                }
                Err(e) => {
                    tracing::error!(tenant_id, error = %e, "event-sessions worker skipped cycle");
                }
            }
        }
    });
}

/// `None` means the tenant is not an active guild and this tick must not sync.
async fn prepare_cycle(
    control: &DatabaseConnection,
    tenant_id: &str,
) -> Result<Option<AlbionScope>, AppError> {
    let kind_status = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT status, kind FROM tenants WHERE id = $1",
            [tenant_id.into()],
        ))
        .await
        .map_err(AppError::Database)?;
    let Some(row) = kind_status else {
        return Ok(None);
    };
    let status: String = row.try_get_by_index(0).map_err(AppError::Database)?;
    let kind: String = row.try_get_by_index(1).map_err(AppError::Database)?;
    if kind.is_empty() || !albion_scope::sync_cycle_should_run(&status, &kind) {
        return Ok(None);
    }
    match albion_scope::load_albion_scope(control, tenant_id).await {
        Ok(scope) => Ok(Some(scope)),
        Err(albion_scope::AlbionScopeError::NotConfigured) => Ok(None),
        Err(albion_scope::AlbionScopeError::Database(err)) => Err(AppError::Database(err)),
    }
}

/// One pass of the worker: auto-stop expired sessions, then refresh links.
///
/// The two passes are independent; a failure in one does not skip the other,
/// and each logs its own errors so the cycle keeps running.
async fn run_cycle(
    db: &DatabaseConnection,
    control: &DatabaseConnection,
    tenant_id: &str,
    albionbb: &AlbionBbService,
    albiondata: &AlbionDataService,
    scope: &AlbionScope,
) -> Result<(), AppError> {
    let events = EventService::new();
    auto_stop_expired_sessions(db, &events, control, tenant_id).await?;
    if let Err(error) = GiveawayService::new().draw_due(db).await {
        tracing::warn!(error = %error, "giveaway auto-draw cycle failed");
    }
    let context = scope.linking_context();
    let guild = ExtractionGuildContext {
        guild_id: scope.guild_id.clone(),
        // The extractor treats an empty region as "use the service default".
        server: Some(scope.server()).filter(|region| !region.is_empty()),
    };
    refresh_pending_links(db, albionbb, albiondata, &context, &guild).await?;
    Ok(())
}
