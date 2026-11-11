//! Route matrix: every mutating event route refuses a synchronized copy.
//!
//! The matrix runs the real router on SQLite as the bot system caller (which holds
//! every permission), so a 403 can only come from the copy guard. Routes that only
//! touch tenant-local state (self-service join/leave, VOD post bookkeeping, reads) are
//! deliberately not in the list: the guard must not fire there.

use axum::http::StatusCode;
use sea_orm::{ActiveModelTrait, ActiveValue::Set, DatabaseConnection};
use serde_json::{Value, json};

use crate::modules::events::entities::event;
use crate::modules::events::test_support::matrix_app;
use crate::modules::sync::test_support::{
    call, insert_user, link_event, register_tenant, sqlite_db,
};

const TENANT: &str = "guild-a";
const ORIGIN_EVENT: i64 = 77;

/// `(method, path template with {id}, body)` for every guarded mutating event route.
fn guarded_routes() -> Vec<(&'static str, &'static str, Option<Value>)> {
    let version = json!({ "expected_roster_version": 0 });
    vec![
        (
            "PUT",
            "/{id}/roster/seats/R1-1",
            Some(json!({ "user_id": 1, "expected_roster_version": 0 })),
        ),
        ("DELETE", "/{id}/roster/seats/R1-1", Some(version.clone())),
        (
            "POST",
            "/{id}/roster/swaps",
            Some(json!({
                "source_seat_key": "R1-1",
                "target_seat_key": "R1-2",
                "expected_roster_version": 0
            })),
        ),
        ("POST", "/{id}/roster/auto-fill", Some(version)),
        ("POST", "/{id}/roster-roles", Some(json!({ "build_id": 1 }))),
        ("DELETE", "/{id}/roster-roles/1", None),
        ("POST", "/{id}/mirror-retry", None),
        ("PATCH", "/{id}", Some(json!({}))),
        ("DELETE", "/{id}", None),
        ("POST", "/{id}/archive", None),
        ("POST", "/{id}/unarchive", None),
        ("POST", "/{id}/participants", Some(json!({ "user_id": 1 }))),
        ("PUT", "/{id}/participants/1", Some(json!({}))),
        ("DELETE", "/{id}/participants/1", None),
        ("POST", "/{id}/remind", None),
        (
            "PUT",
            "/{id}/discord-voice-channel",
            Some(json!({ "channel_id": "123456789012345678" })),
        ),
        ("DELETE", "/{id}/discord-voice-channel", None),
        ("POST", "/{id}/start", None),
        ("POST", "/{id}/cancel", None),
        ("POST", "/{id}/uncancel", None),
        ("POST", "/{id}/stop", None),
        ("PUT", "/{id}/battles", Some(json!({ "battle_ids": [] }))),
    ]
}

async fn insert_event(db: &DatabaseConnection, creator: i64) -> i64 {
    event::ActiveModel {
        title: Set("matrix event".to_owned()),
        created_by: Set(creator),
        event_date_utc: Set(chrono::Utc::now().into()),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("insert event")
    .id
}

fn is_copy_rejection(status: StatusCode, body: &Value) -> bool {
    status == StatusCode::FORBIDDEN && body["code"] == "copy_read_only"
}

#[tokio::test]
async fn every_mutating_event_route_rejects_a_copy_with_the_origin() {
    let db = sqlite_db().await;
    register_tenant(&db, "alliance", "Weaklings Alliance", "alliance").await;
    let creator = insert_user(&db, "creator").await;
    let app = matrix_app(super::router(), &db, TENANT, "guild");

    let routes = guarded_routes();
    assert_eq!(routes.len(), 22, "one entry per guarded handler");
    for (method, template, body) in routes {
        let copy = insert_event(&db, creator).await;
        link_event(&db, ("alliance", ORIGIN_EVENT), (TENANT, copy), true).await;
        let path = template.replace("{id}", &copy.to_string());
        let (status, json) = call(&app, method, &path, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}: {json}");
        assert_eq!(json["code"], "copy_read_only", "{method} {path}: {json}");
        assert_eq!(json["origin"]["tenant_id"], "alliance", "{method} {path}");
        assert_eq!(json["origin"]["tenant_name"], "Weaklings Alliance");
        assert_eq!(json["origin"]["kind"], "event");
        assert_eq!(json["origin"]["entity_id"], ORIGIN_EVENT);
        assert_eq!(
            json["origin"]["path"],
            format!("/events/{ORIGIN_EVENT}"),
            "{method} {path}"
        );
    }
}

#[tokio::test]
async fn detached_and_unsynced_events_are_not_rejected_by_the_guard() {
    let db = sqlite_db().await;
    let creator = insert_user(&db, "creator").await;
    let app = matrix_app(super::router(), &db, TENANT, "guild");

    for (method, template, body) in guarded_routes() {
        for detached in [false, true] {
            let id = insert_event(&db, creator).await;
            if detached {
                link_event(&db, ("alliance", ORIGIN_EVENT), (TENANT, id), false).await;
            }
            let path = template.replace("{id}", &id.to_string());
            let (status, json) = call(&app, method, &path, body.clone()).await;
            assert!(
                !is_copy_rejection(status, &json),
                "{method} {path} (detached={detached}) hit the copy guard: {json}"
            );
        }
    }
}

#[tokio::test]
async fn management_authority_reports_a_copy_as_unmanageable() {
    let db = sqlite_db().await;
    let creator = insert_user(&db, "creator").await;
    let app = matrix_app(super::router(), &db, TENANT, "guild");
    let own = insert_event(&db, creator).await;
    let copy = insert_event(&db, creator).await;
    let detached = insert_event(&db, creator).await;
    link_event(&db, ("alliance", 1), (TENANT, copy), true).await;
    link_event(&db, ("alliance", 2), (TENANT, detached), false).await;

    for (id, can_manage) in [(own, true), (copy, false), (detached, true)] {
        let (status, json) = call(&app, "GET", &format!("/{id}/management-authority"), None).await;
        assert_eq!(status, StatusCode::OK, "{json}");
        assert_eq!(json["data"]["can_manage"], can_manage, "event {id}: {json}");
    }
}
