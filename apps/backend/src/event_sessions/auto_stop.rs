//! Auto-stop of expired live event sessions.
//!
//! A session that is still `live` past its `auto_stop_deadline` should be
//! transitioned to `auto_stopped` so downstream consumers stop treating it as
//! active. This runs on the worker cadence, so latency is bounded by the tick
//! interval rather than by user action.

use chrono::Utc;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};

use crate::errors::AppError;
use crate::modules::events::entities::event;
use crate::modules::events::service::EventService;

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
        if let Err(e) = service.stop_event(db, session.id, true).await {
            tracing::warn!(event_id = session.id, error = %e, "auto-stop failed");
        }
    }

    Ok(())
}
