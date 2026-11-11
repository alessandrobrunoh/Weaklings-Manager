//! Copy-role and guard behavior on the legacy backing (SQLite).

use axum::{body::to_bytes, response::IntoResponse};

use super::copy_role::CopyRole;
use super::guard::copy_info;
use super::test_support::{
    insert_split, insert_user, link_event, register_tenant, share_split, sqlite_db,
};
use super::{LegacyLinks, assert_split_writable, assert_writable, copy_role};
use backend_core::errors::AppError;
use backend_core::sync_origin::SyncKind;

const TENANT: &str = "guild-a";

fn legacy(db: &sea_orm::DatabaseConnection) -> LegacyLinks<'_> {
    LegacyLinks {
        control: db,
        tenant_id: TENANT,
    }
}

#[tokio::test]
async fn event_roles_follow_the_legacy_link_rows() {
    let db = sqlite_db().await;
    // 10: untouched; 11: active copy; 12: copy whose link was disabled; 13: origin of a copy.
    link_event(&db, ("alliance", 1), (TENANT, 11), true).await;
    link_event(&db, ("alliance", 2), (TENANT, 12), false).await;
    link_event(&db, (TENANT, 13), ("guild-b", 99), true).await;

    let role = |id| {
        let db = &db;
        async move {
            copy_role(db, legacy(db), SyncKind::Event, id)
                .await
                .expect("role")
        }
    };
    assert_eq!(role(10).await, CopyRole::NotSynced);
    assert_eq!(role(11).await, CopyRole::ActiveCopy);
    assert_eq!(role(12).await, CopyRole::DetachedCopy);
    assert_eq!(role(13).await, CopyRole::Origin);
    // The same id in another tenant is a different row.
    let other = LegacyLinks {
        control: &db,
        tenant_id: "guild-b",
    };
    assert_eq!(
        copy_role(&db, other, SyncKind::Event, 11).await.unwrap(),
        CopyRole::NotSynced
    );
}

#[tokio::test]
async fn detached_copies_are_copies_for_xp_but_writable_like_origins() {
    assert!(CopyRole::ActiveCopy.is_copy() && CopyRole::ActiveCopy.is_read_only());
    assert!(CopyRole::DetachedCopy.is_copy() && !CopyRole::DetachedCopy.is_read_only());
    for role in [CopyRole::Origin, CopyRole::NotSynced] {
        assert!(!role.is_copy() && !role.is_read_only());
    }
}

#[tokio::test]
async fn guard_rejects_only_active_event_copies_and_names_the_origin() {
    let db = sqlite_db().await;
    register_tenant(&db, "alliance", "Weaklings Alliance", "alliance").await;
    link_event(&db, ("alliance", 1), (TENANT, 11), true).await;
    link_event(&db, ("alliance", 2), (TENANT, 12), false).await;
    link_event(&db, (TENANT, 13), ("guild-b", 99), true).await;

    for id in [10, 12, 13] {
        assert_writable(&db, legacy(&db), SyncKind::Event, id)
            .await
            .unwrap_or_else(|error| panic!("event {id} must stay writable: {error}"));
    }
    let Err(AppError::ReadOnlyCopy(origin)) =
        assert_writable(&db, legacy(&db), SyncKind::Event, 11).await
    else {
        panic!("an active copy must be rejected");
    };
    assert_eq!(origin.tenant_id.as_deref(), Some("alliance"));
    assert_eq!(origin.tenant_name.as_deref(), Some("Weaklings Alliance"));
    assert_eq!(origin.tenant_kind.as_deref(), Some("alliance"));
    assert_eq!(origin.kind, SyncKind::Event);
    assert_eq!(origin.entity_id, Some(1));
    assert_eq!(origin.path.as_deref(), Some("/events/1"));
}

#[tokio::test]
async fn read_only_copy_renders_a_403_problem_with_code_and_origin() {
    let db = sqlite_db().await;
    register_tenant(&db, "alliance", "Weaklings Alliance", "alliance").await;
    link_event(&db, ("alliance", 7), (TENANT, 11), true).await;
    let error = assert_writable(&db, legacy(&db), SyncKind::Event, 11)
        .await
        .expect_err("copy");

    let response = error.into_response();
    assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["type"], "/errors/sync-copy-read-only");
    assert_eq!(json["status"], 403);
    assert_eq!(json["code"], "copy_read_only");
    assert_eq!(json["origin"]["tenant_id"], "alliance");
    assert_eq!(json["origin"]["kind"], "event");
    assert_eq!(json["origin"]["entity_id"], 7);
    assert_eq!(json["origin"]["path"], "/events/7");
    assert!(
        json["detail"]
            .as_str()
            .unwrap()
            .contains("Weaklings Alliance")
    );
    assert!(json.get("details").is_none(), "details stays absent");
}

#[tokio::test]
async fn other_problems_keep_their_exact_shape() {
    let response = AppError::Forbidden("nope".into()).into_response();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    for key in ["code", "details", "origin"] {
        assert!(
            json.get(key).is_none(),
            "{key} must be absent on legacy problems"
        );
    }
}

#[tokio::test]
async fn split_copies_resolve_their_origin_from_the_share_row() {
    let db = sqlite_db().await;
    register_tenant(&db, "guild-src", "Source Guild", "guild").await;
    let creator = insert_user(&db, "creator").await;
    let own = insert_split(&db, creator, false).await;
    let copy = insert_split(&db, creator, true).await;
    let orphan_copy = insert_split(&db, creator, true).await;
    share_split(&db, TENANT, ("guild-src", 42), copy).await;

    assert_eq!(
        copy_role(&db, legacy(&db), SyncKind::Split, own)
            .await
            .unwrap(),
        CopyRole::NotSynced
    );
    assert_eq!(
        copy_role(&db, legacy(&db), SyncKind::Split, copy)
            .await
            .unwrap(),
        CopyRole::ActiveCopy
    );
    assert_writable(&db, legacy(&db), SyncKind::Split, own)
        .await
        .expect("own split is writable");

    let Err(AppError::ReadOnlyCopy(origin)) =
        assert_writable(&db, legacy(&db), SyncKind::Split, copy).await
    else {
        panic!("a published split copy must be rejected");
    };
    assert_eq!(origin.tenant_id.as_deref(), Some("guild-src"));
    assert_eq!(origin.tenant_name.as_deref(), Some("Source Guild"));
    assert_eq!(origin.entity_id, Some(42));
    assert_eq!(origin.path.as_deref(), Some("/splits/42"));

    // A copy whose share row is gone is still rejected; only the decoration is thinner.
    let Err(AppError::ReadOnlyCopy(thin)) =
        assert_writable(&db, legacy(&db), SyncKind::Split, orphan_copy).await
    else {
        panic!("an orphan copy must still be rejected");
    };
    assert_eq!(thin.tenant_id, None);
    assert_eq!(thin.entity_id, None);
    assert_eq!(thin.kind, SyncKind::Split);

    // The shared-out source is an origin.
    let source_side = LegacyLinks {
        control: &db,
        tenant_id: "guild-src",
    };
    let source_split = insert_split(&db, creator, false).await;
    share_split(&db, "alliance", ("guild-src", source_split), 900).await;
    assert_eq!(
        copy_role(&db, source_side, SyncKind::Split, source_split)
            .await
            .unwrap(),
        CopyRole::Origin
    );
}

#[tokio::test]
async fn split_row_guard_needs_no_control_handle() {
    assert_split_writable(None, 1, false).await.expect("own");
    assert!(matches!(
        assert_split_writable(None, 1, true).await,
        Err(AppError::ReadOnlyCopy(_))
    ));
}

#[tokio::test]
async fn copy_info_batches_every_copy_of_a_list() {
    let db = sqlite_db().await;
    register_tenant(&db, "alliance", "Weaklings Alliance", "alliance").await;
    link_event(&db, ("alliance", 1), (TENANT, 11), true).await;
    link_event(&db, ("alliance", 2), (TENANT, 12), false).await;
    link_event(&db, ("alliance", 3), ("guild-b", 13), true).await;

    let info = copy_info(&db, legacy(&db), SyncKind::Event, &[10, 11, 12, 13])
        .await
        .expect("info");
    assert_eq!(info.len(), 2, "only this tenant's copies, no origins");
    assert_eq!(info[&11].role, CopyRole::ActiveCopy);
    assert_eq!(info[&11].origin.entity_id, Some(1));
    assert_eq!(
        info[&11].origin.tenant_name.as_deref(),
        Some("Weaklings Alliance")
    );
    assert_eq!(info[&12].role, CopyRole::DetachedCopy);
    assert_eq!(info[&12].origin.path.as_deref(), Some("/events/2"));
    assert!(
        copy_info(&db, legacy(&db), SyncKind::Event, &[])
            .await
            .unwrap()
            .is_empty()
    );

    let creator = insert_user(&db, "creator").await;
    let copy = insert_split(&db, creator, true).await;
    let own = insert_split(&db, creator, false).await;
    share_split(&db, TENANT, ("guild-src", 5), copy).await;
    let splits = copy_info(&db, legacy(&db), SyncKind::Split, &[copy, own])
        .await
        .expect("split info");
    assert_eq!(splits.len(), 1);
    assert_eq!(splits[&copy].origin.entity_id, Some(5));
}

#[tokio::test]
async fn missing_event_link_table_is_an_error_not_a_free_pass() {
    // A broken control plane must never silently make copies writable.
    let db = sea_orm::Database::connect("sqlite::memory:").await.unwrap();
    assert!(
        assert_writable(&db, legacy(&db), SyncKind::Event, 1)
            .await
            .is_err()
    );
}
