//! Retryable Alliance-to-Guild event copies.

use std::{collections::HashMap, time::Duration};

use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, DbBackend, EntityTrait,
    QueryFilter, Set, Statement, TransactionTrait,
};
use tokio::time::interval;

use crate::{
    errors::AppError,
    modules::{
        admin::service::AdminService,
        alliance_share::{ShareActor, copy_alliance_comp_to_tenant},
        events::{
            entities::{event, event_roster_role},
            fanout_outbox::{self, ClaimedTarget},
            models::CreateEventRequest,
            service::EventService,
        },
        users::{entities::Entity as UserEntity, identity::upsert_discord_user},
    },
    tenant::TenantRegistry,
};

const FANOUT_TICK: Duration = Duration::from_secs(15);
const TARGET_LEASE_SECONDS: i64 = 60;
const MAX_TARGETS_PER_TICK: u64 = 12;

/// Start the control-plane fanout retry loop.
pub fn spawn(control: DatabaseConnection, registry: TenantRegistry) {
    tokio::spawn(async move {
        let mut ticker = interval(FANOUT_TICK);
        loop {
            ticker.tick().await;
            if let Err(error) = process_due_targets(&control, &registry).await {
                tracing::error!(error = %error, "event fanout retry cycle failed");
            }
        }
    });
}

/// Process due outbox targets once. Also called after enqueue to reduce normal
/// publish latency; the periodic worker recovers failures and process restarts.
pub async fn process_due_targets(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
) -> Result<usize, AppError> {
    let targets =
        fanout_outbox::claim_due(control, MAX_TARGETS_PER_TICK, TARGET_LEASE_SECONDS).await?;
    let count = targets.len();
    for target in targets {
        match process_target(control, registry, &target).await {
            Ok(Some(destination_event_id)) => {
                fanout_outbox::mark_succeeded(
                    control,
                    target.job_id,
                    &target.tenant_id,
                    target.lease_token,
                    destination_event_id,
                )
                .await?;
            }
            Ok(None) => {
                fanout_outbox::mark_inactive(
                    control,
                    target.job_id,
                    &target.tenant_id,
                    target.lease_token,
                )
                .await?;
            }
            Err(error) => {
                let retry_delay = retry_delay_seconds(target.attempts);
                tracing::warn!(
                    job_id = %target.job_id,
                    source_tenant_id = %target.source_tenant_id,
                    source_event_id = target.source_event_id,
                    target_tenant_id = %target.tenant_id,
                    attempt = target.attempts,
                    error = %error,
                    "event fanout target failed; scheduled for retry"
                );
                fanout_outbox::mark_retryable(
                    control,
                    target.job_id,
                    &target.tenant_id,
                    target.lease_token,
                    &error.to_string(),
                    retry_delay,
                )
                .await?;
            }
        }
    }
    Ok(count)
}

fn retry_delay_seconds(attempt: i32) -> i64 {
    15_i64
        .saturating_mul(1_i64 << attempt.clamp(0, 8))
        .min(3600)
}

async fn process_target(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    target: &ClaimedTarget,
) -> Result<Option<i64>, AppError> {
    if !matches!(target.operation.as_str(), "publish" | "update" | "archive") {
        return Err(AppError::Conflict(format!(
            "event fanout operation '{}' is not supported by this worker",
            target.operation
        )));
    }

    let source_context = registry.get_or_load(&target.source_tenant_id).await?;
    let target_context = registry.get_or_load(&target.tenant_id).await?;
    if source_context.kind != "alliance" || target_context.kind != "guild" {
        return Ok(None);
    }
    if !active_alliance_member(control, &target.source_tenant_id, &target.tenant_id).await? {
        archive_existing_copy(
            &target_context.db,
            &target.source_tenant_id,
            target.source_event_id,
        )
        .await?;
        return Ok(None);
    }

    let source = event::Entity::find_by_id(target.source_event_id)
        .one(&source_context.db)
        .await?
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "alliance source event {} no longer exists",
                target.source_event_id
            ))
        })?;

    let existing_copy = event::Entity::find()
        .filter(event::Column::SourceTenantId.eq(target.source_tenant_id.clone()))
        .filter(event::Column::SourceEventId.eq(target.source_event_id))
        .one(&target_context.db)
        .await?;
    if source.archived_at.is_some() || source.status == "cancelled" {
        if let Some(copy) = &existing_copy {
            // Converge (not just archive) so a cancelled source also cancels
            // the copy and content edits made before cancellation are kept.
            crate::modules::events::lifecycle::converge_copy_to_source(
                &target_context.db,
                &source,
                copy.id,
            )
            .await?;
        }
        return Ok(None);
    }

    let source_comp_id = source.comp_id;
    let (target_comp_id, build_id_map) = if let Some(comp_id) = source_comp_id {
        let previous_comp = existing_copy.as_ref().and_then(|copy| copy.comp_id);
        let previous_builds = load_build_id_map(control, target).await?;
        let creator = event_creator(&source_context.db, source.created_by).await?;
        let (copy_comp_id, mapping) = copy_alliance_comp_to_tenant(
            &source_context.db,
            &target_context.db,
            comp_id,
            &creator,
            previous_comp,
            &previous_builds,
        )
        .await?;
        save_asset_map(control, target, "comp", comp_id, copy_comp_id).await?;
        for (source_build, target_build) in &mapping {
            save_asset_map(control, target, "build", *source_build, *target_build).await?;
        }
        (Some(copy_comp_id), mapping)
    } else {
        (None, HashMap::new())
    };

    let target_event_id = if let Some(copy) = existing_copy {
        // Every operation converges an existing copy to the current source
        // state, which makes update, archive, and publish retries idempotent.
        crate::modules::events::lifecycle::converge_copy_to_source(
            &target_context.db,
            &source,
            copy.id,
        )
        .await?;
        copy.id
    } else {
        let source_creator = event_creator(&source_context.db, source.created_by).await?;
        let creator_id = upsert_discord_user(
            &target_context.db,
            &source_creator.discord_id,
            &source_creator.username,
            source_creator.email.as_deref().unwrap_or(""),
            "User",
            false,
        )
        .await?;
        let local_settings = AdminService::get_guild_settings(&target_context.db).await?;
        let request = CreateEventRequest {
            title: source.title.clone(),
            description: source.description.clone(),
            call_to_arms: source.call_to_arms,
            regear: source.regear,
            event_kind: Some(source.event_kind.clone()),
            comp_id: target_comp_id,
            player_cap: source.player_cap,
            event_date_utc: Some(source.event_date_utc.to_utc().to_rfc3339()),
            mass_time_utc: source.mass_time_utc.map(|time| time.to_utc().to_rfc3339()),
            start_time_utc: source.start_time_utc.map(|time| time.to_utc().to_rfc3339()),
            // Role IDs belong to the source Discord server. The destination
            // poller uses its own server-level announcement configuration.
            discord_role_ids: Vec::new(),
            create_split: false,
            island_tab_id: None,
            ping_alliance: false,
            vod_forum_post_enabled: source.vod_forum_post_enabled,
            discord_delivery: local_settings.discord_event_delivery,
        };
        EventService::new()
            .create_event_with_source_identity(
                &target_context.db,
                creator_id,
                request,
                Some((target.source_tenant_id.clone(), target.source_event_id)),
            )
            .await?
            .id
    };

    sync_roster_roles(
        &source_context.db,
        &target_context.db,
        target.source_event_id,
        target_event_id,
        &build_id_map,
    )
    .await?;
    let linked = link_copy_if_membership_active(
        control,
        &target.source_tenant_id,
        target.source_event_id,
        &target.tenant_id,
        target_event_id,
    )
    .await?;
    if !linked {
        archive_existing_copy(
            &target_context.db,
            &target.source_tenant_id,
            target.source_event_id,
        )
        .await?;
        return Ok(None);
    }
    Ok(Some(target_event_id))
}

async fn event_creator(db: &DatabaseConnection, user_id: i64) -> Result<ShareActor, AppError> {
    let creator = UserEntity::find_by_id(user_id)
        .one(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("event creator {user_id} not found")))?;
    let discord_id = creator
        .discord_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| format!("event-creator-{user_id}"));
    let email = format!("{discord_id}@event-sync.invalid");
    Ok(ShareActor {
        discord_id,
        username: creator.username,
        email: Some(creator.email)
            .filter(|email| !email.trim().is_empty())
            .or(Some(email)),
    })
}

async fn active_alliance_member(
    control: &DatabaseConnection,
    alliance_id: &str,
    guild_id: &str,
) -> Result<bool, AppError> {
    let row = control
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT 1 FROM alliance_memberships \
             WHERE alliance_tenant_id=$1 AND guild_tenant_id=$2 AND status='active'",
            [alliance_id.into(), guild_id.into()],
        ))
        .await?;
    Ok(row.is_some())
}

async fn link_copy_if_membership_active(
    control: &DatabaseConnection,
    alliance_id: &str,
    source_event_id: i64,
    guild_id: &str,
    destination_event_id: i64,
) -> Result<bool, AppError> {
    let txn = control.begin().await?;
    let membership = txn
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT status FROM alliance_memberships \
             WHERE alliance_tenant_id=$1 AND guild_tenant_id=$2 FOR UPDATE",
            [alliance_id.into(), guild_id.into()],
        ))
        .await?;
    let active = membership
        .map(|row| row.try_get_by_index::<String>(0))
        .transpose()?
        .is_some_and(|status| status == "active");
    if !active {
        txn.commit().await?;
        return Ok(false);
    }
    txn.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO event_sync_links \
         (id, source_tenant_id, source_event_id, mirror_tenant_id, mirror_event_id) \
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (mirror_tenant_id, mirror_event_id) DO NOTHING",
        [
            uuid::Uuid::new_v4().into(),
            alliance_id.into(),
            source_event_id.into(),
            guild_id.into(),
            destination_event_id.into(),
        ],
    ))
    .await?;
    let link = txn
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT source_tenant_id, source_event_id FROM event_sync_links \
             WHERE mirror_tenant_id=$1 AND mirror_event_id=$2",
            [guild_id.into(), destination_event_id.into()],
        ))
        .await?
        .ok_or_else(|| AppError::Internal("event link missing after insert".to_owned()))?;
    let linked_source: String = link.try_get_by_index(0)?;
    let linked_event: i64 = link.try_get_by_index(1)?;
    if linked_source != alliance_id || linked_event != source_event_id {
        return Err(AppError::Conflict(
            "destination event is already linked to another source event".to_owned(),
        ));
    }
    txn.commit().await?;
    Ok(true)
}

async fn sync_roster_roles(
    source: &DatabaseConnection,
    target: &DatabaseConnection,
    source_event_id: i64,
    target_event_id: i64,
    build_id_map: &HashMap<i64, i64>,
) -> Result<(), AppError> {
    let source_roles = event_roster_role::Entity::find()
        .filter(event_roster_role::Column::EventId.eq(source_event_id))
        .all(source)
        .await?;
    let mapped_roles = source_roles
        .into_iter()
        .map(|role| {
            build_id_map
                .get(&role.build_id)
                .copied()
                .map(|build_id| build_id)
                .ok_or_else(|| {
                    AppError::Conflict(format!(
                        "source roster build {} has no destination mapping",
                        role.build_id
                    ))
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let txn = target.begin().await?;
    event_roster_role::Entity::delete_many()
        .filter(event_roster_role::Column::EventId.eq(target_event_id))
        .exec(&txn)
        .await?;
    for build_id in mapped_roles {
        event_roster_role::ActiveModel {
            event_id: Set(target_event_id),
            build_id: Set(build_id),
            ..Default::default()
        }
        .insert(&txn)
        .await?;
    }
    txn.commit().await?;
    Ok(())
}

async fn archive_existing_copy(
    target: &DatabaseConnection,
    source_tenant_id: &str,
    source_event_id: i64,
) -> Result<(), AppError> {
    let Some(copy) = event::Entity::find()
        .filter(event::Column::SourceTenantId.eq(source_tenant_id.to_owned()))
        .filter(event::Column::SourceEventId.eq(source_event_id))
        .one(target)
        .await?
    else {
        return Ok(());
    };
    if copy.archived_at.is_some() {
        return Ok(());
    }
    let mut active: event::ActiveModel = copy.into();
    active.archived_at = Set(Some(chrono::Utc::now().into()));
    active.updated_at = Set(chrono::Utc::now().into());
    active.update(target).await?;
    Ok(())
}

async fn load_build_id_map(
    control: &DatabaseConnection,
    target: &ClaimedTarget,
) -> Result<HashMap<i64, i64>, AppError> {
    let rows = control
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT source_id, destination_id FROM event_fanout_assets \
             WHERE job_id=$1 AND tenant_id=$2 AND asset_type='build'",
            [target.job_id.into(), target.tenant_id.clone().into()],
        ))
        .await?;
    rows.into_iter()
        .map(|row| Ok((row.try_get_by_index(0)?, row.try_get_by_index(1)?)))
        .collect::<Result<HashMap<_, _>, sea_orm::DbErr>>()
        .map_err(Into::into)
}

async fn save_asset_map(
    control: &DatabaseConnection,
    target: &ClaimedTarget,
    asset_type: &str,
    source_id: i64,
    destination_id: i64,
) -> Result<(), AppError> {
    control
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO event_fanout_assets (job_id, tenant_id, asset_type, source_id, destination_id) \
             VALUES ($1,$2,$3,$4,$5) ON CONFLICT (job_id, tenant_id, asset_type, source_id) \
             DO UPDATE SET destination_id=EXCLUDED.destination_id",
            [
                target.job_id.into(),
                target.tenant_id.clone().into(),
                asset_type.into(),
                source_id.into(),
                destination_id.into(),
            ],
        ))
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        modules::comps::{
            models::{
                AddCompBuildRequest, CreateBuildCategoryRequest, CreateBuildRequest,
                CreateCompCategoryRequest, CreateCompRequest,
            },
            service::CompService,
            status::BuildRole,
        },
        modules::events::fanout_outbox::Operation,
        modules::events::{
            entities::event_roster_role, models::CreateEventRequest, service::EventService,
        },
        postgres::{
            connect_with_search_path, drop_schema, ensure_schema,
            test_support::{try_admin_db, unique_schema},
        },
    };
    use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait};
    use sea_orm_migration::MigratorTrait;

    struct TestWorld {
        admin: DatabaseConnection,
        control: DatabaseConnection,
        registry: TenantRegistry,
        tenant_dbs: Vec<DatabaseConnection>,
        schemas: Vec<String>,
    }

    impl TestWorld {
        async fn new(guild_delivery: &[&str]) -> Option<Self> {
            let (url, admin) = try_admin_db().await?;
            let control_schema = unique_schema("fanout_ctl");
            ensure_schema(&admin, &control_schema)
                .await
                .expect("create control schema");
            let control = connect_with_search_path(&url, &control_schema)
                .await
                .expect("connect control schema");
            crate::control_migration::Migrator::up(&control, None)
                .await
                .expect("apply control migrations");

            let mut schemas = vec![control_schema];
            let mut tenant_dbs = Vec::new();
            let mut tenants = vec![("alliance", "alliance")];
            for (index, _) in guild_delivery.iter().enumerate() {
                tenants.push((if index == 0 { "guild-a" } else { "guild-b" }, "guild"));
            }
            for (id, kind) in &tenants {
                let schema = unique_schema("fanout_ten");
                ensure_schema(&admin, &schema)
                    .await
                    .expect("create tenant schema");
                let db = connect_with_search_path(&url, &schema)
                    .await
                    .expect("connect tenant schema");
                crate::migration::Migrator::up(&db, None)
                    .await
                    .expect("apply tenant migrations");
                control
                    .execute(Statement::from_sql_and_values(
                        DbBackend::Postgres,
                        "INSERT INTO tenants (id, slug, name, schema_name, status, kind) \
                         VALUES ($1,$1,$1,$2,'active',$3)",
                        [(*id).into(), schema.clone().into(), (*kind).into()],
                    ))
                    .await
                    .expect("insert tenant");
                schemas.push(schema);
                tenant_dbs.push(db);
            }

            let guild_ids = tenants
                .iter()
                .filter(|(_, kind)| *kind == "guild")
                .map(|(id, _)| (*id).to_owned())
                .collect::<Vec<_>>();
            for guild_id in &guild_ids {
                control
                    .execute(Statement::from_sql_and_values(
                        DbBackend::Postgres,
                        "INSERT INTO alliance_memberships \
                         (alliance_tenant_id,guild_tenant_id,status) VALUES ('alliance',$1,'active')",
                        [guild_id.clone().into()],
                    ))
                    .await
                    .expect("insert active membership");
            }
            for (index, delivery) in guild_delivery.iter().enumerate() {
                let guild_db = &tenant_dbs[index + 1];
                guild_db
                    .execute(Statement::from_sql_and_values(
                        DbBackend::Postgres,
                        "UPDATE guild_settings SET discord_event_delivery=$1 WHERE id=1",
                        [(*delivery).into()],
                    ))
                    .await
                    .expect("set local event delivery");
            }
            let registry = TenantRegistry::new(url, control.clone());
            Some(Self {
                admin,
                control,
                registry,
                tenant_dbs,
                schemas,
            })
        }

        async fn close(self) {
            let Self {
                admin,
                control,
                registry,
                tenant_dbs,
                schemas,
            } = self;
            drop(registry);
            for db in tenant_dbs {
                db.close().await.expect("close tenant DB");
            }
            control.close().await.expect("close control DB");
            for schema in schemas {
                drop_schema(&admin, &schema)
                    .await
                    .expect("drop test schema");
            }
        }
    }

    fn flash_event(title: &str) -> CreateEventRequest {
        CreateEventRequest {
            title: title.to_owned(),
            description: None,
            call_to_arms: false,
            regear: false,
            event_kind: Some("flash".to_owned()),
            comp_id: None,
            player_cap: None,
            event_date_utc: Some("2026-07-20T20:00:00Z".to_owned()),
            mass_time_utc: None,
            start_time_utc: None,
            discord_role_ids: Vec::new(),
            create_split: false,
            island_tab_id: None,
            ping_alliance: false,
            vod_forum_post_enabled: false,
            discord_delivery: "message".to_owned(),
        }
    }

    #[tokio::test]
    async fn alliance_event_fans_out_idempotently_with_each_guild_delivery() {
        let Some(world) = TestWorld::new(&["calendar", "forum"]).await else {
            return;
        };
        let alliance_db = &world.tenant_dbs[0];
        let creator_id = upsert_discord_user(
            alliance_db,
            "discord-creator",
            "Alliance creator",
            "creator@example.invalid",
            "User",
            false,
        )
        .await
        .expect("create source event owner");
        let source_event = EventService::new()
            .create_event(alliance_db, creator_id, flash_event("Alliance test event"))
            .await
            .expect("create canonical event");
        let canonical = event::Entity::find_by_id(source_event.id)
            .one(alliance_db)
            .await
            .unwrap()
            .expect("canonical event row");
        assert_eq!(canonical.source_tenant_id, None);
        assert_eq!(canonical.source_event_id, None);
        let targets = vec!["guild-a".to_owned(), "guild-b".to_owned()];
        let job_id = fanout_outbox::enqueue(
            &world.control,
            "alliance",
            source_event.id,
            Operation::Publish,
            &format!("publish:{}", source_event.id),
            &targets,
        )
        .await
        .expect("enqueue publish");

        process_due_targets(&world.control, &world.registry)
            .await
            .expect("process fanout");
        // Reprocessing a completed job must not create any more copies.
        assert_eq!(
            process_due_targets(&world.control, &world.registry)
                .await
                .expect("retry completed fanout"),
            0
        );

        for (index, expected_delivery) in ["calendar", "forum"].into_iter().enumerate() {
            let guild_db = &world.tenant_dbs[index + 1];
            let copies = event::Entity::find()
                .filter(event::Column::SourceTenantId.eq("alliance"))
                .filter(event::Column::SourceEventId.eq(source_event.id))
                .all(guild_db)
                .await
                .expect("read copied event");
            assert_eq!(copies.len(), 1);
            assert_eq!(copies[0].discord_delivery, expected_delivery);
        }
        let links = world
            .control
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT COUNT(*) FROM event_sync_links \
                 WHERE source_tenant_id='alliance' AND source_event_id=$1",
                [source_event.id.into()],
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(links.try_get_by_index::<i64>(0).unwrap(), 2);
        let statuses = fanout_outbox::target_statuses(&world.control, job_id)
            .await
            .unwrap();
        assert!(statuses.iter().all(|status| status.state == "complete"));
        world.close().await;
    }

    #[tokio::test]
    async fn membership_departure_before_claim_prevents_a_live_copy() {
        let Some(world) = TestWorld::new(&["calendar"]).await else {
            return;
        };
        let alliance_db = &world.tenant_dbs[0];
        let creator_id = upsert_discord_user(
            alliance_db,
            "discord-creator-left",
            "Alliance creator",
            "creator-left@example.invalid",
            "User",
            false,
        )
        .await
        .expect("create source event owner");
        let source_event = EventService::new()
            .create_event(
                alliance_db,
                creator_id,
                flash_event("Departing guild event"),
            )
            .await
            .expect("create canonical event");
        let job_id = fanout_outbox::enqueue(
            &world.control,
            "alliance",
            source_event.id,
            Operation::Publish,
            &format!("publish:{}", source_event.id),
            &["guild-a".to_owned()],
        )
        .await
        .expect("enqueue publish");
        world
            .control
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE alliance_memberships SET status='left' \
                 WHERE alliance_tenant_id='alliance' AND guild_tenant_id='guild-a'",
                [],
            ))
            .await
            .expect("mark guild departed");

        process_due_targets(&world.control, &world.registry)
            .await
            .expect("process departed target");
        let statuses = fanout_outbox::target_statuses(&world.control, job_id)
            .await
            .unwrap();
        assert_eq!(statuses[0].state, "inactive");
        let copies = event::Entity::find()
            .filter(event::Column::SourceTenantId.eq("alliance"))
            .filter(event::Column::SourceEventId.eq(source_event.id))
            .count(&world.tenant_dbs[1])
            .await
            .unwrap();
        assert_eq!(copies, 0);
        world.close().await;
    }

    #[tokio::test]
    async fn guild_origin_event_is_not_fanned_out_to_other_guilds() {
        let Some(world) = TestWorld::new(&["calendar", "forum"]).await else {
            return;
        };
        let guild_a = &world.tenant_dbs[1];
        let creator_id = upsert_discord_user(
            guild_a,
            "guild-creator",
            "Guild creator",
            "guild-creator@example.invalid",
            "User",
            false,
        )
        .await
        .expect("create source event owner");
        let source_event = EventService::new()
            .create_event(guild_a, creator_id, flash_event("Guild-only event"))
            .await
            .expect("create guild event");
        let job_id = fanout_outbox::enqueue(
            &world.control,
            "guild-a",
            source_event.id,
            Operation::Publish,
            &format!("publish:{}", source_event.id),
            &["guild-b".to_owned()],
        )
        .await
        .expect("enqueue wrong-direction job");

        process_due_targets(&world.control, &world.registry)
            .await
            .expect("process wrong-direction job");
        let statuses = fanout_outbox::target_statuses(&world.control, job_id)
            .await
            .unwrap();
        assert_eq!(statuses[0].state, "inactive");
        assert_eq!(
            event::Entity::find()
                .filter(event::Column::SourceTenantId.eq("guild-a"))
                .filter(event::Column::SourceEventId.eq(source_event.id))
                .count(&world.tenant_dbs[2])
                .await
                .unwrap(),
            0
        );
        world.close().await;
    }

    #[tokio::test]
    async fn organized_event_copies_comp_builds_and_roster_roles() {
        let Some(world) = TestWorld::new(&["forum"]).await else {
            return;
        };
        let alliance_db = &world.tenant_dbs[0];
        let creator_id = upsert_discord_user(
            alliance_db,
            "organized-creator",
            "Alliance creator",
            "organized-creator@example.invalid",
            "User",
            false,
        )
        .await
        .expect("create source event owner");
        let comps = CompService::new();
        let build_category = comps
            .create_build_category(
                alliance_db,
                CreateBuildCategoryRequest {
                    name: "Fanout builds".to_owned(),
                    description: None,
                },
            )
            .await
            .expect("create build category");
        let comp_category = comps
            .create_comp_category(
                alliance_db,
                CreateCompCategoryRequest {
                    name: "Fanout comps".to_owned(),
                    description: None,
                },
            )
            .await
            .expect("create comp category");
        let build = comps
            .create_build(
                alliance_db,
                creator_id,
                CreateBuildRequest {
                    name: "Fanout healer".to_owned(),
                    description: None,
                    role: BuildRole::Healer,
                    category_id: build_category.id,
                    items: None,
                },
            )
            .await
            .expect("create source build");
        let comp = comps
            .create_comp(
                alliance_db,
                creator_id,
                CreateCompRequest {
                    name: "Fanout comp".to_owned(),
                    description: None,
                    category_id: comp_category.id,
                    builds: vec![AddCompBuildRequest {
                        build_id: build.summary.id,
                        quantity: 1,
                    }],
                    parent_id: None,
                },
            )
            .await
            .expect("create source comp");
        let mut request = flash_event("Organized alliance event");
        request.event_kind = Some("organized".to_owned());
        request.comp_id = Some(comp.summary.id);
        let source_event = EventService::new()
            .create_event(alliance_db, creator_id, request)
            .await
            .expect("create canonical event");
        event_roster_role::ActiveModel {
            event_id: Set(source_event.id),
            build_id: Set(build.summary.id),
            ..Default::default()
        }
        .insert(alliance_db)
        .await
        .expect("add source roster role");
        let job_id = fanout_outbox::enqueue(
            &world.control,
            "alliance",
            source_event.id,
            Operation::Publish,
            &format!("publish:{}", source_event.id),
            &["guild-a".to_owned()],
        )
        .await
        .expect("enqueue publish");
        let claimed = fanout_outbox::claim_due(&world.control, 1, 60)
            .await
            .expect("claim target")
            .pop()
            .expect("one target");
        let first_copy_id = process_target(&world.control, &world.registry, &claimed)
            .await
            .expect("first copy attempt")
            .expect("active target");
        let retry_copy_id = process_target(&world.control, &world.registry, &claimed)
            .await
            .expect("retry after copy creation before acknowledgement")
            .expect("active target");
        assert_eq!(first_copy_id, retry_copy_id);
        fanout_outbox::mark_succeeded(
            &world.control,
            job_id,
            "guild-a",
            claimed.lease_token,
            first_copy_id,
        )
        .await
        .expect("acknowledge fanout target");

        let guild_db = &world.tenant_dbs[1];
        let copy = event::Entity::find()
            .filter(event::Column::SourceTenantId.eq("alliance"))
            .filter(event::Column::SourceEventId.eq(source_event.id))
            .one(guild_db)
            .await
            .unwrap()
            .expect("find guild event copy");
        let copied_comp = copy.comp_id.expect("copy has its own comp");
        let copied_build = crate::modules::comps::entities::build::Entity::find()
            .filter(crate::modules::comps::entities::build::Column::Name.eq("Fanout healer"))
            .one(guild_db)
            .await
            .unwrap()
            .expect("find copied build");
        let roster_roles = event_roster_role::Entity::find()
            .filter(event_roster_role::Column::EventId.eq(copy.id))
            .all(guild_db)
            .await
            .unwrap();
        assert_eq!(roster_roles.len(), 1);
        assert_eq!(roster_roles[0].build_id, copied_build.id);
        let comp_builds = crate::modules::comps::entities::comp_build::Entity::find()
            .filter(crate::modules::comps::entities::comp_build::Column::CompId.eq(copied_comp))
            .all(guild_db)
            .await
            .unwrap();
        assert_eq!(comp_builds.len(), 1);
        assert_eq!(comp_builds[0].build_id, copied_build.id);
        let statuses = fanout_outbox::target_statuses(&world.control, job_id)
            .await
            .unwrap();
        assert_eq!(statuses[0].state, "complete");
        world.close().await;
    }
}
