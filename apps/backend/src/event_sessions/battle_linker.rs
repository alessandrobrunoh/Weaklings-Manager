//! `AlbionBB` battle linking for event sessions.
//!
//! `AlbionBB` takes ~30 minutes to ingest a battle, so a session is polled
//! repeatedly until the post-stop grace period elapses (then we finalize).
//! This module owns that polling policy.

use std::collections::HashSet;

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, QuerySelect};

use backend_albion_data::albionbb::service::AlbionBbService;
use backend_albion_data::albiondata::service::AlbionDataService;
use backend_battles::battles::service::BattlesService;
use backend_core::albion_common::BattleLinkingContext;
use backend_core::errors::AppError;
use backend_entities::battles::{Column as SnapshotColumn, Entity as SnapshotEntity};
use backend_entities::events::{event, event_battle};
use backend_events::events::service::EventService;
use backend_regear::extractor::{ExtractionGuildContext, RegearExtractor};

/// Session states the linker looks at. `scheduled` events have nothing to link yet.
/// `cancelled` is only listed so a leftover unfinished link is closed without polling.
const LINKER_STATUSES: [&str; 4] = ["live", "stopped", "auto_stopped", "cancelled"];

/// Most linked battles hydrated (detail fetched and snapshot stored) per event per tick, so one
/// tick never turns into a burst of `AlbionBB` detail calls.
pub const HYDRATIONS_PER_TICK: usize = 5;

/// Re-links battles for every session still awaiting linkage.
///
/// Sessions are visited oldest `started_at` first, so when two events overlap the earlier one
/// deterministically keeps a shared battle. For each session we either finalize (grace period
/// elapsed, or cancelled) or run one linker tick, tolerating transient upstream failures by
/// retrying on the next worker pass. Scheduled sessions are never polled.
///
/// # Example
/// ```ignore
/// refresh_pending_links(&db, &albionbb, &battles, &albiondata, &context, &guild).await?;
/// ```
pub async fn refresh_pending_links(
    db: &DatabaseConnection,
    albionbb: &AlbionBbService,
    battles: &BattlesService,
    albiondata: &AlbionDataService,
    context: &BattleLinkingContext,
    guild: &ExtractionGuildContext,
) -> Result<(), AppError> {
    // A link to another tenant's event never links battles: the owning event does, in its own
    // tenant, and its battles are read through the link.
    let pending_sessions = event::Entity::find()
        .filter(event::Column::SourceTenantId.is_null())
        .filter(event::Column::LinkStatus.is_in(["in_progress", "pending"]))
        .filter(event::Column::Status.is_in(LINKER_STATUSES))
        .order_by_asc(event::Column::StartedAt)
        .order_by_asc(event::Column::Id)
        .all(db)
        .await
        .map_err(AppError::Database)?;

    for session in pending_sessions {
        if EventService::linker_is_done(&session) {
            let Some(session) =
                last_attempt_if_never_tried(db, albionbb, battles, albiondata, context, session)
                    .await
            else {
                continue;
            };
            finalize_expired_link(db, battles, albiondata, guild, &session).await;
            continue;
        }
        link_or_retry(db, albionbb, battles, albiondata, context, &session).await;
    }

    Ok(())
}

/// Runs one linking attempt for a finished session that was never attempted, and returns the
/// reloaded session to finalize.
///
/// This happens when the tenant had no Albion guild configured while the event ran: the linker
/// did not run at all, and the first tick after the guild is configured finds the grace period
/// long over. Finalizing straight away would mark the event `completed` with no battle ever
/// looked up. The attempt links what it finds; if it fails, `link_last_error` is set and the
/// session is finalized as `failed`. A cancelled session is closed without an attempt.
/// Returns `None` when the session cannot be reloaded; the next tick retries.
async fn last_attempt_if_never_tried(
    db: &DatabaseConnection,
    albionbb: &AlbionBbService,
    battles: &BattlesService,
    albiondata: &AlbionDataService,
    context: &BattleLinkingContext,
    session: event::Model,
) -> Option<event::Model> {
    if session.link_attempts > 0 || session.status == "cancelled" {
        return Some(session);
    }
    tracing::info!(
        event_id = session.id,
        "finished event was never linked; running one attempt before finalizing"
    );
    link_or_retry(db, albionbb, battles, albiondata, context, &session).await;
    match event::Entity::find_by_id(session.id).one(db).await {
        Ok(Some(reloaded)) => Some(reloaded),
        Ok(None) => None,
        Err(error) => {
            tracing::warn!(event_id = session.id, error = %error, "could not reload the session");
            None
        }
    }
}

/// Fetches and stores the snapshot of linked battles that have none, at most `limit` per call.
///
/// A linked battle without a snapshot has no kills, losses or win/loss evidence, so the event
/// page and regear extraction would see it as empty. This does what `battle_sync` does for the
/// newest battles (`get_battle_detail_with_losses`), but for the battles of one event.
/// Failures are logged and retried on the next tick. Returns how many battles were hydrated.
pub async fn hydrate_linked_battles(
    db: &DatabaseConnection,
    battles: &BattlesService,
    albiondata: &AlbionDataService,
    event_id: i64,
    limit: usize,
) -> usize {
    let linked = match event_battle::Entity::find()
        .filter(event_battle::Column::EventId.eq(event_id))
        .order_by_asc(event_battle::Column::BattleStartedAt)
        .all(db)
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(event_id, error = %error, "could not list linked battles to hydrate");
            return 0;
        }
    };
    let battle_ids: Vec<i64> = linked
        .iter()
        .filter_map(|row| row.albionbb_battle_id.parse::<i64>().ok())
        .collect();
    if battle_ids.is_empty() {
        return 0;
    }
    let snapshotted: HashSet<i64> = match SnapshotEntity::find()
        .select_only()
        .column(SnapshotColumn::BattleId)
        .filter(SnapshotColumn::BattleId.is_in(battle_ids.clone()))
        .into_tuple::<i64>()
        .all(db)
        .await
    {
        Ok(ids) => ids.into_iter().collect(),
        Err(error) => {
            tracing::warn!(event_id, error = %error, "could not list stored battle snapshots");
            return 0;
        }
    };

    let mut hydrated = 0;
    for battle_id in battle_ids
        .into_iter()
        .filter(|id| !snapshotted.contains(id))
        .take(limit)
    {
        match battles
            .get_battle_detail_with_losses(db, battle_id, albiondata)
            .await
        {
            Ok(_) => hydrated += 1,
            Err(error) => {
                tracing::warn!(
                    event_id,
                    battle_id,
                    error = %error,
                    "could not hydrate a linked battle, will retry next tick"
                );
            }
        }
    }
    hydrated
}

/// Finalizes a session whose grace period has elapsed (or that was cancelled), logging any failure.
///
/// If the last linking attempt failed, the link is finalized as `failed` rather than
/// `completed`, keeping `link_last_error` visible. A cancelled session is only closed.
///
/// Finalizing is also the moment regears become extractable: the battles are
/// linked and will not change again, so every guild death in them is now
/// known. Running earlier would miss whatever `AlbionBB` had not yet ingested.
/// Linked battles still lacking a snapshot are hydrated first, because the
/// extractor reads kill feeds from snapshots.
async fn finalize_expired_link(
    db: &DatabaseConnection,
    battles: &BattlesService,
    albiondata: &AlbionDataService,
    guild: &ExtractionGuildContext,
    session: &event::Model,
) {
    let event_id = session.id;
    if session.status == "cancelled" {
        if let Err(e) = EventService::finalize_link(db, event_id, false).await {
            tracing::warn!(event_id = event_id, error = %e, "finalize_link failed");
        }
        return;
    }
    hydrate_linked_battles(db, battles, albiondata, event_id, HYDRATIONS_PER_TICK).await;
    let failed = session.link_last_error.is_some();
    if let Err(e) = EventService::finalize_link(db, event_id, failed).await {
        tracing::warn!(event_id = event_id, error = %e, "finalize_link failed");
        return;
    }
    if failed {
        tracing::warn!(
            event_id = event_id,
            attempts = session.link_attempts,
            last_error = session.link_last_error.as_deref().unwrap_or_default(),
            "battle linking ended after the grace period with its last attempt failed"
        );
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

/// Runs one linker tick, then gives the linked battles their evidence.
///
/// A first upstream failure is logged at debug (the next tick retries); once the previous
/// attempt had failed too (`link_last_error` is set), it is logged at warn so a persistent
/// outage is visible. Battles linked before a failure are hydrated all the same.
async fn link_or_retry(
    db: &DatabaseConnection,
    albionbb: &AlbionBbService,
    battles: &BattlesService,
    albiondata: &AlbionDataService,
    context: &BattleLinkingContext,
    session: &event::Model,
) {
    let event_id = session.id;
    match EventService::link_battles_for_event(db, albionbb, context, event_id).await {
        Ok(new_count) => {
            tracing::debug!(event_id = event_id, new_battles = new_count, "link tick");
        }
        Err(AppError::UpstreamService(msg)) if session.link_last_error.is_none() => {
            tracing::debug!(event_id = event_id, error = %msg, "upstream error, will retry");
        }
        Err(AppError::UpstreamService(msg)) => {
            tracing::warn!(
                event_id = event_id,
                attempts = session.link_attempts,
                error = %msg,
                "upstream error persists, will retry"
            );
        }
        Err(e) => {
            tracing::warn!(event_id = event_id, error = %e, "link_battles_for_event failed");
        }
    }
    let hydrated =
        hydrate_linked_battles(db, battles, albiondata, event_id, HYDRATIONS_PER_TICK).await;
    if hydrated > 0 {
        tracing::debug!(event_id = event_id, hydrated, "hydrated linked battles");
    }
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, Duration, Utc};
    use sea_orm::{ActiveModelTrait, ActiveValue::Set};

    use super::*;
    use backend_albion_data::albionbb::client::AlbionBbApiClient;
    use backend_albion_data::albionbb::test_support::{FakeUpstream, json_ok, serve, status};
    use backend_runtime::sync::test_support::insert_user;

    const GUILD: &str = "guild-1";

    fn battle_json(id: i64, started: DateTime<Utc>, detail: bool) -> String {
        let at = started.to_rfc3339();
        let players = if detail { r#", "players": []"# } else { "" };
        format!(
            r#"{{"albionId": {id}, "startedAt": "{at}", "finishedAt": "{at}", "totalFame": 1000, "totalKills": 5, "totalPlayers": 20, "guilds": []{players}}}"#
        )
    }

    fn albionbb(upstream: &FakeUpstream) -> AlbionBbService {
        AlbionBbService::new(AlbionBbApiClient::new(
            Some(upstream.base_url.clone()),
            None,
        ))
    }

    fn battles_service(albionbb: &AlbionBbService) -> BattlesService {
        BattlesService::new(
            albionbb.clone(),
            GUILD.to_string(),
            &[],
            &[],
            "eu".to_string(),
        )
    }

    fn context() -> BattleLinkingContext {
        BattleLinkingContext::new(GUILD, &[], &[]).with_server(Some("eu".to_string()))
    }

    fn guild() -> ExtractionGuildContext {
        ExtractionGuildContext {
            guild_id: GUILD.to_string(),
            server: Some("eu".to_string()),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_session(
        db: &DatabaseConnection,
        creator: i64,
        status: &str,
        link_status: &str,
        started: Option<DateTime<Utc>>,
        stopped: Option<DateTime<Utc>>,
        link_last_error: Option<&str>,
    ) -> i64 {
        event::ActiveModel {
            title: Set(format!("{status} session")),
            event_kind: Set("flash".to_string()),
            comp_id: Set(None),
            created_by: Set(creator),
            event_date_utc: Set(started.unwrap_or_else(Utc::now).fixed_offset()),
            status: Set(status.to_string()),
            started_at: Set(started.map(|at| at.fixed_offset())),
            stopped_at: Set(stopped.map(|at| at.fixed_offset())),
            link_status: Set(link_status.to_string()),
            link_last_error: Set(link_last_error.map(ToString::to_string)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("session should be inserted")
        .id
    }

    async fn set_attempts(db: &DatabaseConnection, id: i64, attempts: i64) {
        let mut active: event::ActiveModel = load_event(db, id).await.into();
        active.link_attempts = Set(attempts);
        active.update(db).await.expect("attempts should be stored");
    }

    async fn load_event(db: &DatabaseConnection, id: i64) -> event::Model {
        event::Entity::find_by_id(id)
            .one(db)
            .await
            .expect("event query")
            .expect("event exists")
    }

    async fn linked_ids(db: &DatabaseConnection, event_id: i64) -> Vec<String> {
        event_battle::Entity::find()
            .filter(event_battle::Column::EventId.eq(event_id))
            .all(db)
            .await
            .expect("event battles query")
            .into_iter()
            .map(|row| row.albionbb_battle_id)
            .collect()
    }

    #[tokio::test]
    async fn only_live_and_stopped_sessions_are_polled_and_finished_ones_are_closed() {
        let db = backend_migration::testkit::migrated_sqlite().await;
        let creator = insert_user(&db, "creator").await;
        let now = Utc::now();
        let live = insert_session(
            &db,
            creator,
            "live",
            "in_progress",
            Some(now - Duration::hours(1)),
            None,
            None,
        )
        .await;
        let scheduled =
            insert_session(&db, creator, "scheduled", "pending", None, None, None).await;
        // Cancelled before this fix existed: still marked in progress.
        let cancelled = insert_session(
            &db,
            creator,
            "cancelled",
            "in_progress",
            Some(now - Duration::hours(2)),
            Some(now - Duration::hours(1)),
            None,
        )
        .await;
        // Grace period over and the last attempt failed.
        let failed = insert_session(
            &db,
            creator,
            "stopped",
            "in_progress",
            Some(now - Duration::hours(4)),
            Some(now - Duration::hours(3)),
            Some("AlbionBB API returned 503"),
        )
        .await;
        set_attempts(&db, failed, 3).await;
        // Grace period over and the last attempt was fine.
        let clean = insert_session(
            &db,
            creator,
            "auto_stopped",
            "in_progress",
            Some(now - Duration::hours(6)),
            Some(now - Duration::hours(5)),
            None,
        )
        .await;
        set_attempts(&db, clean, 2).await;

        // The one live event asks for one (empty) page; nobody else may touch the upstream.
        let upstream = serve(vec![json_ok("[]")]).await;
        let service = albionbb(&upstream);
        refresh_pending_links(
            &db,
            &service,
            &battles_service(&service),
            &AlbionDataService::default(),
            &context(),
            &guild(),
        )
        .await
        .expect("refresh succeeds");

        assert_eq!(upstream.request_count(), 1);
        let live = load_event(&db, live).await;
        assert_eq!(
            (live.link_status.as_str(), live.link_attempts),
            ("in_progress", 1)
        );
        let scheduled = load_event(&db, scheduled).await;
        assert_eq!(scheduled.link_status, "pending");
        assert_eq!(scheduled.link_attempts, 0);
        assert_eq!(load_event(&db, cancelled).await.link_status, "completed");
        let failed = load_event(&db, failed).await;
        assert_eq!(failed.link_status, "failed");
        assert_eq!(
            failed.link_last_error.as_deref(),
            Some("AlbionBB API returned 503")
        );
        let clean = load_event(&db, clean).await;
        assert_eq!(clean.link_status, "completed");
        assert_eq!(clean.link_last_error, None);
    }

    #[tokio::test]
    async fn a_finished_event_never_attempted_gets_one_attempt_before_it_is_finalized() {
        let db = backend_migration::testkit::migrated_sqlite().await;
        let creator = insert_user(&db, "creator").await;
        let now = Utc::now();
        // Ran while the tenant had no Albion guild configured: the linker never looked at it.
        let id = insert_session(
            &db,
            creator,
            "stopped",
            "in_progress",
            Some(now - Duration::hours(4)),
            Some(now - Duration::hours(3)),
            None,
        )
        .await;

        let upstream = serve(vec![json_ok("[]")]).await;
        let service = albionbb(&upstream);
        refresh_pending_links(
            &db,
            &service,
            &battles_service(&service),
            &AlbionDataService::default(),
            &context(),
            &guild(),
        )
        .await
        .expect("refresh succeeds");

        assert_eq!(upstream.request_count(), 1, "the battles were looked up once");
        let event = load_event(&db, id).await;
        assert_eq!(
            (event.link_status.as_str(), event.link_attempts),
            ("completed", 1)
        );
    }

    #[tokio::test]
    async fn a_never_attempted_event_whose_only_attempt_fails_is_finalized_as_failed() {
        let db = backend_migration::testkit::migrated_sqlite().await;
        let creator = insert_user(&db, "creator").await;
        let now = Utc::now();
        let id = insert_session(
            &db,
            creator,
            "auto_stopped",
            "pending",
            Some(now - Duration::hours(4)),
            Some(now - Duration::hours(3)),
            None,
        )
        .await;

        let upstream = serve(vec![status("403 Forbidden", "")]).await;
        let service = albionbb(&upstream);
        refresh_pending_links(
            &db,
            &service,
            &battles_service(&service),
            &AlbionDataService::default(),
            &context(),
            &guild(),
        )
        .await
        .expect("refresh succeeds");

        let event = load_event(&db, id).await;
        assert_eq!(event.link_status, "failed", "not silently completed");
        assert_eq!(event.link_attempts, 1);
        assert!(
            event
                .link_last_error
                .as_deref()
                .is_some_and(|error| error.contains("403")),
            "the reason stays visible: {:?}",
            event.link_last_error
        );
    }

    #[tokio::test]
    async fn overlapping_events_are_visited_by_started_at_not_by_id() {
        let db = backend_migration::testkit::migrated_sqlite().await;
        let creator = insert_user(&db, "creator").await;
        let now = Utc::now();
        // The later event is inserted first, so it has the lower id.
        let later = insert_session(
            &db,
            creator,
            "live",
            "in_progress",
            Some(now - Duration::hours(1)),
            None,
            None,
        )
        .await;
        let earlier = insert_session(
            &db,
            creator,
            "live",
            "in_progress",
            Some(now - Duration::hours(2)),
            None,
            None,
        )
        .await;
        assert!(later < earlier);

        // Battle 7 sits in both windows. Requests in order: the earlier event lists page 1
        // and the empty page 2, then its battle is hydrated (detail, kill feed); the later
        // event lists page 1 and page 2 and finds the battle already taken.
        let started = now - Duration::minutes(50);
        let page = json_ok(&format!("[{}]", battle_json(7, started, false)));
        let upstream = serve(vec![
            page.clone(),
            json_ok("[]"),
            json_ok(&battle_json(7, started, true)),
            json_ok("[]"),
            page,
            json_ok("[]"),
        ])
        .await;
        let service = albionbb(&upstream);
        refresh_pending_links(
            &db,
            &service,
            &battles_service(&service),
            &AlbionDataService::default(),
            &context(),
            &guild(),
        )
        .await
        .expect("refresh succeeds");

        assert_eq!(linked_ids(&db, earlier).await, vec!["7".to_string()]);
        assert!(linked_ids(&db, later).await.is_empty());
    }

    #[tokio::test]
    async fn linked_battles_without_a_snapshot_are_hydrated_within_the_budget() {
        let db = backend_migration::testkit::migrated_sqlite().await;
        let creator = insert_user(&db, "creator").await;
        let now = Utc::now();
        let id = insert_session(
            &db,
            creator,
            "live",
            "in_progress",
            Some(now - Duration::hours(1)),
            None,
            None,
        )
        .await;
        for (battle_id, minutes) in [(1_i64, 50), (2, 40), (3, 30)] {
            event_battle::ActiveModel {
                event_id: Set(id),
                albionbb_battle_id: Set(battle_id.to_string()),
                battle_started_at: Set((now - Duration::minutes(minutes)).fixed_offset()),
                guild_players_count: Set(0),
                fetched_at: Set(now.fixed_offset()),
                ..Default::default()
            }
            .insert(&db)
            .await
            .expect("linked battle");
        }

        // Each hydration is one detail request and one (empty) kill feed request.
        let started = |minutes: i64| now - Duration::minutes(minutes);
        let upstream = serve(vec![
            json_ok(&battle_json(1, started(50), true)),
            json_ok("[]"),
            json_ok(&battle_json(2, started(40), true)),
            json_ok("[]"),
            json_ok(&battle_json(3, started(30), true)),
            json_ok("[]"),
        ])
        .await;
        let service = albionbb(&upstream);
        let battles = battles_service(&service);
        let albiondata = AlbionDataService::default();

        // The budget caps one call at two battles.
        assert_eq!(
            hydrate_linked_battles(&db, &battles, &albiondata, id, 2).await,
            2
        );
        assert_eq!(upstream.request_count(), 4);
        // Battles that already have a snapshot are not fetched again.
        assert_eq!(
            hydrate_linked_battles(&db, &battles, &albiondata, id, 5).await,
            1
        );
        assert_eq!(upstream.request_count(), 6);
        assert_eq!(
            hydrate_linked_battles(&db, &battles, &albiondata, id, 5).await,
            0
        );
        assert_eq!(upstream.request_count(), 6);

        let stored = SnapshotEntity::find()
            .filter(SnapshotColumn::BattleId.is_in([1_i64, 2, 3]))
            .all(&db)
            .await
            .expect("snapshots");
        assert_eq!(stored.len(), 3);
    }
}
