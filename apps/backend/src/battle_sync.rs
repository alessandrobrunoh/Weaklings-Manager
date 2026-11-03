//! Background worker that persists guild battle snapshots automatically.
//!
//! `BattlesService::get_battle_detail_with_losses` only writes a
//! `guild_battle_snapshots` row when someone actually opens a battle's detail
//! page in the UI — silver-loss stats (user profile, event rollups) were
//! silently incomplete for any battle nobody clicked into. This worker closes
//! that gap by mirroring what the Discord poller sees (`/api/battles`, page 1)
//! and backfilling any battle not yet persisted.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use sea_orm::{ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter, Statement};
use tokio::time::interval;

use crate::albion_scope::{self, AlbionScope};
use crate::modules::albionbb::service::AlbionBbService;
use crate::modules::albiondata::service::AlbionDataService;
use crate::modules::battles::entities::{Column as SnapshotColumn, Entity as SnapshotEntity};
use crate::modules::battles::service::BattlesService;
use crate::modules::events::service::BattleLinkingContext;
use crate::pagination::{PaginationParams, SortOrder};

/// Tick interval for the sync worker. Battles that fall off page 1 between
/// ticks are already covered by whichever tick first saw them.
const TICK_INTERVAL: Duration = Duration::from_secs(120);

/// Spawns the battle-sync worker on the current runtime. Returns immediately;
/// the task runs until the process exits.
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
                tracing::info!(tenant_id, "battle-sync worker stopped");
                break;
            }
            match prepare_cycle(&control, &tenant_id).await {
                Ok(None) => {}
                Ok(Some(_)) if stop.load(Ordering::Relaxed) => {
                    tracing::info!(tenant_id, "battle-sync worker stopped");
                    break;
                }
                Ok(Some(scope)) => {
                    let battles = BattlesService::new(
                        albionbb.clone(),
                        scope.guild_id.clone(),
                        &scope.allied_guild_ids,
                        &scope.allied_guild_names,
                        scope.server(),
                    );
                    let guild_ctx = scope.linking_context();
                    let albiondata = albiondata.with_default_server(scope.region.clone());
                    if let Err(e) = run_cycle(&db, &battles, &albiondata, &guild_ctx).await {
                        tracing::warn!(tenant_id, error = %e, "battle-sync worker cycle failed");
                    }
                }
                Err(error) => {
                    tracing::warn!(tenant_id, error = %error, "battle-sync worker skipped cycle");
                }
            }
        }
    });
}

async fn prepare_cycle(
    control: &DatabaseConnection,
    tenant_id: &str,
) -> Result<Option<AlbionScope>, crate::errors::AppError> {
    let row = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT status, kind FROM tenants WHERE id = $1",
            [tenant_id.into()],
        ))
        .await
        .map_err(crate::errors::AppError::Database)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let status: String = row
        .try_get_by_index(0)
        .map_err(crate::errors::AppError::Database)?;
    let kind: String = row
        .try_get_by_index(1)
        .map_err(crate::errors::AppError::Database)?;
    if kind.is_empty() || !albion_scope::sync_cycle_should_run(&status, &kind) {
        return Ok(None);
    }
    match albion_scope::load_albion_scope(control, tenant_id).await {
        Ok(scope) => Ok(Some(scope)),
        Err(albion_scope::AlbionScopeError::NotConfigured) => Ok(None),
        Err(albion_scope::AlbionScopeError::Database(err)) => {
            Err(crate::errors::AppError::Database(err))
        }
    }
}

/// One pass: list the most recent guild battles and persist any that aren't
/// already snapshotted.
async fn run_cycle(
    db: &DatabaseConnection,
    battles: &BattlesService,
    albiondata: &AlbionDataService,
    guild_ctx: &BattleLinkingContext,
) -> Result<(), crate::errors::AppError> {
    let page = battles
        .list_guild_battles(
            db,
            None,
            &PaginationParams {
                page: Some(1),
                limit: Some(50),
            },
            None,
            Some("start_time"),
            SortOrder::Desc,
            None,
        )
        .await?;

    for summary in page.items {
        let already_saved = SnapshotEntity::find()
            .filter(SnapshotColumn::BattleId.eq(summary.battle_id))
            .one(db)
            .await
            .map_err(crate::errors::AppError::Database)?
            .is_some();

        if already_saved {
            continue;
        }

        if let Err(e) = battles
            .get_battle_detail_with_losses(db, summary.battle_id, albiondata)
            .await
        {
            tracing::warn!(
                battle_id = summary.battle_id,
                error = %e,
                "battle-sync: failed to fetch/persist battle detail, will retry next tick"
            );
        }
    }

    // Second phase: scout whatever is now persisted. Runs after the loop above
    // so a battle's snapshot is guaranteed to exist before we try to read it.
    // Failures are logged, never propagated — scouting must not be able to
    // stall snapshot persistence.
    match crate::modules::intel::auto_scout::scout_recent_snapshots(db, guild_ctx).await {
        Ok(0) => {}
        Ok(count) => tracing::info!(battles = count, "battle-sync: scouted new battles"),
        Err(e) => tracing::warn!(error = %e, "battle-sync: intel scouting pass failed"),
    }

    // Third phase: group any fights the sync worker seeded without an event attached.
    // Same best-effort, logged-not-propagated style as scouting above — a failed grouping
    // pass must not be able to stall snapshot persistence or scouting on the next tick.
    match crate::modules::events::service::group_orphan_fights(db, guild_ctx, chrono::Utc::now())
        .await
    {
        Ok(0) => {}
        Ok(count) => tracing::info!(fights_merged = count, "battle-sync: grouped orphan fights"),
        Err(e) => tracing::warn!(error = %e, "battle-sync: orphan fight grouping pass failed"),
    }

    Ok(())
}
