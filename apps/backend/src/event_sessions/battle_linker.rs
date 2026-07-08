//! AlbionBB battle linking for event sessions.
//!
//! AlbionBB takes ~30 minutes to ingest a battle, so a session is polled
//! repeatedly until either the post-stop grace period elapses (then we
//! finalize) or the listing stabilises. This module owns that polling policy.

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};

use crate::errors::AppError;
use crate::modules::albionbb::service::AlbionBbService;
use crate::modules::events::entities::event;
use crate::modules::events::service::EventService;

/// Re-links battles for every session still awaiting linkage.
///
/// For each pending session we either finalize (grace period elapsed) or run
/// one linker tick, tolerating transient upstream failures by retrying on the
/// next worker pass.
///
/// # Example
/// ```ignore
/// refresh_pending_links(&db, &albionbb, &cfg.albion_guild_id).await?;
/// ```
pub async fn refresh_pending_links(
    db: &DatabaseConnection,
    albionbb: &AlbionBbService,
    guild_id: &str,
) -> Result<(), AppError> {
    let pending_sessions = event::Entity::find()
        .filter(
            event::Column::LinkStatus
                .eq("in_progress")
                .or(event::Column::LinkStatus.eq("pending")),
        )
        .all(db)
        .await
        .map_err(AppError::Database)?;

    for session in pending_sessions {
        if EventService::linker_is_done(&session) {
            finalize_expired_link(db, session.id).await;
            continue;
        }
        link_or_retry(db, albionbb, guild_id, session.id).await;
    }

    Ok(())
}

/// Finalizes a session whose grace period has elapsed, logging any failure.
async fn finalize_expired_link(db: &DatabaseConnection, event_id: i64) {
    if let Err(e) = EventService::finalize_link(db, event_id, false).await {
        tracing::warn!(event_id = event_id, error = %e, "finalize_link failed");
    }
}

/// Runs one linker tick, swallowing transient upstream errors to retry later.
async fn link_or_retry(
    db: &DatabaseConnection,
    albionbb: &AlbionBbService,
    guild_id: &str,
    event_id: i64,
) {
    match EventService::link_battles_for_event(db, albionbb, guild_id, event_id).await {
        Ok(new_count) => {
            tracing::debug!(event_id = event_id, new_battles = new_count, "link tick");
        }
        Err(AppError::UpstreamService(msg)) => {
            tracing::debug!(event_id = event_id, error = %msg, "upstream error, will retry");
        }
        Err(e) => {
            tracing::warn!(event_id = event_id, error = %e, "link_battles_for_event failed");
        }
    }
}
