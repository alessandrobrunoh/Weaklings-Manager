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

/// Create the alliance-side event and persist its idempotent cross-tenant link.
pub async fn create_mirror(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    source_db: &DatabaseConnection,
    source_tenant_id: &str,
    source_event: &EventView,
    source_creator: &ShareActor,
) -> Result<Option<i64>, AppError> {
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
        return Ok(None);
    };
    let alliance = registry.get_or_load(&alliance_id).await?;

    let params = ShareParams {
        source_tenant_id,
        source_kind: "guild",
        actor: source_creator,
        authorized: true,
    };
    let comp_share = AllianceShareService::share_comp(
        control,
        registry,
        source_db,
        params,
        CreateAllianceShareRequest {
            artifact_type: ArtifactType::Comp,
            id: source_event.comp_id,
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

    let creator_id = upsert_user(&alliance.db, source_creator).await?;
    let mirror = EventService::new()
        .create_event(
            &alliance.db,
            creator_id,
            CreateEventRequest {
                title: source_event.title.clone(),
                description: source_event.description.clone(),
                call_to_arms: source_event.call_to_arms,
                regear: source_event.regear,
                comp_id: comp_share.published_id,
                player_cap: source_event.player_cap,
                event_date_utc: Some(source_event.start_time_utc.clone()),
                mass_time_utc: Some(source_event.mass_time_utc.clone()),
                start_time_utc: Some(source_event.start_time_utc.clone()),
                discord_role_ids: Vec::new(),
                create_split: false,
                island_tab_id: None,
                ping_alliance: false,
            },
        )
        .await?;

    for build_id in mapped_roles {
        crate::modules::events::entities::event_roster_role::ActiveModel {
            event_id: sea_orm::ActiveValue::Set(mirror.id),
            build_id: sea_orm::ActiveValue::Set(build_id),
            ..Default::default()
        }
        .insert(&alliance.db)
        .await?;
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
        AllianceShareService::attach_shared_split_to_event(registry, &split_share, mirror.id)
            .await?;
    }

    control
        .execute(Statement::from_sql_and_values(
            control.get_database_backend(),
            "INSERT INTO event_sync_links
                (id, source_tenant_id, source_event_id, mirror_tenant_id, mirror_event_id)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (source_tenant_id, source_event_id) DO NOTHING",
            [
                uuid::Uuid::new_v4().to_string().into(),
                source_tenant_id.into(),
                source_event.id.into(),
                alliance_id.into(),
                mirror.id.into(),
            ],
        ))
        .await?;

    Ok(Some(mirror.id))
}

/// Resolve the event's peer, regardless of which tenant contains the event.
pub async fn peer_event(
    control: &DatabaseConnection,
    tenant_id: &str,
    event_id: i64,
) -> Result<Option<(String, i64)>, AppError> {
    let row = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT source_tenant_id, source_event_id, mirror_tenant_id, mirror_event_id
             FROM event_sync_links
             WHERE (source_tenant_id = $1 AND source_event_id = $2)
                OR (mirror_tenant_id = $1 AND mirror_event_id = $2)",
            [tenant_id.into(), event_id.into()],
        ))
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let source_tenant: String = row.try_get_by_index(0)?;
    let source_event: i64 = row.try_get_by_index(1)?;
    let mirror_tenant: String = row.try_get_by_index(2)?;
    let mirror_event: i64 = row.try_get_by_index(3)?;
    if source_tenant == tenant_id && source_event == event_id {
        Ok(Some((mirror_tenant, mirror_event)))
    } else {
        Ok(Some((source_tenant, source_event)))
    }
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
pub async fn sync_participation(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    tenant_id: &str,
    event_id: i64,
    actor: &ShareActor,
    request: Option<ParticipateEventRequest>,
) -> Result<(), AppError> {
    let Some((peer_tenant, peer_id)) = peer_event(control, tenant_id, event_id).await? else {
        return Ok(());
    };
    let peer = registry.get_or_load(&peer_tenant).await?;
    let peer_user = upsert_user(&peer.db, actor).await?;
    let service = EventService::new();
    if let Some(request) = request {
        let mapped = ParticipateEventRequest {
            primary_build_id: map_build(control, tenant_id, &peer_tenant, request.primary_build_id)
                .await?,
            secondary_build_id: map_build(
                control,
                tenant_id,
                &peer_tenant,
                request.secondary_build_id,
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
    Ok(())
}

async fn map_build(
    control: &DatabaseConnection,
    from_tenant: &str,
    to_tenant: &str,
    build_id: Option<i64>,
) -> Result<Option<i64>, AppError> {
    let Some(build_id) = build_id else {
        return Ok(None);
    };
    if from_tenant == to_tenant {
        return Ok(Some(build_id));
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
