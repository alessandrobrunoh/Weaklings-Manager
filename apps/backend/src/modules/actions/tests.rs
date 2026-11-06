//! Engine tests: the descriptor matrix (pure), execution on SQLite, and the Postgres
//! concurrency case (skipped without `TEST_DATABASE_URL`).

use std::collections::HashSet;

use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, DatabaseConnection,
    EntityTrait, PaginatorTrait, QueryFilter,
};
use sea_orm_migration::MigratorTrait;

use super::action_log::{self, RETENTION_DAYS};
use super::engine::{
    self, Actor, Facts, Failure, Request, Target, Verdict, describe_one, evaluate,
    event_action_list,
};
use super::entities::event as event_def;
use super::model::{Noop, OriginRule};
use crate::modules::auth::Permission;
use crate::modules::events::entities::event;
use crate::modules::events::lifecycle::XpFilter;
use crate::modules::events::lifecycle::{AfterCommit, Cause};
use crate::modules::events::status::{EVENT_TRANSITIONS, edge};
use crate::modules::sync::OriginRef;
use crate::modules::sync::copy_role::CopyRole;
use crate::modules::sync::test_support::sqlite_db;
use crate::modules::users::entities as users;

const TENANT: &str = "1000000000000000001";

fn facts(state: &str, archived: bool, creator: i64, copy: CopyRole) -> Facts {
    Facts {
        id: 7,
        state: state.to_owned(),
        archived,
        creator_id: creator,
        copy,
        origin: None,
        etag: "e-7-1".to_owned(),
    }
}

fn actor(user_id: i64, granted: &[Permission], module_available: bool) -> Actor {
    Actor {
        user_id,
        discord_id: None,
        granted: granted.iter().copied().collect::<HashSet<_>>(),
        module_available,
    }
}

fn def(id: &str) -> &'static super::model::ActionDef {
    event_def::find_def(id).expect("registered action")
}

fn reason(verdict: &Verdict) -> Option<&'static str> {
    match verdict {
        Verdict::Allowed => None,
        Verdict::Denied(denial) => Some(denial.reason_code),
    }
}

#[test]
fn every_transition_action_matches_the_status_table() {
    for edge_row in EVENT_TRANSITIONS {
        // The scheduler's auto_stop has no client descriptor; the other edges must all have one.
        if edge_row.action == "auto_stop" {
            assert!(event_def::find_def(edge_row.action).is_none());
            continue;
        }
        let registered = def(edge_row.action);
        let mut from: Vec<&str> = registered.from.to_vec();
        from.sort_unstable();
        let mut expected: Vec<&str> = edge_row.from.iter().map(|s| s.as_str()).collect();
        expected.sort_unstable();
        assert_eq!(from, expected, "from states of {}", edge_row.action);
        assert_eq!(
            registered.to,
            Some(edge_row.to.as_str()),
            "{}",
            edge_row.action
        );
    }
    assert!(edge("archive").is_none());
    assert_eq!(def("archive").to, None);
}

#[test]
fn registry_ids_are_unique_and_every_row_names_its_module() {
    let mut ids: Vec<&str> = event_def::DEFS.iter().map(|d| d.id).collect();
    ids.sort_unstable();
    let before = ids.len();
    ids.dedup();
    assert_eq!(before, ids.len());
    assert!(
        event_def::DEFS
            .iter()
            .all(|d| d.module == "events" && d.entity == "event")
    );
}

#[test]
fn module_gate_comes_first_and_hides_the_action() {
    let verdict = evaluate(
        def("stop"),
        &facts("live", false, 1, CopyRole::ActiveCopy),
        &actor(1, &[], false),
    );
    assert_eq!(reason(&verdict), Some("module_unavailable"));
    let descriptor = describe_one(
        def("stop"),
        &facts("live", false, 1, CopyRole::Origin),
        &actor(1, &[], false),
    );
    assert!(
        !descriptor.visible,
        "module refusals are hidden, not shown disabled"
    );
}

#[test]
fn active_copies_refuse_owner_actions_and_allow_copy_actions() {
    let copy = facts("live", false, 1, CopyRole::ActiveCopy);
    let owner = actor(1, &[Permission::EventsEdit], true);
    assert_eq!(
        reason(&evaluate(def("stop"), &copy, &owner)),
        Some("copy_read_only")
    );
    assert_eq!(
        reason(&evaluate(def("edit"), &copy, &owner)),
        Some("copy_read_only")
    );
    assert_eq!(
        reason(&evaluate(def("join"), &copy, &actor(9, &[], true))),
        None
    );
    assert_eq!(def("join").origin, OriginRule::CopyAllowed);
    let detached = facts("live", false, 1, CopyRole::DetachedCopy);
    assert_eq!(
        reason(&evaluate(def("stop"), &detached, &owner)),
        None,
        "a detached copy is local"
    );
}

#[test]
fn copy_refusal_carries_the_origin_in_params_and_text() {
    let mut copy = facts("live", false, 1, CopyRole::ActiveCopy);
    copy.origin = Some(OriginRef {
        tenant_id: Some("9".to_owned()),
        tenant_name: Some("Guild A".to_owned()),
        tenant_kind: Some("alliance".to_owned()),
        kind: crate::modules::sync::SyncKind::Event,
        entity_id: Some(3),
        path: Some("/events/3".to_owned()),
    });
    match evaluate(
        def("cancel"),
        &copy,
        &actor(1, &[Permission::EventsEdit], true),
    ) {
        Verdict::Denied(denial) => {
            assert_eq!(denial.status, 403);
            assert!(denial.visible);
            assert!(denial.reason.contains("Guild A"), "{}", denial.reason);
            assert_eq!(denial.params["origin"]["tenant_id"], "9");
        }
        Verdict::Allowed => panic!("an active copy must refuse cancel"),
    }
}

#[test]
fn authority_refuses_non_creators_without_the_permission() {
    let owner_created = facts("scheduled", false, 1, CopyRole::Origin);
    let stranger = actor(2, &[], true);
    assert_eq!(
        reason(&evaluate(def("cancel"), &owner_created, &stranger)),
        Some("not_creator_or_manager")
    );
    assert_eq!(
        reason(&evaluate(
            def("cancel"),
            &owner_created,
            &actor(1, &[], true)
        )),
        None
    );
    assert_eq!(
        reason(&evaluate(
            def("cancel"),
            &owner_created,
            &actor(2, &[Permission::EventsEdit], true)
        )),
        None
    );
    assert_eq!(
        reason(&evaluate(
            def("archive"),
            &owner_created,
            &actor(2, &[Permission::EventsEdit], true)
        )),
        Some("not_creator_or_manager"),
        "archive needs the delete permission, not edit"
    );
}

#[test]
fn archived_entities_refuse_unless_the_action_allows_it() {
    let archived = facts("scheduled", true, 1, CopyRole::Origin);
    let creator = actor(1, &[], true);
    assert_eq!(
        reason(&evaluate(def("start"), &archived, &creator)),
        Some("archived")
    );
    assert_eq!(
        reason(&evaluate(
            def("archive"),
            &archived,
            &actor(1, &[Permission::EventsDelete], true)
        )),
        None
    );
    assert_eq!(
        reason(&evaluate(
            def("unarchive"),
            &archived,
            &actor(1, &[Permission::EventsDelete], true)
        )),
        None
    );
}

#[test]
fn state_checks_and_noops_follow_the_table() {
    let creator = actor(1, &[], true);
    let live = facts("live", false, 1, CopyRole::Origin);
    let stopped = facts("stopped", false, 1, CopyRole::Origin);
    let cancelled = facts("cancelled", false, 1, CopyRole::Origin);

    assert_eq!(
        reason(&evaluate(def("start"), &live, &creator)),
        None,
        "start on live is a noop"
    );
    assert!(super::engine::is_noop(def("start"), &live));
    match evaluate(def("start"), &stopped, &creator) {
        Verdict::Denied(denial) => {
            assert_eq!(denial.reason_code, "wrong_state");
            assert_eq!(denial.status, 409);
            assert_eq!(denial.params["state"], "stopped");
        }
        Verdict::Allowed => panic!("stopped events cannot be restarted"),
    }
    assert_eq!(
        reason(&evaluate(def("stop"), &stopped, &creator)),
        None,
        "stop on stopped is a noop"
    );
    assert_eq!(
        reason(&evaluate(def("cancel"), &cancelled, &creator)),
        None,
        "cancel on cancelled is a noop"
    );
    assert_eq!(
        reason(&evaluate(def("uncancel"), &live, &creator)),
        Some("wrong_state"),
        "uncancel needs cancelled"
    );
    assert_eq!(def("start").noop, Noop::InStates(&["live"]));
}

#[test]
fn unimplemented_actions_are_listed_but_hidden() {
    let descriptor = describe_one(
        def("join"),
        &facts("scheduled", false, 1, CopyRole::Origin),
        &actor(2, &[], true),
    );
    assert!(descriptor.allowed);
    assert!(!descriptor.visible);
    assert_eq!(descriptor.transport, "action");
    let roster = describe_one(
        def("roster_edit"),
        &facts("live", false, 1, CopyRole::Origin),
        &actor(1, &[], true),
    );
    assert_eq!(roster.transport, "direct");
}

async fn insert_user(db: &DatabaseConnection, name: &str) -> i64 {
    users::ActiveModel {
        username: Set(name.to_owned()),
        email: Set(format!("{name}@example.com")),
        role: Set("User".to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("insert user")
    .id
}

/// Inserts a flash event in `status` created by `creator`.
async fn insert_event(db: &DatabaseConnection, creator: i64, status: &str, archived: bool) -> i64 {
    let now = Utc::now().fixed_offset();
    let row = event::ActiveModel {
        title: Set(format!("{status} event")),
        event_kind: Set(event::KIND_FLASH.to_owned()),
        created_by: Set(creator),
        event_date_utc: Set(now),
        status: Set(status.to_owned()),
        started_at: Set((status == "live" || status == "stopped").then_some(now)),
        stopped_at: Set((status == "stopped").then_some(now)),
        auto_stop_deadline: Set((status == "live").then_some(now)),
        archived_at: Set(archived.then_some(now)),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("insert event");
    row.id
}

struct Fixture {
    db: DatabaseConnection,
    creator: i64,
    manager: Actor,
    stranger: Actor,
}

async fn fixture() -> Fixture {
    let db = sqlite_db().await;
    let creator = insert_user(&db, "creator").await;
    Fixture {
        db,
        creator,
        manager: actor(
            creator + 1,
            &[Permission::EventsEdit, Permission::EventsDelete],
            true,
        ),
        stranger: actor(creator + 2, &[], true),
    }
}

fn target(db: &DatabaseConnection) -> Target<'_> {
    Target {
        db,
        control: db,
        tenant_id: TENANT,
    }
}

fn request<'a>(action: &'a str, key: Option<&'a str>) -> Request<'a> {
    Request {
        action,
        expected_etag: None,
        idempotency_key: key,
        params: None,
    }
}

async fn status_of(db: &DatabaseConnection, id: i64) -> String {
    event::Entity::find_by_id(id)
        .one(db)
        .await
        .expect("read event")
        .expect("event exists")
        .status
}

async fn log_rows(db: &DatabaseConnection, id: i64) -> Vec<action_log::Model> {
    action_log::Entity::find()
        .filter(action_log::Column::EntityId.eq(id))
        .all(db)
        .await
        .expect("read log")
}

#[tokio::test]
async fn start_applies_once_and_writes_one_log_row() {
    let fx = fixture().await;
    let id = insert_event(&fx.db, fx.creator, "scheduled", false).await;
    let result = engine::execute(
        &target(&fx.db),
        &fx.manager,
        id,
        &request("start", None),
        Cause::Web,
        &AfterCommit::default(),
    )
    .await
    .expect("start applies");
    assert_eq!(result.outcome, "applied");
    assert_eq!(result.state.from, "scheduled");
    assert_eq!(result.state.to, "live");
    assert_eq!(status_of(&fx.db, id).await, "live");
    let rows = log_rows(&fx.db, id).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].outcome, "applied");
    assert_eq!(rows[0].channel, "web");
}

#[tokio::test]
async fn replay_with_the_same_key_returns_the_first_answer_without_a_second_row() {
    let fx = fixture().await;
    let id = insert_event(&fx.db, fx.creator, "scheduled", false).await;
    let first = engine::execute(
        &target(&fx.db),
        &fx.manager,
        id,
        &request("start", Some("k-1")),
        Cause::Web,
        &AfterCommit::default(),
    )
    .await
    .expect("first start");
    let started_at = event::Entity::find_by_id(id)
        .one(&fx.db)
        .await
        .unwrap()
        .unwrap()
        .started_at;
    // Stopping in between must not make the replay refuse: the first answer stands.
    engine::execute(
        &target(&fx.db),
        &fx.manager,
        id,
        &request("stop", None),
        Cause::Web,
        &AfterCommit::default(),
    )
    .await
    .expect("stop");
    let replay = engine::execute(
        &target(&fx.db),
        &fx.manager,
        id,
        &request("start", Some("k-1")),
        Cause::Web,
        &AfterCommit::default(),
    )
    .await
    .expect("replay");
    assert_eq!(replay.outcome, "applied");
    assert_eq!(replay.state.to, first.state.to);
    let row = event::Entity::find_by_id(id)
        .one(&fx.db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.status, "stopped", "the replay changed nothing");
    assert_eq!(
        row.started_at, started_at,
        "the start time was not rewritten"
    );
    let start_rows = log_rows(&fx.db, id)
        .await
        .into_iter()
        .filter(|row| row.action == "start")
        .count();
    assert_eq!(start_rows, 1, "one log row for the replayed start");
}

#[tokio::test]
async fn same_state_requests_are_noops_and_leave_the_row_alone() {
    let fx = fixture().await;
    let id = insert_event(&fx.db, fx.creator, "stopped", false).await;
    let before = event::Entity::find_by_id(id)
        .one(&fx.db)
        .await
        .unwrap()
        .unwrap();
    let result = engine::execute(
        &target(&fx.db),
        &fx.manager,
        id,
        &request("stop", None),
        Cause::Web,
        &AfterCommit::default(),
    )
    .await
    .expect("stop on stopped");
    assert_eq!(result.outcome, "noop");
    assert!(result.effects.is_empty());
    assert!(result.sync.is_none());
    let after = event::Entity::find_by_id(id)
        .one(&fx.db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        before.updated_at, after.updated_at,
        "no row write on a noop"
    );
    assert_eq!(
        log_rows(&fx.db, id)
            .await
            .first()
            .map(|r| r.outcome.clone()),
        Some("noop".to_owned())
    );
}

#[tokio::test]
async fn a_failing_log_write_leaves_the_state_untouched() {
    let fx = fixture().await;
    let id = insert_event(&fx.db, fx.creator, "scheduled", false).await;
    fx.db
        .execute_unprepared("DROP TABLE action_log")
        .await
        .expect("drop log table");
    let outcome = engine::execute(
        &target(&fx.db),
        &fx.manager,
        id,
        &request("start", None),
        Cause::Web,
        &AfterCommit::default(),
    )
    .await;
    assert!(matches!(outcome, Err(Failure::Error(_))), "{outcome:?}");
    assert_eq!(
        status_of(&fx.db, id).await,
        "scheduled",
        "apply rolled back with the log"
    );
}

#[tokio::test]
async fn a_denied_execute_answers_with_the_listed_descriptor() {
    let fx = fixture().await;
    let id = insert_event(&fx.db, fx.creator, "live", false).await;
    let denied = engine::execute(
        &target(&fx.db),
        &fx.stranger,
        id,
        &request("cancel", None),
        Cause::Web,
        &AfterCommit::default(),
    )
    .await;
    let entry = match denied {
        Err(Failure::Denied { status, entry }) => {
            assert_eq!(status, 403);
            *entry
        }
        other => panic!("expected a denial, got {other:?}"),
    };
    let facts = engine::load_event_facts(&fx.db, &fx.db, TENANT, id)
        .await
        .unwrap();
    let listed = event_action_list(&facts, &fx.stranger)
        .actions
        .into_iter()
        .find(|descriptor| descriptor.id == "cancel")
        .expect("cancel is listed");
    assert_eq!(entry, listed, "the 403 body is the descriptor entry");
    assert_eq!(entry, describe_one(def("cancel"), &facts, &fx.stranger));
    assert_eq!(status_of(&fx.db, id).await, "live");
}

#[tokio::test]
async fn a_stale_revision_returns_the_fresh_list_and_changes_nothing() {
    let fx = fixture().await;
    let id = insert_event(&fx.db, fx.creator, "scheduled", false).await;
    let stale = Request {
        action: "start",
        expected_etag: Some("e-0-0"),
        idempotency_key: None,
        params: None,
    };
    match engine::execute(
        &target(&fx.db),
        &fx.manager,
        id,
        &stale,
        Cause::Web,
        &AfterCommit::default(),
    )
    .await
    {
        Err(Failure::Stale(list)) => {
            assert_eq!(list.entity.id, Some(id));
            assert!(list.etag.is_some());
        }
        other => panic!("expected stale, got {other:?}"),
    }
    assert_eq!(status_of(&fx.db, id).await, "scheduled");
}

#[tokio::test]
async fn a_stop_on_an_archived_event_is_refused_with_archived() {
    let fx = fixture().await;
    let id = insert_event(&fx.db, fx.creator, "live", true).await;
    let result = engine::execute(
        &target(&fx.db),
        &fx.manager,
        id,
        &request("stop", None),
        Cause::Web,
        &AfterCommit::default(),
    )
    .await;
    match result {
        Err(Failure::Denied { status, entry }) => {
            assert_eq!(status, 409);
            assert_eq!(entry.reason_code.as_deref(), Some("archived"));
        }
        other => panic!("expected archived refusal, got {other:?}"),
    }
}

#[tokio::test]
async fn direct_and_unimplemented_actions_do_not_execute_here() {
    let fx = fixture().await;
    let id = insert_event(&fx.db, fx.creator, "scheduled", false).await;
    for action in ["join", "roster_edit", "remind", "no_such_action"] {
        let result = engine::execute(
            &target(&fx.db),
            &fx.manager,
            id,
            &request(action, None),
            Cause::Web,
            &AfterCommit::default(),
        )
        .await;
        assert!(
            matches!(result, Err(Failure::Error(_))),
            "{action}: {result:?}"
        );
    }
}

#[tokio::test]
async fn retention_prunes_only_rows_older_than_ninety_days() {
    let fx = fixture().await;
    let old = Utc::now().fixed_offset() - chrono::TimeDelta::days(RETENTION_DAYS + 10);
    for (created, key) in [(old, "old"), (Utc::now().fixed_offset(), "new")] {
        action_log::ActiveModel {
            entity_type: Set("event".to_owned()),
            entity_id: Set(Some(1)),
            action: Set("start".to_owned()),
            actor_user_id: Set(1),
            channel: Set("web".to_owned()),
            idempotency_key: Set(Some(key.to_owned())),
            outcome: Set("applied".to_owned()),
            created_at: Set(created),
            ..Default::default()
        }
        .insert(&fx.db)
        .await
        .expect("insert log row");
    }
    let removed = action_log::prune(&fx.db).await.expect("prune");
    assert_eq!(removed, 1);
    let left = action_log::Entity::find().count(&fx.db).await.unwrap();
    assert_eq!(left, 1);
}

#[tokio::test]
async fn the_idempotency_index_rejects_a_second_row_with_the_same_key() {
    let fx = fixture().await;
    let row = |key: &str| action_log::ActiveModel {
        entity_type: Set("event".to_owned()),
        entity_id: Set(Some(1)),
        action: Set("start".to_owned()),
        actor_user_id: Set(5),
        channel: Set("web".to_owned()),
        idempotency_key: Set(Some(key.to_owned())),
        outcome: Set("applied".to_owned()),
        created_at: Set(Utc::now().fixed_offset()),
        ..Default::default()
    };
    row("dup").insert(&fx.db).await.expect("first row");
    assert!(
        row("dup").insert(&fx.db).await.is_err(),
        "same actor, action and key"
    );
    row("other")
        .insert(&fx.db)
        .await
        .expect("another key is fine");
}

#[tokio::test]
async fn a_plain_event_is_not_synced() {
    let fx = fixture().await;
    let id = insert_event(&fx.db, fx.creator, "live", false).await;
    let facts = engine::load_event_facts(&fx.db, &fx.db, TENANT, id)
        .await
        .unwrap();
    assert_eq!(facts.copy, CopyRole::NotSynced);
    assert!(facts.origin.is_none());
    assert!(facts.etag.starts_with(&format!("e-{id}-")));
}

#[tokio::test]
async fn cancel_then_uncancel_round_trips_through_the_core() {
    let fx = fixture().await;
    let id = insert_event(&fx.db, fx.creator, "scheduled", false).await;
    for (action, expect) in [("cancel", "cancelled"), ("uncancel", "scheduled")] {
        let result = engine::execute(
            &target(&fx.db),
            &fx.manager,
            id,
            &request(action, None),
            Cause::Web,
            &AfterCommit::default(),
        )
        .await
        .expect(action);
        assert_eq!(result.state.to, expect);
        assert_eq!(status_of(&fx.db, id).await, expect);
    }
    assert!(event_def::transition_for("cancel", XpFilter::Everyone).is_some());
}

/// Two concurrent starts on one event: exactly one applies, the other is a noop. Needs
/// the real row lock, so it runs only with `TEST_DATABASE_URL` (skipped otherwise).
#[tokio::test]
async fn concurrent_starts_apply_once_on_postgres() {
    use crate::postgres::{
        connect_with_search_path, drop_schema, ensure_schema,
        test_support::{try_admin_db, unique_schema},
    };
    let Some((url, admin)) = try_admin_db().await else {
        return;
    };
    let schema = unique_schema("act_toctou");
    ensure_schema(&admin, &schema).await.expect("create schema");
    let db = connect_with_search_path(&url, &schema)
        .await
        .expect("connect schema");
    crate::migration::Migrator::up(&db, None)
        .await
        .expect("tenant migrations");

    let creator = insert_user(&db, "racer").await;
    let id = insert_event(&db, creator, "scheduled", false).await;
    let manager = actor(creator, &[Permission::EventsEdit], true);
    let cx_a = target(&db);
    let cx_b = target(&db);
    let req_a = request("start", None);
    let req_b = request("start", None);
    let after = AfterCommit::default();
    let (a, b) = tokio::join!(
        engine::execute(&cx_a, &manager, id, &req_a, Cause::Web, &after),
        engine::execute(&cx_b, &manager, id, &req_b, Cause::Web, &after),
    );
    let outcomes: Vec<String> = [a, b]
        .into_iter()
        .map(|result| result.expect("both return a result").outcome)
        .collect();
    let applied = outcomes.iter().filter(|o| o.as_str() == "applied").count();
    let noops = outcomes.iter().filter(|o| o.as_str() == "noop").count();
    assert_eq!((applied, noops), (1, 1), "{outcomes:?}");
    assert_eq!(status_of(&db, id).await, "live");

    db.close().await.expect("close tenant DB");
    drop_schema(&admin, &schema).await.expect("drop schema");
}
