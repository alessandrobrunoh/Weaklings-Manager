//! Route-level checks of the lifecycle effects (DO §5.3).
//!
//! The matrix harness sends requests with the bot secret, so every lifecycle request here is
//! a forwarded Discord request (`Cause::Discord`). They must write the same outbox rows as a
//! web transition, and the responses must report exactly those rows.

use axum::http::StatusCode;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ConnectionTrait, DatabaseConnection, DbBackend, Statement,
};
use serde_json::{Value, json};

use crate::modules::events::entities::event;
use super::lifecycle::{Cause, Transition, transition_in_txn};
use crate::modules::events::test_support::matrix_app;
use crate::modules::sync::test_support::{call, insert_user, sqlite_db};
use sea_orm::TransactionTrait;

const TENANT: &str = "guild-a";

async fn insert_event(db: &DatabaseConnection, creator: i64, status: &str) -> i64 {
    event::ActiveModel {
        title: Set(format!("{status} event")),
        created_by: Set(creator),
        // Flash events need no composition; organized ones do (service listing rejects them).
        event_kind: Set(event::KIND_FLASH.to_owned()),
        event_date_utc: Set(chrono::Utc::now().into()),
        status: Set(status.to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("insert event")
    .id
}

/// Outbox rows as `(id, kind, payload, cause)`, keyed by id.
async fn outbox(db: &DatabaseConnection) -> Vec<(i64, String, String, String)> {
    db.query_all(Statement::from_string(
        DbBackend::Sqlite,
        "SELECT id, kind, payload, cause FROM discord_outbox ORDER BY id".to_owned(),
    ))
    .await
    .expect("read outbox")
    .iter()
    .map(|row| {
        (
            row.try_get::<i64>("", "id").expect("id"),
            row.try_get::<String>("", "kind").expect("kind"),
            row.try_get::<String>("", "payload").expect("payload"),
            row.try_get::<String>("", "cause").expect("cause"),
        )
    })
    .collect()
}

/// `(kind, payload)` of the rows with the given ids, in the given order.
fn rows_for(rows: &[(i64, String, String, String)], ids: &[i64]) -> Vec<(String, String)> {
    ids.iter()
        .map(|id| {
            let row = rows
                .iter()
                .find(|row| row.0 == *id)
                .expect("reported row exists");
            (row.1.clone(), row.2.clone())
        })
        .collect()
}

/// Ids reported in a response's `effects` array, checked against the kind they name.
fn reported(json: &Value) -> Vec<i64> {
    json["effects"]
        .as_array()
        .expect("effects array")
        .iter()
        .map(|effect| effect["id"].as_i64().expect("effect id"))
        .collect()
}

#[tokio::test]
async fn bot_start_writes_the_same_effects_as_a_web_transition() {
    let db = sqlite_db().await;
    let creator = insert_user(&db, "creator").await;
    let app = matrix_app(super::router(), &db, TENANT, "guild");

    let via_bot = insert_event(&db, creator, "scheduled").await;
    let (status, json) = call(&app, "POST", &format!("/{via_bot}/start"), None).await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json["status"], "success");
    assert_eq!(json["data"]["status"], "live");
    let bot_ids = reported(&json);
    let kinds: Vec<&str> = json["effects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|effect| effect["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["event.start", "event.upsert", "calendar.sync"]);

    let via_web = insert_event(&db, creator, "scheduled").await;
    let txn = db.begin().await.unwrap();
    let outcome = transition_in_txn(&txn, via_web, Transition::Start, Cause::Web, None)
        .await
        .unwrap();
    txn.commit().await.unwrap();
    let web_ids: Vec<i64> = outcome.effects.iter().map(|effect| effect.id).collect();

    let rows = outbox(&db).await;
    assert_eq!(
        rows_for(&rows, &bot_ids),
        rows_for(&rows, &web_ids),
        "the bot route and the web transition write identical (kind, payload) rows"
    );
    let bot_row = rows.iter().find(|row| row.0 == bot_ids[0]).unwrap();
    assert_eq!(
        bot_row.3, "discord",
        "the forwarded request is stored as a Discord cause"
    );
}

#[tokio::test]
async fn start_on_a_live_event_is_a_conflict_and_writes_nothing() {
    let db = sqlite_db().await;
    let creator = insert_user(&db, "creator").await;
    let app = matrix_app(super::router(), &db, TENANT, "guild");
    let id = insert_event(&db, creator, "scheduled").await;
    let (status, _) = call(&app, "POST", &format!("/{id}/start"), None).await;
    assert_eq!(status, StatusCode::OK);

    let before = outbox(&db).await;
    let (status, json) = call(&app, "POST", &format!("/{id}/start"), None).await;
    assert_eq!(status, StatusCode::CONFLICT, "{json}");
    assert_eq!(outbox(&db).await, before);
}

#[tokio::test]
async fn repeated_stop_reports_no_effects() {
    let db = sqlite_db().await;
    let creator = insert_user(&db, "creator").await;
    let app = matrix_app(super::router(), &db, TENANT, "guild");
    let id = insert_event(&db, creator, "scheduled").await;
    call(&app, "POST", &format!("/{id}/start"), None).await;

    let (status, first) = call(&app, "POST", &format!("/{id}/stop"), None).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(reported(&first).len(), 3);

    let before = outbox(&db).await;
    let (status, again) = call(&app, "POST", &format!("/{id}/stop"), None).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["effects"], json!([]));
    assert_eq!(outbox(&db).await, before);
}

#[tokio::test]
async fn remind_reports_the_manual_reminder_effect() {
    let db = sqlite_db().await;
    let creator = insert_user(&db, "creator").await;
    let app = matrix_app(super::router(), &db, TENANT, "guild");
    let id = insert_event(&db, creator, "scheduled").await;

    let (status, json) = call(&app, "POST", &format!("/{id}/remind"), None).await;
    assert_eq!(status, StatusCode::OK, "{json}");
    let ids = reported(&json);
    assert_eq!(json["effects"][0]["kind"], "event.reminder");
    let rows = outbox(&db).await;
    assert_eq!(rows_for(&rows, &ids)[0].0, "event.reminder");
    assert_eq!(
        rows.iter().find(|row| row.0 == ids[0]).unwrap().3,
        "manual",
        "a remind is manual whoever asks"
    );
}
