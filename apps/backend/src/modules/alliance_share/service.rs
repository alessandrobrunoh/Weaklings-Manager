//! Publish a guild build or composition snapshot into the alliance tenant schema.

use std::collections::HashMap;

use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, DatabaseConnection,
    EntityTrait, QueryFilter, QueryOrder, Statement, TransactionTrait,
};

use crate::errors::AppError;
use crate::modules::auth::UserContext;
use crate::modules::comps::entities::{
    build, build_category, build_category::Column as BuildCategoryColumn, build_item,
    build_item::Column as BuildItemColumn, build_item_spell, comp, comp_build,
    comp_build::Column as CompBuildColumn, comp_category,
    comp_category::Column as CompCategoryColumn,
};
use crate::modules::splits::entities::split::{self as split_row};
use crate::modules::splits::entities::split_bag::{self as split_bag, Column as SplitBagColumn};
use crate::modules::splits::entities::split_discord_sync;
use crate::modules::splits::entities::split_island::{
    self as split_island, Column as IslandColumn,
};
use crate::modules::splits::entities::split_island_tab::{self as split_tab, Column as TabColumn};
use crate::modules::splits::entities::split_participant::{
    self as split_participant, Column as ParticipantColumn,
};
use crate::modules::users::entities::{self as user_entities, Entity as UserEntity};
use crate::tenant::TenantRegistry;

use super::models::{
    AllianceShareStatusView, AllianceShareView, ArtifactType, CreateAllianceShareRequest,
};

const ARTIFACT_BUILD: &str = "build";
const ARTIFACT_COMP: &str = "comp";
const ARTIFACT_SPLIT: &str = "split";

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
                "use share_split for split artifacts".to_owned(),
            ));
        }
        let artifact_type = req.artifact_type.as_str();
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

    /// Copy a guild composition into the alliance schema, auto-publishing any referenced builds
    /// that are not already shared.
    ///
    /// Re-share refreshes the composition snapshot in place. Already-shared builds are reused as-is
    /// (their own share lifecycle is independent).
    ///
    /// # Errors
    ///
    /// - 403 when `authorized` is false
    /// - 400 when called from an alliance tenant or with an unsupported type
    /// - 409 when the guild has no *active* alliance membership
    /// - 404 when the source composition does not exist
    pub async fn share_comp(
        control: &DatabaseConnection,
        registry: &TenantRegistry,
        source_db: &DatabaseConnection,
        params: ShareParams<'_>,
        req: CreateAllianceShareRequest,
    ) -> Result<AllianceShareView, AppError> {
        deny_unless_guild_officer(&params)?;
        if req.artifact_type != ArtifactType::Comp {
            return Err(AppError::Validation(
                "only comp shares are supported".to_owned(),
            ));
        }
        let alliance_tenant_id =
            active_alliance_tenant_id(control, params.source_tenant_id).await?;

        let source = comp::Entity::find_by_id(req.id)
            .one(source_db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Comp {} not found", req.id)))?;

        let entries = comp_build::Entity::find()
            .filter(CompBuildColumn::CompId.eq(source.id))
            .all(source_db)
            .await?;

        let mut source_to_dest = HashMap::new();
        for entry in &entries {
            let published_build_id =
                ensure_build_published(control, registry, source_db, &params, entry.build_id)
                    .await?;
            source_to_dest.insert(entry.build_id, published_build_id);
        }

        let alliance = registry.get_or_load(&alliance_tenant_id).await?;
        let creator_id =
            resolve_created_by(source_db, &alliance.db, source.created_by, params.actor).await?;
        let existing = find_share(control, params.source_tenant_id, ARTIFACT_COMP, req.id).await?;
        let published_id = copy_comp_graph(
            source_db,
            &alliance.db,
            source.id,
            creator_id,
            &source_to_dest,
            existing.as_ref().map(|row| row.published_id),
        )
        .await?;

        upsert_share_row(
            control,
            existing.as_ref().map(|row| row.id.as_str()),
            &alliance_tenant_id,
            params.source_tenant_id,
            ARTIFACT_COMP,
            req.id,
            published_id,
            &params.actor.discord_id,
        )
        .await?;

        find_share(control, params.source_tenant_id, ARTIFACT_COMP, req.id)
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
        artifact_share_status(control, source_tenant_id, ARTIFACT_BUILD, source_id).await
    }

    /// Share status for a guild-side composition detail badge.
    ///
    /// # Errors
    ///
    /// Returns a database error if the control-plane query fails.
    pub async fn comp_share_status(
        control: &DatabaseConnection,
        source_tenant_id: &str,
        source_id: i64,
    ) -> Result<AllianceShareStatusView, AppError> {
        artifact_share_status(control, source_tenant_id, ARTIFACT_COMP, source_id).await
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

    /// Drop the alliance composition copy and the mapping row.
    ///
    /// Referenced published builds are left in place — they have their own share rows.
    ///
    /// # Errors
    ///
    /// - 403 when `authorized` is false
    /// - 400 when called from an alliance tenant
    /// - 404 when no share exists for this source composition
    pub async fn unshare_comp(
        control: &DatabaseConnection,
        registry: &TenantRegistry,
        params: ShareParams<'_>,
        source_id: i64,
    ) -> Result<(), AppError> {
        deny_unless_guild_officer(&params)?;
        let share = find_share(control, params.source_tenant_id, ARTIFACT_COMP, source_id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Comp {source_id} is not shared")))?;

        let alliance = registry.get_or_load(&share.alliance_tenant_id).await?;
        delete_or_hide_published_comp(&alliance.db, share.published_id).await?;
        delete_share_row(control, &share.id).await?;
        Ok(())
    }

    /// Copy a guild split into the alliance schema as a read-only snapshot, or refresh it.
    ///
    /// # Errors
    ///
    /// - 403 when `authorized` is false
    /// - 400 when called from an alliance tenant or with a non-split type
    /// - 409 when the guild has no *active* alliance membership
    /// - 404 when the source split does not exist
    pub async fn share_split(
        control: &DatabaseConnection,
        registry: &TenantRegistry,
        source_db: &DatabaseConnection,
        params: ShareParams<'_>,
        req: CreateAllianceShareRequest,
    ) -> Result<AllianceShareView, AppError> {
        deny_unless_guild_officer(&params)?;
        if req.artifact_type != ArtifactType::Split {
            return Err(AppError::Validation(
                "use share_build for build artifacts".to_owned(),
            ));
        }
        let alliance_tenant_id =
            active_alliance_tenant_id(control, params.source_tenant_id).await?;

        let source = split_row::Entity::find_by_id(req.id)
            .one(source_db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Split {} not found", req.id)))?;

        let alliance = registry.get_or_load(&alliance_tenant_id).await?;
        let creator_id =
            resolve_created_by(source_db, &alliance.db, source.created_by, params.actor).await?;

        let existing = find_share(control, params.source_tenant_id, ARTIFACT_SPLIT, req.id).await?;
        let published_id = copy_split_graph(
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
            ARTIFACT_SPLIT,
            req.id,
            published_id,
            &params.actor.discord_id,
        )
        .await?;

        find_share(control, params.source_tenant_id, ARTIFACT_SPLIT, req.id)
            .await?
            .ok_or_else(|| AppError::Internal("share row vanished after upsert".to_owned()))
    }

    /// Attach a published split to an event in the destination tenant.
    ///
    /// Event mirrors are a special kind of share: unlike a generic alliance
    /// snapshot, their split is live on both Discord servers and must be
    /// discoverable by both pollers.  Keep this small operation here so the
    /// event mirror cannot accidentally update the source split.
    pub async fn attach_shared_split_to_event(
        registry: &TenantRegistry,
        share: &AllianceShareView,
        event_id: i64,
    ) -> Result<(), AppError> {
        let alliance = registry.get_or_load(&share.alliance_tenant_id).await?;
        let split = split_row::Entity::find_by_id(share.published_id)
            .one(&alliance.db)
            .await?
            .ok_or_else(|| {
                AppError::NotFound(format!("Published split {} not found", share.published_id))
            })?;
        let mut active: split_row::ActiveModel = split.into();
        active.event_id = Set(Some(event_id));
        // A mirrored split is intentionally writable from either tenant.  The
        // event/participation API remains the source of truth for signups,
        // while this flag lets the alliance Discord poller create its thread.
        active.origin_read_only = Set(false);
        active.updated_at = Set(chrono::Utc::now().into());
        active.update(&alliance.db).await?;
        Ok(())
    }

    /// Share status for a guild-side split detail badge.
    ///
    /// # Errors
    ///
    /// Returns a database error if the control-plane query fails.
    pub async fn split_share_status(
        control: &DatabaseConnection,
        source_tenant_id: &str,
        source_id: i64,
    ) -> Result<AllianceShareStatusView, AppError> {
        let share = find_share(control, source_tenant_id, ARTIFACT_SPLIT, source_id).await?;
        Ok(AllianceShareStatusView {
            shared: share.is_some(),
            share,
        })
    }

    /// Drop the alliance split copy and the mapping row. Does not touch the guild split.
    ///
    /// # Errors
    ///
    /// - 403 when `authorized` is false
    /// - 400 when called from an alliance tenant
    /// - 404 when no share exists for this source split
    pub async fn unshare_split(
        control: &DatabaseConnection,
        registry: &TenantRegistry,
        params: ShareParams<'_>,
        source_id: i64,
    ) -> Result<(), AppError> {
        deny_unless_guild_officer(&params)?;
        let share = find_share(control, params.source_tenant_id, ARTIFACT_SPLIT, source_id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Split {source_id} is not shared")))?;

        let alliance = registry.get_or_load(&share.alliance_tenant_id).await?;
        delete_or_hide_published_split(&alliance.db, share.published_id).await?;
        delete_share_row(control, &share.id).await?;
        Ok(())
    }
}

async fn artifact_share_status(
    control: &DatabaseConnection,
    source_tenant_id: &str,
    artifact_type: &str,
    source_id: i64,
) -> Result<AllianceShareStatusView, AppError> {
    let share = find_share(control, source_tenant_id, artifact_type, source_id).await?;
    Ok(AllianceShareStatusView {
        shared: share.is_some(),
        share,
    })
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

/// Auto-publish a guild build if it is not already shared. Returns the alliance-schema id.
async fn ensure_build_published(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    source_db: &DatabaseConnection,
    params: &ShareParams<'_>,
    source_build_id: i64,
) -> Result<i64, AppError> {
    if let Some(existing) = find_share(
        control,
        params.source_tenant_id,
        ARTIFACT_BUILD,
        source_build_id,
    )
    .await?
    {
        return Ok(existing.published_id);
    }
    let published = AllianceShareService::share_build(
        control,
        registry,
        source_db,
        ShareParams {
            source_tenant_id: params.source_tenant_id,
            source_kind: params.source_kind,
            actor: params.actor,
            authorized: params.authorized,
        },
        CreateAllianceShareRequest {
            artifact_type: ArtifactType::Build,
            id: source_build_id,
        },
    )
    .await?;
    Ok(published.published_id)
}

/// Copy (or refresh) the composition and its `comp_builds` into `dest`.
///
/// `source_to_dest_build` maps guild build ids to already-published alliance build ids.
/// `parent_id` is dropped: the parent may not exist in the alliance schema.
async fn copy_comp_graph(
    source: &DatabaseConnection,
    dest: &DatabaseConnection,
    source_comp_id: i64,
    dest_creator_id: i64,
    source_to_dest_build: &HashMap<i64, i64>,
    published_id: Option<i64>,
) -> Result<i64, AppError> {
    let source_comp = comp::Entity::find_by_id(source_comp_id)
        .one(source)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Comp {source_comp_id} not found")))?;
    let source_category = comp_category::Entity::find_by_id(source_comp.category_id)
        .one(source)
        .await?
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "Comp category {} not found",
                source_comp.category_id
            ))
        })?;
    let source_entries = comp_build::Entity::find()
        .filter(CompBuildColumn::CompId.eq(source_comp.id))
        .all(source)
        .await?;

    let txn = dest.begin().await?;
    let dest_category_id = ensure_comp_category(&txn, &source_category).await?;

    let dest_comp_id = if let Some(existing_id) = published_id {
        if let Some(existing) = comp::Entity::find_by_id(existing_id).one(&txn).await? {
            let mut active: comp::ActiveModel = existing.into();
            active.name = Set(source_comp.name.clone());
            active.description = Set(source_comp.description.clone());
            active.category_id = Set(dest_category_id);
            active.version = Set(source_comp.version);
            active.parent_id = Set(None);
            active.archived_at = Set(None);
            active.updated_at = Set(chrono::Utc::now().into());
            active.update(&txn).await?;
            comp_build::Entity::delete_many()
                .filter(CompBuildColumn::CompId.eq(existing_id))
                .exec(&txn)
                .await?;
            existing_id
        } else {
            insert_comp_row(&txn, &source_comp, dest_category_id, dest_creator_id).await?
        }
    } else {
        insert_comp_row(&txn, &source_comp, dest_category_id, dest_creator_id).await?
    };

    for entry in source_entries {
        let dest_build_id = source_to_dest_build
            .get(&entry.build_id)
            .copied()
            .ok_or_else(|| {
                AppError::Internal(format!(
                    "missing published build mapping for source build {}",
                    entry.build_id
                ))
            })?;
        comp_build::ActiveModel {
            comp_id: Set(dest_comp_id),
            build_id: Set(dest_build_id),
            quantity: Set(entry.quantity),
            ..Default::default()
        }
        .insert(&txn)
        .await?;
    }

    txn.commit().await?;
    Ok(dest_comp_id)
}

async fn insert_comp_row(
    db: &impl ConnectionTrait,
    source: &comp::Model,
    category_id: i64,
    created_by: i64,
) -> Result<i64, AppError> {
    let inserted = comp::ActiveModel {
        name: Set(source.name.clone()),
        description: Set(source.description.clone()),
        category_id: Set(category_id),
        version: Set(source.version),
        created_by: Set(created_by),
        parent_id: Set(None),
        archived_at: Set(None),
        ..Default::default()
    }
    .insert(db)
    .await?;
    Ok(inserted.id)
}

async fn ensure_comp_category(
    db: &impl ConnectionTrait,
    source: &comp_category::Model,
) -> Result<i64, AppError> {
    if let Some(existing) = comp_category::Entity::find()
        .filter(CompCategoryColumn::Slug.eq(&source.slug))
        .one(db)
        .await?
    {
        return Ok(existing.id);
    }
    if let Some(existing) = comp_category::Entity::find()
        .filter(CompCategoryColumn::Name.eq(&source.name))
        .one(db)
        .await?
    {
        return Ok(existing.id);
    }
    let inserted = comp_category::ActiveModel {
        name: Set(source.name.clone()),
        slug: Set(source.slug.clone()),
        description: Set(source.description.clone()),
        ..Default::default()
    }
    .insert(db)
    .await?;
    Ok(inserted.id)
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
    let email = actor
        .email
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("{}@alliance-share.invalid", actor.discord_id));
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

async fn delete_or_hide_published_comp(
    db: &DatabaseConnection,
    published_id: i64,
) -> Result<(), AppError> {
    let Some(existing) = comp::Entity::find_by_id(published_id).one(db).await? else {
        return Ok(());
    };
    match comp::Entity::delete_by_id(published_id).exec(db).await {
        Ok(_) => Ok(()),
        Err(err) => match err.sql_err() {
            Some(sea_orm::SqlErr::ForeignKeyConstraintViolation(_)) => {
                let mut active: comp::ActiveModel = existing.into();
                active.archived_at = Set(Some(chrono::Utc::now().into()));
                active.updated_at = Set(chrono::Utc::now().into());
                active.update(db).await?;
                Ok(())
            }
            _ => Err(AppError::Database(err)),
        },
    }
}
/// Copy (or refresh) a split snapshot into `dest`. Returns the published split id.
///
/// Does not write the source split (no Discord forum watermark bump) and does not create
/// `split_discord_sync` rows on either side.
async fn copy_split_graph(
    source: &DatabaseConnection,
    dest: &DatabaseConnection,
    source_split_id: i64,
    dest_creator_id: i64,
    published_id: Option<i64>,
) -> Result<i64, AppError> {
    let source_split = split_row::Entity::find_by_id(source_split_id)
        .one(source)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Split {source_split_id} not found")))?;
    let source_bags = split_bag::Entity::find()
        .filter(SplitBagColumn::SplitId.eq(source_split.id))
        .order_by_asc(SplitBagColumn::Id)
        .all(source)
        .await?;
    let source_participants = split_participant::Entity::find()
        .filter(ParticipantColumn::SplitId.eq(source_split.id))
        .all(source)
        .await?;

    let mut dest_user_ids = std::collections::HashMap::new();
    dest_user_ids.insert(source_split.created_by, dest_creator_id);
    for participant in &source_participants {
        if dest_user_ids.contains_key(&participant.user_id) {
            continue;
        }
        let dest_id = resolve_copied_user(source, dest, participant.user_id).await?;
        dest_user_ids.insert(participant.user_id, dest_id);
    }

    let txn = dest.begin().await?;
    let dest_tab_id = ensure_island_tab(source, &txn, source_split.island_tab_id).await?;
    let dest_split_id = if let Some(existing_id) = published_id {
        if let Some(existing) = split_row::Entity::find_by_id(existing_id).one(&txn).await? {
            let mut active: split_row::ActiveModel = existing.into();
            active.status = Set(source_split.status.clone());
            active.estimated_market_value = Set(source_split.estimated_market_value);
            active.fee = Set(source_split.fee);
            active.repair_value = Set(source_split.repair_value);
            active.bags_value = Set(source_split.bags_value);
            active.net_value = Set(source_split.net_value);
            active.note = Set(source_split.note.clone());
            active.event_id = Set(None);
            active.island_tab_id = Set(dest_tab_id);
            active.finalized_at = Set(source_split.finalized_at);
            active.archived_at = Set(None);
            active.origin_read_only = Set(true);
            active.updated_at = Set(chrono::Utc::now().into());
            active.update(&txn).await?;
            split_bag::Entity::delete_many()
                .filter(SplitBagColumn::SplitId.eq(existing_id))
                .exec(&txn)
                .await?;
            split_participant::Entity::delete_many()
                .filter(ParticipantColumn::SplitId.eq(existing_id))
                .exec(&txn)
                .await?;
            existing_id
        } else {
            insert_split_row(&txn, &source_split, dest_creator_id, dest_tab_id).await?
        }
    } else {
        insert_split_row(&txn, &source_split, dest_creator_id, dest_tab_id).await?
    };

    for bag in source_bags {
        split_bag::ActiveModel {
            split_id: Set(dest_split_id),
            amount: Set(bag.amount),
            ..Default::default()
        }
        .insert(&txn)
        .await?;
    }
    for participant in source_participants {
        let Some(dest_user_id) = dest_user_ids.get(&participant.user_id).copied() else {
            continue;
        };
        split_participant::ActiveModel {
            split_id: Set(dest_split_id),
            user_id: Set(dest_user_id),
            weight: Set(participant.weight),
            ..Default::default()
        }
        .insert(&txn)
        .await?;
    }

    txn.commit().await?;
    Ok(dest_split_id)
}

async fn insert_split_row(
    db: &impl ConnectionTrait,
    source: &split_row::Model,
    created_by: i64,
    island_tab_id: Option<i64>,
) -> Result<i64, AppError> {
    let inserted = split_row::ActiveModel {
        created_by: Set(created_by),
        status: Set(source.status.clone()),
        estimated_market_value: Set(source.estimated_market_value),
        fee: Set(source.fee),
        repair_value: Set(source.repair_value),
        bags_value: Set(source.bags_value),
        net_value: Set(source.net_value),
        note: Set(source.note.clone()),
        event_id: Set(None),
        island_tab_id: Set(island_tab_id),
        finalized_at: Set(source.finalized_at),
        archived_at: Set(None),
        origin_read_only: Set(true),
        ..Default::default()
    }
    .insert(db)
    .await?;
    Ok(inserted.id)
}

async fn ensure_island_tab(
    source: &DatabaseConnection,
    dest: &impl ConnectionTrait,
    source_tab_id: Option<i64>,
) -> Result<Option<i64>, AppError> {
    let Some(tab_id) = source_tab_id else {
        return Ok(None);
    };
    let Some(tab) = split_tab::Entity::find_by_id(tab_id).one(source).await? else {
        return Ok(None);
    };
    let Some(island) = split_island::Entity::find_by_id(tab.island_id)
        .one(source)
        .await?
    else {
        return Ok(None);
    };
    let dest_island = if let Some(existing) = split_island::Entity::find()
        .filter(IslandColumn::City.eq(&island.city))
        .filter(IslandColumn::Name.eq(&island.name))
        .one(dest)
        .await?
    {
        existing
    } else {
        split_island::ActiveModel {
            name: Set(island.name.clone()),
            city: Set(island.city.clone()),
            ..Default::default()
        }
        .insert(dest)
        .await?
    };
    if let Some(existing_tab) = split_tab::Entity::find()
        .filter(TabColumn::IslandId.eq(dest_island.id))
        .filter(TabColumn::Name.eq(&tab.name))
        .one(dest)
        .await?
    {
        return Ok(Some(existing_tab.id));
    }
    let inserted = split_tab::ActiveModel {
        island_id: Set(dest_island.id),
        name: Set(tab.name.clone()),
        sort_order: Set(tab.sort_order),
        ..Default::default()
    }
    .insert(dest)
    .await?;
    Ok(Some(inserted.id))
}

async fn resolve_copied_user(
    source: &DatabaseConnection,
    dest: &DatabaseConnection,
    source_user_id: i64,
) -> Result<i64, AppError> {
    let Some(user) = UserEntity::find_by_id(source_user_id).one(source).await? else {
        return upsert_alliance_user(
            dest,
            &ShareActor {
                discord_id: format!("share-user-{source_user_id}"),
                username: format!("user-{source_user_id}"),
                email: None,
            },
        )
        .await;
    };
    upsert_alliance_user(
        dest,
        &ShareActor {
            discord_id: user
                .discord_id
                .clone()
                .unwrap_or_else(|| format!("share-user-{source_user_id}")),
            username: user.username,
            email: Some(user.email),
        },
    )
    .await
}

async fn delete_or_hide_published_split(
    db: &DatabaseConnection,
    published_id: i64,
) -> Result<(), AppError> {
    let Some(existing) = split_row::Entity::find_by_id(published_id).one(db).await? else {
        return Ok(());
    };
    split_bag::Entity::delete_many()
        .filter(SplitBagColumn::SplitId.eq(published_id))
        .exec(db)
        .await?;
    split_participant::Entity::delete_many()
        .filter(ParticipantColumn::SplitId.eq(published_id))
        .exec(db)
        .await?;
    split_discord_sync::Entity::delete_by_id(published_id)
        .exec(db)
        .await?;
    match split_row::Entity::delete_by_id(published_id).exec(db).await {
        Ok(_) => Ok(()),
        Err(err) => match err.sql_err() {
            Some(sea_orm::SqlErr::ForeignKeyConstraintViolation(_)) => {
                let mut active: split_row::ActiveModel = existing.into();
                active.archived_at = Set(Some(chrono::Utc::now().into()));
                active.updated_at = Set(chrono::Utc::now().into());
                active.origin_read_only = Set(true);
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
    use crate::modules::comps::models::AddCompBuildRequest;
    use crate::modules::comps::models::BuildFilters;
    use crate::modules::comps::models::CompFilters;
    use crate::modules::comps::models::CreateCompRequest;
    use crate::modules::comps::models::UpdateCompBuildQuantityRequest;
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

    fn share_comp_req(id: i64) -> CreateAllianceShareRequest {
        CreateAllianceShareRequest {
            artifact_type: ArtifactType::Comp,
            id,
        }
    }

    fn empty_comp_filters() -> CompFilters {
        CompFilters {
            category_id: None,
            q: None,
            search: None,
            date_from: None,
            date_to: None,
            sort: None,
            order: None,
            archived: None,
        }
    }

    fn empty_build_filters() -> BuildFilters {
        BuildFilters {
            role: None,
            category_id: None,
            q: None,
            search: None,
            sort: None,
            order: None,
            archived: None,
        }
    }

    fn page50() -> PaginationParams {
        PaginationParams {
            page: Some(1),
            limit: Some(50),
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

    #[tokio::test]
    async fn unauthorized_comp_share_is_forbidden() {
        let db = seed_sqlite().await;
        let err = AllianceShareService::share_comp(
            &db,
            &TenantRegistry::new(String::new(), db.clone()),
            &db,
            ShareParams {
                source_tenant_id: "guild-1",
                source_kind: "guild",
                actor: &actor("officer-1"),
                authorized: false,
            },
            share_comp_req(1),
        )
        .await
        .expect_err("forbidden");
        match err {
            AppError::Forbidden(msg) => assert!(msg.contains("alliance.share")),
            other => panic!("expected forbidden, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn share_comp_from_alliance_tenant_is_bad_request() {
        let db = seed_sqlite().await;
        let err = AllianceShareService::share_comp(
            &db,
            &TenantRegistry::new(String::new(), db.clone()),
            &db,
            ShareParams {
                source_tenant_id: "alliance-1",
                source_kind: "alliance",
                actor: &actor("officer-1"),
                authorized: true,
            },
            share_comp_req(1),
        )
        .await
        .expect_err("validation");
        match err {
            AppError::Validation(msg) => assert!(msg.contains("alliance tenant")),
            other => panic!("expected validation, got {other:?}"),
        }
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn copy_comp_graph_maps_builds_and_quantities_into_the_other_schema() {
        let source = seed_sqlite().await;
        let dest = seed_sqlite().await;
        let src_user = insert_user(&source, "maker", "maker@example.com").await;
        let dest_user = insert_user(&dest, "maker", "maker@example.com").await;
        let comps = CompService::new();
        let src_build_cat = comps
            .create_build_category(
                &source,
                crate::modules::comps::models::CreateBuildCategoryRequest {
                    name: "Crystal".to_owned(),
                    description: None,
                },
            )
            .await
            .expect("src build cat");
        let dest_build_cat = comps
            .create_build_category(
                &dest,
                crate::modules::comps::models::CreateBuildCategoryRequest {
                    name: "Crystal".to_owned(),
                    description: None,
                },
            )
            .await
            .expect("dest build cat");
        let src_mace = comps
            .create_build(
                &source,
                src_user,
                crate::modules::comps::models::CreateBuildRequest {
                    name: "Heavy Mace".to_owned(),
                    description: None,
                    role: BuildRole::Dps,
                    category_id: src_build_cat.id,
                    items: None,
                },
            )
            .await
            .expect("src mace");
        let dest_mace = comps
            .create_build(
                &dest,
                dest_user,
                crate::modules::comps::models::CreateBuildRequest {
                    name: "Heavy Mace".to_owned(),
                    description: None,
                    role: BuildRole::Dps,
                    category_id: dest_build_cat.id,
                    items: None,
                },
            )
            .await
            .expect("dest mace");
        let src_holy = comps
            .create_build(
                &source,
                src_user,
                crate::modules::comps::models::CreateBuildRequest {
                    name: "Holy Staff".to_owned(),
                    description: None,
                    role: BuildRole::Healer,
                    category_id: src_build_cat.id,
                    items: None,
                },
            )
            .await
            .expect("src holy");
        let dest_holy = comps
            .create_build(
                &dest,
                dest_user,
                crate::modules::comps::models::CreateBuildRequest {
                    name: "Holy Staff".to_owned(),
                    description: None,
                    role: BuildRole::Healer,
                    category_id: dest_build_cat.id,
                    items: None,
                },
            )
            .await
            .expect("dest holy");
        let src_comp_cat = comps
            .create_comp_category(
                &source,
                crate::modules::comps::models::CreateCompCategoryRequest {
                    name: "ZvZ".to_owned(),
                    description: None,
                },
            )
            .await
            .expect("src comp cat");
        let created = comps
            .create_comp(
                &source,
                src_user,
                CreateCompRequest {
                    name: "Main ZvZ".to_owned(),
                    description: Some("20 man".to_owned()),
                    category_id: src_comp_cat.id,
                    builds: vec![
                        AddCompBuildRequest {
                            build_id: src_mace.summary.id,
                            quantity: 12,
                        },
                        AddCompBuildRequest {
                            build_id: src_holy.summary.id,
                            quantity: 8,
                        },
                    ],
                    parent_id: None,
                },
            )
            .await
            .expect("comp");

        let mut mapping = HashMap::new();
        mapping.insert(src_mace.summary.id, dest_mace.summary.id);
        mapping.insert(src_holy.summary.id, dest_holy.summary.id);

        let published_id = copy_comp_graph(
            &source,
            &dest,
            created.summary.id,
            dest_user,
            &mapping,
            None,
        )
        .await
        .expect("copy");

        let copied = comps.get_comp(&dest, published_id).await.expect("copied");
        assert_eq!(copied.summary.name, "Main ZvZ");
        assert_eq!(copied.summary.category_name.as_deref(), Some("ZvZ"));
        assert_eq!(copied.summary.parent_id, None);
        assert_eq!(copied.builds.len(), 2);
        let by_name: HashMap<_, _> = copied
            .builds
            .iter()
            .map(|row| (row.build.name.as_str(), (row.build_id, row.quantity)))
            .collect();
        assert_eq!(by_name["Heavy Mace"], (dest_mace.summary.id, 12));
        assert_eq!(by_name["Holy Staff"], (dest_holy.summary.id, 8));

        comps
            .update_comp_build_quantity(
                &source,
                created.summary.id,
                src_mace.summary.id,
                UpdateCompBuildQuantityRequest { quantity: 15 },
            )
            .await
            .expect("qty");
        let again = copy_comp_graph(
            &source,
            &dest,
            created.summary.id,
            dest_user,
            &mapping,
            Some(published_id),
        )
        .await
        .expect("recopy");
        assert_eq!(again, published_id);
        let refreshed = comps.get_comp(&dest, published_id).await.expect("refresh");
        let mace_qty = refreshed
            .builds
            .iter()
            .find(|row| row.build.name == "Heavy Mace")
            .map(|row| row.quantity);
        assert_eq!(mace_qty, Some(15));
        let count = comp::Entity::find().all(&dest).await.expect("all").len();
        assert_eq!(count, 1, "re-share must not duplicate the published comp");
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn share_copies_comp_and_missing_builds_into_alliance_schema() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_shcomp");
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
        let build_cat = comps
            .create_build_category(
                &guild_ctx.db,
                crate::modules::comps::models::CreateBuildCategoryRequest {
                    name: "Crystal".to_owned(),
                    description: None,
                },
            )
            .await
            .expect("build cat");
        let mace = comps
            .create_build(
                &guild_ctx.db,
                src_user,
                crate::modules::comps::models::CreateBuildRequest {
                    name: "Heavy Mace".to_owned(),
                    description: None,
                    role: BuildRole::Dps,
                    category_id: build_cat.id,
                    items: None,
                },
            )
            .await
            .expect("mace");
        let holy = comps
            .create_build(
                &guild_ctx.db,
                src_user,
                crate::modules::comps::models::CreateBuildRequest {
                    name: "Holy Staff".to_owned(),
                    description: None,
                    role: BuildRole::Healer,
                    category_id: build_cat.id,
                    items: None,
                },
            )
            .await
            .expect("holy");
        let comp_cat = comps
            .create_comp_category(
                &guild_ctx.db,
                crate::modules::comps::models::CreateCompCategoryRequest {
                    name: "ZvZ".to_owned(),
                    description: None,
                },
            )
            .await
            .expect("comp cat");
        let created = comps
            .create_comp(
                &guild_ctx.db,
                src_user,
                CreateCompRequest {
                    name: "Main ZvZ".to_owned(),
                    description: Some("20 man".to_owned()),
                    category_id: comp_cat.id,
                    builds: vec![
                        AddCompBuildRequest {
                            build_id: mace.summary.id,
                            quantity: 12,
                        },
                        AddCompBuildRequest {
                            build_id: holy.summary.id,
                            quantity: 8,
                        },
                    ],
                    parent_id: None,
                },
            )
            .await
            .expect("comp");

        let officer = actor("officer-1");
        let params = ShareParams {
            source_tenant_id: guild_id.as_str(),
            source_kind: "guild",
            actor: &officer,
            authorized: true,
        };
        let already = AllianceShareService::share_build(
            &control,
            &registry,
            &guild_ctx.db,
            ShareParams {
                source_tenant_id: params.source_tenant_id,
                source_kind: params.source_kind,
                actor: params.actor,
                authorized: params.authorized,
            },
            share_req(mace.summary.id),
        )
        .await
        .expect("pre-share mace");

        let first = AllianceShareService::share_comp(
            &control,
            &registry,
            &guild_ctx.db,
            ShareParams {
                source_tenant_id: params.source_tenant_id,
                source_kind: params.source_kind,
                actor: params.actor,
                authorized: params.authorized,
            },
            share_comp_req(created.summary.id),
        )
        .await
        .expect("share comp");
        assert_eq!(first.alliance_tenant_id, alliance_id);
        assert_eq!(first.source_id, created.summary.id);
        assert_eq!(first.artifact_type, "comp");

        let alliance_ctx = registry
            .get_or_load(&alliance_id)
            .await
            .expect("alliance ctx");
        let listed = comps
            .list_comps(&alliance_ctx.db, empty_comp_filters(), page50())
            .await
            .expect("list comps");
        assert_eq!(listed.items.len(), 1);
        assert_eq!(listed.items[0].name, "Main ZvZ");
        assert_eq!(listed.items[0].id, first.published_id);
        assert_eq!(listed.items[0].category_name.as_deref(), Some("ZvZ"));
        assert_eq!(listed.items[0].total_quantity, 20);

        let published = comps
            .get_comp(&alliance_ctx.db, first.published_id)
            .await
            .expect("published detail");
        assert_eq!(published.builds.len(), 2);
        let by_name: HashMap<_, _> = published
            .builds
            .iter()
            .map(|row| (row.build.name.as_str(), row.quantity))
            .collect();
        assert_eq!(by_name["Heavy Mace"], 12);
        assert_eq!(by_name["Holy Staff"], 8);
        let mace_entry = published
            .builds
            .iter()
            .find(|row| row.build.name == "Heavy Mace")
            .expect("mace entry");
        assert_eq!(
            mace_entry.build_id, already.published_id,
            "already-shared build must be reused"
        );

        let alliance_builds = comps
            .list_builds(&alliance_ctx.db, empty_build_filters(), page50())
            .await
            .expect("list builds");
        assert_eq!(
            alliance_builds.items.len(),
            2,
            "missing holy staff is auto-published; mace is not duplicated"
        );

        comps
            .update_comp_build_quantity(
                &guild_ctx.db,
                created.summary.id,
                mace.summary.id,
                UpdateCompBuildQuantityRequest { quantity: 14 },
            )
            .await
            .expect("edit qty");
        let second = AllianceShareService::share_comp(
            &control,
            &registry,
            &guild_ctx.db,
            params,
            share_comp_req(created.summary.id),
        )
        .await
        .expect("reshare");
        assert_eq!(second.id, first.id);
        assert_eq!(second.published_id, first.published_id);
        let refreshed = comps
            .get_comp(&alliance_ctx.db, first.published_id)
            .await
            .expect("refreshed");
        let mace_qty = refreshed
            .builds
            .iter()
            .find(|row| row.build.name == "Heavy Mace")
            .map(|row| row.quantity);
        assert_eq!(mace_qty, Some(14));
        let still_builds = comps
            .list_builds(&alliance_ctx.db, empty_build_filters(), page50())
            .await
            .expect("builds after reshare");
        assert_eq!(still_builds.items.len(), 2);

        AllianceShareService::unshare_comp(
            &control,
            &registry,
            ShareParams {
                source_tenant_id: &guild_id,
                source_kind: "guild",
                actor: &actor("officer-1"),
                authorized: true,
            },
            created.summary.id,
        )
        .await
        .expect("unshare");
        let after = comps
            .list_comps(&alliance_ctx.db, empty_comp_filters(), page50())
            .await
            .expect("list after unshare");
        assert!(
            after.items.is_empty(),
            "unshare must drop the alliance comp"
        );
        let leftover_builds = comps
            .list_builds(&alliance_ctx.db, empty_build_filters(), page50())
            .await
            .expect("builds after unshare");
        assert_eq!(
            leftover_builds.items.len(),
            2,
            "unshare of a comp must not delete previously shared builds"
        );
        let status =
            AllianceShareService::comp_share_status(&control, &guild_id, created.summary.id)
                .await
                .expect("status");
        assert!(!status.shared);

        drop_schema(&admin, &guild.schema_name)
            .await
            .expect("drop guild");
        drop_schema(&admin, &alliance.schema_name)
            .await
            .expect("drop alliance");
        drop_schema(&admin, &schema).await.expect("drop");
    }
    fn split_share_req(id: i64) -> CreateAllianceShareRequest {
        CreateAllianceShareRequest {
            artifact_type: ArtifactType::Split,
            id,
        }
    }

    async fn seed_guild_split(
        db: &DatabaseConnection,
        creator: i64,
        participant: i64,
    ) -> crate::modules::splits::models::SplitDetail {
        use crate::modules::splits::models::{
            CreateIslandRequest, CreateSplitRequest, UpsertParticipantRequest,
        };
        use crate::modules::splits::service::SplitService;
        use sea_orm::prelude::Decimal;
        let service = SplitService::new();
        let island = service
            .create_island(
                db,
                CreateIslandRequest {
                    name: "HQ".to_owned(),
                    city: "lymhurst".to_owned(),
                    tabs: vec!["Loot".to_owned()],
                },
            )
            .await
            .expect("island");
        let mut req = CreateSplitRequest {
            estimated_market_value: "100.00".parse().unwrap(),
            fee: Some(Decimal::new(20, 0)),
            repair_value: "5.00".parse().unwrap(),
            bags_value: Decimal::ZERO,
            bags: vec!["15.00".parse().unwrap(), "10.00".parse().unwrap()],
            note: Some("Avalon chest".to_owned()),
            event_id: None,
            island_tab_id: island.tabs[0].id,
            participants: vec![UpsertParticipantRequest {
                user_id: participant,
                weight: Decimal::ONE,
            }],
        };
        req.island_tab_id = island.tabs[0].id;
        service.create_split(db, creator, req).await.expect("split")
    }

    #[tokio::test]
    async fn copy_split_graph_is_read_only_and_does_not_touch_guild_discord_sync() {
        use crate::modules::splits::models::UpdateSplitRequest;
        use crate::modules::splits::service::SplitService;
        use crate::modules::splits::status::SplitStatus;
        let source = seed_sqlite().await;
        let dest = seed_sqlite().await;
        let src_user = insert_user(&source, "officer", "officer@example.com").await;
        let alice = insert_user(&source, "alice", "alice@example.com").await;
        let dest_user = insert_user(&dest, "officer", "officer@example.com").await;
        let created = seed_guild_split(&source, src_user, alice).await;
        split_discord_sync::ActiveModel {
            split_id: Set(created.summary.id),
            thread_id: Set(Some("thread-1".to_owned())),
            last_audit_id: Set(0),
            last_transaction_id: Set(0),
            ..Default::default()
        }
        .insert(&source)
        .await
        .expect("guild discord sync");
        let source_updated = split_row::Entity::find_by_id(created.summary.id)
            .one(&source)
            .await
            .expect("load")
            .expect("row")
            .updated_at;

        let published_id = copy_split_graph(&source, &dest, created.summary.id, dest_user, None)
            .await
            .expect("copy");

        let copied = SplitService::new()
            .get_split(&dest, published_id)
            .await
            .expect("copied");
        assert!(copied.summary.origin_read_only);
        assert_eq!(copied.summary.status, SplitStatus::Pending);
        assert_eq!(copied.summary.note.as_deref(), Some("Avalon chest"));
        assert_eq!(copied.summary.fee, "20".parse().unwrap());
        assert_eq!(copied.bags.len(), 2);
        assert_eq!(copied.participants.len(), 1);
        assert_eq!(copied.participants[0].username, "alice");
        assert_eq!(copied.summary.event_id, None);

        let complete_err = SplitService::for_tenant("alliance")
            .complete_split(&dest, published_id, dest_user)
            .await
            .expect_err("alliance complete");
        match complete_err {
            AppError::Forbidden(msg) => assert!(msg.contains("read-only")),
            other => panic!("expected forbidden, got {other:?}"),
        }
        let bags_err = SplitService::new()
            .update_split(
                &dest,
                published_id,
                UpdateSplitRequest {
                    estimated_market_value: None,
                    fee: None,
                    repair_value: None,
                    bags_value: None,
                    bags: Some(vec!["1.00".parse().unwrap()]),
                    note: None,
                    event_id: None,
                    island_tab_id: None,
                    participants: None,
                },
            )
            .await
            .expect_err("bags");
        match bags_err {
            AppError::Forbidden(_) => {}
            other => panic!("expected forbidden, got {other:?}"),
        }

        let guild_sync = split_discord_sync::Entity::find_by_id(created.summary.id)
            .one(&source)
            .await
            .expect("sync")
            .expect("still there");
        assert_eq!(guild_sync.thread_id.as_deref(), Some("thread-1"));
        let after = split_row::Entity::find_by_id(created.summary.id)
            .one(&source)
            .await
            .expect("load")
            .expect("row");
        assert_eq!(after.updated_at, source_updated);
        assert!(!after.origin_read_only);
        let dest_sync = split_discord_sync::Entity::find()
            .all(&dest)
            .await
            .expect("dest sync");
        assert!(dest_sync.is_empty());
    }

    #[tokio::test]
    async fn share_split_copies_into_alliance_schema_and_unshare_hides_it() {
        use crate::modules::splits::service::SplitService;
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_splsh");
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
        let alice = user_entities::ActiveModel {
            username: Set("alice".to_owned()),
            email: Set("alice@example.com".to_owned()),
            role: Set("User".to_owned()),
            discord_id: Set(Some("alice-discord".to_owned())),
            ..Default::default()
        }
        .insert(&guild_ctx.db)
        .await
        .expect("alice")
        .id;
        let created = seed_guild_split(&guild_ctx.db, src_user, alice).await;

        let first = AllianceShareService::share_split(
            &control,
            &registry,
            &guild_ctx.db,
            ShareParams {
                source_tenant_id: &guild_id,
                source_kind: "guild",
                actor: &actor("officer-1"),
                authorized: true,
            },
            split_share_req(created.summary.id),
        )
        .await
        .expect("share");
        assert_eq!(first.alliance_tenant_id, alliance_id);
        assert_eq!(first.artifact_type, ARTIFACT_SPLIT);

        let alliance_ctx = registry
            .get_or_load(&alliance_id)
            .await
            .expect("alliance ctx");
        let listed = SplitService::new()
            .list_splits(
                &alliance_ctx.db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(50),
                },
                &crate::modules::splits::models::SplitFilters::default(),
            )
            .await
            .expect("list");
        assert_eq!(listed.items.len(), 1);
        assert_eq!(listed.items[0].id, first.published_id);
        assert!(listed.items[0].origin_read_only);
        assert_eq!(listed.items[0].note.as_deref(), Some("Avalon chest"));

        let second = AllianceShareService::share_split(
            &control,
            &registry,
            &guild_ctx.db,
            ShareParams {
                source_tenant_id: &guild_id,
                source_kind: "guild",
                actor: &actor("officer-1"),
                authorized: true,
            },
            split_share_req(created.summary.id),
        )
        .await
        .expect("reshare");
        assert_eq!(second.id, first.id);
        assert_eq!(second.published_id, first.published_id);

        AllianceShareService::unshare_split(
            &control,
            &registry,
            ShareParams {
                source_tenant_id: &guild_id,
                source_kind: "guild",
                actor: &actor("officer-1"),
                authorized: true,
            },
            created.summary.id,
        )
        .await
        .expect("unshare");
        let hidden = SplitService::new()
            .list_splits(
                &alliance_ctx.db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(50),
                },
                &crate::modules::splits::models::SplitFilters::default(),
            )
            .await
            .expect("list after unshare");
        assert!(hidden.items.is_empty());
        let status =
            AllianceShareService::split_share_status(&control, &guild_id, created.summary.id)
                .await
                .expect("status");
        assert!(!status.shared);
        SplitService::new()
            .get_split(&guild_ctx.db, created.summary.id)
            .await
            .expect("guild split remains");

        drop_schema(&admin, &guild.schema_name)
            .await
            .expect("drop guild");
        drop_schema(&admin, &alliance.schema_name)
            .await
            .expect("drop alliance");
        drop_schema(&admin, &schema).await.expect("drop");
    }
}
