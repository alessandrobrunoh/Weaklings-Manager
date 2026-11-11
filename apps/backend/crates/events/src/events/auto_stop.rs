//! Auto-stop of expired live event sessions.
//!
//! A session that is still `live` past its `auto_stop_deadline` should be
//! transitioned to `auto_stopped` so downstream consumers stop treating it as
//! active. This runs on the worker cadence, so latency is bounded by the tick
//! interval rather than by user action.

use chrono::Utc;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};

use crate::events::lifecycle::{Cause, Transition, XpFilter};
use crate::events::service::EventService;
use backend_core::errors::AppError;
use backend_core::sync_origin::SyncKind;
use backend_entities::events::event;
use backend_runtime::sync::{LegacyLinks, copy_role};

/// Stops every `live` session whose `auto_stop_deadline` has already elapsed.
///
/// Sessions without a deadline, or not yet past it, are skipped. A failure on
/// one session is logged and does not abort the remaining batch.
///
/// # Example
/// ```ignore
/// auto_stop_expired_sessions(&db, &EventService::new()).await?;
/// ```
pub async fn auto_stop_expired_sessions(
    db: &DatabaseConnection,
    service: &EventService,
    control: &DatabaseConnection,
    tenant_id: &str,
) -> Result<(), AppError> {
    let now = Utc::now();

    let live_sessions = event::Entity::find()
        .filter(event::Column::Status.eq("live"))
        .all(db)
        .await
        .map_err(AppError::Database)?;

    for session in live_sessions {
        let deadline = match session.auto_stop_deadline {
            Some(deadline) => deadline,
            None => continue,
        };
        if deadline.with_timezone(&Utc) > now {
            continue;
        }
        tracing::info!(event_id = session.id, "auto-stopping expired event session");
        // Every role stops: an active copy follows local times, a detached copy is
        // local and behaves as an origin. Progression rewards stay with the origin
        // tenant, so any copy (detached included) awards nothing.
        let legacy = LegacyLinks { control, tenant_id };
        let award_xp = match copy_role(db, legacy, SyncKind::Event, session.id).await {
            Ok(role) => !role.is_copy(),
            Err(error) => {
                tracing::warn!(
                    event_id = session.id,
                    error = %error,
                    "could not resolve event copy role; leaving session live"
                );
                continue;
            }
        };
        let stop = Transition::Stop {
            auto: true,
            xp: XpFilter::from_award_xp(award_xp),
        };
        if let Err(e) = service
            .transition(db, session.id, stop, Cause::Scheduler, None)
            .await
        {
            tracing::warn!(event_id = session.id, error = %e, "auto-stop failed");
        }
    }

    Ok(())
}
