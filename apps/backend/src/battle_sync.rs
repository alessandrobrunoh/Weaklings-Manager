//! Background worker that persists guild battle snapshots automatically.
//!
//! `BattlesService::get_battle_detail_with_losses` only writes a
//! `guild_battle_snapshots` row when someone actually opens a battle's detail
//! page in the UI — silver-loss stats (user profile, event rollups) were
//! silently incomplete for any battle nobody clicked into. This worker closes
//! that gap by mirroring what the Discord poller sees (`/api/battles`, page 1)
//! and backfilling any battle not yet persisted. Battles that ended less than
//! 30 minutes ago are re-fetched (a few per tick) because kills reach `AlbionBB`
//! late and an early snapshot is partial.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter, Statement,
};
use tokio::time::interval;

use backend_albion_data::albionbb::service::AlbionBbService;
use backend_albion_data::albiondata::service::AlbionDataService;
use backend_battles::battles::service::BattlesService;
use backend_core::albion_common::BattleLinkingContext;
use backend_core::pagination::{PaginationParams, SortOrder};
use backend_entities::battles::{Column as SnapshotColumn, Entity as SnapshotEntity};
use backend_identity::albion_scope::{self, AlbionScope};

/// Tick interval for the sync worker. Battles that fall off page 1 between
/// ticks are already covered by whichever tick first saw them.
const TICK_INTERVAL: Duration = Duration::from_secs(120);

/// A battle that ended less than this long ago may still be receiving kills upstream (`AlbionBB`
/// documents up to ~15 minutes of lag), so its stored snapshot can be partial and is re-fetched.
const SNAPSHOT_SETTLE_WINDOW: chrono::Duration = chrono::Duration::minutes(30);

/// Minimum age of a stored snapshot before a recent battle is re-fetched, so a battle is
/// refreshed every few ticks, not on each one.
const SNAPSHOT_REFRESH_INTERVAL: chrono::Duration = chrono::Duration::minutes(5);

/// Most already-saved snapshots re-fetched per tick, on top of the battles with no snapshot yet.
const REFRESHES_PER_TICK: usize = 5;

/// Whether a stored snapshot of a battle should be fetched again.
///
/// True when the battle ended inside [`SNAPSHOT_SETTLE_WINDOW`] and the snapshot is at least
/// [`SNAPSHOT_REFRESH_INTERVAL`] old. A battle with no known end time is left alone.
fn snapshot_needs_refresh(
    ended_at: Option<chrono::DateTime<chrono::Utc>>,
    fetched_at: chrono::DateTime<chrono::Utc>,
    now: chrono::DateTime<chrono::Utc>,
) -> bool {
    let Some(ended_at) = ended_at else {
        return false;
    };
    now - ended_at < SNAPSHOT_SETTLE_WINDOW && now - fetched_at >= SNAPSHOT_REFRESH_INTERVAL
}

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
) -> Result<Option<AlbionScope>, backend_core::errors::AppError> {
    let row = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT status, kind FROM tenants WHERE id = $1",
            [tenant_id.into()],
        ))
        .await
        .map_err(backend_core::errors::AppError::Database)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let status: String = row
        .try_get_by_index(0)
        .map_err(backend_core::errors::AppError::Database)?;
    let kind: String = row
        .try_get_by_index(1)
        .map_err(backend_core::errors::AppError::Database)?;
    if kind.is_empty() || !albion_scope::sync_cycle_should_run(&status, &kind) {
        return Ok(None);
    }
    match albion_scope::load_albion_scope(control, tenant_id).await {
        Ok(scope) => Ok(Some(scope)),
        Err(albion_scope::AlbionScopeError::NotConfigured) => {
            tracing::warn!(
                tenant_id,
                "tenant has no Albion guild id or region configured: battle sync is skipped \
                 until an admin sets them"
            );
            Ok(None)
        }
        Err(albion_scope::AlbionScopeError::Database(err)) => {
            Err(backend_core::errors::AppError::Database(err))
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
) -> Result<(), backend_core::errors::AppError> {
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

    let now = chrono::Utc::now();
    let mut refreshed = 0usize;
    for summary in page.items {
        let saved = SnapshotEntity::find()
            .filter(SnapshotColumn::BattleId.eq(summary.battle_id))
            .one(db)
            .await
            .map_err(backend_core::errors::AppError::Database)?;

        if let Some(saved) = saved {
            // Kills keep arriving for a while after a battle ends, so a snapshot taken early is
            // partial. Re-hydrate recent ones, a handful per tick at most.
            let ended_at = chrono::DateTime::parse_from_rfc3339(&summary.end_time)
                .ok()
                .map(|ended| ended.with_timezone(&chrono::Utc));
            let stale =
                snapshot_needs_refresh(ended_at, saved.fetched_at.with_timezone(&chrono::Utc), now);
            if !stale || refreshed >= REFRESHES_PER_TICK {
                continue;
            }
            refreshed += 1;
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
    match backend_intel::auto_scout::scout_recent_snapshots(db, guild_ctx).await {
        Ok(0) => {}
        Ok(count) => tracing::info!(battles = count, "battle-sync: scouted new battles"),
        Err(e) => tracing::warn!(error = %e, "battle-sync: intel scouting pass failed"),
    }

    // Third phase: group any fights the sync worker seeded without an event attached.
    // Same best-effort, logged-not-propagated style as scouting above — a failed grouping
    // pass must not be able to stall snapshot persistence or scouting on the next tick.
    match backend_events::events::service::group_orphan_fights(db, guild_ctx, chrono::Utc::now())
        .await
    {
        Ok(0) => {}
        Ok(count) => tracing::info!(fights_merged = count, "battle-sync: grouped orphan fights"),
        Err(e) => tracing::warn!(error = %e, "battle-sync: orphan fight grouping pass failed"),
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, Duration as ChronoDuration, Utc};
    use sea_orm::{ActiveModelTrait, ActiveValue::Set};

    use super::*;
    use backend_albion_data::albionbb::client::AlbionBbApiClient;
    use backend_albion_data::albionbb::test_support::{json_ok, serve};
    use backend_entities::battles::BattleLossEstimate;

    fn minutes_ago(now: DateTime<Utc>, minutes: i64) -> DateTime<Utc> {
        now - ChronoDuration::minutes(minutes)
    }

    #[test]
    fn only_recently_ended_and_not_freshly_fetched_snapshots_are_refreshed() {
        let now = Utc::now();
        // Ended 10 minutes ago, fetched 8 minutes ago: kills may still have arrived since.
        assert!(snapshot_needs_refresh(
            Some(minutes_ago(now, 10)),
            minutes_ago(now, 8),
            now
        ));
        // Fetched a minute ago: too soon to ask again.
        assert!(!snapshot_needs_refresh(
            Some(minutes_ago(now, 10)),
            minutes_ago(now, 1),
            now
        ));
        // Ended 45 minutes ago: settled, the stored snapshot is final.
        assert!(!snapshot_needs_refresh(
            Some(minutes_ago(now, 45)),
            minutes_ago(now, 40),
            now
        ));
        // Unknown end time: left alone.
        assert!(!snapshot_needs_refresh(None, minutes_ago(now, 40), now));
    }

    fn battle_json(id: i64, started: DateTime<Utc>, ended: DateTime<Utc>, detail: bool) -> String {
        let players = if detail { r#", "players": []"# } else { "" };
        format!(
            r#"{{"albionId": {id}, "startedAt": "{}", "finishedAt": "{}", "totalFame": 1000, "totalKills": 5, "totalPlayers": 20, "guilds": []{players}}}"#,
            started.to_rfc3339(),
            ended.to_rfc3339()
        )
    }

    async fn insert_snapshot(
        db: &DatabaseConnection,
        battle_id: i64,
        started: DateTime<Utc>,
        ended: DateTime<Utc>,
        fetched: DateTime<Utc>,
    ) {
        backend_entities::battles::ActiveModel {
            battle_id: Set(battle_id),
            start_time: Set(started.fixed_offset()),
            end_time: Set(Some(ended.fixed_offset())),
            total_players: Set(20),
            total_kills: Set(1),
            total_fame: Set(1000),
            guilds_json: Set("[]".to_string()),
            players_json: Set("[]".to_string()),
            kills_json: Set("[]".to_string()),
            losses_json: Set(
                serde_json::to_string(&BattleLossEstimate::default()).expect("empty loss estimate")
            ),
            fetched_at: Set(fetched.fixed_offset()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("snapshot should be inserted");
    }

    async fn snapshot_fetched_at(db: &DatabaseConnection, battle_id: i64) -> DateTime<Utc> {
        SnapshotEntity::find()
            .filter(SnapshotColumn::BattleId.eq(battle_id))
            .one(db)
            .await
            .expect("snapshot query")
            .expect("snapshot exists")
            .fetched_at
            .with_timezone(&Utc)
    }

    #[tokio::test]
    async fn a_cycle_refetches_the_snapshot_of_a_battle_that_ended_recently() {
        let db = backend_migration::testkit::migrated_sqlite().await;
        let now = Utc::now();
        // Battle 1 ended 10 minutes ago and was saved an hour ago: partial, to be refreshed.
        let (recent_start, recent_end) = (minutes_ago(now, 20), minutes_ago(now, 10));
        let recent_saved = minutes_ago(now, 60);
        insert_snapshot(&db, 1, recent_start, recent_end, recent_saved).await;
        // Battle 2 ended two hours ago: settled, never fetched again.
        let (old_start, old_end) = (minutes_ago(now, 140), minutes_ago(now, 120));
        let old_saved = minutes_ago(now, 110);
        insert_snapshot(&db, 2, old_start, old_end, old_saved).await;

        // Requests in order: catalog page 1, the empty page that ends the catalog, the detail of
        // each listed battle (newest first), then the kill feed of the one battle refreshed.
        let upstream = serve(vec![
            json_ok(&format!(
                "[{},{}]",
                battle_json(1, recent_start, recent_end, false),
                battle_json(2, old_start, old_end, false)
            )),
            json_ok("[]"),
            json_ok(&battle_json(1, recent_start, recent_end, true)),
            json_ok(&battle_json(2, old_start, old_end, true)),
            json_ok("[]"),
        ])
        .await;
        let albionbb = AlbionBbService::new(AlbionBbApiClient::new(
            Some(upstream.base_url.clone()),
            None,
        ));
        let battles =
            BattlesService::new(albionbb, "guild-1".to_string(), &[], &[], "eu".to_string());
        let context = BattleLinkingContext::new("guild-1", &[], &[]);

        run_cycle(&db, &battles, &AlbionDataService::default(), &context)
            .await
            .expect("cycle succeeds");

        assert_eq!(
            upstream.request_count(),
            5,
            "exactly one kill feed was fetched: the recent battle was refreshed, the old one not"
        );
        assert!(snapshot_fetched_at(&db, 1).await > recent_saved + ChronoDuration::minutes(30));
        let untouched = snapshot_fetched_at(&db, 2).await;
        assert!(
            (untouched - old_saved).num_seconds().abs() < 1,
            "the settled battle keeps its snapshot, fetched_at is {untouched}"
        );
    }
}
