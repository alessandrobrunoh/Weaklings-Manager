//! Automatic scouting of newly persisted battle snapshots.
//!
//! Officers should not have to remember to press a button for the enemy
//! library to stay current, so scouting piggybacks on the battle-sync worker.
//!
//! The pass is deliberately forgiving: a battle that cannot be scouted is
//! logged and skipped, never retried in a tight loop and never allowed to
//! abort the surrounding sync cycle. Losing one scout is a much smaller
//! problem than stalling snapshot persistence.

use chrono::{DateTime, Utc};
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde::Serialize;
use utoipa::ToSchema;

use crate::errors::AppError;
use crate::modules::battles::entities::{
    Column as SnapshotColumn, Entity as SnapshotEntity, Model as SnapshotModel,
};
use crate::modules::events::service::BattleLinkingContext;
use crate::modules::intel::entities::scouted_comp_battle;
use crate::modules::intel::service::IntelService;

/// How many recent snapshots one pass will consider.
///
/// Bounded so that a first run against a long history does not turn one worker
/// tick into a multi-minute job; older battles are picked up over subsequent
/// ticks, or on demand via the manual endpoint.
const SCAN_LIMIT: u64 = 50;

/// Hard ceiling on `scout_snapshots_before`'s `limit`, regardless of what the
/// caller requests, so one manual backfill page cannot turn into an unbounded
/// scan of the whole snapshot history.
const MAX_BACKFILL_LIMIT: u64 = 500;

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
    scout_unscouted_snapshots(db, guild_ctx, snapshots).await
}

/// One page of a manually-triggered scouting backfill, older than
/// `before` and bounded by `limit`. Unlike `scout_recent_snapshots`
/// (which always looks at the newest snapshots), this is a cursor an
/// officer pages backward through history with: call once, then call
/// again passing `oldest_considered_start_time` from the response as the
/// next call's `before`, until `considered` is 0.
#[derive(Debug, Serialize, ToSchema)]
pub struct BackfillOutcome {
    /// How many of the considered snapshots were newly scouted.
    pub scouted: usize,
    /// How many snapshots this call looked at, before the already-scouted
    /// skip. `0` means the cursor has reached the end of history.
    pub considered: usize,
    /// The earliest `start_time` among the snapshots this call considered.
    /// `None` when `considered` is `0`. Pass this back as the next call's
    /// `before` to keep paging backward.
    pub oldest_considered_start_time: Option<DateTime<Utc>>,
}

/// Scouts one page of snapshots older than `before`, ordered newest first
/// and capped at `limit` (itself capped at [`MAX_BACKFILL_LIMIT`]).
///
/// This is the manually-triggered counterpart to `scout_recent_snapshots`:
/// where that function only ever looks at the newest [`SCAN_LIMIT`]
/// snapshots and so can permanently miss a battle that scrolls out of that
/// window before being scouted, this lets an officer walk the full history
/// backward on demand.
pub async fn scout_snapshots_before(
    db: &DatabaseConnection,
    guild_ctx: &BattleLinkingContext,
    before: DateTime<Utc>,
    limit: u64,
) -> Result<BackfillOutcome, AppError> {
    let capped_limit = limit.min(MAX_BACKFILL_LIMIT);
    let snapshots = SnapshotEntity::find()
        .filter(SnapshotColumn::StartTime.lt(before))
        .order_by_desc(SnapshotColumn::StartTime)
        .limit(capped_limit)
        .all(db)
        .await?;
    let considered = snapshots.len();
    let oldest_considered_start_time = snapshots
        .iter()
        .map(|snapshot| snapshot.start_time.with_timezone(&Utc))
        .min();
    let scouted = scout_unscouted_snapshots(db, guild_ctx, snapshots).await?;
    Ok(BackfillOutcome {
        scouted,
        considered,
        oldest_considered_start_time,
    })
}

/// Scouts whichever of `snapshots` are not already in `scouted_comp_battles`.
///
/// Shared by `scout_recent_snapshots` and `scout_snapshots_before`: both
/// differ only in which batch of snapshots they gather, not in what happens
/// to that batch once gathered.
async fn scout_unscouted_snapshots(
    db: &DatabaseConnection,
    guild_ctx: &BattleLinkingContext,
    snapshots: Vec<SnapshotModel>,
) -> Result<usize, AppError> {
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

#[cfg(test)]
mod tests {
    use chrono::Duration;
    use sea_orm::{ActiveModelTrait, ActiveValue::Set, Database};

    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::battles::models::{BattleGuildSummary, BattlePlayer};
    use crate::modules::intel::entities::scouted_comp;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("connect to in-memory SQLite");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("run database migrations");
        db
    }

    fn ctx() -> BattleLinkingContext {
        BattleLinkingContext::new("our-guild", &[], &[])
    }

    fn guild(id: &str, name: &str, players: i64) -> BattleGuildSummary {
        BattleGuildSummary {
            id: id.to_string(),
            name: name.to_string(),
            alliance_name: None,
            alliance_id: None,
            players,
            kills: 0,
            deaths: 0,
            kill_fame: 0,
            winner: false,
            average_item_power: 1000.0,
        }
    }

    fn player(id: &str, guild_id: &str, guild_name: &str) -> BattlePlayer {
        BattlePlayer {
            id: id.to_string(),
            name: id.to_string(),
            guild_id: guild_id.to_string(),
            guild_name: guild_name.to_string(),
            alliance_name: None,
            alliance_id: None,
            kills: 0,
            deaths: 0,
            kill_fame: 0,
            death_fame: 0,
            item_power: 1000.0,
        }
    }

    /// Inserts a snapshot with a friendly and a two-player enemy side, which
    /// `scout_from_snapshot` always turns into exactly one scoutable draft.
    async fn insert_scoutable_snapshot(
        db: &DatabaseConnection,
        battle_id: i64,
        start_time: DateTime<Utc>,
    ) {
        let guilds = vec![guild("our-guild", "Weaklings", 2), guild("foe", "Foes", 2)];
        let players = vec![
            player("us-a", "our-guild", "Weaklings"),
            player("us-b", "our-guild", "Weaklings"),
            player("foe-a", "foe", "Foes"),
            player("foe-b", "foe", "Foes"),
        ];
        crate::modules::battles::entities::ActiveModel {
            battle_id: Set(battle_id),
            start_time: Set(start_time.into()),
            end_time: Set(None),
            total_players: Set(i64::try_from(players.len()).unwrap_or(i64::MAX)),
            total_kills: Set(0),
            total_fame: Set(0),
            guilds_json: Set(serde_json::to_string(&guilds).expect("serialize guilds")),
            players_json: Set(serde_json::to_string(&players).expect("serialize players")),
            kills_json: Set("[]".to_string()),
            losses_json: Set("[]".to_string()),
            fetched_at: Set(start_time.into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert battle snapshot");
    }

    /// Marks `battle_id` as already scouted by linking it to a fresh, minimal
    /// scouted comp row.
    async fn mark_already_scouted(db: &DatabaseConnection, battle_id: i64) {
        let now = Utc::now().into();
        let scouted_comp_id = scouted_comp::ActiveModel {
            name: Set("Pre-existing Scout".to_string()),
            opponent_guild_id: Set(None),
            opponent_guild_name: Set("Foes".to_string()),
            opponent_alliance_name: Set(None),
            category: Set("small".to_string()),
            player_count: Set(2),
            weapon_sample_size: Set(0),
            avg_ip: Set(1000.0),
            roles_json: Set("{}".to_string()),
            weapons_json: Set("{}".to_string()),
            players_json: Set("[]".to_string()),
            fingerprint: Set(format!("pre-existing-{battle_id}")),
            source_battle_count: Set(1),
            threat_score: Set(2),
            notes: Set(None),
            is_archived: Set(false),
            first_seen_at: Set(now),
            saved_at: Set(now),
            created_by_user_id: Set(None),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert scouted comp")
        .id;
        scouted_comp_battle::ActiveModel {
            scouted_comp_id: Set(scouted_comp_id),
            battle_id: Set(battle_id),
            linked_at: Set(now),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert scouted comp battle link");
    }

    #[tokio::test]
    async fn backfill_of_an_empty_table_considers_and_scouts_nothing() {
        let db = seed_db().await;

        let outcome = scout_snapshots_before(&db, &ctx(), Utc::now(), 200)
            .await
            .expect("backfill runs");

        assert_eq!(outcome.scouted, 0);
        assert_eq!(outcome.considered, 0);
        assert_eq!(outcome.oldest_considered_start_time, None);
    }

    #[tokio::test]
    async fn backfill_pages_backward_by_start_time() {
        let db = seed_db().await;
        let base = Utc::now();
        insert_scoutable_snapshot(&db, 1, base - Duration::hours(3)).await;
        insert_scoutable_snapshot(&db, 2, base - Duration::hours(2)).await;
        insert_scoutable_snapshot(&db, 3, base - Duration::hours(1)).await;

        // `before` only covers the oldest two of the three snapshots.
        let cutoff = base - Duration::minutes(90);
        let outcome = scout_snapshots_before(&db, &ctx(), cutoff, 200)
            .await
            .expect("backfill runs");

        assert_eq!(outcome.considered, 2);
        assert_eq!(outcome.scouted, 2);
        let oldest = outcome
            .oldest_considered_start_time
            .expect("some snapshot was considered");
        assert!((oldest - (base - Duration::hours(3))).num_seconds().abs() <= 1);
    }

    #[tokio::test]
    async fn backfill_skips_a_snapshot_already_scouted() {
        let db = seed_db().await;
        let base = Utc::now();
        insert_scoutable_snapshot(&db, 10, base - Duration::hours(1)).await;
        insert_scoutable_snapshot(&db, 11, base - Duration::hours(2)).await;
        mark_already_scouted(&db, 10).await;

        let outcome = scout_snapshots_before(&db, &ctx(), base, 200)
            .await
            .expect("backfill runs");

        assert_eq!(
            outcome.considered, 2,
            "an already-scouted snapshot is still considered, just not re-scouted"
        );
        assert_eq!(
            outcome.scouted, 1,
            "only the not-yet-scouted snapshot should be newly scouted"
        );
    }

    /// Does not prove the exact ceiling value (that would need >500 rows),
    /// only that an absurd requested `limit` is clamped rather than passed
    /// straight through to the query builder and erroring or hanging.
    #[tokio::test]
    async fn backfill_accepts_an_oversized_requested_limit_without_erroring() {
        let db = seed_db().await;
        let base = Utc::now();
        for i in 0i64..3 {
            insert_scoutable_snapshot(&db, 100 + i, base - Duration::hours(i)).await;
        }

        let outcome = scout_snapshots_before(&db, &ctx(), base + Duration::hours(1), u64::MAX)
            .await
            .expect("backfill runs even with an absurd requested limit");

        assert_eq!(outcome.considered, 3);
    }
}
