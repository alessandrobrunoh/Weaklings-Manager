//! Publish a guild build snapshot into the alliance tenant schema.

use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, DatabaseConnection,
    EntityTrait, QueryFilter, Statement, TransactionTrait,
};

use crate::errors::AppError;
use crate::modules::auth::UserContext;
use crate::modules::comps::entities::{
    build, build_category, build_category::Column as BuildCategoryColumn, build_item,
    build_item::Column as BuildItemColumn, build_item_spell,
};
use crate::modules::users::entities::{self as user_entities, Entity as UserEntity};
use crate::tenant::TenantRegistry;

use super::models::{
    AllianceShareStatusView, AllianceShareView, ArtifactType, CreateAllianceShareRequest,
};

const ARTIFACT_BUILD: &str = "build";

/// Discord identity used to upsert the published copy's `created_by` in the alliance schema.
#[derive(Debug, Clone)]
pub struct ShareActor {
    /// Discord snowflake.
    pub discord_id: String,
    /// Display name.
    pub username: String,
    /// Email, when Discord provided one.
    pub email: Option<String>,
}

impl ShareActor {
    /// Build from the session user.
    #[must_use]
    pub fn from_user(user: &UserContext) -> Self {
        Self {
            discord_id: user.id.clone(),
            username: user.username.clone(),
            email: user.email.clone(),
        }
    }
}

/// Tenant-scoped inputs for a share/unshare call.
pub struct ShareParams<'a> {
    /// Discord guild id of the caller tenant.
    pub source_tenant_id: &'a str,
    /// `guild` or `alliance`.
    pub source_kind: &'a str,
    /// Who is publishing.
    pub actor: &'a ShareActor,
    /// Whether the caller holds `alliance.share`.
    pub authorized: bool,
}

/// Alliance share operations.
pub struct AllianceShareService;

impl AllianceShareService {
    /// Copy a guild build into the alliance schema, or refresh the existing snapshot.
    ///
    /// # Errors
    ///
    /// - 403 when `authorized` is false
    /// - 400 when called from an alliance tenant or with an unsupported type
    /// - 409 when the guild has no *active* alliance membership
    /// - 404 when the source build does not exist
    pub async fn share_build(
        control: &DatabaseConnection,
        registry: &TenantRegistry,
        source_db: &DatabaseConnection,
        params: ShareParams<'_>,
        req: CreateAllianceShareRequest,
    ) -> Result<AllianceShareView, AppError> {
        deny_unless_guild_officer(&params)?;
        let artifact_type = req.artifact_type.as_str();
        if req.artifact_type != ArtifactType::Build {
            return Err(AppError::Validation(
                "only build shares are supported".to_owned(),
            ));
        }
        let alliance_tenant_id =
            active_alliance_tenant_id(control, params.source_tenant_id).await?;

        let source = build::Entity::find_by_id(req.id)
            .one(source_db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Build {} not found", req.id)))?;

        let alliance = registry.get_or_load(&alliance_tenant_id).await?;
        let creator_id =
            resolve_created_by(source_db, &alliance.db, source.created_by, params.actor).await?;

        let existing = find_share(control, params.source_tenant_id, artifact_type, req.id).await?;
        let published_id = copy_build_graph(
            source_db,
            &alliance.db,
            source.id,
            creator_id,
            existing.as_ref().map(|row| row.published_id),
        )
        .await?;

        upsert_share_row(
            control,
            existing.as_ref().map(|row| row.id.as_str()),
            &alliance_tenant_id,
            params.source_tenant_id,
            artifact_type,
            req.id,
            published_id,
            &params.actor.discord_id,
        )
        .await?;

        find_share(control, params.source_tenant_id, artifact_type, req.id)
            .await?
            .ok_or_else(|| AppError::Internal("share row vanished after upsert".to_owned()))
    }

    /// Share status for a guild-side build detail badge.
    ///
    /// Missing membership or a missing row both look like "not shared" — the badge is informational.
    ///
    /// # Errors
    ///
    /// Returns a database error if the control-plane query fails.
    pub async fn build_share_status(
        control: &DatabaseConnection,
        source_tenant_id: &str,
        source_id: i64,
    ) -> Result<AllianceShareStatusView, AppError> {
        let share = find_share(control, source_tenant_id, ARTIFACT_BUILD, source_id).await?;
        Ok(AllianceShareStatusView {
            shared: share.is_some(),
            share,
        })
    }

    /// Drop the alliance copy and the mapping row.
    ///
    /// # Errors
    ///
    /// - 403 when `authorized` is false
    /// - 400 when called from an alliance tenant
    /// - 404 when no share exists for this source build
    pub async fn unshare_build(
        control: &DatabaseConnection,
        registry: &TenantRegistry,
        params: ShareParams<'_>,
        source_id: i64,
    ) -> Result<(), AppError> {
        deny_unless_guild_officer(&params)?;
        let share = find_share(control, params.source_tenant_id, ARTIFACT_BUILD, source_id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Build {source_id} is not shared")))?;

        let alliance = registry.get_or_load(&share.alliance_tenant_id).await?;
        delete_or_hide_published_build(&alliance.db, share.published_id).await?;
        delete_share_row(control, &share.id).await?;
        Ok(())
    }
}

fn deny_unless_guild_officer(params: &ShareParams<'_>) -> Result<(), AppError> {
    if !params.authorized {
        return Err(AppError::Forbidden(
            "missing permission alliance.share".to_owned(),
        ));
    }
    if params.source_kind == "alliance" {
        return Err(AppError::Validation(
            "share from an alliance tenant is not allowed".to_owned(),
        ));
    }
    Ok(())
}

async fn active_alliance_tenant_id(
    control: &DatabaseConnection,
    guild_tenant_id: &str,
) -> Result<String, AppError> {
    let row = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT alliance_tenant_id FROM alliance_memberships \
             WHERE guild_tenant_id = $1 AND status = 'active'",
            [guild_tenant_id.into()],
        ))
        .await?;
    let Some(row) = row else {
        return Err(AppError::Conflict(
            "guild is not an active member of an alliance".to_owned(),
        ));
    };
    Ok(row.try_get_by_index(0)?)
}

async fn find_share(
    control: &DatabaseConnection,
    source_tenant_id: &str,
    artifact_type: &str,
    source_id: i64,
) -> Result<Option<AllianceShareView>, AppError> {
    let row = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT id::text, alliance_tenant_id, source_tenant_id, artifact_type, source_id, \
                    published_id, shared_by, shared_at::text \
             FROM alliance_shares \
             WHERE source_tenant_id = $1 AND artifact_type = $2 AND source_id = $3",
            [
                source_tenant_id.into(),
                artifact_type.into(),
                source_id.into(),
            ],
        ))
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(AllianceShareView {
        id: row.try_get_by_index(0)?,
        alliance_tenant_id: row.try_get_by_index(1)?,
        source_tenant_id: row.try_get_by_index(2)?,
        artifact_type: row.try_get_by_index(3)?,
        source_id: row.try_get_by_index(4)?,
        published_id: row.try_get_by_index(5)?,
        shared_by: row.try_get_by_index(6)?,
        shared_at: row.try_get_by_index(7)?,
    }))
}

#[allow(clippy::too_many_arguments)]
async fn upsert_share_row(
    control: &DatabaseConnection,
    existing_id: Option<&str>,
    alliance_tenant_id: &str,
    source_tenant_id: &str,
    artifact_type: &str,
    source_id: i64,
    published_id: i64,
    shared_by: &str,
) -> Result<(), AppError> {
    if let Some(id) = existing_id {
        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "UPDATE alliance_shares \
                 SET published_id = $1, shared_by = $2, shared_at = now() \
                 WHERE id = $3::uuid",
                [published_id.into(), shared_by.into(), id.into()],
            ))
            .await?;
        return Ok(());
    }
    let id = uuid::Uuid::new_v4().to_string();
    control
        .execute(Statement::from_sql_and_values(
            control.get_database_backend(),
            "INSERT INTO alliance_shares \
             (id, alliance_tenant_id, source_tenant_id, artifact_type, source_id, published_id, shared_by) \
             VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)",
            [
                id.into(),
                alliance_tenant_id.into(),
                source_tenant_id.into(),
                artifact_type.into(),
                source_id.into(),
                published_id.into(),
                shared_by.into(),
            ],
        ))
        .await?;
    Ok(())
}

async fn delete_share_row(control: &DatabaseConnection, id: &str) -> Result<(), AppError> {
    control
        .execute(Statement::from_sql_and_values(
            control.get_database_backend(),
            "DELETE FROM alliance_shares WHERE id = $1::uuid",
            [id.into()],
        ))
        .await?;
    Ok(())
}

/// Copy (or refresh) the build graph into `dest`. Returns the published build id.
async fn copy_build_graph(
    source: &DatabaseConnection,
    dest: &DatabaseConnection,
    source_build_id: i64,
    dest_creator_id: i64,
    published_id: Option<i64>,
) -> Result<i64, AppError> {
    let source_build = build::Entity::find_by_id(source_build_id)
        .one(source)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Build {source_build_id} not found")))?;
    let source_category = build_category::Entity::find_by_id(source_build.category_id)
        .one(source)
        .await?
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "Build category {} not found",
                source_build.category_id
            ))
        })?;
    let source_items = build_item::Entity::find()
        .filter(BuildItemColumn::BuildId.eq(source_build.id))
        .all(source)
        .await?;

    let txn = dest.begin().await?;
    let dest_category_id = ensure_category(&txn, &source_category).await?;

    let dest_build_id = if let Some(existing_id) = published_id {
        if let Some(existing) = build::Entity::find_by_id(existing_id).one(&txn).await? {
            let mut active: build::ActiveModel = existing.into();
            active.name = Set(source_build.name.clone());
            active.description = Set(source_build.description.clone());
            active.role = Set(source_build.role.clone());
            active.category_id = Set(dest_category_id);
            active.version = Set(source_build.version);
            active.archived_at = Set(None);
            active.updated_at = Set(chrono::Utc::now().into());
            active.update(&txn).await?;
            build_item::Entity::delete_many()
                .filter(BuildItemColumn::BuildId.eq(existing_id))
                .exec(&txn)
                .await?;
            existing_id
        } else {
            insert_build_row(&txn, &source_build, dest_category_id, dest_creator_id).await?
        }
    } else {
        insert_build_row(&txn, &source_build, dest_category_id, dest_creator_id).await?
    };

    for item in source_items {
        let copied = build_item::ActiveModel {
            build_id: Set(dest_build_id),
            loadout: Set(item.loadout.clone()),
            slot: Set(item.slot.clone()),
            openalbion_item_type: Set(item.openalbion_item_type.clone()),
            openalbion_item_id: Set(item.openalbion_item_id),
            openalbion_item_name: Set(item.openalbion_item_name.clone()),
            openalbion_item_icon: Set(item.openalbion_item_icon.clone()),
            openalbion_item_tier: Set(item.openalbion_item_tier.clone()),
            openalbion_item_quality: Set(item.openalbion_item_quality),
            openalbion_item_enchantment: Set(item.openalbion_item_enchantment),
            ..Default::default()
        }
        .insert(&txn)
        .await?;

        let spells = build_item_spell::Entity::find()
            .filter(build_item_spell::Column::BuildItemId.eq(item.id))
            .all(source)
            .await?;
        for spell in spells {
            build_item_spell::ActiveModel {
                build_item_id: Set(copied.id),
                kind: Set(spell.kind),
                slot_index: Set(spell.slot_index),
                spell_id: Set(spell.spell_id),
                ..Default::default()
            }
            .insert(&txn)
            .await?;
        }
    }

    txn.commit().await?;
    Ok(dest_build_id)
}

async fn insert_build_row(
    db: &impl ConnectionTrait,
    source: &build::Model,
    category_id: i64,
    created_by: i64,
) -> Result<i64, AppError> {
    let inserted = build::ActiveModel {
        name: Set(source.name.clone()),
        description: Set(source.description.clone()),
        role: Set(source.role.clone()),
        category_id: Set(category_id),
        version: Set(source.version),
        created_by: Set(created_by),
        archived_at: Set(None),
        ..Default::default()
    }
    .insert(db)
    .await?;
    Ok(inserted.id)
}

async fn ensure_category(
    db: &impl ConnectionTrait,
    source: &build_category::Model,
) -> Result<i64, AppError> {
    if let Some(existing) = build_category::Entity::find()
        .filter(BuildCategoryColumn::Slug.eq(&source.slug))
        .one(db)
        .await?
    {
        return Ok(existing.id);
    }
    if let Some(existing) = build_category::Entity::find()
        .filter(BuildCategoryColumn::Name.eq(&source.name))
        .one(db)
        .await?
    {
        return Ok(existing.id);
    }
    let inserted = build_category::ActiveModel {
        name: Set(source.name.clone()),
        slug: Set(source.slug.clone()),
        description: Set(source.description.clone()),
        ..Default::default()
    }
    .insert(db)
    .await?;
    Ok(inserted.id)
}

async fn resolve_created_by(
    source_db: &DatabaseConnection,
    dest_db: &DatabaseConnection,
    source_created_by: i64,
    actor: &ShareActor,
) -> Result<i64, AppError> {
    if let Some(source_user) = UserEntity::find_by_id(source_created_by)
        .one(source_db)
        .await?
        && let Some(discord_id) = source_user.discord_id.clone()
    {
        return upsert_alliance_user(
            dest_db,
            &ShareActor {
                discord_id,
                username: source_user.username,
                email: Some(source_user.email),
            },
        )
        .await;
    }
    upsert_alliance_user(dest_db, actor).await
}

async fn upsert_alliance_user(
    db: &DatabaseConnection,
    actor: &ShareActor,
) -> Result<i64, AppError> {
    if let Some(existing) = UserEntity::find()
        .filter(user_entities::Column::DiscordId.eq(&actor.discord_id))
        .one(db)
        .await?
    {
        return Ok(existing.id);
    }

    let email = actor
        .email
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("{}@alliance-share.invalid", actor.discord_id));

    if let Some(existing) = UserEntity::find()
        .filter(user_entities::Column::Email.eq(&email))
        .one(db)
        .await?
    {
        let id = existing.id;
        let mut active: user_entities::ActiveModel = existing.into();
        active.discord_id = Set(Some(actor.discord_id.clone()));
        active.username = Set(actor.username.clone());
        active.update(db).await?;
        return Ok(id);
    }

    let inserted = user_entities::ActiveModel {
        username: Set(actor.username.clone()),
        email: Set(email),
        role: Set("User".to_owned()),
        discord_id: Set(Some(actor.discord_id.clone())),
        ..Default::default()
    }
    .insert(db)
    .await?;
    Ok(inserted.id)
}

async fn delete_or_hide_published_build(
    db: &DatabaseConnection,
    published_id: i64,
) -> Result<(), AppError> {
    let Some(existing) = build::Entity::find_by_id(published_id).one(db).await? else {
        return Ok(());
    };
    match build::Entity::delete_by_id(published_id).exec(db).await {
        Ok(_) => Ok(()),
        Err(err) => match err.sql_err() {
            Some(sea_orm::SqlErr::ForeignKeyConstraintViolation(_)) => {
                let mut active: build::ActiveModel = existing.into();
                active.archived_at = Set(Some(chrono::Utc::now().into()));
                active.updated_at = Set(chrono::Utc::now().into());
                active.update(db).await?;
                Ok(())
            }
            _ => Err(AppError::Database(err)),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_migration::Migrator as ControlMigrator;
    use crate::migration::MigratorTrait;
    use crate::modules::comps::models::BuildFilters;
    use crate::modules::comps::models::UpsertBuildItemRequest;
    use crate::modules::comps::service::CompService;
    use crate::modules::comps::status::{BuildLoadout, BuildRole, BuildSlot};
    use crate::modules::platform::models::RegisterTenantRequest;
    use crate::modules::platform::service::PlatformService;
    use crate::pagination::PaginationParams;
    use crate::postgres::{
        connect_with_search_path, drop_schema, ensure_schema,
        test_support::{try_admin_db, unique_schema},
    };
    use sea_orm::Database;

    fn actor(discord_id: &str) -> ShareActor {
        ShareActor {
            discord_id: discord_id.to_owned(),
            username: "officer".to_owned(),
            email: Some(format!("{discord_id}@example.com")),
        }
    }

    fn share_req(id: i64) -> CreateAllianceShareRequest {
        CreateAllianceShareRequest {
            artifact_type: ArtifactType::Build,
            id,
        }
    }

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
        }
    }

    fn alliance_register(id: &str, members: Vec<String>) -> RegisterTenantRequest {
        RegisterTenantRequest {
            id: id.to_owned(),
            name: "Alliance Hub".into(),
            kind: Some("alliance".into()),
            albion_guild_id: String::new(),
            albion_api_region: String::new(),
            albion_allied_guild_ids: None,
            albion_allied_guild_names: None,
            member_guild_ids: members,
        }
    }

    async fn seed_sqlite() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.expect("sqlite");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("migrate");
        db
    }

    async fn insert_user(db: &DatabaseConnection, username: &str, email: &str) -> i64 {
        user_entities::ActiveModel {
            username: Set(username.to_owned()),
            email: Set(email.to_owned()),
            role: Set("Admin".to_owned()),
            discord_id: Set(Some(format!("{username}-discord"))),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("user")
        .id
    }

    fn weapon(name: &str) -> UpsertBuildItemRequest {
        UpsertBuildItemRequest {
            openalbion_item_type: "weapon".to_owned(),
            openalbion_item_id: 1,
            openalbion_item_name: name.to_owned(),
            openalbion_item_icon: None,
            openalbion_item_tier: Some("T8".to_owned()),
            openalbion_item_quality: None,
            openalbion_item_enchantment: None,
        }
    }

    #[tokio::test]
    async fn unauthorized_share_is_forbidden() {
        let db = seed_sqlite().await;
        let err = AllianceShareService::share_build(
            &db,
            &TenantRegistry::new(String::new(), db.clone()),
            &db,
            ShareParams {
                source_tenant_id: "guild-1",
                source_kind: "guild",
                actor: &actor("officer-1"),
                authorized: false,
            },
            share_req(1),
        )
        .await
        .expect_err("forbidden");
        match err {
            AppError::Forbidden(msg) => assert!(msg.contains("alliance.share")),
            other => panic!("expected forbidden, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn share_from_alliance_tenant_is_bad_request() {
        let db = seed_sqlite().await;
        let err = AllianceShareService::share_build(
            &db,
            &TenantRegistry::new(String::new(), db.clone()),
            &db,
            ShareParams {
                source_tenant_id: "alliance-1",
                source_kind: "alliance",
                actor: &actor("officer-1"),
                authorized: true,
            },
            share_req(1),
        )
        .await
        .expect_err("validation");
        match err {
            AppError::Validation(msg) => assert!(msg.contains("alliance tenant")),
            other => panic!("expected validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn copy_build_graph_creates_items_and_spells_in_the_other_schema() {
        let source = seed_sqlite().await;
        let dest = seed_sqlite().await;
        let src_user = insert_user(&source, "maker", "maker@example.com").await;
        let dest_user = insert_user(&dest, "maker", "maker@example.com").await;
        let comps = CompService::new();
        let category = comps
            .create_build_category(
                &source,
                crate::modules::comps::models::CreateBuildCategoryRequest {
                    name: "Crystal".to_owned(),
                    description: None,
                },
            )
            .await
            .expect("category");
        let created = comps
            .create_build(
                &source,
                src_user,
                crate::modules::comps::models::CreateBuildRequest {
                    name: "Heavy Mace".to_owned(),
                    description: Some("smash".to_owned()),
                    role: BuildRole::Dps,
                    category_id: category.id,
                    items: None,
                },
            )
            .await
            .expect("build");
        comps
            .upsert_build_item(
                &source,
                created.summary.id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                weapon("Mace"),
            )
            .await
            .expect("item");
        let item = build_item::Entity::find()
            .filter(BuildItemColumn::BuildId.eq(created.summary.id))
            .one(&source)
            .await
            .expect("load item")
            .expect("item row");
        build_item_spell::ActiveModel {
            build_item_id: Set(item.id),
            kind: Set("active".to_owned()),
            slot_index: Set(1),
            spell_id: Set("HEROICSTRIKE2".to_owned()),
            ..Default::default()
        }
        .insert(&source)
        .await
        .expect("spell");

        let published_id = copy_build_graph(&source, &dest, created.summary.id, dest_user, None)
            .await
            .expect("copy");

        let copied = comps.get_build(&dest, published_id).await.expect("copied");
        assert_eq!(copied.summary.name, "Heavy Mace");
        assert_eq!(copied.summary.category_name.as_deref(), Some("Crystal"));
        assert_eq!(copied.items.len(), 1);
        assert_eq!(copied.items[0].openalbion_item_name, "Mace");
        assert_eq!(
            copied.items[0].spells.active.get("1").map(String::as_str),
            Some("HEROICSTRIKE2")
        );

        comps
            .upsert_build_item(
                &source,
                created.summary.id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                weapon("Updated Mace"),
            )
            .await
            .expect("update source");
        let again = copy_build_graph(
            &source,
            &dest,
            created.summary.id,
            dest_user,
            Some(published_id),
        )
        .await
        .expect("recopy");
        assert_eq!(again, published_id);
        let refreshed = comps.get_build(&dest, published_id).await.expect("refresh");
        assert_eq!(refreshed.items[0].openalbion_item_name, "Updated Mace");
        let count = build::Entity::find().all(&dest).await.expect("all").len();
        assert_eq!(count, 1, "re-share must not duplicate the published build");
    }

    #[tokio::test]
    async fn share_without_alliance_is_conflict() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_sh409");
        ensure_schema(&admin, &schema).await.expect("schema");
        let control = connect_with_search_path(&url, &schema)
            .await
            .expect("connect");
        ControlMigrator::up(&control, None).await.expect("migrate");
        let registry = TenantRegistry::new(url, control.clone());
        let guild_id = unique_schema("gid");
        let guild = PlatformService::register_tenant(
            &control,
            &registry,
            guild_register(&guild_id, "Lone Guild"),
            "officer-1",
            None,
        )
        .await
        .expect("guild");
        let guild_ctx = registry.get_or_load(&guild_id).await.expect("guild ctx");
        let err = AllianceShareService::share_build(
            &control,
            &registry,
            &guild_ctx.db,
            ShareParams {
                source_tenant_id: &guild_id,
                source_kind: "guild",
                actor: &actor("officer-1"),
                authorized: true,
            },
            share_req(1),
        )
        .await
        .expect_err("no alliance");
        match err {
            AppError::Conflict(msg) => assert!(msg.contains("alliance")),
            other => panic!("expected conflict, got {other:?}"),
        }
        drop_schema(&admin, &guild.schema_name)
            .await
            .expect("drop guild");
        drop_schema(&admin, &schema).await.expect("drop");
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn share_copies_build_into_alliance_schema_and_is_idempotent() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_shok");
        ensure_schema(&admin, &schema).await.expect("schema");
        let control = connect_with_search_path(&url, &schema)
            .await
            .expect("connect");
        ControlMigrator::up(&control, None).await.expect("migrate");
        let registry = TenantRegistry::new(url, control.clone());
        let guild_id = unique_schema("gid");
        let alliance_id = unique_schema("aid");
        let guild = PlatformService::register_tenant(
            &control,
            &registry,
            guild_register(&guild_id, "Member Guild"),
            "officer-1",
            None,
        )
        .await
        .expect("guild");
        let alliance = PlatformService::register_tenant(
            &control,
            &registry,
            alliance_register(&alliance_id, vec![guild_id.clone()]),
            "officer-1",
            None,
        )
        .await
        .expect("alliance");

        let guild_ctx = registry.get_or_load(&guild_id).await.expect("guild ctx");
        let comps = CompService::new();
        let src_user = user_entities::ActiveModel {
            username: Set("officer".to_owned()),
            email: Set("officer-1@example.com".to_owned()),
            role: Set("Admin".to_owned()),
            discord_id: Set(Some("officer-1".to_owned())),
            ..Default::default()
        }
        .insert(&guild_ctx.db)
        .await
        .expect("user")
        .id;
        let category = comps
            .create_build_category(
                &guild_ctx.db,
                crate::modules::comps::models::CreateBuildCategoryRequest {
                    name: "Crystal".to_owned(),
                    description: None,
                },
            )
            .await
            .expect("category");
        let created = comps
            .create_build(
                &guild_ctx.db,
                src_user,
                crate::modules::comps::models::CreateBuildRequest {
                    name: "Heavy Mace".to_owned(),
                    description: None,
                    role: BuildRole::Dps,
                    category_id: category.id,
                    items: None,
                },
            )
            .await
            .expect("build");
        comps
            .upsert_build_item(
                &guild_ctx.db,
                created.summary.id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                weapon("Mace"),
            )
            .await
            .expect("item");

        let first = AllianceShareService::share_build(
            &control,
            &registry,
            &guild_ctx.db,
            ShareParams {
                source_tenant_id: &guild_id,
                source_kind: "guild",
                actor: &actor("officer-1"),
                authorized: true,
            },
            share_req(created.summary.id),
        )
        .await
        .expect("share");
        assert_eq!(first.alliance_tenant_id, alliance_id);
        assert_eq!(first.source_id, created.summary.id);

        let alliance_ctx = registry
            .get_or_load(&alliance_id)
            .await
            .expect("alliance ctx");
        let listed = comps
            .list_builds(
                &alliance_ctx.db,
                BuildFilters {
                    role: None,
                    category_id: None,
                    q: None,
                    search: None,
                    sort: None,
                    order: None,
                    archived: None,
                },
                PaginationParams {
                    page: Some(1),
                    limit: Some(50),
                },
            )
            .await
            .expect("list");
        assert_eq!(listed.items.len(), 1);
        assert_eq!(listed.items[0].name, "Heavy Mace");
        assert_eq!(listed.items[0].id, first.published_id);

        comps
            .upsert_build_item(
                &guild_ctx.db,
                created.summary.id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                weapon("Better Mace"),
            )
            .await
            .expect("edit");
        let second = AllianceShareService::share_build(
            &control,
            &registry,
            &guild_ctx.db,
            ShareParams {
                source_tenant_id: &guild_id,
                source_kind: "guild",
                actor: &actor("officer-1"),
                authorized: true,
            },
            share_req(created.summary.id),
        )
        .await
        .expect("reshare");
        assert_eq!(second.id, first.id);
        assert_eq!(second.published_id, first.published_id);
        let refreshed = comps
            .get_build(&alliance_ctx.db, first.published_id)
            .await
            .expect("published");
        assert_eq!(refreshed.items[0].openalbion_item_name, "Better Mace");

        drop_schema(&admin, &guild.schema_name)
            .await
            .expect("drop guild");
        drop_schema(&admin, &alliance.schema_name)
            .await
            .expect("drop alliance");
        drop_schema(&admin, &schema).await.expect("drop");
    }
}
