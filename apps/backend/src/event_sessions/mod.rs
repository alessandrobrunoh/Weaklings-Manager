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

use std::time::Duration;

use sea_orm::DatabaseConnection;
use tokio::time::interval;

use auto_stop::auto_stop_expired_sessions;
use battle_linker::refresh_pending_links;

use crate::config::Config;
use crate::errors::AppError;
use crate::modules::albionbb::service::AlbionBbService;
use crate::modules::events::service::{BattleLinkingContext, EventService};

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
pub fn spawn(db: DatabaseConnection, albionbb: AlbionBbService, cfg: Config) {
    tokio::spawn(async move {
        let mut ticker = interval(TICK_INTERVAL);
        // Don't pile up ticks if a cycle takes longer than TICK_INTERVAL.
        // (default `MissedTickBehavior::Burst` is fine here.)
        loop {
            ticker.tick().await;
            if let Err(e) = run_cycle(&db, &albionbb, &cfg).await {
                tracing::error!(error = %e, "event-sessions worker cycle failed");
            }
        }
    });
}

/// One pass of the worker: auto-stop expired sessions, then refresh links.
///
/// The two passes are independent; a failure in one does not skip the other,
/// and each logs its own errors so the cycle keeps running.
async fn run_cycle(
    db: &DatabaseConnection,
    albionbb: &AlbionBbService,
    cfg: &Config,
) -> Result<(), AppError> {
    auto_stop_expired_sessions(db, &EventService::new()).await?;
    let context = BattleLinkingContext::new(
        &cfg.albion_guild_id,
        &cfg.albion_allied_guild_ids(),
        &cfg.albion_allied_guild_names(),
    );
    refresh_pending_links(db, albionbb, &context).await?;
    Ok(())
}
