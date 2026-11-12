//! Retryable Alliance-to-Guild event links.
//!
//! Every active member guild of an alliance gets a link to an alliance event (see
//! [`super::links`]), so the guild's own Discord announces it and its members can sign up and
//! manage it from their server. The worker only creates and converges the link rows; the event
//! itself (comp, roster, split) stays in the alliance tenant.

use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, DbBackend, EntityTrait,
    QueryFilter, QueryOrder, QuerySelect, Set, Statement, TransactionTrait,
};

use crate::alliance_share::ShareActor;
use crate::events::fanout_outbox::{self, ClaimedTarget, FailureDisposition};
use backend_core::errors::AppError;
use backend_entities::events::event;
use backend_entities::users::Entity as UserEntity;
use backend_identity::admin::service::AdminService;
use backend_identity::tenant::TenantRegistry;
use backend_identity::users::identity::upsert_discord_user;

const TARGET_LEASE_SECONDS: i64 = 60;
const MAX_TARGETS_PER_TICK: u64 = 12;

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
                let message = error.to_string();
                let disposition = fanout_outbox::mark_failed(
                    control,
                    &target,
                    &message,
                    retry_delay_seconds(target.attempts),
                )
                .await?;
                match disposition {
                    FailureDisposition::Retry => tracing::warn!(
                        job_id = %target.job_id,
                        source_tenant_id = %target.source_tenant_id,
                        source_event_id = target.source_event_id,
                        target_tenant_id = %target.tenant_id,
                        attempt = target.attempts,
                        max_attempts = fanout_outbox::MAX_ATTEMPTS,
                        error = %message,
                        "event fanout target failed; scheduled for retry"
                    ),
                    FailureDisposition::Exhausted => tracing::error!(
                        job_id = %target.job_id,
                        source_tenant_id = %target.source_tenant_id,
                        source_event_id = target.source_event_id,
                        target_tenant_id = %target.tenant_id,
                        operation = %target.operation,
                        attempt = target.attempts,
                        error = %message,
                        "event fanout target exhausted its attempts; \
                         requeue it from the platform API once the cause is fixed"
                    ),
                }
            }
        }
    }
    Ok(count)
}

/// How far back a scheduled alliance event still counts as upcoming for the catch-up sweep.
const RECONCILE_GRACE_HOURS: i64 = 12;
/// Upper bound of alliance events examined per alliance in one sweep.
const RECONCILE_EVENT_LIMIT: u64 = 200;

/// Catch-up sweep: gives every active member guild a copy of the alliance's upcoming and live
/// events it does not have yet.
///
/// A fanout job snapshots the member guilds at the moment the event is created or edited, so a
/// guild that joins (or rejoins) afterwards, or whose publish was lost, would otherwise see
/// nothing until an unrelated edit happened to enqueue an update. The job key carries the
/// membership's acceptance time, so a guild that leaves and rejoins is served again, and a
/// repeated sweep writes nothing while a job for the same guild and event already exists.
///
/// # Errors
///
/// Returns a database error when the control plane cannot be queried; one unreadable alliance
/// tenant is logged and skipped.
pub async fn reconcile_missing_copies(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
) -> Result<usize, AppError> {
    let members = control
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT alliance_tenant_id, guild_tenant_id, \
                    COALESCE(EXTRACT(EPOCH FROM accepted_at), 0)::bigint \
             FROM alliance_memberships WHERE status = 'active' \
             ORDER BY alliance_tenant_id, guild_tenant_id",
            [],
        ))
        .await?;
    let mut by_alliance: Vec<(String, Vec<(String, i64)>)> = Vec::new();
    for row in members {
        let alliance: String = row.try_get_by_index(0)?;
        let guild: String = row.try_get_by_index(1)?;
        let accepted: i64 = row.try_get_by_index(2)?;
        match by_alliance.last_mut() {
            Some((id, guilds)) if *id == alliance => guilds.push((guild, accepted)),
            _ => by_alliance.push((alliance, vec![(guild, accepted)])),
        }
    }

    let mut enqueued = 0;
    for (alliance_id, guilds) in by_alliance {
        let context = match registry.get_or_load(&alliance_id).await {
            Ok(context) if context.kind == "alliance" => context,
            Ok(_) => continue,
            Err(error) => {
                tracing::warn!(alliance_id, error = %error, "event catch-up skipped an unreadable alliance");
                continue;
            }
        };
        let now = chrono::Utc::now();
        let upcoming = event::Entity::find()
            .filter(event::Column::SourceEventId.is_null())
            .filter(event::Column::ArchivedAt.is_null())
            .filter(
                sea_orm::Condition::any()
                    .add(event::Column::Status.eq("live"))
                    .add(
                        sea_orm::Condition::all()
                            .add(event::Column::Status.eq("scheduled"))
                            .add(
                                event::Column::EventDateUtc
                                    .gte(now - chrono::Duration::hours(RECONCILE_GRACE_HOURS)),
                            ),
                    ),
            )
            .order_by_desc(event::Column::Id)
            .limit(RECONCILE_EVENT_LIMIT)
            .all(&context.db)
            .await?;
        let Some(oldest) = upcoming.iter().map(|event| event.id).min() else {
            continue;
        };
        let linked = control
            .query_all(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT source_event_id, mirror_tenant_id FROM event_sync_links \
                 WHERE source_tenant_id = $1 AND source_event_id >= $2 AND sync_enabled",
                [alliance_id.clone().into(), oldest.into()],
            ))
            .await?
            .into_iter()
            .map(|row| {
                Ok((
                    row.try_get_by_index::<i64>(0)?,
                    row.try_get_by_index::<String>(1)?,
                ))
            })
            .collect::<Result<std::collections::HashSet<_>, sea_orm::DbErr>>()?;

        for event in upcoming {
            for (guild, accepted) in &guilds {
                if linked.contains(&(event.id, guild.clone())) {
                    continue;
                }
                let key = format!("join:{}:{guild}:{accepted}", event.id);
                let known = control
                    .query_one(Statement::from_sql_and_values(
                        DbBackend::Postgres,
                        "SELECT 1 FROM event_fanout_jobs \
                         WHERE source_tenant_id = $1 AND source_event_id = $2 \
                           AND operation = 'publish' AND idempotency_key = $3",
                        [
                            alliance_id.clone().into(),
                            event.id.into(),
                            key.clone().into(),
                        ],
                    ))
                    .await?;
                if known.is_some() {
                    continue;
                }
                fanout_outbox::enqueue(
                    control,
                    &alliance_id,
                    event.id,
                    fanout_outbox::Operation::Publish,
                    &key,
                    std::slice::from_ref(guild),
                )
                .await?;
                enqueued += 1;
            }
        }
    }
    Ok(enqueued)
}

fn retry_delay_seconds(attempt: i32) -> i64 {
    backend_runtime::backoff::retry_delay_seconds(attempt)
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
            crate::events::lifecycle::converge_copy_to_source(&target_context.db, &source, copy.id)
                .await?;
        }
        return Ok(None);
    }

    let existing_copy_id = existing_copy.as_ref().map(|copy| copy.id);
    let target_event_id = if let Some(copy) = existing_copy {
        // Every operation converges an existing link to the current source
        // state, which makes update, archive, and publish retries idempotent.
        crate::events::lifecycle::converge_copy_to_source(&target_context.db, &source, copy.id)
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
        // A link carries no comp, roster or split: requests on it are served by the alliance
        // event itself (see `link_proxy`), so nothing has to be copied or mapped.
        crate::events::links::insert_link_row(
            &target_context.db,
            creator_id,
            &target.source_tenant_id,
            &source,
            &local_settings.discord_event_delivery,
        )
        .await?
        .id
    };
    if existing_copy_id.is_none() && source.status != "scheduled" {
        // A copy created after the source went live or stopped (a late or requeued target) must
        // not start as `scheduled`.
        crate::events::lifecycle::converge_copy_to_source(
            &target_context.db,
            &source,
            target_event_id,
        )
        .await?;
    }

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
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (mirror_tenant_id, mirror_event_id) \
         DO UPDATE SET sync_enabled = true \
         WHERE event_sync_links.source_tenant_id = EXCLUDED.source_tenant_id \
           AND event_sync_links.source_event_id = EXCLUDED.source_event_id",
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::fanout_outbox::Operation;
    use crate::events::{models::CreateEventRequest, service::EventService};
    use backend_comps::{
        models::{
            AddCompBuildRequest, CreateBuildCategoryRequest, CreateBuildRequest,
            CreateCompCategoryRequest, CreateCompRequest,
        },
        service::CompService,
    };
    use backend_core::postgres::{
        connect_with_search_path, drop_schema, ensure_schema,
        test_support::{try_admin_db, unique_schema},
    };
    use backend_entities::events::event_roster_role;
    use backend_entities::status::comps::BuildRole;
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
            backend_migration::control::Migrator::up(&control, None)
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
                backend_migration::Migrator::up(&db, None)
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
            origin_guild_id: None,
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

        // A link is always announced publicly: guild-a's "calendar" becomes "message".
        for (index, expected_delivery) in ["message", "forum"].into_iter().enumerate() {
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
    async fn organized_event_links_copy_no_comp_builds_or_roster_roles() {
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
                    items: crate::events::test_support::main_weapon_items(),
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
        // The link carries nothing comp-shaped: the alliance event serves its roster.
        assert_eq!(copy.comp_id, None);
        assert_eq!(copy.event_kind, "organized");
        assert!(!copy.vod_forum_post_enabled);
        let guild_builds = backend_entities::comps::build::Entity::find()
            .filter(backend_entities::comps::build::Column::Name.eq("Fanout healer"))
            .all(guild_db)
            .await
            .unwrap();
        assert!(guild_builds.is_empty(), "no build is copied into the guild");
        let roster_roles = event_roster_role::Entity::find()
            .filter(event_roster_role::Column::EventId.eq(copy.id))
            .all(guild_db)
            .await
            .unwrap();
        assert!(roster_roles.is_empty(), "no roster role is copied into the guild");
        let statuses = fanout_outbox::target_statuses(&world.control, job_id)
            .await
            .unwrap();
        assert_eq!(statuses[0].state, "complete");

        // A later change is a NEW job with its own idempotency key; it converges the same link.
        EventService::new()
            .start_event(alliance_db, source_event.id)
            .await
            .expect("start the source event");
        let update_job = fanout_outbox::enqueue(
            &world.control,
            "alliance",
            source_event.id,
            Operation::Update,
            "update:after-start",
            &["guild-a".to_owned()],
        )
        .await
        .expect("enqueue update");
        let update_claim = fanout_outbox::claim_due(&world.control, 1, 60)
            .await
            .expect("claim update target")
            .pop()
            .expect("one update target");
        assert_eq!(update_claim.job_id, update_job);
        let updated_copy_id = process_target(&world.control, &world.registry, &update_claim)
            .await
            .expect("update copy")
            .expect("active target");
        assert_eq!(updated_copy_id, first_copy_id);
        let live_copy = event::Entity::find_by_id(first_copy_id)
            .one(guild_db)
            .await
            .unwrap()
            .expect("copy still exists");
        assert_eq!(
            live_copy.status, "live",
            "the copy follows the source start"
        );
        world.close().await;
    }

    #[tokio::test]
    async fn catch_up_gives_a_late_guild_the_upcoming_events_exactly_once() {
        let Some(world) = TestWorld::new(&["forum"]).await else {
            return;
        };
        let alliance_db = &world.tenant_dbs[0];
        let creator_id = upsert_discord_user(
            alliance_db,
            "catchup-creator",
            "Catch-up creator",
            "catchup-creator@example.invalid",
            "User",
            false,
        )
        .await
        .expect("create source event owner");
        // Created while no fanout job exists for the guild: it joined later, or the publish
        // was lost.
        let mut request = flash_event("Created before the guild joined");
        request.event_date_utc =
            Some((chrono::Utc::now() + chrono::Duration::days(2)).to_rfc3339());
        let source_event = EventService::new()
            .create_event(alliance_db, creator_id, request)
            .await
            .expect("create canonical event");

        assert_eq!(
            reconcile_missing_copies(&world.control, &world.registry)
                .await
                .expect("first sweep"),
            1
        );
        assert_eq!(
            process_due_targets(&world.control, &world.registry)
                .await
                .expect("drain"),
            1
        );
        let copy = event::Entity::find()
            .filter(event::Column::SourceTenantId.eq("alliance"))
            .filter(event::Column::SourceEventId.eq(source_event.id))
            .one(&world.tenant_dbs[1])
            .await
            .unwrap()
            .expect("the guild now has a copy");
        assert_eq!(copy.title, "Created before the guild joined");

        // Nothing is missing any more, and nothing is written again.
        assert_eq!(
            reconcile_missing_copies(&world.control, &world.registry)
                .await
                .expect("second sweep"),
            0
        );
        world.close().await;
    }

    #[tokio::test]
    async fn a_copy_created_after_the_source_went_live_is_not_left_scheduled() {
        let Some(world) = TestWorld::new(&["forum"]).await else {
            return;
        };
        let alliance_db = &world.tenant_dbs[0];
        let creator_id = upsert_discord_user(
            alliance_db,
            "late-creator",
            "Late creator",
            "late-creator@example.invalid",
            "User",
            false,
        )
        .await
        .expect("create source event owner");
        let source_event = EventService::new()
            .create_event(alliance_db, creator_id, flash_event("Already live"))
            .await
            .expect("create canonical event");
        EventService::new()
            .start_event(alliance_db, source_event.id)
            .await
            .expect("start the source before any copy exists");
        fanout_outbox::enqueue(
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
        let copy_id = process_target(&world.control, &world.registry, &claimed)
            .await
            .expect("copy attempt")
            .expect("active target");
        let copy = event::Entity::find_by_id(copy_id)
            .one(&world.tenant_dbs[1])
            .await
            .unwrap()
            .expect("copy exists");
        assert_eq!(copy.status, "live");
        assert!(copy.started_at.is_some());
        world.close().await;
    }
}
