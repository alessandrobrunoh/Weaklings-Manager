//! Automatic scouting of newly persisted battle snapshots.
//!
//! Officers should not have to remember to press a button for the enemy
//! library to stay current, so scouting piggybacks on the battle-sync worker.
//!
//! The pass is deliberately forgiving: a battle that cannot be scouted is
//! logged and skipped, never retried in a tight loop and never allowed to
//! abort the surrounding sync cycle. Losing one scout is a much smaller
//! problem than stalling snapshot persistence.

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, QuerySelect};

use crate::errors::AppError;
use crate::modules::battles::entities::{Column as SnapshotColumn, Entity as SnapshotEntity};
use crate::modules::events::service::BattleLinkingContext;
use crate::modules::intel::entities::scouted_comp_battle;
use crate::modules::intel::service::IntelService;

/// How many recent snapshots one pass will consider.
///
/// Bounded so that a first run against a long history does not turn one worker
/// tick into a multi-minute job; older battles are picked up over subsequent
/// ticks, or on demand via the manual endpoint.
const SCAN_LIMIT: u64 = 50;

/// Scouts recent snapshots that have never been scouted.
///
/// Returns how many battles were newly scouted. A battle counts as already
/// scouted when any row in `scouted_comp_battles` references it, which is a
/// single indexed lookup — no `processed` flag is needed on the snapshot table.
///
/// Battles we did not take part in yield no drafts and are silently skipped;
/// that is a normal outcome, not an error.
pub async fn scout_recent_snapshots(
    db: &DatabaseConnection,
    guild_ctx: &BattleLinkingContext,
) -> Result<usize, AppError> {
    let snapshots = SnapshotEntity::find()
        .order_by_desc(SnapshotColumn::StartTime)
        .limit(SCAN_LIMIT)
        .all(db)
        .await?;
    if snapshots.is_empty() {
        return Ok(0);
    }

    let candidate_ids: Vec<i64> = snapshots.iter().map(|row| row.battle_id).collect();
    let already_scouted: std::collections::HashSet<i64> = scouted_comp_battle::Entity::find()
        .filter(scouted_comp_battle::Column::BattleId.is_in(candidate_ids))
        .all(db)
        .await?
        .into_iter()
        .map(|row| row.battle_id)
        .collect();

    let service = IntelService::new();
    let mut scouted = 0usize;
    for snapshot in snapshots {
        if already_scouted.contains(&snapshot.battle_id) {
            continue;
        }
        match service
            .scout_battle(db, guild_ctx, snapshot.battle_id, false, None)
            .await
        {
            Ok(outcomes) if outcomes.is_empty() => {}
            Ok(outcomes) => {
                scouted += 1;
                tracing::debug!(
                    battle_id = snapshot.battle_id,
                    comps = outcomes.len(),
                    "intel: scouted battle"
                );
            }
            Err(err) => {
                tracing::warn!(
                    battle_id = snapshot.battle_id,
                    error = %err,
                    "intel: failed to scout battle, will retry on a later tick"
                );
            }
        }
    }
    Ok(scouted)
}
