//! End-to-end tests of the event link model on SQLite.
//!
//! Two databases play two tenants: `link_db` is the tenant the request arrives in (it doubles as
//! the control plane, which only needs the `event_sync_links` stand-in) and `origin_db` is the
//! tenant that owns the event. The real events router runs with the link proxy in front of it, so
//! what is asserted here is what a client sees: a request on a link id acts on the origin, is
//! authorized in the caller's own tenant, and is answered in the link's terms.

use axum::{Extension, Router, http::StatusCode};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait,
    PaginatorTrait, QueryFilter,
};
use serde_json::json;

use crate::events::roster_hub::RosterHub;
use crate::events::test_support::link_app;
use crate::events::{links, router};
use backend_entities::auth::{role, role_permission};
use backend_entities::events::{event, event_participation};
use backend_entities::users;
use backend_identity::auth::{Permission, Permissions};
use backend_identity::tenant::TenantRegistry;
use backend_runtime::sync::test_support::{
    call, call_with_headers, link_event, matrix_tenant, register_tenant, sqlite_db,
};

const ORIGIN: &str = "origin-tenant";
const LINK: &str = "link-tenant";

struct World {
    app: Router,
    /// The tenant the request arrives in, and the control plane.
    link_db: DatabaseConnection,
    /// The tenant that owns the event.
    origin_db: DatabaseConnection,
    registry: TenantRegistry,
    hub: RosterHub,
    origin: event::Model,
    link: event::Model,
}

async fn insert_member(db: &DatabaseConnection, name: &str, role: &str) -> i64 {
    users::ActiveModel {
        username: Set(name.to_owned()),
        email: Set(format!("{name}@example.com")),
        role: Set(role.to_owned()),
        discord_id: Set(Some(format!("discord-{name}"))),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("insert member")
    .id
}

async fn insert_event(db: &DatabaseConnection, creator: i64) -> event::Model {
    event::ActiveModel {
        title: Set("Shared mass".to_owned()),
        event_kind: Set("flash".to_owned()),
        created_by: Set(creator),
        event_date_utc: Set(chrono::Utc::now().into()),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("insert event")
}

async fn grant(db: &DatabaseConnection, name: &str, permission: Permission) {
    role::ActiveModel {
        id: Set(name.to_lowercase()),
        name: Set(name.to_owned()),
        priority: Set(50),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("insert role");
    role_permission::ActiveModel {
        role_id: Set(name.to_lowercase()),
        permission: Set(permission.as_str().to_owned()),
    }
    .insert(db)
    .await
    .expect("insert role permission");
}

/// A world where `origin_kind` owns the event and `link_kind` holds a link to it.
///
/// The link tenant has an `Officer` role (`events.manage`) and a `Member` role (`events.view`);
/// users `officer`, `member` and `creator` exist there, and `creator` is also the origin event's
/// creator in the origin tenant, reached by Discord id.
async fn world(origin_kind: &str, link_kind: &str) -> World {
    let link_db = sqlite_db().await;
    let origin_db = sqlite_db().await;
    register_tenant(&link_db, ORIGIN, "Origin Tenant", origin_kind).await;
    register_tenant(&link_db, LINK, "Link Tenant", link_kind).await;

    let registry = TenantRegistry::new("sqlite::memory:".to_owned(), link_db.clone());
    registry.cache_context_for_tests(matrix_tenant(ORIGIN, origin_kind, &origin_db));
    registry.cache_context_for_tests(matrix_tenant(LINK, link_kind, &link_db));

    // Event ids are per-tenant sequences: push the origin's past the link's so a request that
    // is not re-addressed cannot pass for one that is.
    let origin_creator = insert_member(&origin_db, "creator", "Member").await;
    for _ in 0..4 {
        insert_event(&origin_db, origin_creator).await;
    }
    let origin = insert_event(&origin_db, origin_creator).await;

    grant(&link_db, "Officer", Permission::EventsManage).await;
    grant(&link_db, "Member", Permission::EventsView).await;
    let link_creator = insert_member(&link_db, "creator", "Member").await;
    insert_member(&link_db, "officer", "Officer").await;
    insert_member(&link_db, "member", "Member").await;

    let link = links::insert_link_row(&link_db, link_creator, ORIGIN, &origin, "calendar")
        .await
        .expect("link row");
    link_event(&link_db, (ORIGIN, origin.id), (LINK, link.id), true).await;
    assert_ne!(origin.id, link.id, "the two tenants must disagree on the id");

    let permissions = Permissions::new_empty();
    permissions.reload(&link_db).await.expect("permissions");
    let hub = RosterHub::default();
    let app = link_app(
        router().layer(Extension(permissions)),
        &link_db,
        LINK,
        link_kind,
        registry.clone(),
        hub.clone(),
    );
    World {
        app,
        link_db,
        origin_db,
        registry,
        hub,
        origin,
        link,
    }
}

async fn reload(db: &DatabaseConnection, id: i64) -> event::Model {
    event::Entity::find_by_id(id)
        .one(db)
        .await
        .expect("query")
        .expect("row exists")
}

async fn authority(world: &World, who: &str) -> (StatusCode, serde_json::Value) {
    call_with_headers(
        &world.app,
        "GET",
        &format!("/{}/management-authority", world.link.id),
        None,
        &[("X-Discord-Id", &format!("discord-{who}"))],
    )
    .await
}

#[tokio::test]
async fn an_action_on_a_link_lands_on_the_origin_and_is_answered_as_the_link() {
    let world = world("guild", "alliance").await;

    let (status, json) = call(&world.app, "POST", &format!("/{}/archive", world.link.id), None).await;

    assert_eq!(status, StatusCode::OK, "{json}");
    let view = &json["data"];
    assert_eq!(view["id"], world.link.id, "the answer names the link, not the origin");
    assert_eq!(view["is_link"], true);
    assert_eq!(view["source_tenant_id"], ORIGIN);
    assert_eq!(view["source_event_id"], world.origin.id);
    assert_eq!(view["source_tenant_name"], "Origin Tenant");

    let origin = reload(&world.origin_db, world.origin.id).await;
    assert!(origin.archived_at.is_some(), "the one event is archived at its origin");
    let link = reload(&world.link_db, world.link.id).await;
    assert!(
        link.archived_at.is_some(),
        "the link follows the origin's lifecycle"
    );
}

#[tokio::test]
async fn a_detached_link_is_an_ordinary_local_event() {
    let world = world("guild", "alliance").await;
    // The membership ended: the sync link is disabled, so the row answers for itself.
    sea_orm::ConnectionTrait::execute_unprepared(
        &world.link_db,
        "UPDATE event_sync_links SET sync_enabled = FALSE",
    )
    .await
    .expect("disable link");

    let (status, json) = call(&world.app, "POST", &format!("/{}/archive", world.link.id), None).await;

    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json["data"]["id"], world.link.id);
    assert_eq!(json["data"]["is_link"], true, "the row still carries its origin identity");
    let origin = reload(&world.origin_db, world.origin.id).await;
    assert!(origin.archived_at.is_none(), "the origin event is untouched");
}

#[tokio::test]
async fn alliance_officers_manage_a_guild_event_from_its_link() {
    let world = world("guild", "alliance").await;

    let (status, officer) = authority(&world, "officer").await;
    assert_eq!(status, StatusCode::OK, "{officer}");
    assert_eq!(officer["data"]["can_manage"], true, "{officer}");
    assert_eq!(officer["data"]["is_organizer"], false);

    let (status, member) = authority(&world, "member").await;
    assert_eq!(status, StatusCode::OK, "{member}");
    assert_eq!(member["data"]["can_manage"], false, "{member}");

    // The creator is recognised by Discord id in the origin tenant, whatever they hold here.
    let (status, creator) = authority(&world, "creator").await;
    assert_eq!(status, StatusCode::OK, "{creator}");
    assert_eq!(creator["data"]["is_organizer"], true, "{creator}");
    assert_eq!(creator["data"]["can_manage"], true, "{creator}");
}

#[tokio::test]
async fn guild_officers_do_not_manage_an_alliance_event_but_its_creator_does() {
    let world = world("alliance", "guild").await;

    let (status, officer) = authority(&world, "officer").await;
    assert_eq!(status, StatusCode::OK, "{officer}");
    assert_eq!(
        officer["data"]["can_manage"], false,
        "a member guild's events.manage stops at the guild's border: {officer}"
    );

    let (status, creator) = authority(&world, "creator").await;
    assert_eq!(status, StatusCode::OK, "{creator}");
    assert_eq!(creator["data"]["can_manage"], true, "{creator}");

    // The refusal is enforced on the action, not only reported by the read-only twin.
    let (status, json) = call_with_headers(
        &world.app,
        "POST",
        &format!("/{}/archive", world.link.id),
        None,
        &[("X-Discord-Id", "discord-officer")],
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{json}");
    let origin = reload(&world.origin_db, world.origin.id).await;
    assert!(origin.archived_at.is_none());
}

#[tokio::test]
async fn a_caller_unknown_to_their_own_tenant_is_refused_on_a_link() {
    let world = world("guild", "alliance").await;

    let (status, json) = authority(&world, "stranger").await;

    assert_eq!(status, StatusCode::UNAUTHORIZED, "{json}");
}

#[tokio::test]
async fn the_voice_channel_belongs_to_the_origin_servers_only() {
    let world = world("guild", "alliance").await;

    let (status, json) = call(
        &world.app,
        "PUT",
        &format!("/{}/discord-voice-channel", world.link.id),
        Some(json!({ "channel_id": "123456789012345678" })),
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT, "{json}");
    let origin = reload(&world.origin_db, world.origin.id).await;
    assert_eq!(origin.discord_voice_channel_id, None);
}

#[tokio::test]
async fn a_signup_made_through_a_link_lands_on_the_one_roster_and_reaches_the_link_tenant() {
    let world = world("guild", "alliance").await;
    let mut receiver = world.hub.subscribe();
    let member = world.origin.created_by;

    let (status, json) = call(
        &world.app,
        "POST",
        &format!("/{}/participants", world.link.id),
        Some(json!({ "user_id": member })),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json["data"]["id"], world.link.id, "{json}");
    let on_origin = event_participation::Entity::find()
        .filter(event_participation::Column::EventId.eq(world.origin.id))
        .count(&world.origin_db)
        .await
        .unwrap();
    assert_eq!(on_origin, 1, "the signup is on the origin event");
    let on_link = event_participation::Entity::find()
        .filter(event_participation::Column::EventId.eq(world.link.id))
        .count(&world.link_db)
        .await
        .unwrap();
    assert_eq!(on_link, 0, "the link holds no roster of its own");

    let mut tenants = Vec::new();
    while let Ok(notification) = receiver.try_recv() {
        tenants.push((notification.tenant_id, notification.event_id));
    }
    tenants.sort();
    let mut expected = vec![
        (ORIGIN.to_owned(), world.origin.id),
        (LINK.to_owned(), world.link.id),
    ];
    expected.sort();
    assert_eq!(tenants, expected, "viewers on both sides are told");
    let link = reload(&world.link_db, world.link.id).await;
    assert!(
        link.roster_version > world.link.roster_version,
        "the link's revision moves so its Discord card refreshes"
    );
}

#[tokio::test]
async fn a_roster_change_reaches_the_origin_and_every_link_tenant() {
    let world = world("guild", "alliance").await;
    // A second link, in a third tenant.
    let other_db = sqlite_db().await;
    world
        .registry
        .cache_context_for_tests(matrix_tenant("other-link", "guild", &other_db));
    let other_creator = insert_member(&other_db, "creator", "Member").await;
    let other = links::insert_link_row(&other_db, other_creator, ORIGIN, &world.origin, "message")
        .await
        .expect("second link");
    link_event(&world.link_db, (ORIGIN, world.origin.id), ("other-link", other.id), true).await;

    let mut receiver = world.hub.subscribe();
    links::publish_roster_change(
        &world.hub,
        &world.link_db,
        &world.registry,
        ORIGIN,
        world.origin.id,
        9,
        "assigned",
        vec!["R1-1".to_owned()],
    )
    .await;

    let mut seen = Vec::new();
    while let Ok(notification) = receiver.try_recv() {
        assert_eq!(notification.roster_version, 9);
        assert_eq!(notification.change_kind, Some("assigned"));
        seen.push((notification.tenant_id, notification.event_id));
    }
    seen.sort();
    let mut expected = vec![
        (ORIGIN.to_owned(), world.origin.id),
        (LINK.to_owned(), world.link.id),
        ("other-link".to_owned(), other.id),
    ];
    expected.sort();
    assert_eq!(seen, expected, "the origin hub and each link's tenant are told");

    // Each link's revision moves too, which is what makes its Discord server refresh the card.
    assert_eq!(reload(&world.link_db, world.link.id).await.roster_version, 9);
    assert_eq!(reload(&other_db, other.id).await.roster_version, 9);
}

#[tokio::test]
async fn reconcile_converges_a_link_that_missed_its_propagation() {
    let world = world("guild", "alliance").await;
    let mut renamed: event::ActiveModel = world.origin.clone().into();
    renamed.title = Set("Renamed at the origin".to_owned());
    renamed.roster_version = Set(world.origin.roster_version + 3);
    renamed.update(&world.origin_db).await.expect("rename origin");

    let changed = links::reconcile_link_state(&world.link_db, &world.registry)
        .await
        .expect("reconcile");

    assert_eq!(changed, 1);
    let link = reload(&world.link_db, world.link.id).await;
    assert_eq!(link.title, "Renamed at the origin");
    assert_eq!(link.roster_version, world.origin.roster_version + 3);
    let again = links::reconcile_link_state(&world.link_db, &world.registry)
        .await
        .expect("second reconcile");
    assert_eq!(again, 0, "a converged link is not written again");
}

#[tokio::test]
async fn an_empty_link_whose_membership_ended_is_archived() {
    let world = world("guild", "alliance").await;
    sea_orm::ConnectionTrait::execute_unprepared(
        &world.link_db,
        "UPDATE event_sync_links SET sync_enabled = FALSE",
    )
    .await
    .expect("disable link");

    let changed = links::reconcile_link_state(&world.link_db, &world.registry)
        .await
        .expect("reconcile");

    assert_eq!(changed, 1);
    let link = reload(&world.link_db, world.link.id).await;
    assert!(link.archived_at.is_some());
}

#[tokio::test]
async fn a_synchronized_copy_of_the_old_model_becomes_a_link_and_keeps_its_signups() {
    let world = world("alliance", "guild").await;
    // The guild held the copy instead of a link: drop the world's link row, since a tenant has at
    // most one event per origin.
    event::Entity::delete_by_id(world.link.id)
        .exec(&world.link_db)
        .await
        .expect("drop the world's link");
    // The old model: the guild holds a full copy with its own signups and no origin columns.
    let copy_creator = insert_member(&world.link_db, "copier", "Member").await;
    let copy = insert_event(&world.link_db, copy_creator).await;
    let alice = insert_member(&world.link_db, "alice", "Member").await;
    event_participation::ActiveModel {
        event_id: Set(copy.id),
        user_id: Set(alice),
        primary_build_id: Set(None),
        secondary_build_id: Set(None),
        created_at: Set(chrono::Utc::now().into()),
        updated_at: Set(chrono::Utc::now().into()),
        ..Default::default()
    }
    .insert(&world.link_db)
    .await
    .expect("copy signup");
    link_event(&world.link_db, (ORIGIN, world.origin.id), (LINK, copy.id), true).await;

    let converted = links::convert_legacy_copies(&world.link_db, &world.registry)
        .await
        .expect("conversion");

    assert_eq!(converted, 1);
    let copy_after = reload(&world.link_db, copy.id).await;
    assert_eq!(copy_after.comp_id, None);
    assert_eq!(copy_after.source_tenant_id.as_deref(), Some(ORIGIN));
    assert_eq!(copy_after.source_event_id, Some(world.origin.id));
    let copy_signups = event_participation::Entity::find()
        .filter(event_participation::Column::EventId.eq(copy.id))
        .count(&world.link_db)
        .await
        .unwrap();
    assert_eq!(copy_signups, 0, "the copy keeps no roster of its own");

    let alice_on_origin = users::Entity::find()
        .filter(users::Column::DiscordId.eq("discord-alice"))
        .one(&world.origin_db)
        .await
        .unwrap()
        .expect("alice exists in the origin tenant");
    let signup = event_participation::Entity::find()
        .filter(event_participation::Column::EventId.eq(world.origin.id))
        .filter(event_participation::Column::UserId.eq(alice_on_origin.id))
        .one(&world.origin_db)
        .await
        .unwrap();
    assert!(signup.is_some(), "her signup moved to the one roster");
    let origin_after = reload(&world.origin_db, world.origin.id).await;
    assert!(origin_after.roster_version > world.origin.roster_version);

    let again = links::convert_legacy_copies(&world.link_db, &world.registry)
        .await
        .expect("second conversion");
    assert_eq!(again, 0, "the conversion is idempotent");
}
