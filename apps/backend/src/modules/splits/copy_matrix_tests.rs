//! Route matrix: every mutating split route refuses a published copy.
//!
//! Runs the real router on SQLite as the bot system caller (all permissions), so a 403
//! with `copy_read_only` can only come from the copy guard. Tenant-local routes
//! (Discord sync state, reads, previews) are not listed on purpose.

use axum::http::StatusCode;
use serde_json::{Value, json};

use crate::modules::sync::test_support::{
    call, insert_split, insert_user, matrix_app, register_tenant, share_split, sqlite_db,
};

const TENANT: &str = "alliance-a";

/// `(method, path template with {id}, body)` for every guarded mutating split route.
fn guarded_routes() -> Vec<(&'static str, &'static str, Option<Value>)> {
    vec![
        ("PATCH", "/{id}", Some(json!({ "bags": ["50.00"] }))),
        ("DELETE", "/{id}", None),
        ("POST", "/{id}/archive", None),
        ("POST", "/{id}/unarchive", None),
        (
            "POST",
            "/{id}/participants",
            Some(json!({ "user_id": 1, "weight": "1" })),
        ),
        ("DELETE", "/{id}/participants/1", None),
        ("POST", "/{id}/donate", None),
        ("POST", "/{id}/complete", None),
        ("POST", "/{id}/not-completed", None),
        ("POST", "/{id}/lost", None),
    ]
}

#[tokio::test]
async fn every_mutating_split_route_rejects_a_copy_with_the_origin() {
    let db = sqlite_db().await;
    register_tenant(&db, "guild-src", "Source Guild", "guild").await;
    let creator = insert_user(&db, "creator").await;

    // A published copy is read-only whatever kind of tenant holds it.
    for tenant_kind in ["alliance", "guild"] {
        let app = matrix_app(super::router(), &db, TENANT, tenant_kind);
        for (method, template, body) in guarded_routes() {
            let copy = insert_split(&db, creator, true).await;
            share_split(&db, TENANT, ("guild-src", 4000 + copy), copy).await;
            let path = template.replace("{id}", &copy.to_string());
            let (status, json) = call(&app, method, &path, body).await;
            let what = format!("{tenant_kind} {method} {path}: {json}");
            assert_eq!(status, StatusCode::FORBIDDEN, "{what}");
            assert_eq!(json["code"], "copy_read_only", "{what}");
            assert_eq!(json["origin"]["tenant_id"], "guild-src", "{what}");
            assert_eq!(json["origin"]["tenant_name"], "Source Guild", "{what}");
            assert_eq!(json["origin"]["kind"], "split", "{what}");
            assert_eq!(json["origin"]["entity_id"], 4000 + copy, "{what}");
            assert_eq!(
                json["origin"]["path"],
                format!("/splits/{}", 4000 + copy),
                "{what}"
            );
        }
    }
}

#[tokio::test]
async fn own_splits_are_not_rejected_by_the_copy_guard() {
    let db = sqlite_db().await;
    let creator = insert_user(&db, "creator").await;
    let app = matrix_app(super::router(), &db, TENANT, "guild");
    for (method, template, body) in guarded_routes() {
        let own = insert_split(&db, creator, false).await;
        let path = template.replace("{id}", &own.to_string());
        let (status, json) = call(&app, method, &path, body).await;
        assert!(
            !(status == StatusCode::FORBIDDEN && json["code"] == "copy_read_only"),
            "{method} {path} hit the copy guard: {json}"
        );
    }
}

#[tokio::test]
async fn alliance_tenant_keeps_its_own_rule_for_non_copy_splits() {
    let db = sqlite_db().await;
    let creator = insert_user(&db, "creator").await;
    let app = matrix_app(super::router(), &db, TENANT, "alliance");
    let own = insert_split(&db, creator, false).await;
    let (status, json) = call(&app, "POST", &format!("/{own}/lost"), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{json}");
    assert_ne!(json["code"], "copy_read_only");
    assert!(json["detail"].as_str().unwrap().contains("read-only"));
}

#[tokio::test]
async fn batch_completion_reports_a_copy_as_a_failure_without_touching_it() {
    let db = sqlite_db().await;
    let creator = insert_user(&db, "creator").await;
    let app = matrix_app(super::router(), &db, TENANT, "guild");
    let copy = insert_split(&db, creator, true).await;
    let (_, _) = call(&app, "GET", "/summary", None).await;
    let (status, json) = call(
        &app,
        "POST",
        "/complete-batch",
        Some(json!({ "split_ids": [copy] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json["data"]["completed"], json!([]));
    assert_eq!(json["data"]["failed"][0]["split_id"], copy);
}
