//! Owner-authorized lifecycle synchronization for linked event copies.
//!
//! Event content and lifecycle state (update, cancel/uncancel, archive) flow
//! from the source event to every active copy. Alliance-owned events use the
//! durable fanout outbox so a failed target stays visible and retryable;
//! guild-origin events with an alliance mirror converge inline, and a failure
//! is returned to the caller so repeating the request retries the copy.
//! No cross-tenant write is atomic: each destination converges independently
//! to the current source state, which makes every retry idempotent.

use sea_orm::{
    ActiveModelTrait, ConnectionTrait, DatabaseConnection, DbBackend, EntityTrait, Set, Statement,
};

use crate::{errors::AppError, tenant::TenantRegistry};

use super::{
    entities::event,
    fanout_outbox,
    sync::{canonical_event_origin, linked_event_peers},
};

/// Rejects management actions on a linked copy of another tenant's event.
///
/// Only the source event owner tenant may edit, cancel, or archive. Copies
/// whose sync link is still enabled reject every management mutation; a link
/// disabled by a membership departure leaves the copy locally managed.
pub async fn assert_manageable_source_event(
    control: &DatabaseConnection,
    tenant_id: &str,
    event_id: i64,
) -> Result<(), AppError> {
    let row = control
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT source_tenant_id FROM event_sync_links \
             WHERE mirror_tenant_id = $1 AND mirror_event_id = $2 AND sync_enabled",
            [tenant_id.into(), event_id.into()],
        ))
        .await?;
    if let Some(row) = row {
        let source: String = row.try_get_by_index(0)?;
        return Err(AppError::Forbidden(format!(
            "this event is a synchronized copy owned by tenant {source}; \
             manage it from the owner tenant instead"
        )));
    }
    Ok(())
}

/// Converges one copy's content and lifecycle state to the current source.
///
/// Content and status follow the source unconditionally. Discord voice channels
/// and battle-linker progress stay tenant-local. A cancelled or archived
/// source archives the copy; an unarchived source restores it.
pub async fn converge_copy_to_source(
    target_db: &DatabaseConnection,
    source: &event::Model,
    copy_id: i64,
) -> Result<(), AppError> {
    let Some(copy) = event::Entity::find_by_id(copy_id).one(target_db).await? else {
        return Ok(());
    };
    let copy_archived = copy.archived_at.is_some();
    let requeue_deleted_vod =
        source.vod_forum_post_enabled && copy.vod_forum_post_status == "deleted";
    let mut active: event::ActiveModel = copy.into();
    active.title = Set(source.title.clone());
    active.description = Set(source.description.clone());
    active.call_to_arms = Set(source.call_to_arms);
    active.regear = Set(source.regear);
    active.player_cap = Set(source.player_cap);
    active.event_date_utc = Set(source.event_date_utc);
    active.mass_time_utc = Set(source.mass_time_utc);
    active.start_time_utc = Set(source.start_time_utc);
    active.vod_forum_post_enabled = Set(source.vod_forum_post_enabled);
    let source_terminal = source.archived_at.is_some() || source.status == "cancelled";
    if source_terminal {
        active.status = Set(source.status.clone());
        if !copy_archived {
            active.archived_at = Set(Some(chrono::Utc::now().into()));
        }
    } else {
        active.status = Set(source.status.clone());
        active.started_at = Set(source.started_at);
        active.stopped_at = Set(source.stopped_at);
        active.auto_stop_deadline = Set(source.auto_stop_deadline);
        if requeue_deleted_vod {
            // A confirmed archive deletion is safe to replace with a new
            // tenant-local VOD post after the source event is restored.
            active.vod_forum_post_status = Set("pending".to_owned());
            active.vod_forum_thread_id = Set(None);
        }
        // Source session state is authoritative, but its Discord voice channel
        // and local battle-link progress remain destination-specific.
        active.archived_at = Set(None);
    }
    active.updated_at = Set(chrono::Utc::now().into());
    active.update(target_db).await?;
    Ok(())
}

/// Propagates an owner-authorized source change to every active copy.
///
/// Alliance sources enqueue a durable fanout job (operation `update` or
/// `archive`) with the current active-membership snapshot and process it once
/// inline; failures remain in the outbox, visible through the fanout status
/// endpoint and retried by the periodic worker. Guild sources converge their
/// alliance mirrors inline; an error is returned so the caller can retry.
pub async fn sync_owner_change_to_copies(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    tenant_id: &str,
    source: &event::Model,
    operation: fanout_outbox::Operation,
) -> Result<(), AppError> {
    // A copy never propagates: its canonical source owns the change.
    let (canonical_tenant, _canonical_event) =
        canonical_event_origin(control, tenant_id, source.id).await?;
    if canonical_tenant != tenant_id {
        return Ok(());
    }
    let peers = linked_event_peers(control, tenant_id, source.id).await?;
    if peers.is_empty() {
        return Ok(());
    }

    let kind = super::attribution::tenant_kind(control, tenant_id).await?;
    if kind == "alliance" {
        let rows = control
            .query_all(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT guild_tenant_id FROM alliance_memberships \
                 WHERE alliance_tenant_id = $1 AND status = 'active' \
                 ORDER BY guild_tenant_id",
                [tenant_id.into()],
            ))
            .await?;
        let targets = rows
            .into_iter()
            .map(|row| row.try_get_by_index::<String>(0))
            .collect::<Result<Vec<_>, _>>()?;
        let job_id = fanout_outbox::enqueue(
            control,
            tenant_id,
            source.id,
            operation,
            &format!(
                "{}:{}",
                operation_key(operation),
                source.updated_at.to_utc().to_rfc3339()
            ),
            &targets,
        )
        .await?;
        if let Err(error) = super::fanout_worker::process_due_targets(control, registry).await {
            // The job row is durable: report it, keep it retryable, do not fail
            // the already-committed source mutation.
            tracing::error!(
                job_id = %job_id,
                source_event_id = source.id,
                error = %error,
                "event lifecycle fanout queued but immediate processing failed"
            );
        }
        return Ok(());
    }

    for (peer_tenant, peer_event_id) in peers {
        let peer = registry.get_or_load(&peer_tenant).await?;
        converge_copy_to_source(&peer.db, source, peer_event_id).await?;
    }
    Ok(())
}

fn operation_key(operation: fanout_outbox::Operation) -> &'static str {
    match operation {
        fanout_outbox::Operation::Publish => "publish",
        fanout_outbox::Operation::Update => "update",
        fanout_outbox::Operation::Archive => "archive",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::alliance_share::ShareActor;
    use crate::modules::events::{
        fanout_outbox::{self, Operation},
        models::{CreateEventRequest, ParticipateEventRequest},
        service::EventService,
        sync::sync_participation,
    };
    use crate::modules::users::identity::upsert_discord_user;
    use crate::postgres::{
        connect_with_search_path, drop_schema, ensure_schema,
        test_support::{try_admin_db, unique_schema},
    };
    use crate::tenant::TenantRegistry;
    use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter};
    use sea_orm_migration::MigratorTrait;

    struct TestWorld {
        admin: DatabaseConnection,
        control: DatabaseConnection,
        registry: TenantRegistry,
        tenant_dbs: Vec<DatabaseConnection>,
        schemas: Vec<String>,
    }

    impl TestWorld {
        /// One alliance tenant and two member guild tenants.
        async fn new() -> Option<Self> {
            let (url, admin) = try_admin_db().await?;
            let control_schema = unique_schema("life_ctl");
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
            for (id, kind) in [
                ("alliance", "alliance"),
                ("guild-a", "guild"),
                ("guild-b", "guild"),
            ] {
                let schema = unique_schema("life_ten");
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
                        [id.into(), schema.clone().into(), kind.into()],
                    ))
                    .await
                    .expect("insert tenant");
                if kind == "guild" {
                    control
                        .execute(Statement::from_sql_and_values(
                            DbBackend::Postgres,
                            "INSERT INTO alliance_memberships \
                             (alliance_tenant_id,guild_tenant_id,status) \
                             VALUES ('alliance',$1,'active')",
                            [id.into()],
                        ))
                        .await
                        .expect("insert membership");
                }
                schemas.push(schema);
                tenant_dbs.push(db);
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

        async fn add_user_membership(&self, discord_id: &str, tenant_id: &str) {
            self.control
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "INSERT INTO user_tenant_memberships (discord_id, tenant_id) VALUES ($1,$2)",
                    [discord_id.into(), tenant_id.into()],
                ))
                .await
                .expect("user membership");
        }

        /// The guild copy of an alliance source event, panicking when absent.
        async fn guild_copy(&self, guild_index: usize, source_event_id: i64) -> event::Model {
            event::Entity::find()
                .filter(event::Column::SourceTenantId.eq("alliance"))
                .filter(event::Column::SourceEventId.eq(source_event_id))
                .one(&self.tenant_dbs[guild_index])
                .await
                .expect("query guild copy")
                .expect("guild copy exists")
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

    fn rename_event(title: &str) -> crate::modules::events::models::UpdateEventRequest {
        crate::modules::events::models::UpdateEventRequest {
            title: Some(title.to_owned()),
            description: None,
            call_to_arms: None,
            regear: None,
            comp_id: None,
            event_date_utc: None,
            mass_time_utc: None,
            start_time_utc: None,
            ping_alliance: None,
            alliance_discord_message_id: None,
        }
    }

    async fn publish_alliance_event(world: &TestWorld, title: &str) -> event::Model {
        let alliance_db = &world.tenant_dbs[0];
        let creator_id = upsert_discord_user(
            alliance_db,
            "discord-creator",
            "Creator",
            "creator@example.invalid",
            "User",
            false,
        )
        .await
        .expect("create owner");
        let created = EventService::new()
            .create_event(alliance_db, creator_id, flash_event(title))
            .await
            .expect("create source event");
        fanout_outbox::enqueue(
            &world.control,
            "alliance",
            created.id,
            Operation::Publish,
            &format!("publish:{}", created.id),
            &["guild-a".to_owned(), "guild-b".to_owned()],
        )
        .await
        .expect("enqueue publish");
        super::super::fanout_worker::process_due_targets(&world.control, &world.registry)
            .await
            .expect("process publish");
        event::Entity::find_by_id(created.id)
            .one(alliance_db)
            .await
            .expect("reload source")
            .expect("source event row")
    }

    #[tokio::test]
    async fn guild_copies_reject_management_and_owner_changes_converge() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Owner-managed event").await;
        let copy_a = world.guild_copy(1, source.id).await;

        // Guild copies reject management; the owner tenant does not.
        assert!(matches!(
            assert_manageable_source_event(&world.control, "guild-a", copy_a.id).await,
            Err(AppError::Forbidden(_))
        ));
        assert_manageable_source_event(&world.control, "alliance", source.id)
            .await
            .expect("owner tenant may manage");

        // An owner update converges every active copy.
        let alliance_db = &world.tenant_dbs[0];
        EventService::new()
            .update_event(alliance_db, source.id, rename_event("Renamed by owner"))
            .await
            .expect("update source");
        let updated = event::Entity::find_by_id(source.id)
            .one(alliance_db)
            .await
            .expect("reload")
            .expect("source row");
        sync_owner_change_to_copies(
            &world.control,
            &world.registry,
            "alliance",
            &updated,
            Operation::Update,
        )
        .await
        .expect("sync owner change");
        for guild_index in [1, 2] {
            let copy = world.guild_copy(guild_index, source.id).await;
            assert_eq!(copy.title, "Renamed by owner");
            assert!(copy.archived_at.is_none());
        }

        // Starting/stopping is owner state; the copy's Discord voice channel
        // remains local, but its visible event status and timestamps converge.
        EventService::new()
            .start_event(alliance_db, source.id)
            .await
            .expect("start source");
        let live = event::Entity::find_by_id(source.id)
            .one(alliance_db)
            .await
            .expect("reload live")
            .expect("source row");
        sync_owner_change_to_copies(
            &world.control,
            &world.registry,
            "alliance",
            &live,
            Operation::Update,
        )
        .await
        .expect("sync live");
        for guild_index in [1, 2] {
            let copy = world.guild_copy(guild_index, source.id).await;
            assert_eq!(copy.status, "live");
            assert_eq!(copy.started_at, live.started_at);
            assert_eq!(copy.discord_voice_channel_id, None);
        }

        // Cancelling the source cancels and archives every copy.
        EventService::new()
            .cancel_event(alliance_db, source.id)
            .await
            .expect("cancel source");
        let cancelled = event::Entity::find_by_id(source.id)
            .one(alliance_db)
            .await
            .expect("reload")
            .expect("source row");
        sync_owner_change_to_copies(
            &world.control,
            &world.registry,
            "alliance",
            &cancelled,
            Operation::Archive,
        )
        .await
        .expect("sync cancel");
        for guild_index in [1, 2] {
            let copy = world.guild_copy(guild_index, source.id).await;
            assert_eq!(copy.status, "cancelled");
            assert!(copy.archived_at.is_some());
        }

        // Uncancel restores the copies.
        EventService::new()
            .uncancel_event(alliance_db, source.id)
            .await
            .expect("uncancel source");
        let restored = event::Entity::find_by_id(source.id)
            .one(alliance_db)
            .await
            .expect("reload")
            .expect("source row");
        sync_owner_change_to_copies(
            &world.control,
            &world.registry,
            "alliance",
            &restored,
            Operation::Update,
        )
        .await
        .expect("sync uncancel");
        for guild_index in [1, 2] {
            let copy = world.guild_copy(guild_index, source.id).await;
            assert_eq!(copy.status, "scheduled");
            assert!(copy.archived_at.is_none());
        }
        world.close().await;
    }

    #[tokio::test]
    async fn restoring_archived_event_requeues_deleted_vod_posts_per_tenant() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Restore VOD posts").await;
        let databases = [
            &world.tenant_dbs[0],
            &world.tenant_dbs[1],
            &world.tenant_dbs[2],
        ];
        for (index, db) in databases.into_iter().enumerate() {
            let mut active: event::ActiveModel = event::Entity::find_by_id(source.id)
                .one(db)
                .await
                .expect("load event")
                .expect("event exists")
                .into();
            active.vod_forum_post_enabled = Set(true);
            active.vod_forum_post_status = Set("created".to_owned());
            active.vod_forum_thread_id = Set(Some(format!("vod-thread-{index}")));
            active.update(db).await.expect("seed created VOD post");
        }

        let alliance_db = &world.tenant_dbs[0];
        EventService::new()
            .archive_event(alliance_db, source.id)
            .await
            .expect("archive source");
        let archived = event::Entity::find_by_id(source.id)
            .one(alliance_db)
            .await
            .expect("reload archived source")
            .expect("source row");
        sync_owner_change_to_copies(
            &world.control,
            &world.registry,
            "alliance",
            &archived,
            Operation::Archive,
        )
        .await
        .expect("archive copies");

        for (index, db) in databases.into_iter().enumerate() {
            assert!(
                EventService::new()
                    .record_vod_forum_post_deleted(db, source.id, &format!("vod-thread-{index}"),)
                    .await
                    .expect("record VOD deletion")
            );
        }

        let restored = EventService::new()
            .unarchive_event(alliance_db, source.id)
            .await
            .expect("restore source");
        assert_eq!(restored.vod_forum_post_status, "pending");
        assert_eq!(restored.vod_forum_thread_id, None);
        let restored_model = event::Entity::find_by_id(source.id)
            .one(alliance_db)
            .await
            .expect("reload restored source")
            .expect("source row");
        sync_owner_change_to_copies(
            &world.control,
            &world.registry,
            "alliance",
            &restored_model,
            Operation::Update,
        )
        .await
        .expect("restore copies");

        for guild_index in [1, 2] {
            let copy = world.guild_copy(guild_index, source.id).await;
            assert_eq!(copy.vod_forum_post_status, "pending");
            assert_eq!(copy.vod_forum_thread_id, None);
            assert!(copy.archived_at.is_none());
        }
        world.close().await;
    }

    #[tokio::test]
    async fn update_job_recovers_after_a_partial_target_failure() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Retry event").await;
        let alliance_db = &world.tenant_dbs[0];
        EventService::new()
            .update_event(alliance_db, source.id, rename_event("Retried title"))
            .await
            .expect("update source");
        let updated = event::Entity::find_by_id(source.id)
            .one(alliance_db)
            .await
            .expect("reload")
            .expect("source row");

        let job_id = fanout_outbox::enqueue(
            &world.control,
            "alliance",
            source.id,
            Operation::Update,
            &format!("update:{}", updated.updated_at.to_utc().to_rfc3339()),
            &["guild-a".to_owned(), "guild-b".to_owned()],
        )
        .await
        .expect("enqueue update");

        // Claim exactly one target and fail it, simulating a partial failure.
        let claimed = fanout_outbox::claim_due(&world.control, 1, 60)
            .await
            .expect("claim one target");
        let failed_target = claimed
            .into_iter()
            .find(|target| target.tenant_id == "guild-a")
            .expect("guild-a claimed first");
        fanout_outbox::mark_retryable(
            &world.control,
            job_id,
            "guild-a",
            failed_target.lease_token,
            "simulated transient failure",
            3600,
        )
        .await
        .expect("mark target failed");

        // The retry worker still converges the healthy target.
        super::super::fanout_worker::process_due_targets(&world.control, &world.registry)
            .await
            .expect("process remaining target");
        assert_eq!(
            world.guild_copy(2, source.id).await.title,
            "Retried title",
            "healthy target converged"
        );
        assert_ne!(
            world.guild_copy(1, source.id).await.title,
            "Retried title",
            "failed target not yet converged"
        );
        let statuses = fanout_outbox::target_statuses(&world.control, job_id)
            .await
            .unwrap();
        let failed = statuses
            .iter()
            .find(|status| status.tenant_id == "guild-a")
            .expect("failed target status");
        assert_eq!(failed.state, "failed");
        assert!(
            failed
                .last_error
                .as_deref()
                .is_some_and(|error| error.contains("simulated transient failure"))
        );

        // Once the retry delay elapses, the failed target converges too.
        world
            .control
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE event_fanout_targets SET next_attempt_at = NOW() \
                 WHERE job_id=$1 AND tenant_id='guild-a'",
                [job_id.into()],
            ))
            .await
            .expect("force retry due");
        super::super::fanout_worker::process_due_targets(&world.control, &world.registry)
            .await
            .expect("retry failed target");
        assert_eq!(
            world.guild_copy(1, source.id).await.title,
            "Retried title",
            "failed target converged after retry"
        );
        let statuses = fanout_outbox::target_statuses(&world.control, job_id)
            .await
            .unwrap();
        assert!(statuses.iter().all(|status| status.state == "complete"));
        world.close().await;
    }

    async fn participation_count(db: &DatabaseConnection, event_id: i64) -> i64 {
        crate::modules::events::entities::event_participation::Entity::find()
            .filter(
                crate::modules::events::entities::event_participation::Column::EventId.eq(event_id),
            )
            .count(db)
            .await
            .expect("count participations") as i64
    }

    fn actor(discord_id: &str) -> ShareActor {
        ShareActor {
            discord_id: discord_id.to_owned(),
            username: "Participant".to_owned(),
            email: None,
        }
    }

    #[tokio::test]
    async fn alliance_join_attributed_to_one_guild_copy_and_leave_from_any_copy() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Attribution event").await;
        let copy_a = world.guild_copy(1, source.id).await;
        let copy_b = world.guild_copy(2, source.id).await;
        let alliance_db = &world.tenant_dbs[0];

        // A caller in two guilds must choose explicitly.
        world.add_user_membership("discord-7", "guild-a").await;
        world.add_user_membership("discord-7", "guild-b").await;
        assert!(matches!(
            super::super::attribution::resolve_join_attribution(
                &world.control,
                "alliance",
                source.id,
                "discord-7",
                None,
            )
            .await,
            Err(AppError::Conflict(_))
        ));
        let attributed = super::super::attribution::resolve_join_attribution(
            &world.control,
            "alliance",
            source.id,
            "discord-7",
            Some("guild-b"),
        )
        .await
        .expect("explicit guild choice resolves");
        assert_eq!(attributed, "guild-b");

        // Join from the alliance copy.
        let user_id = upsert_discord_user(
            alliance_db,
            "discord-7",
            "Participant",
            "discord-7@example.invalid",
            "User",
            false,
        )
        .await
        .expect("alliance user");
        let request = ParticipateEventRequest {
            primary_build_id: None,
            secondary_build_id: None,
        };
        EventService::new()
            .participate_with_roster_version(alliance_db, source.id, user_id, request.clone())
            .await
            .expect("join canonical event");
        sync_participation(
            &world.control,
            &world.registry,
            "alliance",
            source.id,
            &actor("discord-7"),
            Some(request),
            Some(&attributed),
        )
        .await
        .expect("attributed fanout");

        assert_eq!(participation_count(alliance_db, source.id).await, 1);
        assert_eq!(
            participation_count(&world.tenant_dbs[2], copy_b.id).await,
            1,
            "attributed guild copy receives the signup"
        );
        assert_eq!(
            participation_count(&world.tenant_dbs[1], copy_a.id).await,
            0,
            "sibling guild copy must not receive the signup"
        );

        // Leave from the attributed guild copy removes the canonical signup too.
        let guild_b_user = upsert_discord_user(
            &world.tenant_dbs[2],
            "discord-7",
            "Participant",
            "discord-7@example.invalid",
            "User",
            false,
        )
        .await
        .expect("guild-b user");
        EventService::new()
            .cancel_participation(&world.tenant_dbs[2], copy_b.id, guild_b_user)
            .await
            .expect("leave from guild copy");
        sync_participation(
            &world.control,
            &world.registry,
            "guild-b",
            copy_b.id,
            &actor("discord-7"),
            None,
            None,
        )
        .await
        .expect("leave fanout");
        assert_eq!(participation_count(alliance_db, source.id).await, 0);
        assert_eq!(
            participation_count(&world.tenant_dbs[2], copy_b.id).await,
            0
        );
        assert_eq!(
            participation_count(&world.tenant_dbs[1], copy_a.id).await,
            0
        );
        world.close().await;
    }

    #[tokio::test]
    async fn guild_tenant_join_attributes_to_itself_and_skips_sibling_guilds() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Guild-context event").await;
        let copy_a = world.guild_copy(1, source.id).await;
        let copy_b = world.guild_copy(2, source.id).await;

        let attributed = super::super::attribution::resolve_join_attribution(
            &world.control,
            "guild-a",
            copy_a.id,
            "discord-9",
            None,
        )
        .await
        .expect("guild context auto-selects the current tenant");
        assert_eq!(attributed, "guild-a");

        let guild_a_db = &world.tenant_dbs[1];
        let user_id = upsert_discord_user(
            guild_a_db,
            "discord-9",
            "Member",
            "discord-9@example.invalid",
            "User",
            false,
        )
        .await
        .expect("guild-a user");
        let request = ParticipateEventRequest {
            primary_build_id: None,
            secondary_build_id: None,
        };
        EventService::new()
            .participate_with_roster_version(guild_a_db, copy_a.id, user_id, request.clone())
            .await
            .expect("join guild copy");
        sync_participation(
            &world.control,
            &world.registry,
            "guild-a",
            copy_a.id,
            &actor("discord-9"),
            Some(request),
            Some(&attributed),
        )
        .await
        .expect("guild join fanout");

        assert_eq!(participation_count(guild_a_db, copy_a.id).await, 1);
        assert_eq!(
            participation_count(&world.tenant_dbs[0], source.id).await,
            1,
            "the canonical event receives the signup"
        );
        assert_eq!(
            participation_count(&world.tenant_dbs[2], copy_b.id).await,
            0,
            "sibling guild copy must not receive the signup"
        );
        world.close().await;
    }
}
