//! Cross-tenant event mirrors.
//!
//! The control plane owns the relationship because the two event rows live in
//! different tenant schemas. The mirror is deliberately created with
//! `ping_alliance = false`, so creating it cannot recursively create another
//! mirror.

use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, Statement,
};

use crate::{
    errors::AppError,
    modules::{
        alliance_share::{
            AllianceShareService, ShareActor, ShareParams,
            models::{ArtifactType, CreateAllianceShareRequest},
        },
        events::{
            models::{CreateEventRequest, EventView, ParticipateEventRequest},
            service::EventService,
        },
        splits::entities::split,
    },
    tenant::TenantRegistry,
};

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

/// Create the alliance-side event and persist its idempotent cross-tenant link.
///
/// # Errors
///
/// Returns `AppError::Conflict` when `source_event` is itself a copy of another tenant's event
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

    let params = ShareParams {
        source_tenant_id,
        source_kind: "guild",
        actor: source_creator,
        authorized: true,
    };
    let Some(event_comp_id) = source_event.comp_id else {
        return Err(AppError::Conflict(
            "flash masses cannot be shared to the alliance Discord".to_owned(),
        ));
    };
    let comp_share = AllianceShareService::share_comp(
        control,
        registry,
        source_db,
        params,
        CreateAllianceShareRequest {
            artifact_type: ArtifactType::Comp,
            id: event_comp_id,
        },
    )
    .await?;

    let source_roles = crate::modules::events::entities::event_roster_role::Entity::find()
        .filter(
            crate::modules::events::entities::event_roster_role::Column::EventId
                .eq(source_event.id),
        )
        .all(source_db)
        .await?;
    let mut mapped_roles = Vec::with_capacity(source_roles.len());
    for role in source_roles {
        let build_share = AllianceShareService::share_build(
            control,
            registry,
            source_db,
            ShareParams {
                source_tenant_id,
                source_kind: "guild",
                actor: source_creator,
                authorized: true,
            },
            CreateAllianceShareRequest {
                artifact_type: ArtifactType::Build,
                id: role.build_id,
            },
        )
        .await?;
        mapped_roles.push(build_share.published_id);
    }

    let mirror = crate::modules::events::entities::event::Entity::find()
        .filter(
            crate::modules::events::entities::event::Column::SourceTenantId
                .eq(source_tenant_id.to_owned()),
        )
        .filter(crate::modules::events::entities::event::Column::SourceEventId.eq(source_event.id))
        .one(&alliance.db)
        .await?;
    let mirror_id = if let Some(mirror) = mirror {
        mirror.id
    } else {
        let creator_id = upsert_user(&alliance.db, source_creator).await?;
        EventService::new()
            .create_event_with_source_identity(
                &alliance.db,
                creator_id,
                CreateEventRequest {
                    title: source_event.title.clone(),
                    description: source_event.description.clone(),
                    call_to_arms: source_event.call_to_arms,
                    regear: source_event.regear,
                    event_kind: None,
                    comp_id: Some(comp_share.published_id),
                    player_cap: source_event.player_cap,
                    event_date_utc: Some(source_event.start_time_utc.clone()),
                    mass_time_utc: Some(source_event.mass_time_utc.clone()),
                    start_time_utc: Some(source_event.start_time_utc.clone()),
                    discord_role_ids: Vec::new(),
                    create_split: false,
                    island_tab_id: None,
                    origin_guild_id: None,
                    ping_alliance: false,
                    vod_forum_post_enabled: source_event.vod_forum_post_enabled,
                    discord_delivery: source_event.discord_delivery.clone(),
                },
                Some((source_tenant_id.to_owned(), source_event.id)),
            )
            .await?
            .id
    };

    for build_id in mapped_roles {
        use crate::modules::events::entities::event_roster_role as roster_role;
        let existing_role = roster_role::Entity::find()
            .filter(roster_role::Column::EventId.eq(mirror_id))
            .filter(roster_role::Column::BuildId.eq(build_id))
            .one(&alliance.db)
            .await?;
        if existing_role.is_none() {
            roster_role::ActiveModel {
                event_id: sea_orm::ActiveValue::Set(mirror_id),
                build_id: sea_orm::ActiveValue::Set(build_id),
                ..Default::default()
            }
            .insert(&alliance.db)
            .await?;
        }
    }

    let source_split = split::Entity::find()
        .filter(split::Column::EventId.eq(source_event.id))
        .order_by_desc(split::Column::Id)
        .one(source_db)
        .await?;
    if let Some(source_split) = source_split {
        let split_share = AllianceShareService::share_split(
            control,
            registry,
            source_db,
            ShareParams {
                source_tenant_id,
                source_kind: "guild",
                actor: source_creator,
                authorized: true,
            },
            CreateAllianceShareRequest {
                artifact_type: ArtifactType::Split,
                id: source_split.id,
            },
        )
        .await?;
        AllianceShareService::attach_shared_split_to_event(registry, &split_share, mirror_id)
            .await?;
        crate::modules::splits::service::SplitService::new()
            .sync_event_participants(&alliance.db, mirror_id)
            .await?;
    }

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
    crate::modules::users::identity::upsert_discord_user(
        db,
        &actor.discord_id,
        &actor.username,
        &email,
        "User",
        false,
    )
    .await
}

/// Fan out a self-service participation mutation to the linked event.
///
/// The mutation reaches the canonical event, every non-guild copy (such as an
/// alliance mirror of a guild event), and — when a guild attribution is known —
/// only the copy in the attributed guild. Legacy joins recorded before
/// attribution existed keep the previous propagate-to-all-peers behavior.
pub async fn sync_participation(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    tenant_id: &str,
    event_id: i64,
    actor: &ShareActor,
    request: Option<ParticipateEventRequest>,
    attributed_guild: Option<&str>,
) -> Result<(), AppError> {
    let peers = linked_event_peers(control, tenant_id, event_id).await?;
    if peers.is_empty() {
        return Ok(());
    }
    let (origin_tenant, origin_event) =
        canonical_event_origin(control, tenant_id, event_id).await?;
    let attribution = if let Some(guild) = attributed_guild {
        Some(guild.to_owned())
    } else {
        let stored = crate::modules::events::attribution::stored_attribution(
            control,
            &origin_tenant,
            origin_event,
            &actor.discord_id,
        )
        .await?;
        if stored.is_none() && request.is_some() {
            // Joins must always carry a resolved attribution; without one
            // (for example a guild-tenant join of an unlinked-local event)
            // fall back to the caller's tenant.
            Some(tenant_id.to_owned())
        } else {
            stored
        }
    };
    let peers = filter_peers_by_attribution(control, peers, attribution.as_deref()).await?;
    if peers.is_empty() {
        return Ok(());
    }
    let current = registry.get_or_load(tenant_id).await?;
    let service = EventService::new();
    for (peer_tenant, peer_id) in peers {
        let peer = registry.get_or_load(&peer_tenant).await?;
        let peer_user = upsert_user(&peer.db, actor).await?;
        if let Some(request) = &request {
            let mapped = ParticipateEventRequest {
                primary_build_id: map_build(
                    control,
                    tenant_id,
                    &peer_tenant,
                    request.primary_build_id,
                    &origin_tenant,
                    origin_event,
                )
                .await?,
                secondary_build_id: map_build(
                    control,
                    tenant_id,
                    &peer_tenant,
                    request.secondary_build_id,
                    &origin_tenant,
                    origin_event,
                )
                .await?,
            };
            service
                .participate_with_roster_version(&peer.db, peer_id, peer_user, mapped)
                .await?;
        } else {
            service
                .cancel_participation(&peer.db, peer_id, peer_user)
                .await?;
        }
        crate::modules::splits::service::SplitService::new()
            .sync_event_participants(&peer.db, peer_id)
            .await?;
    }
    // Event-linked splits use the event roster as their participant source.
    // Keep every copy current when a signup changes from any tenant.
    crate::modules::splits::service::SplitService::new()
        .sync_event_participants(&current.db, event_id)
        .await?;
    Ok(())
}

pub async fn canonical_event_origin(
    control: &DatabaseConnection,
    tenant_id: &str,
    event_id: i64,
) -> Result<(String, i64), AppError> {
    let row = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT source_tenant_id, source_event_id FROM event_sync_links \
             WHERE sync_enabled AND mirror_tenant_id=$1 AND mirror_event_id=$2",
            [tenant_id.into(), event_id.into()],
        ))
        .await?;
    match row {
        Some(row) => Ok((row.try_get_by_index(0)?, row.try_get_by_index(1)?)),
        None => Ok((tenant_id.to_owned(), event_id)),
    }
}

/// Keeps the canonical event and non-guild copies, plus only the attributed
/// guild's copy among guild copies.
async fn filter_peers_by_attribution(
    control: &DatabaseConnection,
    peers: Vec<(String, i64)>,
    attribution: Option<&str>,
) -> Result<Vec<(String, i64)>, AppError> {
    let Some(guild) = attribution else {
        return Ok(peers);
    };
    let mut kept = Vec::with_capacity(peers.len());
    for (peer_tenant, peer_id) in peers {
        let kind = crate::modules::events::attribution::tenant_kind(control, &peer_tenant).await?;
        if kind != "guild" || peer_tenant == guild {
            kept.push((peer_tenant, peer_id));
        }
    }
    Ok(kept)
}

async fn map_build(
    control: &DatabaseConnection,
    from_tenant: &str,
    to_tenant: &str,
    build_id: Option<i64>,
    origin_tenant: &str,
    origin_event: i64,
) -> Result<Option<i64>, AppError> {
    let Some(build_id) = build_id else {
        return Ok(None);
    };
    if from_tenant == to_tenant {
        return Ok(Some(build_id));
    }
    let event_copy_mapping = if from_tenant == origin_tenant {
        control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT a.destination_id FROM event_fanout_assets a \
                 JOIN event_fanout_jobs j ON j.id=a.job_id \
                 WHERE j.source_tenant_id=$1 AND j.source_event_id=$2 \
                   AND a.tenant_id=$3 AND a.asset_type='build' AND a.source_id=$4 \
                 ORDER BY j.created_at DESC LIMIT 1",
                [
                    origin_tenant.into(),
                    origin_event.into(),
                    to_tenant.into(),
                    build_id.into(),
                ],
            ))
            .await?
            .map(|row| row.try_get_by_index::<i64>(0))
            .transpose()?
    } else {
        control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT a.source_id FROM event_fanout_assets a \
                 JOIN event_fanout_jobs j ON j.id=a.job_id \
                 WHERE j.source_tenant_id=$1 AND j.source_event_id=$2 \
                   AND a.tenant_id=$3 AND a.asset_type='build' AND a.destination_id=$4 \
                 ORDER BY j.created_at DESC LIMIT 1",
                [
                    origin_tenant.into(),
                    origin_event.into(),
                    from_tenant.into(),
                    build_id.into(),
                ],
            ))
            .await?
            .map(|row| row.try_get_by_index::<i64>(0))
            .transpose()?
    };
    if let Some(mapped_id) = event_copy_mapping {
        return Ok(Some(mapped_id));
    }
    let row = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT source_id, published_id, source_tenant_id
             FROM alliance_shares
             WHERE artifact_type = 'build'
               AND ((source_tenant_id = $1 AND alliance_tenant_id = $2 AND source_id = $3)
                 OR (source_tenant_id = $2 AND alliance_tenant_id = $1 AND published_id = $3))",
            [from_tenant.into(), to_tenant.into(), build_id.into()],
        ))
        .await?
        .ok_or_else(|| {
            AppError::Validation(
                "The selected build is not shared with the linked event".to_owned(),
            )
        })?;
    let source_tenant: String = row.try_get_by_index(2)?;
    if source_tenant == from_tenant {
        Ok(Some(row.try_get_by_index(1)?))
    } else {
        Ok(Some(row.try_get_by_index(0)?))
    }
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
                matches!(err, crate::errors::AppError::Conflict(_)),
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
