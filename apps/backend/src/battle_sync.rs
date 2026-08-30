//! Background worker that persists guild battle snapshots automatically.
//!
//! `BattlesService::get_battle_detail_with_losses` only writes a
//! `guild_battle_snapshots` row when someone actually opens a battle's detail
//! page in the UI — silver-loss stats (user profile, event rollups) were
//! silently incomplete for any battle nobody clicked into. This worker closes
//! that gap by mirroring what the Discord poller sees (`/api/battles`, page 1)
//! and backfilling any battle not yet persisted.

use std::time::Duration;

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use tokio::time::interval;

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
    battles: BattlesService,
    albiondata: AlbionDataService,
    guild_ctx: BattleLinkingContext,
) {
    tokio::spawn(async move {
        let mut ticker = interval(TICK_INTERVAL);
        loop {
            ticker.tick().await;
            if let Err(e) = run_cycle(&db, &battles, &albiondata, &guild_ctx).await {
                tracing::warn!(error = %e, "battle-sync worker cycle failed");
            }
        }
    });
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

    Ok(())
}
