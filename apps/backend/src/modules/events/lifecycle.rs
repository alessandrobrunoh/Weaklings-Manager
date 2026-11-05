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

    #[tokio::test]
    async fn alliance_split_preflights_every_guild_and_retries_after_manual_roster_removal() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Split distribution event").await;
        let alliance_db = &world.tenant_dbs[0];
        let alice = upsert_discord_user(
            alliance_db,
            "distribution-alice",
            "Alice",
            "alice@example.invalid",
            "User",
            false,
        )
        .await
        .expect("alliance Alice");
        let bob = upsert_discord_user(
            alliance_db,
            "distribution-bob",
            "Bob",
            "bob@example.invalid",
            "User",
            false,
        )
        .await
        .expect("alliance Bob");
        for (discord_id, guild_id) in [
            ("distribution-alice", "guild-a"),
            ("distribution-bob", "guild-b"),
        ] {
            world.add_user_membership(discord_id, guild_id).await;
            world
                .control
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "INSERT INTO event_participant_attributions \
                     (id,source_tenant_id,source_event_id,discord_id,guild_tenant_id) \
                     VALUES ($1,'alliance',$2,$3,$4)",
                    [
                        uuid::Uuid::new_v4().into(),
                        source.id.into(),
                        discord_id.into(),
                        guild_id.into(),
                    ],
                ))
                .await
                .expect("event attribution");
        }
        let alice_guild_id = upsert_discord_user(
            &world.tenant_dbs[1],
            "distribution-alice",
            "Alice",
            "alice@example.invalid",
            "User",
            false,
        )
        .await
        .expect("guild Alice");
        upsert_discord_user(
            &world.tenant_dbs[2],
            "distribution-bob",
            "Bob",
            "bob@example.invalid",
            "User",
            false,
        )
        .await
        .expect("guild Bob");

        alliance_db
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE events SET status='stopped' WHERE id=$1",
                [source.id.into()],
            ))
            .await
            .expect("stop event");
        let split_row = alliance_db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO splits \
                 (created_by,status,estimated_market_value,fee,repair_value,bags_value,event_id,updated_at) \
                 VALUES ($1,'pending',100,0,0,0,$2,NOW()) RETURNING id",
                [source.created_by.into(), source.id.into()],
            ))
            .await
            .expect("insert split")
            .expect("split row");
        let split_id: i64 = split_row.try_get_by_index(0).expect("split id");
        for user_id in [alice, bob] {
            alliance_db
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "INSERT INTO split_participants (split_id,user_id,weight) VALUES ($1,$2,100)",
                    [split_id.into(), user_id.into()],
                ))
                .await
                .expect("split participant");
        }

        world
            .control
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE alliance_memberships SET status='left' \
                 WHERE alliance_tenant_id='alliance' AND guild_tenant_id='guild-b'",
                [],
            ))
            .await
            .expect("depart guild-b");
        let blocked = crate::modules::splits::alliance_distribution::complete(
            &world.control,
            &world.registry,
            "alliance",
            alliance_db,
            split_id,
            source.created_by,
        )
        .await;
        assert!(matches!(blocked, Err(AppError::Conflict(_))));
        assert_eq!(
            crate::modules::bank::entities::Entity::find()
                .count(&world.tenant_dbs[1])
                .await
                .expect("count guild-a transactions"),
            0,
            "preflight failure must not write a transaction to another guild"
        );
        let batch_count: i64 = world
            .control
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT COUNT(*) FROM alliance_split_distribution_batches WHERE split_id=$1",
                [split_id.into()],
            ))
            .await
            .expect("count distribution batches")
            .expect("count row")
            .try_get_by_index(0)
            .expect("batch count");
        assert_eq!(batch_count, 0, "invalid preflight creates no batch");

        // The agreed recovery is manual: remove the participants from the
        // departed guild, then retry the same completion request.
        alliance_db
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "DELETE FROM split_participants WHERE split_id=$1 AND user_id=$2",
                [split_id.into(), bob.into()],
            ))
            .await
            .expect("remove departed guild participant");

        // Simulate a transient failure after the first tenant transaction has
        // committed. Retrying the same roster must resume without paying Alice
        // twice.
        let charlie = upsert_discord_user(
            alliance_db,
            "distribution-charlie",
            "Charlie",
            "charlie@example.invalid",
            "User",
            false,
        )
        .await
        .expect("alliance Charlie");
        world
            .add_user_membership("distribution-charlie", "guild-a")
            .await;
        world
            .control
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO event_participant_attributions \
                 (id,source_tenant_id,source_event_id,discord_id,guild_tenant_id) \
                 VALUES ($1,'alliance',$2,'distribution-charlie','guild-a')",
                [uuid::Uuid::new_v4().into(), source.id.into()],
            ))
            .await
            .expect("Charlie event attribution");
        let charlie_guild_id = upsert_discord_user(
            &world.tenant_dbs[1],
            "distribution-charlie",
            "Charlie",
            "charlie@example.invalid",
            "User",
            false,
        )
        .await
        .expect("guild-a Charlie");
        alliance_db
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO split_participants (split_id,user_id,weight) VALUES ($1,$2,100)",
                [split_id.into(), charlie.into()],
            ))
            .await
            .expect("Charlie split participant");
        world.tenant_dbs[1]
            .execute_unprepared(&format!(
                "CREATE FUNCTION fail_one_projection() RETURNS trigger LANGUAGE plpgsql AS $$ \
                 BEGIN IF NEW.to_user_id = {charlie_guild_id} AND NEW.alliance_distribution_key IS NOT NULL \
                 THEN RAISE EXCEPTION 'simulated transient projection failure'; END IF; RETURN NEW; END $$; \
                 CREATE TRIGGER fail_charlie_projection BEFORE INSERT ON transactions \
                 FOR EACH ROW EXECUTE FUNCTION fail_one_projection();"
            ))
            .await
            .expect("install simulated tenant failure");
        let partial = crate::modules::splits::alliance_distribution::complete(
            &world.control,
            &world.registry,
            "alliance",
            alliance_db,
            split_id,
            source.created_by,
        )
        .await;
        assert!(
            partial.is_err(),
            "transient destination failure is surfaced"
        );
        let failed_status = crate::modules::splits::alliance_distribution::status(
            &world.control,
            "alliance",
            split_id,
        )
        .await
        .expect("load failed batch status")
        .expect("failed batch exists");
        assert_eq!(failed_status.state, "failed");
        assert_eq!(
            failed_status
                .recipients
                .iter()
                .filter(|recipient| recipient.state == "complete")
                .count(),
            1,
            "status records the durable partial result"
        );
        assert!(
            failed_status
                .recipients
                .iter()
                .filter(|recipient| recipient.state == "pending")
                .all(|recipient| recipient.last_error.is_some()),
            "status retains the error on incomplete recipients"
        );
        assert_eq!(
            crate::modules::bank::entities::Entity::find()
                .count(&world.tenant_dbs[1])
                .await
                .expect("count partial destination rows"),
            1,
            "Alice's earlier idempotent credit is durable"
        );
        world.tenant_dbs[1]
            .execute_unprepared(
                "DROP TRIGGER fail_charlie_projection ON transactions; \
                 DROP FUNCTION fail_one_projection();",
            )
            .await
            .expect("remove simulated failure");
        let detail = crate::modules::splits::alliance_distribution::complete(
            &world.control,
            &world.registry,
            "alliance",
            alliance_db,
            split_id,
            source.created_by,
        )
        .await
        .expect("retry after roster cleanup");
        let complete_status = crate::modules::splits::alliance_distribution::status(
            &world.control,
            "alliance",
            split_id,
        )
        .await
        .expect("load complete batch status")
        .expect("completed batch exists");
        assert_eq!(complete_status.state, "complete");
        assert!(
            complete_status
                .recipients
                .iter()
                .all(|recipient| recipient.state == "complete")
        );
        assert_eq!(
            detail.summary.net_value,
            Some(sea_orm::prelude::Decimal::from(100))
        );
        let transactions = crate::modules::bank::entities::Entity::find()
            .all(&world.tenant_dbs[1])
            .await
            .expect("guild-a projected transactions");
        assert_eq!(transactions.len(), 2);
        let by_user = transactions
            .iter()
            .map(|transaction| (transaction.to_user_id, transaction))
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            by_user[&alice_guild_id].amount,
            sea_orm::prelude::Decimal::from(50)
        );
        assert_eq!(
            by_user[&charlie_guild_id].amount,
            sea_orm::prelude::Decimal::from(50)
        );
        assert!(transactions.iter().all(|transaction| {
            transaction.source_alliance_tenant_id.as_deref() == Some("alliance")
                && transaction.source_alliance_split_id == Some(split_id)
        }));
        assert!(
            crate::modules::bank::entities::Entity::find()
                .all(&world.tenant_dbs[2])
                .await
                .expect("guild-b transactions")
                .is_empty()
        );

        crate::modules::splits::alliance_distribution::complete(
            &world.control,
            &world.registry,
            "alliance",
            alliance_db,
            split_id,
            source.created_by,
        )
        .await
        .expect("idempotent repeat");
        assert_eq!(
            crate::modules::bank::entities::Entity::find()
                .count(&world.tenant_dbs[1])
                .await
                .expect("count after repeated completion"),
            2,
            "retries must not duplicate transaction credits"
        );
        world.close().await;
    }

    #[tokio::test]
    async fn concurrent_alliance_split_confirmations_credit_each_guild_once() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Concurrent split event").await;
        let alliance_db = &world.tenant_dbs[0];
        let mut participants = Vec::new();
        for (discord_id, name, guild_id, guild_index) in [
            ("concurrent-alice", "Alice", "guild-a", 1usize),
            ("concurrent-bob", "Bob", "guild-b", 2usize),
        ] {
            let email = format!("{discord_id}@example.invalid");
            let user_id = upsert_discord_user(alliance_db, discord_id, name, &email, "User", false)
                .await
                .expect("alliance user");
            upsert_discord_user(
                &world.tenant_dbs[guild_index],
                discord_id,
                name,
                &email,
                "User",
                false,
            )
            .await
            .expect("guild user");
            world.add_user_membership(discord_id, guild_id).await;
            world
                .control
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "INSERT INTO event_participant_attributions \
                     (id,source_tenant_id,source_event_id,discord_id,guild_tenant_id) \
                     VALUES ($1,'alliance',$2,$3,$4)",
                    [
                        uuid::Uuid::new_v4().into(),
                        source.id.into(),
                        discord_id.into(),
                        guild_id.into(),
                    ],
                ))
                .await
                .expect("event attribution");
            participants.push(user_id);
        }
        alliance_db
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE events SET status='stopped' WHERE id=$1",
                [source.id.into()],
            ))
            .await
            .expect("stop event");
        let split_id: i64 = alliance_db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO splits \
                 (created_by,status,estimated_market_value,fee,repair_value,bags_value,event_id,updated_at) \
                 VALUES ($1,'pending',100,0,0,0,$2,NOW()) RETURNING id",
                [source.created_by.into(), source.id.into()],
            ))
            .await
            .expect("insert split")
            .expect("split row")
            .try_get_by_index(0)
            .expect("split id");
        for user_id in &participants {
            alliance_db
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "INSERT INTO split_participants (split_id,user_id,weight) VALUES ($1,$2,100)",
                    [split_id.into(), (*user_id).into()],
                ))
                .await
                .expect("split participant");
        }

        let confirm = || {
            crate::modules::splits::alliance_distribution::complete(
                &world.control,
                &world.registry,
                "alliance",
                alliance_db,
                split_id,
                source.created_by,
            )
        };
        let (first, second, third) = tokio::join!(confirm(), confirm(), confirm());
        assert!(
            first.is_ok() && second.is_ok() && third.is_ok(),
            "concurrent confirmations must converge: {:?} {:?} {:?}",
            first.as_ref().err(),
            second.as_ref().err(),
            third.as_ref().err()
        );
        for guild_index in [1usize, 2usize] {
            let transactions = crate::modules::bank::entities::Entity::find()
                .all(&world.tenant_dbs[guild_index])
                .await
                .expect("guild transactions");
            assert_eq!(
                transactions.len(),
                1,
                "guild {guild_index} is credited exactly once"
            );
            assert_eq!(transactions[0].amount, sea_orm::prelude::Decimal::from(50));
        }
        let status = crate::modules::splits::alliance_distribution::status(
            &world.control,
            "alliance",
            split_id,
        )
        .await
        .expect("status")
        .expect("batch exists");
        assert_eq!(status.state, "complete");
        world.close().await;
    }

    #[tokio::test]
    async fn failed_guild_mirror_is_retried_without_duplicating_the_alliance_event() {
        use crate::modules::alliance_share::{
            AllianceShareService, ShareParams,
            models::{ArtifactType, CreateAllianceShareRequest},
        };
        use crate::modules::comps::{
            models::{
                AddCompBuildRequest, CreateBuildCategoryRequest, CreateBuildRequest,
                CreateCompCategoryRequest, CreateCompRequest,
            },
            service::CompService,
            status::BuildRole,
        };
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let guild_db = &world.tenant_dbs[1];
        let creator_id = upsert_discord_user(
            guild_db,
            "mirror-creator",
            "Mirror creator",
            "mirror-creator@example.invalid",
            "User",
            false,
        )
        .await
        .expect("guild creator");
        let comps = CompService::new();
        let build_category = comps
            .create_build_category(
                guild_db,
                CreateBuildCategoryRequest {
                    name: "Mirror builds".to_owned(),
                    description: None,
                },
            )
            .await
            .expect("build category");
        let comp_category = comps
            .create_comp_category(
                guild_db,
                CreateCompCategoryRequest {
                    name: "Mirror comps".to_owned(),
                    description: None,
                },
            )
            .await
            .expect("comp category");
        let build = comps
            .create_build(
                guild_db,
                creator_id,
                CreateBuildRequest {
                    name: "Mirror healer".to_owned(),
                    description: None,
                    role: BuildRole::Healer,
                    category_id: build_category.id,
                    items: None,
                },
            )
            .await
            .expect("build");
        let comp = comps
            .create_comp(
                guild_db,
                creator_id,
                CreateCompRequest {
                    name: "Mirror comp".to_owned(),
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
            .expect("comp");
        let mut request = flash_event("Guild event for the alliance");
        request.event_kind = Some("organized".to_owned());
        request.comp_id = Some(comp.summary.id);
        let event = EventService::new()
            .create_event(guild_db, creator_id, request)
            .await
            .expect("guild event");
        let view = EventService::new()
            .get_event_detail(guild_db, event.id)
            .await
            .expect("event view")
            .event;
        let actor = ShareActor {
            discord_id: "mirror-creator".to_owned(),
            username: "Mirror creator".to_owned(),
            email: None,
        };

        // First attempt fails because the guild's membership is not active.
        world
            .control
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE alliance_memberships SET status='left' WHERE guild_tenant_id='guild-a'",
                [],
            ))
            .await
            .expect("suspend membership");
        let error = super::super::sync::create_mirror(
            &world.control,
            &world.registry,
            guild_db,
            "guild-a",
            &view,
            &actor,
        )
        .await
        .expect_err("inactive membership blocks the mirror");
        super::super::mirror_retry::enqueue(
            &world.control,
            "guild-a",
            event.id,
            &actor,
            &error.to_string(),
        )
        .await
        .expect("queue retry");

        let force_due = || {
            world.control.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE event_mirror_requests SET next_attempt_at=NOW()",
                [],
            ))
        };
        force_due().await.expect("make due");
        assert_eq!(
            super::super::mirror_retry::process_due(&world.control, &world.registry)
                .await
                .expect("first retry cycle"),
            1
        );
        let failed =
            super::super::mirror_retry::status_for_event(&world.control, "guild-a", event.id)
                .await
                .expect("status")
                .expect("request exists");
        assert_eq!(failed.state, "failed");
        assert_eq!(failed.attempts, 1);
        assert!(failed.last_error.is_some());
        assert_eq!(failed.mirror_event_id, None);

        // Membership returns; the next retry creates exactly one mirror.
        world
            .control
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE alliance_memberships SET status='active' WHERE guild_tenant_id='guild-a'",
                [],
            ))
            .await
            .expect("restore membership");

        // Simulate a crash after the alliance event commits but before its
        // control-plane link or retry acknowledgement is written.
        let shared_comp = AllianceShareService::share_comp(
            &world.control,
            &world.registry,
            guild_db,
            ShareParams {
                source_tenant_id: "guild-a",
                source_kind: "guild",
                actor: &actor,
                authorized: true,
            },
            CreateAllianceShareRequest {
                artifact_type: ArtifactType::Comp,
                id: comp.summary.id,
            },
        )
        .await
        .expect("share comp before simulated crash");
        let alliance_creator_id = upsert_discord_user(
            &world.tenant_dbs[0],
            "mirror-creator",
            "Mirror creator",
            "mirror-creator@example.invalid",
            "User",
            false,
        )
        .await
        .expect("alliance creator");
        let mut orphan_request = flash_event("Guild event for the alliance");
        orphan_request.event_kind = Some(view.event_kind.clone());
        orphan_request.comp_id = Some(shared_comp.published_id);
        orphan_request.player_cap = view.player_cap;
        orphan_request.event_date_utc = Some(view.event_date_utc.clone());
        orphan_request.mass_time_utc = Some(view.mass_time_utc.clone());
        orphan_request.start_time_utc = Some(view.start_time_utc.clone());
        orphan_request.vod_forum_post_enabled = view.vod_forum_post_enabled;
        orphan_request.discord_delivery = view.discord_delivery.clone();
        let orphan_mirror = EventService::new()
            .create_event_with_source_identity(
                &world.tenant_dbs[0],
                alliance_creator_id,
                orphan_request,
                Some(("guild-a".to_owned(), event.id)),
            )
            .await
            .expect("create mirror before simulated crash");
        let orphan_mirror_id = orphan_mirror.id;

        force_due().await.expect("make due again");
        super::super::mirror_retry::process_due(&world.control, &world.registry)
            .await
            .expect("second retry cycle");
        let done =
            super::super::mirror_retry::status_for_event(&world.control, "guild-a", event.id)
                .await
                .expect("status")
                .expect("request exists");
        assert_eq!(done.state, "complete", "{:?}", done.last_error);
        assert_eq!(done.mirror_event_id, Some(orphan_mirror_id));
        assert_eq!(
            event::Entity::find()
                .count(&world.tenant_dbs[0])
                .await
                .expect("alliance events"),
            1,
            "exactly one alliance mirror exists"
        );

        // A completed request is never claimed again, so no duplicate appears.
        force_due().await.expect("make due after completion");
        assert_eq!(
            super::super::mirror_retry::process_due(&world.control, &world.registry)
                .await
                .expect("idle cycle"),
            0
        );
        assert_eq!(
            event::Entity::find()
                .count(&world.tenant_dbs[0])
                .await
                .expect("alliance events"),
            1
        );
        world.close().await;
    }
}
