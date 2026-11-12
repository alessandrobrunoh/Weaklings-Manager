//! Cross-tenant event links.
//!
//! The control plane owns the relationship because the origin event and its links live in
//! different tenant schemas. A guild event shared with its alliance gets a link row in the
//! alliance tenant (see [`super::links`]); every request on that link is served by the origin
//! (see [`super::link_proxy`]). The link is created with `ping_alliance = false`, so creating it
//! cannot recursively create another link.

use sea_orm::{ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter, Statement};

use crate::alliance_share::ShareActor;
use crate::events::{links, models::EventView};
use backend_core::errors::AppError;
use backend_entities::events::event;
use backend_identity::admin::service::AdminService;
use backend_identity::tenant::TenantRegistry;

/// Ensure an event may create an alliance mirror before the source event is inserted.
pub async fn assert_active_alliance(
    control: &DatabaseConnection,
    guild_tenant_id: &str,
) -> Result<(), AppError> {
    let row = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT 1 FROM alliance_memberships \
             WHERE guild_tenant_id = $1 AND status = 'active'",
            [guild_tenant_id.into()],
        ))
        .await?;
    if row.is_none() {
        return Err(AppError::Conflict(
            "guild is not an active member of an alliance".to_owned(),
        ));
    }
    Ok(())
}

/// Rejects sharing an event that is itself a copy of another tenant's event.
///
/// A mirror is always one hop from its origin. An event that carries a canonical source
/// (`source_tenant_id`/`source_event_id`) is a copy, including a *detached* one whose link was
/// disabled when its guild left an alliance, which the write guard deliberately lets through.
/// Mirroring such a copy would make the copy an origin and add a second hop.
fn ensure_event_is_origin(
    source_tenant_id: Option<&str>,
    source_event_id: Option<i64>,
) -> Result<(), AppError> {
    if source_tenant_id.is_some() || source_event_id.is_some() {
        return Err(AppError::Conflict(
            "this event is a copy of another tenant's event and cannot be shared onward".to_owned(),
        ));
    }
    Ok(())
}

/// Create the alliance-side link of a guild event and persist its idempotent cross-tenant link.
///
/// # Errors
///
/// Returns `AppError::Conflict` when `source_event` is itself a link to another tenant's event
/// (see [`ensure_event_is_origin`]), or when the guild has no active alliance.
pub async fn create_mirror(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    source_db: &DatabaseConnection,
    source_tenant_id: &str,
    source_event: &EventView,
    source_creator: &ShareActor,
) -> Result<Option<i64>, AppError> {
    ensure_event_is_origin(
        source_event.source_tenant_id.as_deref(),
        source_event.source_event_id,
    )?;
    let existing = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT mirror_event_id FROM event_sync_links
             WHERE source_tenant_id = $1 AND source_event_id = $2",
            [source_tenant_id.into(), source_event.id.into()],
        ))
        .await?;
    if let Some(row) = existing {
        return Ok(Some(row.try_get_by_index(0)?));
    }

    let alliance_id = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT alliance_tenant_id FROM alliance_memberships
             WHERE guild_tenant_id = $1 AND status = 'active'",
            [source_tenant_id.into()],
        ))
        .await?
        .map(|row| row.try_get_by_index::<String>(0))
        .transpose()?;
    let Some(alliance_id) = alliance_id else {
        return Err(AppError::Conflict(
            "guild is not an active member of an alliance".to_owned(),
        ));
    };
    let alliance = registry.get_or_load(&alliance_id).await?;
    let source = event::Entity::find_by_id(source_event.id)
        .one(source_db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Event {} not found", source_event.id)))?;

    let mirror = event::Entity::find()
        .filter(event::Column::SourceTenantId.eq(source_tenant_id.to_owned()))
        .filter(event::Column::SourceEventId.eq(source_event.id))
        .one(&alliance.db)
        .await?;
    let mirror_id = if let Some(mirror) = mirror {
        mirror.id
    } else {
        let creator_id = upsert_user(&alliance.db, source_creator).await?;
        let delivery = AdminService::get_guild_settings(&alliance.db)
            .await?
            .discord_event_delivery;
        links::insert_link_row(&alliance.db, creator_id, source_tenant_id, &source, &delivery)
            .await?
            .id
    };

    control
        .execute(Statement::from_sql_and_values(
            control.get_database_backend(),
            "INSERT INTO event_sync_links
                (id, source_tenant_id, source_event_id, mirror_tenant_id, mirror_event_id)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (source_tenant_id, source_event_id, mirror_tenant_id) DO NOTHING",
            [
                uuid::Uuid::new_v4().into(),
                source_tenant_id.into(),
                source_event.id.into(),
                alliance_id.into(),
                mirror_id.into(),
            ],
        ))
        .await?;

    Ok(Some(mirror_id))
}

/// Resolve all linked copies while sync is still enabled.
///
/// Links kept after a guild leaves stay in `event_sync_links` but are not returned.
pub async fn linked_event_peers(
    control: &DatabaseConnection,
    tenant_id: &str,
    event_id: i64,
) -> Result<Vec<(String, i64)>, AppError> {
    let direct_rows = control
        .query_all(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT source_tenant_id, source_event_id, mirror_tenant_id, mirror_event_id
             FROM event_sync_links
             WHERE sync_enabled
               AND ((source_tenant_id = $1 AND source_event_id = $2)
                OR (mirror_tenant_id = $1 AND mirror_event_id = $2))",
            [tenant_id.into(), event_id.into()],
        ))
        .await?;
    let mut links = Vec::with_capacity(direct_rows.len());
    for row in direct_rows {
        links.push(EventSyncLink {
            source_tenant: row.try_get_by_index(0)?,
            source_event: row.try_get_by_index(1)?,
            mirror_tenant: row.try_get_by_index(2)?,
            mirror_event: row.try_get_by_index(3)?,
        });
    }
    let canonical = links
        .iter()
        .find(|link| link.mirror_tenant == tenant_id && link.mirror_event == event_id)
        .map(|link| (link.source_tenant.clone(), link.source_event));
    if let Some((source_tenant, source_event)) = canonical {
        links = control
            .query_all(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT source_tenant_id, source_event_id, mirror_tenant_id, mirror_event_id
                 FROM event_sync_links
                 WHERE sync_enabled
                   AND source_tenant_id = $1
                   AND source_event_id = $2
                 ORDER BY mirror_tenant_id, mirror_event_id",
                [source_tenant.into(), source_event.into()],
            ))
            .await?
            .into_iter()
            .map(|row| {
                Ok(EventSyncLink {
                    source_tenant: row.try_get_by_index(0)?,
                    source_event: row.try_get_by_index(1)?,
                    mirror_tenant: row.try_get_by_index(2)?,
                    mirror_event: row.try_get_by_index(3)?,
                })
            })
            .collect::<Result<Vec<_>, sea_orm::DbErr>>()?;
    }
    Ok(peer_events(tenant_id, event_id, &links))
}

struct EventSyncLink {
    source_tenant: String,
    source_event: i64,
    mirror_tenant: String,
    mirror_event: i64,
}

fn peer_events(tenant_id: &str, event_id: i64, links: &[EventSyncLink]) -> Vec<(String, i64)> {
    let canonical = links
        .iter()
        .find(|link| link.mirror_tenant == tenant_id && link.mirror_event == event_id)
        .map_or((tenant_id, event_id), |link| {
            (link.source_tenant.as_str(), link.source_event)
        });
    let mut peers = Vec::with_capacity(links.len());
    for link in links {
        if (link.source_tenant.as_str(), link.source_event) != canonical {
            continue;
        }
        let mirror = (link.mirror_tenant.as_str(), link.mirror_event);
        if mirror != (tenant_id, event_id) {
            peers.push((link.mirror_tenant.clone(), link.mirror_event));
        }
    }
    if canonical != (tenant_id, event_id) {
        peers.push((canonical.0.to_owned(), canonical.1));
    }
    peers.sort();
    peers.dedup();
    peers
}

async fn upsert_user(db: &DatabaseConnection, actor: &ShareActor) -> Result<i64, AppError> {
    let email = actor
        .email
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("{}@event-sync.invalid", actor.discord_id));
    backend_identity::users::identity::upsert_discord_user(
        db,
        &actor.discord_id,
        &actor.username,
        &email,
        "User",
        false,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{EventSyncLink, ensure_event_is_origin, peer_events};

    #[test]
    fn only_origin_events_can_be_mirrored() {
        assert!(ensure_event_is_origin(None, None).is_ok());
        // A copy, attached or detached, carries its canonical source and is never an origin.
        for (tenant, event) in [
            (Some("alliance-1"), Some(5)),
            (Some("alliance-1"), None),
            (None, Some(5)),
        ] {
            let err = ensure_event_is_origin(tenant, event).expect_err("a copy is not an origin");
            assert!(
                matches!(err, backend_core::errors::AppError::Conflict(_)),
                "{err:?}"
            );
        }
    }

    fn link(
        source_tenant: &str,
        source_event: i64,
        mirror_tenant: &str,
        mirror_event: i64,
    ) -> EventSyncLink {
        EventSyncLink {
            source_tenant: source_tenant.to_owned(),
            source_event,
            mirror_tenant: mirror_tenant.to_owned(),
            mirror_event,
        }
    }

    #[test]
    fn canonical_event_resolves_all_fanout_copies() {
        let links = [
            link("alliance", 7, "guild-b", 21),
            link("alliance", 7, "guild-a", 13),
            link("alliance", 8, "guild-c", 30),
        ];

        assert_eq!(
            peer_events("alliance", 7, &links),
            vec![("guild-a".to_owned(), 13), ("guild-b".to_owned(), 21)]
        );
    }

    #[test]
    fn mirror_resolves_canonical_and_sibling_copies() {
        let links = [
            link("alliance", 7, "guild-b", 21),
            link("alliance", 7, "guild-a", 13),
        ];

        assert_eq!(
            peer_events("guild-a", 13, &links),
            vec![("alliance".to_owned(), 7), ("guild-b".to_owned(), 21)]
        );
    }

    #[test]
    fn unrelated_event_has_no_peers() {
        let links = [link("alliance", 7, "guild-a", 13)];
        assert!(peer_events("guild-a", 14, &links).is_empty());
    }
}
