//! AlbionBB battle linking for event sessions.
//!
//! AlbionBB takes ~30 minutes to ingest a battle, so a session is polled
//! repeatedly until either the post-stop grace period elapses (then we
//! finalize) or the listing stabilises. This module owns that polling policy.

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};

use crate::errors::AppError;
use crate::modules::albionbb::service::AlbionBbService;
use crate::modules::albiondata::service::AlbionDataService;
use crate::modules::events::entities::event;
use crate::modules::events::service::{BattleLinkingContext, EventService};
use crate::modules::regear::extractor::{ExtractionGuildContext, RegearExtractor};

/// Re-links battles for every session still awaiting linkage.
///
/// For each pending session we either finalize (grace period elapsed) or run
/// one linker tick, tolerating transient upstream failures by retrying on the
/// next worker pass.
///
/// # Example
/// ```ignore
/// refresh_pending_links(&db, &albionbb, &context).await?;
/// ```
pub async fn refresh_pending_links(
    db: &DatabaseConnection,
    albionbb: &AlbionBbService,
    albiondata: &AlbionDataService,
    context: &BattleLinkingContext,
    guild: &ExtractionGuildContext,
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
            finalize_expired_link(db, albiondata, guild, session.id).await;
            continue;
        }
        link_or_retry(db, albionbb, context, session.id).await;
    }

    Ok(())
}

/// Finalizes a session whose grace period has elapsed, logging any failure.
///
/// Finalizing is also the moment regears become extractable: the battles are
/// linked and will not change again, so every guild death in them is now
/// known. Running earlier would miss whatever AlbionBB had not yet ingested.
async fn finalize_expired_link(
    db: &DatabaseConnection,
    albiondata: &AlbionDataService,
    guild: &ExtractionGuildContext,
    event_id: i64,
) {
    if let Err(e) = EventService::finalize_link(db, event_id, false).await {
        tracing::warn!(event_id = event_id, error = %e, "finalize_link failed");
        return;
    }
    extract_regears(db, albiondata, guild, event_id).await;
}

/// Extracts regear candidates for a finalized event.
///
/// Idempotent by construction — the extractor skips deaths it has already
/// recorded — so a retry on a later tick cannot duplicate rows.
///
/// Failures are logged and swallowed. Extraction depends on live market prices,
/// and an upstream hiccup must not stop sessions from finalizing; officers can
/// always re-run it by hand from the regear page.
async fn extract_regears(
    db: &DatabaseConnection,
    albiondata: &AlbionDataService,
    guild: &ExtractionGuildContext,
    event_id: i64,
) {
    let extractor = RegearExtractor::new(db, albiondata, guild.clone());
    match extractor.extract_for_event(event_id).await {
        Ok(report) if report.deaths_inserted > 0 => {
            tracing::info!(
                event_id = event_id,
                inserted = report.deaths_inserted,
                skipped = report.deaths_skipped,
                "auto-extracted regear candidates"
            );
        }
        Ok(_) => {}
        // Non-CTA events have no regear entitlement; that is the normal case
        // for most sessions, not a problem worth warning about.
        Err(AppError::Validation(_)) => {}
        Err(e) => {
            tracing::warn!(event_id = event_id, error = %e, "regear auto-extraction failed");
        }
    }
}

/// Runs one linker tick, swallowing transient upstream errors to retry later.
async fn link_or_retry(
    db: &DatabaseConnection,
    albionbb: &AlbionBbService,
    context: &BattleLinkingContext,
    event_id: i64,
) {
    match EventService::link_battles_for_event(db, albionbb, context, event_id).await {
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
