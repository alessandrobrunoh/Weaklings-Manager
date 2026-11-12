//! The link rows other tenants hold for an event they share (see [`super::link_proxy`]).
//!
//! A link carries what a tenant's own Discord delivery needs to announce and list the event:
//! title, description, kind, times and status (kept current by
//! [`super::lifecycle::converge_copy_to_source`]) and the origin's roster revision, which makes
//! the server's poller refresh its signup card. It has no comp, roster, split or VOD of its own:
//! those live on the origin event, which every request on the link is re-addressed to.
//!
//! This module also owns the maintenance that keeps links honest:
//!
//! * [`publish_roster_change`] tells every viewer of every tenant about a roster change.
//! * [`reconcile_link_state`] converges links that missed a propagation (an origin that
//!   auto-stopped, a lost retry) and archives the links of a membership that ended.
//! * [`convert_legacy_copies`] turns the full synchronized copies the previous model created into
//!   links, keeping the signups they alone had.

use std::collections::HashSet;

use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, DatabaseConnection,
    EntityTrait, PaginatorTrait, QueryFilter, Statement, TransactionTrait,
    sea_query::Expr,
};

use backend_core::errors::AppError;
use backend_entities::events::{
    event, event_participation, event_party, event_roster_assignment, event_roster_role,
};
use backend_entities::users;
use backend_identity::tenant::TenantRegistry;
use backend_identity::users::identity::upsert_discord_user;

use super::roster_hub::RosterHub;

/// Inserts the link row a tenant holds for `source`, owned by `creator_id` in that tenant.
///
/// `discord_delivery` is the destination tenant's own delivery mode: how a link is announced is
/// that server's choice. A link never requests a VOD post or pings an alliance: both belong to
/// the origin.
///
/// # Errors
///
/// Returns `AppError::Database` when the insert fails.
pub async fn insert_link_row(
    db: &DatabaseConnection,
    creator_id: i64,
    source_tenant_id: &str,
    source: &event::Model,
    discord_delivery: &str,
) -> Result<event::Model, AppError> {
    let delivery = announcement_delivery(
        backend_identity::admin::models::normalize_discord_delivery(discord_delivery)
            .map_err(AppError::Validation)?,
        true,
    );
    let link = event::ActiveModel {
        title: Set(source.title.clone()),
        description: Set(source.description.clone()),
        call_to_arms: Set(source.call_to_arms),
        regear: Set(source.regear),
        event_kind: Set(source.event_kind.clone()),
        comp_id: Set(None),
        player_cap: Set(source.player_cap),
        created_by: Set(creator_id),
        event_date_utc: Set(source.event_date_utc),
        mass_time_utc: Set(source.mass_time_utc),
        start_time_utc: Set(source.start_time_utc),
        roster_version: Set(source.roster_version),
        ping_alliance: Set(false),
        discord_delivery: Set(delivery),
        vod_forum_post_enabled: Set(false),
        vod_forum_post_status: Set("not_requested".to_owned()),
        source_tenant_id: Set(Some(source_tenant_id.to_owned())),
        source_event_id: Set(Some(source.id)),
        ..Default::default()
    }
    .insert(db)
    .await?;
    Ok(link)
}

/// The delivery mode an event is announced with.
///
/// An event shared across tenants is announced publicly on every server it reaches, even where
/// the server keeps a calendar-only delivery: a calendar entry is private to the members who see
/// the channel, and the point of sharing is that the other side sees it. `calendar` therefore
/// becomes `message` for shared events and their links; every other mode is kept.
#[must_use]
pub fn announcement_delivery(delivery: &str, shared: bool) -> String {
    if shared && delivery == "calendar" {
        "message".to_owned()
    } else {
        delivery.to_owned()
    }
}

/// The `(tenant, event id)` of every enabled link of an origin event.
///
/// # Errors
///
/// Returns `AppError::Database` when the control plane cannot be read.
pub async fn link_targets(
    control: &DatabaseConnection,
    origin_tenant_id: &str,
    origin_event_id: i64,
) -> Result<Vec<(String, i64)>, AppError> {
    let rows = control
        .query_all(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT mirror_tenant_id, mirror_event_id FROM event_sync_links \
             WHERE sync_enabled AND source_tenant_id = $1 AND source_event_id = $2 \
             ORDER BY mirror_tenant_id, mirror_event_id",
            [origin_tenant_id.into(), origin_event_id.into()],
        ))
        .await?;
    rows.into_iter()
        .map(|row| {
            Ok::<(String, i64), sea_orm::DbErr>((
                row.try_get_by_index::<String>(0)?,
                row.try_get_by_index::<i64>(1)?,
            ))
        })
        .collect::<Result<Vec<_>, sea_orm::DbErr>>()
        .map_err(AppError::Database)
}

/// Publishes a roster change of the origin event to the origin's roster hub and to every link's
/// tenant, and moves each link's roster revision so its Discord server refreshes its card.
///
/// Best effort by design: the change is already committed on the origin, so a link that cannot be
/// reached is logged and catches up on the next [`reconcile_link_state`] pass instead of failing
/// the request that succeeded.
#[allow(clippy::too_many_arguments)]
pub async fn publish_roster_change(
    hub: &RosterHub,
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    tenant_id: &str,
    event_id: i64,
    roster_version: i64,
    change_kind: &'static str,
    changed_seat_keys: Vec<String>,
) {
    hub.publish(
        tenant_id,
        event_id,
        roster_version,
        change_kind,
        changed_seat_keys.clone(),
    );
    let targets = match link_targets(control, tenant_id, event_id).await {
        Ok(targets) => targets,
        Err(error) => {
            tracing::warn!(tenant_id, event_id, %error, "could not resolve the links of an event");
            return;
        }
    };
    for (link_tenant, link_event_id) in targets {
        match registry.get_or_load(&link_tenant).await {
            Ok(context) => {
                if let Err(error) =
                    set_link_roster_version(&context.db, link_event_id, roster_version).await
                {
                    tracing::warn!(
                        link_tenant,
                        link_event_id,
                        %error,
                        "could not move the roster revision of an event link"
                    );
                }
            }
            Err(error) => {
                tracing::warn!(link_tenant, %error, "could not load the tenant of an event link");
            }
        }
        hub.publish(
            link_tenant,
            link_event_id,
            roster_version,
            change_kind,
            changed_seat_keys.clone(),
        );
    }
}

/// Moves a link's roster revision forward. The revision never goes backwards, so two changes
/// racing to the same link cannot leave it behind the newer one.
async fn set_link_roster_version(
    db: &DatabaseConnection,
    link_event_id: i64,
    roster_version: i64,
) -> Result<(), AppError> {
    let now: chrono::DateTime<chrono::FixedOffset> = Utc::now().into();
    event::Entity::update_many()
        .filter(event::Column::Id.eq(link_event_id))
        .filter(event::Column::RosterVersion.lt(roster_version))
        .col_expr(event::Column::RosterVersion, Expr::value(roster_version))
        .col_expr(event::Column::UpdatedAt, Expr::value(now))
        .exec(db)
        .await?;
    Ok(())
}

/// How many links one reconcile pass examines, newest first.
const RECONCILE_LINK_LIMIT: u64 = 500;

/// Converges every recent enabled link to its origin and archives the links of ended
/// memberships.
///
/// Propagation after a change is best effort; this pass is the safety net. It catches an origin
/// that stopped by itself (auto-stop runs in the origin's tenant and knows nothing of its
/// links), a retry that was lost, and a roster change whose link update failed. Links whose link
/// is already current are not written (see [`super::lifecycle::converge_copy_to_source`]).
///
/// A link whose membership ended (`sync_enabled = false`) has no origin to serve it any more, so
/// an empty one is archived instead of lingering as an event nobody can sign up for. A detached
/// legacy copy that still holds its own roster is a standalone event now and is left alone.
///
/// Returns the number of links that changed.
///
/// # Errors
///
/// Returns `AppError::Database` when the control plane cannot be read; an unreachable tenant is
/// logged and skipped.
pub async fn reconcile_link_state(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
) -> Result<usize, AppError> {
    let rows = control
        .query_all(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT source_tenant_id, source_event_id, mirror_tenant_id, mirror_event_id, \
                    sync_enabled \
             FROM event_sync_links ORDER BY created_at DESC LIMIT $1",
            [i64::try_from(RECONCILE_LINK_LIMIT).unwrap_or(i64::MAX).into()],
        ))
        .await?;
    let mut changed = 0;
    for row in rows {
        let source_tenant: String = row.try_get_by_index(0)?;
        let source_event: i64 = row.try_get_by_index(1)?;
        let mirror_tenant: String = row.try_get_by_index(2)?;
        let mirror_event: i64 = row.try_get_by_index(3)?;
        let enabled: bool = row.try_get_by_index(4)?;
        let outcome = if enabled {
            reconcile_one(
                registry,
                (source_tenant.as_str(), source_event),
                (mirror_tenant.as_str(), mirror_event),
            )
            .await
        } else {
            archive_detached(registry, &mirror_tenant, mirror_event).await
        };
        match outcome {
            Ok(true) => changed += 1,
            Ok(false) => {}
            Err(error) => tracing::warn!(
                source_tenant,
                source_event,
                mirror_tenant,
                mirror_event,
                %error,
                "event link reconcile skipped a link"
            ),
        }
    }
    Ok(changed)
}

async fn reconcile_one(
    registry: &TenantRegistry,
    source: (&str, i64),
    mirror: (&str, i64),
) -> Result<bool, AppError> {
    let source_context = registry.get_or_load(source.0).await?;
    let Some(origin) = event::Entity::find_by_id(source.1)
        .one(&source_context.db)
        .await?
    else {
        return Ok(false);
    };
    let mirror_context = registry.get_or_load(mirror.0).await?;
    super::lifecycle::converge_copy_to_source(&mirror_context.db, &origin, mirror.1).await
}

async fn archive_detached(
    registry: &TenantRegistry,
    mirror_tenant: &str,
    mirror_event: i64,
) -> Result<bool, AppError> {
    let context = registry.get_or_load(mirror_tenant).await?;
    let Some(row) = event::Entity::find_by_id(mirror_event)
        .one(&context.db)
        .await?
    else {
        return Ok(false);
    };
    if row.archived_at.is_some() || row.comp_id.is_some() {
        return Ok(false);
    }
    let has_signups = event_participation::Entity::find()
        .filter(event_participation::Column::EventId.eq(mirror_event))
        .count(&context.db)
        .await?
        > 0;
    if has_signups {
        return Ok(false);
    }
    let mut active: event::ActiveModel = row.into();
    active.archived_at = Set(Some(Utc::now().into()));
    active.updated_at = Set(Utc::now().into());
    active.update(&context.db).await?;
    Ok(true)
}

/// Turns the full synchronized copies of the previous model into links.
///
/// Until the single-event model, an event shared with an alliance was copied into the other
/// tenant together with its comp, builds, roster and signups, and the copy was read-only. Those
/// copies are still in the tenants. For every enabled sync link whose mirror is still such a copy
/// this pass:
///
/// 1. moves the signups only the copy had onto the origin event as `Fill` participants (the
///    builds of the copy do not exist in the origin's tenant, so the member picks a build again;
///    nobody loses their place), attributing them to the guild they signed up from when the copy
///    lives in a guild;
/// 2. deletes the copy's roster: seat assignments, participations, extra roster roles, parties
///    and the comp reference;
/// 3. stamps the origin identity on the row and drops the VOD and alliance-ping requests a link
///    never makes.
///
/// It is idempotent: a mirror that is already a link (no comp, no signups, identity set) is
/// skipped by one cheap check, so the pass can run on every start and periodically. A copy whose
/// sync link was disabled is a standalone event now and is never converted.
///
/// Returns the number of copies converted.
///
/// # Errors
///
/// Returns `AppError::Database` when the control plane cannot be read; a failing copy is logged
/// and retried on the next pass.
pub async fn convert_legacy_copies(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
) -> Result<usize, AppError> {
    let rows = control
        .query_all(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT source_tenant_id, source_event_id, mirror_tenant_id, mirror_event_id \
             FROM event_sync_links WHERE sync_enabled ORDER BY created_at",
            [],
        ))
        .await?;
    let mut converted = 0;
    for row in rows {
        let source_tenant: String = row.try_get_by_index(0)?;
        let source_event: i64 = row.try_get_by_index(1)?;
        let mirror_tenant: String = row.try_get_by_index(2)?;
        let mirror_event: i64 = row.try_get_by_index(3)?;
        match convert_legacy_copy(
            control,
            registry,
            (source_tenant.as_str(), source_event),
            (mirror_tenant.as_str(), mirror_event),
        )
        .await
        {
            Ok(true) => {
                converted += 1;
                tracing::info!(
                    source_tenant,
                    source_event,
                    mirror_tenant,
                    mirror_event,
                    "synchronized event copy converted to a link"
                );
            }
            Ok(false) => {}
            Err(error) => tracing::warn!(
                source_tenant,
                source_event,
                mirror_tenant,
                mirror_event,
                %error,
                "legacy event copy could not be converted; will retry"
            ),
        }
    }
    Ok(converted)
}

async fn convert_legacy_copy(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    source: (&str, i64),
    mirror: (&str, i64),
) -> Result<bool, AppError> {
    let mirror_context = registry.get_or_load(mirror.0).await?;
    let Some(copy) = event::Entity::find_by_id(mirror.1)
        .one(&mirror_context.db)
        .await?
    else {
        return Ok(false);
    };
    let participations = event_participation::Entity::find()
        .filter(event_participation::Column::EventId.eq(copy.id))
        .all(&mirror_context.db)
        .await?;
    let has_identity =
        copy.source_tenant_id.as_deref() == Some(source.0) && copy.source_event_id == Some(source.1);
    let requests_vod = copy.vod_forum_post_enabled && copy.vod_forum_post_status == "pending";
    let is_link = copy.comp_id.is_none()
        && participations.is_empty()
        && has_identity
        && !copy.ping_alliance
        && !requests_vod;
    if is_link {
        return Ok(false);
    }

    let source_context = registry.get_or_load(source.0).await?;
    let origin = event::Entity::find_by_id(source.1)
        .one(&source_context.db)
        .await?;
    let mut added = 0_i64;
    if let Some(origin) = &origin {
        added = salvage_signups(
            control,
            (&source_context.db, source),
            &mirror_context.db,
            (mirror_context.kind.as_str(), mirror.0),
            &participations,
        )
        .await?;
        if added > 0 {
            let now: chrono::DateTime<chrono::FixedOffset> = Utc::now().into();
            event::Entity::update_many()
                .filter(event::Column::Id.eq(origin.id))
                .col_expr(
                    event::Column::RosterVersion,
                    Expr::col(event::Column::RosterVersion).add(1),
                )
                .col_expr(event::Column::UpdatedAt, Expr::value(now))
                .exec(&source_context.db)
                .await?;
        }
    }

    let txn = mirror_context.db.begin().await?;
    event_roster_assignment::Entity::delete_many()
        .filter(event_roster_assignment::Column::EventId.eq(copy.id))
        .exec(&txn)
        .await?;
    event_participation::Entity::delete_many()
        .filter(event_participation::Column::EventId.eq(copy.id))
        .exec(&txn)
        .await?;
    event_roster_role::Entity::delete_many()
        .filter(event_roster_role::Column::EventId.eq(copy.id))
        .exec(&txn)
        .await?;
    event_party::Entity::delete_many()
        .filter(event_party::Column::EventId.eq(copy.id))
        .exec(&txn)
        .await?;
    let roster_version = origin
        .as_ref()
        .map_or(copy.roster_version + 1, |origin| origin.roster_version);
    let mut active: event::ActiveModel = copy.clone().into();
    active.comp_id = Set(None);
    active.source_tenant_id = Set(Some(source.0.to_owned()));
    active.source_event_id = Set(Some(source.1));
    active.ping_alliance = Set(false);
    if requests_vod {
        active.vod_forum_post_enabled = Set(false);
        active.vod_forum_post_status = Set("not_requested".to_owned());
    }
    active.roster_version = Set(roster_version);
    active.updated_at = Set(Utc::now().into());
    active.update(&txn).await?;
    txn.commit().await?;
    tracing::info!(
        mirror_tenant = mirror.0,
        mirror_event = mirror.1,
        salvaged_signups = added,
        "legacy copy roster removed"
    );
    Ok(true)
}

/// Re-creates, on the origin, the signups only the copy had. Returns how many were added.
async fn salvage_signups(
    control: &DatabaseConnection,
    (origin_db, origin): (&DatabaseConnection, (&str, i64)),
    copy_db: &DatabaseConnection,
    (copy_tenant_kind, copy_tenant_id): (&str, &str),
    participations: &[event_participation::Model],
) -> Result<i64, AppError> {
    let (origin_tenant_id, origin_event_id) = origin;
    if participations.is_empty() {
        return Ok(0);
    }
    let on_origin: HashSet<i64> = event_participation::Entity::find()
        .filter(event_participation::Column::EventId.eq(origin_event_id))
        .all(origin_db)
        .await?
        .into_iter()
        .map(|participation| participation.user_id)
        .collect();
    let mut added = 0;
    for participation in participations {
        let Some(user) = users::Entity::find_by_id(participation.user_id)
            .one(copy_db)
            .await?
        else {
            continue;
        };
        let Some(discord_id) = user.discord_id.clone().filter(|id| !id.trim().is_empty()) else {
            continue;
        };
        let origin_user_id =
            upsert_discord_user(origin_db, &discord_id, &user.username, "", "User", false).await?;
        if on_origin.contains(&origin_user_id) {
            continue;
        }
        event_participation::ActiveModel {
            event_id: Set(origin_event_id),
            user_id: Set(origin_user_id),
            primary_build_id: Set(None),
            secondary_build_id: Set(None),
            created_at: Set(participation.created_at),
            updated_at: Set(Utc::now().into()),
            ..Default::default()
        }
        .insert(origin_db)
        .await?;
        added += 1;
        if copy_tenant_kind == "guild" {
            // The signup came from this guild's server; credit it there, as a live signup would.
            control
                .execute(Statement::from_sql_and_values(
                    control.get_database_backend(),
                    "INSERT INTO event_participant_attributions \
                     (id, source_tenant_id, source_event_id, discord_id, guild_tenant_id) \
                     VALUES ($1, $2, $3, $4, $5) \
                     ON CONFLICT (source_tenant_id, source_event_id, discord_id) DO NOTHING",
                    [
                        uuid::Uuid::new_v4().into(),
                        origin_tenant_id.into(),
                        origin_event_id.into(),
                        discord_id.into(),
                        copy_tenant_id.into(),
                    ],
                ))
                .await?;
        }
    }
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;
    use backend_runtime::sync::test_support::{insert_user, sqlite_db};

    async fn origin_row(db: &DatabaseConnection, creator: i64) -> event::Model {
        event::ActiveModel {
            title: Set("Origin".to_owned()),
            event_kind: Set("flash".to_owned()),
            comp_id: Set(None),
            created_by: Set(creator),
            event_date_utc: Set(Utc::now().into()),
            roster_version: Set(7),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("origin event")
    }

    #[tokio::test]
    async fn a_link_carries_the_display_fields_and_nothing_roster_shaped() {
        let db = sqlite_db().await;
        let creator = insert_user(&db, "creator").await;
        let origin = origin_row(&db, creator).await;

        let link = insert_link_row(&db, creator, "guild-a", &origin, "calendar")
            .await
            .expect("link row");
        assert_eq!(announcement_delivery("forum", true), "forum");
        assert_eq!(announcement_delivery("calendar", false), "calendar");

        assert_eq!(link.title, "Origin");
        assert_eq!(link.comp_id, None);
        assert_eq!(link.roster_version, 7, "the link starts at the origin's revision");
        assert_eq!(link.source_tenant_id.as_deref(), Some("guild-a"));
        assert_eq!(link.source_event_id, Some(origin.id));
        assert_eq!(
            link.discord_delivery, "message",
            "a link is announced publicly even where the server keeps a calendar"
        );
        assert!(!link.ping_alliance && !link.vod_forum_post_enabled);
        assert_eq!(link.vod_forum_post_status, "not_requested");
        let signups = event_participation::Entity::find()
            .filter(event_participation::Column::EventId.eq(link.id))
            .count(&db)
            .await
            .unwrap();
        let parties = event_party::Entity::find()
            .filter(event_party::Column::EventId.eq(link.id))
            .count(&db)
            .await
            .unwrap();
        assert_eq!((signups, parties), (0, 0));
    }

    #[tokio::test]
    async fn the_link_roster_revision_only_moves_forward() {
        let db = sqlite_db().await;
        let creator = insert_user(&db, "creator").await;
        let origin = origin_row(&db, creator).await;
        let link = insert_link_row(&db, creator, "guild-a", &origin, "message")
            .await
            .unwrap();

        set_link_roster_version(&db, link.id, 9).await.unwrap();
        let moved = event::Entity::find_by_id(link.id).one(&db).await.unwrap().unwrap();
        assert_eq!(moved.roster_version, 9);
        assert!(moved.updated_at >= link.updated_at);

        set_link_roster_version(&db, link.id, 8).await.unwrap();
        let kept = event::Entity::find_by_id(link.id).one(&db).await.unwrap().unwrap();
        assert_eq!(kept.roster_version, 9, "an older change never rewinds the link");
    }

    #[tokio::test]
    async fn converging_an_unchanged_link_writes_nothing() {
        let db = sqlite_db().await;
        let creator = insert_user(&db, "creator").await;
        let origin = origin_row(&db, creator).await;
        let link = insert_link_row(&db, creator, "guild-a", &origin, "message")
            .await
            .unwrap();

        let touched = super::super::lifecycle::converge_copy_to_source(&db, &origin, link.id)
            .await
            .unwrap();
        assert!(!touched, "a link that matches its origin is left alone");

        let mut renamed = origin.clone();
        renamed.title = "Renamed".to_owned();
        renamed.roster_version = 8;
        let touched = super::super::lifecycle::converge_copy_to_source(&db, &renamed, link.id)
            .await
            .unwrap();
        assert!(touched);
        let after = event::Entity::find_by_id(link.id).one(&db).await.unwrap().unwrap();
        assert_eq!(after.title, "Renamed");
        assert_eq!(after.roster_version, 8);
    }
}
