//! Route tests for `/api/sync`: permission gating and tenant scoping.
//!
//! The handlers are called with the extractor values the router would provide.
//! The session and bot extractors need a live user row, which the SQLite world
//! does not have; the permission check itself is the same `require` call.

use axum::{Extension, Json, extract::Path, extract::Query};
use chrono::Utc;
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use uuid::Uuid;

use super::jobs::{self, NewJob};
use super::router::{self, EntityBody, JobsQuery, StatusQuery};
use crate::testkit::{ALLIANCE, GUILDS, World};
use backend_core::errors::AppError;
use backend_identity::auth::{Permissions, UserContext};
use backend_identity::tenant::{ControlDb, CurrentTenantId};

fn caller(superadmin: bool) -> UserContext {
    UserContext {
        id: "1".to_owned(),
        username: "tester".to_owned(),
        email: None,
        avatar: None,
        roles: Vec::new(),
        highest_role: String::new(),
        user_id: 1,
        super_admin_id: superadmin.then(|| "1".to_owned()),
        is_tenant_owner: false,
    }
}

fn job(target: &str, key: &str) -> NewJob {
    NewJob {
        kind: "noop".into(),
        op: "upsert",
        flow: "to_copy",
        origin_tenant_id: ALLIANCE.into(),
        origin_id: 42,
        target_tenant_id: target.into(),
        subject: String::new(),
        origin_version: 1,
        ordering_key: format!("noop:{ALLIANCE}:42:{target}"),
        dedupe_key: format!("{ALLIANCE}:1:{target}:{key}"),
        payload: serde_json::json!({}),
        priority: 3,
        max_attempts: 12,
    }
}

/// Two pending jobs: the alliance's `noop:42` to guilds 1 and 2.
async fn seed_two_targets(world: &World) {
    for (target, key) in [(GUILDS[0], "a"), (GUILDS[1], "b")] {
        jobs::enqueue(&world.control, &job(target, key), Utc::now())
            .await
            .expect("enqueue");
    }
}

async fn set_all_states(world: &World, state: &str) {
    world
        .control
        .execute(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "UPDATE sync_jobs SET state = $1",
            [state.into()],
        ))
        .await
        .expect("set state");
}

fn entity(raw: &str) -> Query<StatusQuery> {
    Query(StatusQuery {
        entity: raw.to_owned(),
    })
}

fn body(raw: &str) -> Json<EntityBody> {
    Json(EntityBody {
        entity: raw.to_owned(),
        target_tenant_id: None,
    })
}

#[tokio::test]
async fn view_routes_refuse_callers_without_sync_view() {
    let world = World::new().await;
    seed_two_targets(&world).await;
    let perms = Permissions::new_empty();
    let control = ControlDb(world.control.clone());
    let tenant = CurrentTenantId(ALLIANCE.to_owned());

    let status = router::status(
        caller(false),
        Extension(perms.clone()),
        Extension(control.clone()),
        Extension(tenant.clone()),
        entity("noop:42"),
    )
    .await;
    assert!(matches!(status, Err(AppError::Forbidden(_))), "status");

    let summary = router::summary(
        caller(false),
        Extension(perms.clone()),
        Extension(control.clone()),
        Extension(tenant.clone()),
    )
    .await;
    assert!(matches!(summary, Err(AppError::Forbidden(_))), "summary");

    let listed = router::list_jobs(
        caller(false),
        Extension(perms),
        Extension(control),
        Extension(tenant),
        Query(JobsQuery {
            state: None,
            kind: None,
            entity: None,
            limit: None,
            cursor: None,
        }),
    )
    .await;
    assert!(matches!(listed, Err(AppError::Forbidden(_))), "list");
}

#[tokio::test]
async fn manage_routes_refuse_callers_without_sync_manage() {
    let world = World::new().await;
    seed_two_targets(&world).await;
    set_all_states(&world, "exhausted").await;
    let perms = Permissions::new_empty();
    let control = ControlDb(world.control.clone());
    let tenant = CurrentTenantId(ALLIANCE.to_owned());
    let runtime = world.runtime.clone();

    let retried = router::retry_job(
        caller(false),
        Extension(perms.clone()),
        Extension(control.clone()),
        Extension(tenant.clone()),
        Extension(runtime.clone()),
        Path(Uuid::new_v4()),
    )
    .await;
    assert!(matches!(retried, Err(AppError::Forbidden(_))), "retry job");

    let retried_entity = router::retry_entity(
        caller(false),
        Extension(perms.clone()),
        Extension(control),
        Extension(tenant.clone()),
        Extension(runtime.clone()),
        body("noop:42"),
    )
    .await;
    assert!(
        matches!(retried_entity, Err(AppError::Forbidden(_))),
        "retry entity"
    );

    let resynced = router::resync_entity(
        caller(false),
        Extension(perms),
        Extension(world.alliance().db.clone()),
        Extension(runtime),
        body("noop:42"),
    )
    .await;
    assert!(matches!(resynced, Err(AppError::Forbidden(_))), "resync");

    // Nothing was re-armed by the refused calls.
    assert_eq!(
        count_state(&world, "exhausted").await,
        2,
        "refused retries must not touch the queue"
    );
}

#[tokio::test]
async fn status_is_scoped_to_the_origin_tenant() {
    let world = World::new().await;
    seed_two_targets(&world).await;
    let control = ControlDb(world.control.clone());

    let origin = router::status(
        caller(true),
        Extension(Permissions::new_empty()),
        Extension(control.clone()),
        Extension(CurrentTenantId(ALLIANCE.to_owned())),
        entity("noop:42"),
    )
    .await
    .expect("origin status")
    .0
    .data;
    assert_eq!(origin.state, "pending");
    assert_eq!(origin.targets.len(), 2, "one row per target");
    assert_eq!(origin.entity.role, "origin");

    // A guild that is only a target of the job does not see it through status.
    let guild = router::status(
        caller(true),
        Extension(Permissions::new_empty()),
        Extension(control),
        Extension(CurrentTenantId(GUILDS[0].to_owned())),
        entity("noop:42"),
    )
    .await
    .expect("guild status")
    .0
    .data;
    assert_eq!(guild.state, "not_synced");
    assert!(guild.targets.is_empty());
}

#[tokio::test]
async fn attention_list_shows_jobs_to_origin_and_target_and_summary_counts_the_callers_origin() {
    let world = World::new().await;
    seed_two_targets(&world).await;
    let control = ControlDb(world.control.clone());
    let query = || {
        Query(JobsQuery {
            state: Some("pending".to_owned()),
            kind: None,
            entity: None,
            limit: None,
            cursor: None,
        })
    };

    let as_origin = router::list_jobs(
        caller(true),
        Extension(Permissions::new_empty()),
        Extension(control.clone()),
        Extension(CurrentTenantId(ALLIANCE.to_owned())),
        query(),
    )
    .await
    .expect("origin list")
    .0
    .data;
    assert_eq!(as_origin.jobs.len(), 2);

    let as_target = router::list_jobs(
        caller(true),
        Extension(Permissions::new_empty()),
        Extension(control.clone()),
        Extension(CurrentTenantId(GUILDS[1].to_owned())),
        query(),
    )
    .await
    .expect("target list")
    .0
    .data;
    assert_eq!(as_target.jobs.len(), 1, "a target sees only its own job");

    let summary = router::summary(
        caller(true),
        Extension(Permissions::new_empty()),
        Extension(control),
        Extension(CurrentTenantId(GUILDS[2].to_owned())),
    )
    .await
    .expect("summary")
    .0
    .data;
    assert!(
        summary.counts.is_empty(),
        "a tenant with no jobs has no counts"
    );
}

#[tokio::test]
async fn retry_entity_rearms_only_the_origins_own_jobs() {
    let world = World::new().await;
    seed_two_targets(&world).await;
    set_all_states(&world, "exhausted").await;
    let runtime = world.runtime.clone();

    let by_target = router::retry_entity(
        caller(true),
        Extension(Permissions::new_empty()),
        Extension(ControlDb(world.control.clone())),
        Extension(CurrentTenantId(GUILDS[0].to_owned())),
        Extension(runtime.clone()),
        body("noop:42"),
    )
    .await
    .expect("retry as target")
    .0
    .data;
    assert_eq!(by_target.rearmed, 0, "retry is origin-scoped");

    let by_origin = router::retry_entity(
        caller(true),
        Extension(Permissions::new_empty()),
        Extension(ControlDb(world.control.clone())),
        Extension(CurrentTenantId(ALLIANCE.to_owned())),
        Extension(runtime),
        body("noop:42"),
    )
    .await
    .expect("retry as origin")
    .0
    .data;
    assert_eq!(by_origin.rearmed, 2);
    assert_eq!(count_state(&world, "pending").await, 2);
}

async fn count_state(world: &World, state: &str) -> i64 {
    world
        .control
        .query_one(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "SELECT COUNT(*) FROM sync_jobs WHERE state = $1",
            [state.into()],
        ))
        .await
        .expect("count")
        .expect("row")
        .try_get_by_index(0)
        .expect("count value")
}
