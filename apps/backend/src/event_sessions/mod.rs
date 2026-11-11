//! Background worker for event sessions.
//!
//! The worker runs on a fixed cadence and delegates to two focused passes:
//! 1. [`auto_stop_expired_sessions`] — auto-stop live sessions past their deadline.
//! 2. [`refresh_pending_links`] — keep polling `AlbionBB` until battles are linked.
//!
//! The `AlbionBB` upstream can take ~30 minutes to ingest a battle, so each
//! session is polled repeatedly until the post-stop grace period elapses.
//!
//! Only pass 2 needs the tenant's Albion guild. A tenant without one still gets
//! auto-stop and giveaway draws; the worker logs a warning every tick instead of
//! going silent.

pub mod battle_linker;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sea_orm::{ConnectionTrait, DatabaseConnection, Statement};
use tokio::time::interval;

use backend_events::events::auto_stop::auto_stop_expired_sessions;
use backend_rewards::giveaways::GiveawayService;
use battle_linker::refresh_pending_links;

use backend_albion_data::albionbb::service::AlbionBbService;
use backend_albion_data::albiondata::service::AlbionDataService;
use backend_battles::battles::service::BattlesService;
use backend_core::errors::AppError;
use backend_events::events::service::EventService;
use backend_identity::albion_scope::{self, AlbionScope};
use backend_regear::extractor::ExtractionGuildContext;

/// Tick interval for the worker. Short enough that auto-stop latency stays
/// within tens of seconds, long enough not to hammer the DB.
const TICK_INTERVAL: Duration = Duration::from_secs(30);

/// How often the worker prunes expired `action_log` rows (shared-actions §3.5).
const ACTION_LOG_PRUNE_INTERVAL: Duration = Duration::from_secs(3600);

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
        let mut last_prune: Option<std::time::Instant> = None;
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
            if last_prune.is_none_or(|at| at.elapsed() >= ACTION_LOG_PRUNE_INTERVAL) {
                if let Err(error) = backend_events::actions::action_log::prune(&db).await {
                    tracing::warn!(tenant_id, error = %error, "action log retention failed");
                }
                last_prune = Some(std::time::Instant::now());
            }
            match prepare_cycle(&control, &tenant_id).await {
                Ok(CyclePlan::Skip) => {}
                Ok(_) if stop.load(Ordering::Relaxed) => {
                    tracing::info!(tenant_id, "event-sessions worker stopped");
                    break;
                }
                Ok(CyclePlan::WithoutAlbion) => {
                    tracing::warn!(
                        tenant_id,
                        "tenant has no Albion guild id or region configured: battles are not \
                         linked to events until an admin sets them; auto-stop and giveaway \
                         draws keep running"
                    );
                    if let Err(e) =
                        run_cycle(&db, &control, &tenant_id, &albionbb, &albiondata, None).await
                    {
                        tracing::error!(tenant_id, error = %e, "event-sessions worker cycle failed");
                    }
                }
                Ok(CyclePlan::Albion(scope)) => {
                    let albiondata = albiondata.with_default_server(scope.region.clone());
                    if let Err(e) = run_cycle(
                        &db,
                        &control,
                        &tenant_id,
                        &albionbb,
                        &albiondata,
                        Some(&scope),
                    )
                    .await
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

/// What one worker tick does for a tenant.
#[derive(Debug, PartialEq, Eq)]
enum CyclePlan {
    /// Not an active guild tenant: nothing to do this tick.
    Skip,
    /// Active guild tenant without an Albion guild id or region: auto-stop and giveaway draws
    /// only, no `AlbionBB` work.
    WithoutAlbion,
    /// Fully configured tenant: every pass runs.
    Albion(AlbionScope),
}

/// Maps the outcome of loading a tenant's Albion scope to the passes that may run.
///
/// A missing configuration downgrades the tick instead of skipping it, so sessions still
/// auto-stop; only a failing control-plane query aborts it.
fn plan_for_scope(
    scope: Result<AlbionScope, albion_scope::AlbionScopeError>,
) -> Result<CyclePlan, AppError> {
    match scope {
        Ok(scope) => Ok(CyclePlan::Albion(scope)),
        Err(albion_scope::AlbionScopeError::NotConfigured) => Ok(CyclePlan::WithoutAlbion),
        Err(albion_scope::AlbionScopeError::Database(err)) => Err(AppError::Database(err)),
    }
}

/// Decides what this tick does for the tenant; see [`CyclePlan`].
async fn prepare_cycle(
    control: &DatabaseConnection,
    tenant_id: &str,
) -> Result<CyclePlan, AppError> {
    let kind_status = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT status, kind FROM tenants WHERE id = $1",
            [tenant_id.into()],
        ))
        .await
        .map_err(AppError::Database)?;
    let Some(row) = kind_status else {
        return Ok(CyclePlan::Skip);
    };
    let status: String = row.try_get_by_index(0).map_err(AppError::Database)?;
    let kind: String = row.try_get_by_index(1).map_err(AppError::Database)?;
    if kind.is_empty() || !albion_scope::sync_cycle_should_run(&status, &kind) {
        return Ok(CyclePlan::Skip);
    }
    plan_for_scope(albion_scope::load_albion_scope(control, tenant_id).await)
}

/// One pass of the worker: auto-stop expired sessions, draw due giveaways, then refresh links.
///
/// Auto-stop and giveaways do not depend on Albion, so they run with `scope == None`; only the
/// `AlbionBB` link refresh is skipped then. A failing giveaway draw is logged and does not skip
/// the link refresh, and each link failure is logged per session.
async fn run_cycle(
    db: &DatabaseConnection,
    control: &DatabaseConnection,
    tenant_id: &str,
    albionbb: &AlbionBbService,
    albiondata: &AlbionDataService,
    scope: Option<&AlbionScope>,
) -> Result<(), AppError> {
    let events = EventService::new();
    auto_stop_expired_sessions(db, &events, control, tenant_id).await?;
    if let Err(error) = GiveawayService::new().draw_due(db).await {
        tracing::warn!(error = %error, "giveaway auto-draw cycle failed");
    }
    let Some(scope) = scope else {
        return Ok(());
    };
    let context = scope.linking_context();
    let battles = BattlesService::new(
        albionbb.clone(),
        scope.guild_id.clone(),
        &scope.allied_guild_ids,
        &scope.allied_guild_names,
        scope.server(),
    );
    let guild = ExtractionGuildContext {
        guild_id: scope.guild_id.clone(),
        // The extractor treats an empty region as "use the service default".
        server: Some(scope.server()).filter(|region| !region.is_empty()),
    };
    refresh_pending_links(db, albionbb, &battles, albiondata, &context, &guild).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::{Duration as ChronoDuration, Utc};
    use sea_orm::{ActiveModelTrait, ActiveValue::Set, EntityTrait};

    use super::*;
    use backend_entities::events::event;
    use backend_runtime::sync::test_support::{insert_user, sqlite_db};

    #[test]
    fn a_tenant_without_an_albion_guild_still_gets_a_plan() {
        assert_eq!(
            plan_for_scope(Err(albion_scope::AlbionScopeError::NotConfigured)).unwrap(),
            CyclePlan::WithoutAlbion
        );
        let scope = AlbionScope::from_tenant_columns(Some("guild-1"), Some("europe"), None, None)
            .expect("configured scope");
        assert_eq!(
            plan_for_scope(Ok(scope.clone())).unwrap(),
            CyclePlan::Albion(scope)
        );
        let broken = albion_scope::AlbionScopeError::Database(sea_orm::DbErr::Custom(
            "control down".to_owned(),
        ));
        assert!(matches!(
            plan_for_scope(Err(broken)),
            Err(AppError::Database(_))
        ));
    }

    #[tokio::test]
    async fn auto_stop_runs_when_the_tenant_has_no_albion_scope() {
        let db = sqlite_db().await;
        let creator = insert_user(&db, "creator").await;
        let past = (Utc::now() - ChronoDuration::minutes(5)).fixed_offset();
        let live = event::ActiveModel {
            title: Set("Overdue live session".to_owned()),
            event_kind: Set("flash".to_owned()),
            comp_id: Set(None),
            created_by: Set(creator),
            event_date_utc: Set(past),
            status: Set("live".to_owned()),
            started_at: Set(Some(past)),
            auto_stop_deadline: Set(Some(past)),
            link_status: Set("in_progress".to_owned()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("live session");

        run_cycle(
            &db,
            &db,
            "tenant-a",
            &AlbionBbService::default(),
            &AlbionDataService::default(),
            None,
        )
        .await
        .expect("a cycle without an Albion scope still succeeds");

        let after = event::Entity::find_by_id(live.id)
            .one(&db)
            .await
            .expect("event query")
            .expect("event exists");
        assert_eq!(after.status, "auto_stopped");
    }
}
