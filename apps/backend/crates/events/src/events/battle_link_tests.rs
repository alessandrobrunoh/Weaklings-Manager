//! Regression tests for the automatic battle linker.
//!
//! `AlbionBB` is a scripted loopback upstream answering one canned response per request, so
//! the tests can count the pages the linker asks for and make a chosen page fail. Everything
//! else runs on the migrated SQLite schema.

use chrono::{DateTime, Duration, Utc};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
};

use super::service::{EventService, link_window};
use backend_albion_data::albionbb::client::AlbionBbApiClient;
use backend_albion_data::albionbb::service::AlbionBbService;
use backend_albion_data::albionbb::test_support::{FakeUpstream, json_ok, serve, status};
use backend_core::albion_common::BattleLinkingContext;
use backend_core::errors::AppError;
use backend_entities::events::{event, event_battle};
use backend_runtime::sync::test_support::insert_user;

const GUILD: &str = "guild-1";

fn context() -> BattleLinkingContext {
    BattleLinkingContext::new(GUILD, &[], &[]).with_server(Some("eu".to_string()))
}

fn battle_json(id: i64, started: DateTime<Utc>) -> String {
    let at = started.to_rfc3339();
    format!(
        r#"{{"albionId": {id}, "startedAt": "{at}", "finishedAt": "{at}", "totalFame": 1000, "totalKills": 5, "totalPlayers": 20, "guilds": []}}"#
    )
}

/// One upstream list page holding the given `(battle id, start time)` battles.
fn page(battles: &[(i64, DateTime<Utc>)]) -> String {
    let body = battles
        .iter()
        .map(|(id, started)| battle_json(*id, *started))
        .collect::<Vec<_>>()
        .join(",");
    json_ok(&format!("[{body}]"))
}

fn albionbb(upstream: &FakeUpstream) -> AlbionBbService {
    AlbionBbService::new(AlbionBbApiClient::new(
        Some(upstream.base_url.clone()),
        None,
    ))
}

/// A flash event (no comp needed) in the given session state.
async fn insert_session(
    db: &DatabaseConnection,
    creator: i64,
    session_status: &str,
    scheduled: DateTime<Utc>,
    started: Option<DateTime<Utc>>,
    stopped: Option<DateTime<Utc>>,
) -> i64 {
    event::ActiveModel {
        title: Set(format!("{session_status} session")),
        event_kind: Set("flash".to_string()),
        comp_id: Set(None),
        created_by: Set(creator),
        event_date_utc: Set(scheduled.fixed_offset()),
        status: Set(session_status.to_string()),
        started_at: Set(started.map(|at| at.fixed_offset())),
        stopped_at: Set(stopped.map(|at| at.fixed_offset())),
        link_status: Set("in_progress".to_string()),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("session should be inserted")
    .id
}

async fn load_event(db: &DatabaseConnection, event_id: i64) -> event::Model {
    event::Entity::find_by_id(event_id)
        .one(db)
        .await
        .expect("event query")
        .expect("event exists")
}

async fn linked_battle_ids(db: &DatabaseConnection, event_id: i64) -> Vec<String> {
    let mut ids = event_battle::Entity::find()
        .filter(event_battle::Column::EventId.eq(event_id))
        .all(db)
        .await
        .expect("event battles query")
        .into_iter()
        .map(|row| row.albionbb_battle_id)
        .collect::<Vec<_>>();
    ids.sort();
    ids
}

fn ids(expected: &[&str]) -> Vec<String> {
    expected.iter().map(ToString::to_string).collect()
}

#[tokio::test]
async fn window_is_padded_around_the_earliest_start_signal_and_the_stop() {
    let db = backend_migration::testkit::migrated_sqlite().await;
    let creator = insert_user(&db, "creator").await;
    let t0 = DateTime::parse_from_rfc3339("2026-09-01T20:00:00Z")
        .expect("timestamp")
        .with_timezone(&Utc);
    let now = t0 + Duration::hours(5);

    // Started ten minutes after the scheduled start, stopped after an hour.
    let id = insert_session(
        &db,
        creator,
        "stopped",
        t0,
        Some(t0 + Duration::minutes(10)),
        Some(t0 + Duration::minutes(70)),
    )
    .await;
    let model = load_event(&db, id).await;
    assert_eq!(
        link_window(&model, now),
        (t0 - Duration::minutes(30), t0 + Duration::minutes(90))
    );

    // A mass call before the start opens the window earlier still.
    event::ActiveModel {
        id: Set(id),
        mass_time_utc: Set(Some((t0 - Duration::minutes(20)).fixed_offset())),
        ..Default::default()
    }
    .update(&db)
    .await
    .expect("mass time");
    assert_eq!(
        link_window(&load_event(&db, id).await, now).0,
        t0 - Duration::minutes(50)
    );

    // Pressing Start before the scheduled time wins over the schedule.
    event::ActiveModel {
        id: Set(id),
        mass_time_utc: Set(None),
        started_at: Set(Some((t0 - Duration::minutes(10)).fixed_offset())),
        ..Default::default()
    }
    .update(&db)
    .await
    .expect("early start");
    assert_eq!(
        link_window(&load_event(&db, id).await, now).0,
        t0 - Duration::minutes(40)
    );

    // While the session is live the window runs to now plus the trailing pad.
    event::ActiveModel {
        id: Set(id),
        status: Set("live".to_string()),
        stopped_at: Set(None),
        ..Default::default()
    }
    .update(&db)
    .await
    .expect("live again");
    assert_eq!(
        link_window(&load_event(&db, id).await, now).1,
        now + Duration::minutes(20)
    );
}

#[tokio::test]
async fn walk_stops_at_the_first_page_older_than_the_window() {
    let db = backend_migration::testkit::migrated_sqlite().await;
    let creator = insert_user(&db, "creator").await;
    let now = Utc::now();
    let started = now - Duration::hours(1);
    let id = insert_session(&db, creator, "live", started, Some(started), None).await;

    let upstream = serve(vec![
        // Newest first: both battles are inside the window.
        page(&[
            (5, now - Duration::minutes(10)),
            (4, now - Duration::minutes(30)),
        ]),
        // Every battle on this page began before the window opened ...
        page(&[(3, now - Duration::hours(3)), (2, now - Duration::hours(4))]),
        // ... so this page must never be requested.
        page(&[(9, now - Duration::minutes(20))]),
    ])
    .await;

    let inserted = EventService::link_battles_for_event(&db, &albionbb(&upstream), &context(), id)
        .await
        .expect("linking succeeds");

    assert_eq!(inserted, 2);
    assert_eq!(upstream.request_count(), 2, "paging stops at the old page");
    assert_eq!(linked_battle_ids(&db, id).await, ids(&["4", "5"]));
}

#[tokio::test]
async fn a_failed_page_keeps_the_earlier_pages_and_records_the_error() {
    let db = backend_migration::testkit::migrated_sqlite().await;
    let creator = insert_user(&db, "creator").await;
    let now = Utc::now();
    let started = now - Duration::hours(1);
    let id = insert_session(&db, creator, "live", started, Some(started), None).await;

    // Page 1 is fine, page 2 (and every later request) answers 400.
    let failing = serve(vec![
        page(&[(5, now - Duration::minutes(10))]),
        status("400 Bad Request", ""),
    ])
    .await;
    let result =
        EventService::link_battles_for_event(&db, &albionbb(&failing), &context(), id).await;

    assert!(
        matches!(result, Err(AppError::UpstreamService(_))),
        "the upstream error is still reported, got {result:?}"
    );
    assert_eq!(
        linked_battle_ids(&db, id).await,
        ids(&["5"]),
        "page 1 was linked before the error was reported"
    );
    let failed = load_event(&db, id).await;
    assert_eq!(failed.link_attempts, 1);
    assert!(
        failed
            .link_last_error
            .as_deref()
            .is_some_and(|error| error.contains("400")),
        "the failure is persisted, got {:?}",
        failed.link_last_error
    );
    assert_eq!(failed.link_status, "in_progress");

    // The next clean attempt clears the error and counts again.
    let healthy = serve(vec![
        page(&[(5, now - Duration::minutes(10))]),
        json_ok("[]"),
    ])
    .await;
    EventService::link_battles_for_event(&db, &albionbb(&healthy), &context(), id)
        .await
        .expect("clean attempt");
    let recovered = load_event(&db, id).await;
    assert_eq!(recovered.link_attempts, 2);
    assert_eq!(recovered.link_last_error, None);
    assert_eq!(linked_battle_ids(&db, id).await, ids(&["5"]));
}

#[tokio::test]
async fn a_failure_on_the_first_page_is_recorded_without_linking_anything() {
    let db = backend_migration::testkit::migrated_sqlite().await;
    let creator = insert_user(&db, "creator").await;
    let started = Utc::now() - Duration::hours(1);
    let id = insert_session(&db, creator, "live", started, Some(started), None).await;

    let failing = serve(vec![status("400 Bad Request", "")]).await;
    let result =
        EventService::link_battles_for_event(&db, &albionbb(&failing), &context(), id).await;

    assert!(matches!(result, Err(AppError::UpstreamService(_))));
    assert!(linked_battle_ids(&db, id).await.is_empty());
    let failed = load_event(&db, id).await;
    assert_eq!(failed.link_attempts, 1);
    assert!(failed.link_last_error.is_some());
}

#[tokio::test]
async fn a_missing_page_after_the_first_ends_the_walk_cleanly() {
    let db = backend_migration::testkit::migrated_sqlite().await;
    let creator = insert_user(&db, "creator").await;
    let now = Utc::now();
    let started = now - Duration::hours(1);
    let id = insert_session(&db, creator, "live", started, Some(started), None).await;

    let upstream = serve(vec![
        page(&[(5, now - Duration::minutes(10))]),
        status("404 Not Found", ""),
    ])
    .await;
    EventService::link_battles_for_event(&db, &albionbb(&upstream), &context(), id)
        .await
        .expect("a 404 past the last page is the end of the list, not a failure");

    assert_eq!(linked_battle_ids(&db, id).await, ids(&["5"]));
    assert_eq!(load_event_error(&db, id).await, None);
}

async fn load_event_error(db: &DatabaseConnection, event_id: i64) -> Option<String> {
    load_event(db, event_id).await.link_last_error
}

#[tokio::test]
async fn battles_just_outside_the_start_and_stop_presses_are_linked() {
    let db = backend_migration::testkit::migrated_sqlite().await;
    let creator = insert_user(&db, "creator").await;
    let now = Utc::now();
    let started = now - Duration::hours(2);
    let stopped = now - Duration::hours(1);
    let id = insert_session(
        &db,
        creator,
        "stopped",
        started,
        Some(started),
        Some(stopped),
    )
    .await;

    let upstream = serve(vec![
        page(&[
            // 25 minutes after Stop: outside the 20 minute pad.
            (4, stopped + Duration::minutes(25)),
            // 15 minutes after Stop: inside the pad.
            (3, stopped + Duration::minutes(15)),
            // 20 minutes before Start: inside the 30 minute pad.
            (2, started - Duration::minutes(20)),
            // 40 minutes before Start: outside the pad.
            (1, started - Duration::minutes(40)),
        ]),
        json_ok("[]"),
    ])
    .await;
    EventService::link_battles_for_event(&db, &albionbb(&upstream), &context(), id)
        .await
        .expect("linking succeeds");

    assert_eq!(linked_battle_ids(&db, id).await, ids(&["2", "3"]));
}

#[tokio::test]
async fn a_battle_already_assigned_to_another_event_is_not_stolen() {
    let db = backend_migration::testkit::migrated_sqlite().await;
    let creator = insert_user(&db, "creator").await;
    let now = Utc::now();
    let first_start = now - Duration::hours(2);
    let second_start = now - Duration::hours(1);
    let first = insert_session(&db, creator, "live", first_start, Some(first_start), None).await;
    let second = insert_session(&db, creator, "live", second_start, Some(second_start), None).await;

    // Battle 7 sits inside both windows; the listing repeats it on every page.
    let upstream = serve(vec![page(&[(7, now - Duration::minutes(50))])]).await;
    let service = albionbb(&upstream);
    let first_inserted = EventService::link_battles_for_event(&db, &service, &context(), first)
        .await
        .expect("first event links");
    let second_inserted = EventService::link_battles_for_event(&db, &service, &context(), second)
        .await
        .expect("second event links");

    assert_eq!(first_inserted, 1);
    assert_eq!(second_inserted, 0);
    assert_eq!(linked_battle_ids(&db, first).await, ids(&["7"]));
    assert!(linked_battle_ids(&db, second).await.is_empty());
}

#[tokio::test]
async fn cancelled_events_are_done_and_live_ones_are_not() {
    let db = backend_migration::testkit::migrated_sqlite().await;
    let creator = insert_user(&db, "creator").await;
    let now = Utc::now();
    let started = now - Duration::hours(1);

    let cancelled =
        insert_session(&db, creator, "cancelled", started, Some(started), Some(now)).await;
    assert!(EventService::linker_is_done(
        &load_event(&db, cancelled).await
    ));

    let live = insert_session(&db, creator, "live", started, Some(started), None).await;
    assert!(!EventService::linker_is_done(&load_event(&db, live).await));

    let fresh_stop =
        insert_session(&db, creator, "stopped", started, Some(started), Some(now)).await;
    assert!(!EventService::linker_is_done(
        &load_event(&db, fresh_stop).await
    ));

    let old_stop = insert_session(
        &db,
        creator,
        "stopped",
        started,
        Some(started),
        Some(now - Duration::minutes(50)),
    )
    .await;
    assert!(EventService::linker_is_done(
        &load_event(&db, old_stop).await
    ));
}

#[tokio::test]
async fn finalizing_clears_a_recorded_error_unless_it_failed() {
    let db = backend_migration::testkit::migrated_sqlite().await;
    let creator = insert_user(&db, "creator").await;
    let started = Utc::now() - Duration::hours(3);
    let id = insert_session(
        &db,
        creator,
        "stopped",
        started,
        Some(started),
        Some(started),
    )
    .await;
    event::ActiveModel {
        id: Set(id),
        link_last_error: Set(Some("AlbionBB API returned 503".to_string())),
        ..Default::default()
    }
    .update(&db)
    .await
    .expect("error text");

    EventService::finalize_link(&db, id, true)
        .await
        .expect("fail");
    let failed = load_event(&db, id).await;
    assert_eq!(failed.link_status, "failed");
    assert!(failed.link_last_error.is_some(), "the reason stays visible");
    assert!(failed.link_battles_completed_at.is_some());

    EventService::finalize_link(&db, id, false)
        .await
        .expect("complete");
    let completed = load_event(&db, id).await;
    assert_eq!(completed.link_status, "completed");
    assert_eq!(completed.link_last_error, None);
}
