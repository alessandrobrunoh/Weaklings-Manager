//! Platform alliance departure, checked through event sync.
//!
//! Leaving an alliance (and rejoining it) must keep the old event sync links disabled, so
//! these tests drive `PlatformService` and then run the events participation sync. They
//! live with events because platform sits below events in the crate graph.

use sea_orm::{ConnectionTrait, Statement};
use sea_orm_migration::MigratorTrait;

use crate::control_migration::Migrator;
use crate::errors::AppError;
use crate::modules::alliance_share::ShareActor;
use crate::modules::events::sync::sync_participation;
use crate::modules::platform::models::RegisterTenantRequest;
use crate::modules::platform::service::{PlatformService, UntrackedAllianceRole};
use crate::postgres::{
    connect_with_search_path, drop_schema, ensure_schema,
    test_support::{try_admin_db, unique_schema},
};
use crate::tenant::TenantRegistry;

fn guild_register(id: &str, name: &str) -> RegisterTenantRequest {
    RegisterTenantRequest {
        id: id.to_owned(),
        name: name.to_owned(),
        kind: Some("guild".into()),
        albion_guild_id: "alb-1".into(),
        albion_api_region: "europe".into(),
        albion_allied_guild_ids: None,
        albion_allied_guild_names: None,
        member_guild_ids: vec![],
        albion_alliance_id: None,
    }
}

fn alliance_register(id: &str, members: Vec<String>) -> RegisterTenantRequest {
    RegisterTenantRequest {
        id: id.to_owned(),
        name: "Alliance Hub".into(),
        kind: Some("alliance".into()),
        albion_guild_id: String::new(),
        albion_api_region: "europe".into(),
        albion_allied_guild_ids: None,
        albion_allied_guild_names: None,
        member_guild_ids: members,
        albion_alliance_id: Some("alb-alliance".into()),
    }
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn leave_keeps_history_stops_sync_and_retries_discord() {
    let Some((url, admin)) = try_admin_db().await else {
        return;
    };
    let schema = unique_schema("it_leave");
    ensure_schema(&admin, &schema).await.expect("schema");
    let control = connect_with_search_path(&url, &schema)
        .await
        .expect("connect");
    Migrator::up(&control, None).await.expect("migrate");
    let registry = TenantRegistry::new(url, control.clone());

    let guild_id = unique_schema("gid");
    let alliance_id = unique_schema("aid");
    let guild = PlatformService::register_tenant(
        &control,
        &registry,
        guild_register(&guild_id, "Leaving Guild"),
        "guild-owner",
        None,
    )
    .await
    .expect("guild");
    let alliance = PlatformService::register_tenant(
        &control,
        &registry,
        alliance_register(&alliance_id, vec![guild_id.clone()]),
        "alliance-officer",
        None,
    )
    .await
    .expect("alliance");
    PlatformService::accept_alliance_membership(&control, &alliance_id, &guild_id, "guild-owner")
        .await
        .expect("accept");

    let pending_guild_id = unique_schema("pgid");
    let pending_alliance_id = unique_schema("paid");
    let pending_guild = PlatformService::register_tenant(
        &control,
        &registry,
        guild_register(&pending_guild_id, "Invited Guild"),
        "guild-owner",
        None,
    )
    .await
    .expect("pending guild");
    let pending_alliance = PlatformService::register_tenant(
        &control,
        &registry,
        alliance_register(&pending_alliance_id, vec![pending_guild_id.clone()]),
        "alliance-officer",
        None,
    )
    .await
    .expect("pending alliance");

    control
        .execute_unprepared(&format!(
            "INSERT INTO alliance_shares \
             (id, alliance_tenant_id, source_tenant_id, artifact_type, source_id, published_id, shared_by) \
             VALUES ('{}', '{alliance_id}', '{guild_id}', 'build', 7, 8, 'guild-owner')",
            uuid::Uuid::new_v4()
        ))
        .await
        .expect("share");
    control
        .execute_unprepared(&format!(
            "INSERT INTO event_sync_links \
             (id, source_tenant_id, source_event_id, mirror_tenant_id, mirror_event_id) \
             VALUES ('{}', '{guild_id}', 3, '{alliance_id}', 4)",
            uuid::Uuid::new_v4()
        ))
        .await
        .expect("link");
    PlatformService::record_alliance_role_grant(
        &control,
        &alliance_id,
        &guild_id,
        &alliance_id,
        "discord-user",
        "12345678901234567",
    )
    .await
    .expect("grant");

    let denied = PlatformService::leave_active_alliance(
        &control,
        &alliance_id,
        &guild_id,
        "stranger",
        false,
        &[],
        |_: &str, _: &str, _: &str| std::future::ready(Ok(())),
    )
    .await;
    assert!(matches!(denied, Err(AppError::Forbidden(_))));
    assert_eq!(
        PlatformService::alliance_membership_status(&control, &alliance_id, &guild_id)
            .await
            .expect("status")
            .as_deref(),
        Some("active")
    );

    let pending_leave = PlatformService::leave_active_alliance(
        &control,
        &pending_alliance_id,
        &pending_guild_id,
        "guild-owner",
        false,
        &[],
        |_: &str, _: &str, _: &str| std::future::ready(Ok(())),
    )
    .await;
    assert!(matches!(pending_leave, Err(AppError::Conflict(_))));
    assert_eq!(
        PlatformService::alliance_membership_status(
            &control,
            &pending_alliance_id,
            &pending_guild_id
        )
        .await
        .expect("pending status")
        .as_deref(),
        Some("pending")
    );
    PlatformService::decline_alliance_membership(
        &control,
        &pending_alliance_id,
        &pending_guild_id,
        "guild-owner",
    )
    .await
    .expect("decline still removes only the pending invite");
    assert!(
        PlatformService::alliance_membership_status(
            &control,
            &pending_alliance_id,
            &pending_guild_id
        )
        .await
        .expect("declined")
        .is_none()
    );

    let left = PlatformService::leave_active_alliance(
        &control,
        &alliance_id,
        &guild_id,
        "guild-owner",
        false,
        &[UntrackedAllianceRole {
            discord_guild_id: guild_id.clone(),
            role_id: "22345678901234567".into(),
        }],
        |_: &str, _: &str, _: &str| std::future::ready(Err("discord unavailable".to_owned())),
    )
    .await
    .expect("owner leave");
    assert_eq!(left.status, "left");

    let share_count: i64 = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT COUNT(*) FROM alliance_shares WHERE source_tenant_id = $1",
            [guild_id.clone().into()],
        ))
        .await
        .expect("shares")
        .expect("row")
        .try_get_by_index(0)
        .expect("count");
    assert_eq!(share_count, 1);
    let sync_enabled: bool = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT sync_enabled FROM event_sync_links WHERE source_tenant_id = $1",
            [guild_id.clone().into()],
        ))
        .await
        .expect("link")
        .expect("row")
        .try_get_by_index(0)
        .expect("flag");
    assert!(!sync_enabled);
    let link_count: i64 = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT COUNT(*) FROM event_sync_links WHERE source_tenant_id = $1",
            [guild_id.clone().into()],
        ))
        .await
        .expect("links")
        .expect("row")
        .try_get_by_index(0)
        .expect("count");
    assert_eq!(link_count, 1);

    sync_participation(
        &control,
        &registry,
        &guild_id,
        3,
        &ShareActor {
            discord_id: "discord-user".into(),
            username: "user".into(),
            email: None,
        },
        None,
    )
    .await
    .expect("disabled sync link does not fan out");

    let revocations = control
        .query_all(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT status, discord_user_id, detail FROM alliance_role_revocations \
             WHERE guild_tenant_id = $1 ORDER BY status",
            [guild_id.clone().into()],
        ))
        .await
        .expect("revocations");
    assert_eq!(revocations.len(), 2);
    let mut saw_pending = false;
    let mut saw_ambiguous = false;
    for row in &revocations {
        let status: String = row.try_get_by_index(0).expect("status");
        let user: String = row.try_get_by_index(1).expect("user");
        if status == "pending" {
            saw_pending = true;
            assert_eq!(user, "discord-user");
            let detail: String = row.try_get_by_index(2).expect("detail");
            assert!(detail.contains("discord unavailable"));
        } else if status == "ambiguous" {
            saw_ambiguous = true;
            assert!(user.is_empty());
        }
    }
    assert!(saw_pending);
    assert!(saw_ambiguous);

    PlatformService::leave_active_alliance(
        &control,
        &alliance_id,
        &guild_id,
        "guild-owner",
        false,
        &[],
        |_: &str, _: &str, _: &str| std::future::ready(Ok(())),
    )
    .await
    .expect("retry");
    let pending_left: i64 = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT COUNT(*) FROM alliance_role_revocations \
             WHERE guild_tenant_id = $1 AND status = 'pending'",
            [guild_id.into()],
        ))
        .await
        .expect("pending")
        .expect("row")
        .try_get_by_index(0)
        .expect("count");
    assert_eq!(pending_left, 0);

    drop_schema(&admin, &guild.schema_name)
        .await
        .expect("drop guild");
    drop_schema(&admin, &alliance.schema_name)
        .await
        .expect("drop alliance");
    drop_schema(&admin, &pending_guild.schema_name)
        .await
        .expect("drop pending guild");
    drop_schema(&admin, &pending_alliance.schema_name)
        .await
        .expect("drop pending alliance");
    drop_schema(&admin, &schema).await.expect("drop");
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn rejoin_from_left_reuses_the_row_and_leaves_history_unsynced() {
    let Some((url, admin)) = try_admin_db().await else {
        return;
    };
    let schema = unique_schema("it_rejoin");
    ensure_schema(&admin, &schema).await.expect("schema");
    let control = connect_with_search_path(&url, &schema)
        .await
        .expect("connect");
    Migrator::up(&control, None).await.expect("migrate");
    let registry = TenantRegistry::new(url, control.clone());

    let guild_id = unique_schema("gid");
    let alliance_id = unique_schema("aid");
    let guild = PlatformService::register_tenant(
        &control,
        &registry,
        guild_register(&guild_id, "Returning Guild"),
        "guild-owner",
        None,
    )
    .await
    .expect("guild");
    let alliance = PlatformService::register_tenant(
        &control,
        &registry,
        alliance_register(&alliance_id, vec![guild_id.clone()]),
        "alliance-owner",
        None,
    )
    .await
    .expect("alliance");
    PlatformService::accept_alliance_membership(&control, &alliance_id, &guild_id, "guild-owner")
        .await
        .expect("accept");

    control
        .execute_unprepared(&format!(
            "INSERT INTO alliance_shares \
             (id, alliance_tenant_id, source_tenant_id, artifact_type, source_id, published_id, shared_by) \
             VALUES ('{}', '{alliance_id}', '{guild_id}', 'build', 7, 8, 'guild-owner')",
            uuid::Uuid::new_v4()
        ))
        .await
        .expect("share");
    control
        .execute_unprepared(&format!(
            "INSERT INTO event_sync_links \
             (id, source_tenant_id, source_event_id, mirror_tenant_id, mirror_event_id) \
             VALUES ('{}', '{guild_id}', 3, '{alliance_id}', 4)",
            uuid::Uuid::new_v4()
        ))
        .await
        .expect("link");

    PlatformService::leave_active_alliance(
        &control,
        &alliance_id,
        &guild_id,
        "guild-owner",
        false,
        &[UntrackedAllianceRole {
            discord_guild_id: guild_id.clone(),
            role_id: "32345678901234567".into(),
        }],
        |_: &str, _: &str, _: &str| std::future::ready(Ok(())),
    )
    .await
    .expect("leave");

    let left_at: String = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT left_at::text FROM alliance_memberships WHERE guild_tenant_id = $1",
            [guild_id.clone().into()],
        ))
        .await
        .expect("left_at")
        .expect("row")
        .try_get_by_index(0)
        .expect("left_at");

    let skipped = PlatformService::accept_alliance_membership(
        &control,
        &alliance_id,
        &guild_id,
        "guild-owner",
    )
    .await;
    assert!(matches!(skipped, Err(AppError::NotFound(_))));

    let stranger = PlatformService::invite_alliance_membership(
        &control,
        &alliance_id,
        &guild_id,
        "guild-owner",
    )
    .await;
    assert!(matches!(stranger, Err(AppError::Forbidden(_))));

    let invited = PlatformService::invite_alliance_membership(
        &control,
        &alliance_id,
        &guild_id,
        "alliance-owner",
    )
    .await
    .expect("reinvite");
    assert_eq!(invited.status, "pending");
    assert_eq!(invited.guild_tenant_id, guild_id);

    let memberships: i64 = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT COUNT(*) FROM alliance_memberships WHERE guild_tenant_id = $1",
            [guild_id.clone().into()],
        ))
        .await
        .expect("count")
        .expect("row")
        .try_get_by_index(0)
        .expect("count");
    assert_eq!(memberships, 1);
    let left_at_after: String = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT left_at::text FROM alliance_memberships WHERE guild_tenant_id = $1",
            [guild_id.clone().into()],
        ))
        .await
        .expect("left_at")
        .expect("row")
        .try_get_by_index(0)
        .expect("left_at");
    assert_eq!(left_at_after, left_at);

    let rejoined = PlatformService::accept_alliance_membership(
        &control,
        &alliance_id,
        &guild_id,
        "guild-owner",
    )
    .await
    .expect("accept rejoin");
    assert_eq!(rejoined.status, "active");

    let share_count: i64 = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT COUNT(*) FROM alliance_shares WHERE source_tenant_id = $1",
            [guild_id.clone().into()],
        ))
        .await
        .expect("shares")
        .expect("row")
        .try_get_by_index(0)
        .expect("count");
    assert_eq!(share_count, 1);
    let sync_enabled: bool = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT sync_enabled FROM event_sync_links WHERE source_tenant_id = $1",
            [guild_id.clone().into()],
        ))
        .await
        .expect("link")
        .expect("row")
        .try_get_by_index(0)
        .expect("flag");
    assert!(!sync_enabled);

    sync_participation(
        &control,
        &registry,
        &guild_id,
        3,
        &ShareActor {
            discord_id: "discord-user".into(),
            username: "user".into(),
            email: None,
        },
        None,
    )
    .await
    .expect("old link stays unsynced after rejoin");

    let ambiguous: i64 = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT COUNT(*) FROM alliance_role_revocations \
             WHERE guild_tenant_id = $1 AND status = 'ambiguous' AND discord_user_id = ''",
            [guild_id.clone().into()],
        ))
        .await
        .expect("ambiguous")
        .expect("row")
        .try_get_by_index(0)
        .expect("count");
    assert_eq!(ambiguous, 1);
    let stripped: i64 = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT COUNT(*) FROM alliance_role_revocations \
             WHERE guild_tenant_id = $1 AND status = 'verified'",
            [guild_id.into()],
        ))
        .await
        .expect("verified")
        .expect("row")
        .try_get_by_index(0)
        .expect("count");
    assert_eq!(stripped, 0);

    drop_schema(&admin, &guild.schema_name)
        .await
        .expect("drop guild");
    drop_schema(&admin, &alliance.schema_name)
        .await
        .expect("drop alliance");
    drop_schema(&admin, &schema).await.expect("drop");
}
