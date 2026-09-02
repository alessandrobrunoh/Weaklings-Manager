//! Comp service logic module.
//!
//! Provides CRUD operations for build categories, comp categories, builds (with per-slot
//! items sourced from OpenAlbion), and comps (compositions that group builds with a quantity).

use std::collections::{BTreeMap, HashSet};
use std::str::FromStr;

use sea_orm::prelude::DateTimeWithTimeZone;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait,
    PaginatorTrait, QueryFilter, QueryOrder, TransactionTrait,
};

use sea_orm::sea_query::{Expr, Func};

use crate::errors::{AppError, BlockingReference};
use crate::modules::events::entities::{
    event, event_participation, event_roster_role,
    event_participation::Column as EventParticipationColumn,
    event_roster_role::Column as EventRosterRoleColumn,
};
use crate::pagination::{PaginatedData, PaginationParams, SortOrder, resolve_sort_key};

use super::entities::{
    build, build_category, build_item, build_item_spell, comp, comp_build, comp_category,
};
use super::entities::{
    build::Column as BuildColumn, build_category::Column as BuildCategoryColumn,
    build_item::Column as BuildItemColumn, build_item_spell::Column as BuildItemSpellColumn,
    comp::Column as CompColumn, comp_build::Column as CompBuildColumn,
};
use super::models::{
    AddCompBuildRequest, BuildCategoryView, BuildDetail, BuildFilters, BuildItemSpells,
    BuildItemView, BuildSummary, BuildVersionRef, CompBuildView, CompCategoryView, CompDetail,
    CompFilters, CompSummary, CreateBuildCategoryRequest, CreateBuildRequest,
    CreateCompCategoryRequest, CreateCompRequest, UpdateBuildCategoryRequest, UpdateBuildRequest,
    UpdateCompBuildQuantityRequest, UpdateCompCategoryRequest, UpdateCompRequest,
    UpsertBuildItemRequest,
};
use super::status::{BuildLoadout, BuildRole, BuildSlot};

/// The two kinds of ability slot, as stored in `build_item_spells.kind`.
const ACTIVE_KIND: &str = "active";
const PASSIVE_KIND: &str = "passive";

/// Returns the current UTC timestamp as a `DateTimeWithTimeZone`, used for `updated_at`.
fn now() -> DateTimeWithTimeZone {
    chrono::Utc::now().into()
}

/// Generates a URL-friendly slug from a name: lowercase, spaces → hyphens.
fn slugify(name: &str) -> String {
    name.to_lowercase().replace(' ', "-")
}

/// Parses a build model's stored role string into a [`BuildRole`].
fn parse_role(build: &build::Model) -> Result<BuildRole, AppError> {
    BuildRole::from_str(&build.role)
        .map_err(|_| AppError::Internal(format!("Unknown build role: {}", build.role)))
}

/// Parses a build item model's stored slot string into a [`BuildSlot`].
fn parse_slot(item: &build_item::Model) -> Result<BuildSlot, AppError> {
    BuildSlot::from_str(&item.slot)
        .map_err(|_| AppError::Internal(format!("Unknown build slot: {}", item.slot)))
}

/// Reads a stored item's loadout, failing loudly on a value the code does not know.
fn parse_loadout(item: &build_item::Model) -> Result<BuildLoadout, AppError> {
    BuildLoadout::from_str(&item.loadout)
        .map_err(|_| AppError::Internal(format!("Unknown build loadout: {}", item.loadout)))
}

/// The `spell_id` values chosen on one equipped item, grouped by kind.
async fn read_item_spells(
    db: &DatabaseConnection,
    build_item_id: i64,
) -> Result<BuildItemSpells, AppError> {
    let rows = build_item_spell::Entity::find()
        .filter(BuildItemSpellColumn::BuildItemId.eq(build_item_id))
        .all(db)
        .await?;

    let mut spells = BuildItemSpells::default();
    for row in rows {
        let bucket = match row.kind.as_str() {
            ACTIVE_KIND => &mut spells.active,
            PASSIVE_KIND => &mut spells.passive,
            other => {
                return Err(AppError::Internal(format!("Unknown ability kind: {other}")));
            }
        };
        bucket.insert(row.slot_index.to_string(), row.spell_id);
    }
    Ok(spells)
}

/// Rejects an ability the equipped item does not actually offer in that slot.
///
/// The bundled ability catalog is keyed by the tier-stripped base identifier, so a T4 and a T8
/// Broadsword validate against the same list. An item whose identifier is not in the catalog — a
/// cape, a potion — offers nothing, so any choice on it is refused.
fn validate_ability_choice(
    item: &build_item::Model,
    kind: &str,
    slot_index: i32,
    spell_id: &str,
) -> Result<(), AppError> {
    let base = crate::modules::openalbion::service::base_identifier_for_stored_item(
        item.openalbion_item_id,
        item.openalbion_item_icon.as_deref(),
    )
    .ok_or_else(|| {
        AppError::Validation(format!(
            "{} offers no abilities to choose",
            item.openalbion_item_name
        ))
    })?;
    let abilities = crate::modules::openalbion::service::ability_catalog()
        .get(&base)
        .ok_or_else(|| {
            AppError::Validation(format!(
                "{} offers no abilities to choose",
                item.openalbion_item_name
            ))
        })?;

    let (groups, declared) = match kind {
        ACTIVE_KIND => (&abilities.active, abilities.active_slots),
        PASSIVE_KIND => (&abilities.passive, abilities.passive_slots),
        other => {
            return Err(AppError::Validation(format!(
                "unknown ability kind: {other}"
            )));
        }
    };

    if slot_index < 1 || slot_index > declared {
        return Err(AppError::Validation(format!(
            "{} has {declared} {kind} ability slot(s), so slot {slot_index} does not exist",
            item.openalbion_item_name
        )));
    }

    let offered = groups
        .get(&slot_index.to_string())
        .is_some_and(|choices| choices.iter().any(|choice| choice.id == spell_id));
    if !offered {
        return Err(AppError::Validation(format!(
            "{} does not offer {spell_id} in {kind} slot {slot_index}",
            item.openalbion_item_name
        )));
    }
    Ok(())
}

/// Resolves a user's display name by id, returning `"Unknown"` if the user no longer exists.
async fn username_of(db: &DatabaseConnection, user_id: i64) -> Result<String, AppError> {
    crate::modules::users::display_name::resolve_by_id(db, user_id).await
}

/// Every build sharing one `(name, category)` identity, oldest version first.
///
/// The group *is* the identity pair — there is no separate group id — so the lookup uses the same
/// trimmed, case-insensitive comparison as the uniqueness check, and a row whose name differs only
/// in case still belongs to its group.
async fn build_version_group(
    db: &DatabaseConnection,
    name: &str,
    category_id: i64,
) -> Result<Vec<build::Model>, AppError> {
    let key = identity_key(name);
    let mut group: Vec<build::Model> = build::Entity::find()
        .filter(BuildColumn::CategoryId.eq(category_id))
        .all(db)
        .await?
        .into_iter()
        .filter(|candidate| identity_key(&candidate.name) == key)
        .collect();
    group.sort_by_key(|candidate| candidate.version);
    Ok(group)
}

/// Every comp sharing one `(name, category)` identity, oldest version first.
///
/// See [`build_version_group`]; comps follow the same rule, and `parent_id` is independent of it.
async fn comp_version_group(
    db: &DatabaseConnection,
    name: &str,
    category_id: i64,
) -> Result<Vec<comp::Model>, AppError> {
    let key = identity_key(name);
    let mut group: Vec<comp::Model> = comp::Entity::find()
        .filter(CompColumn::CategoryId.eq(category_id))
        .all(db)
        .await?
        .into_iter()
        .filter(|candidate| identity_key(&candidate.name) == key)
        .collect();
    group.sort_by_key(|candidate| candidate.version);
    Ok(group)
}

/// Clears ability choices that the item now in the slot does not offer.
///
/// Swapping a Broadsword for a Holy Staff leaves the staff's slots empty rather than showing a
/// sword ability the player cannot actually cast. Choices the new item still offers are kept, so
/// re-tiering an item does not wipe the officer's work.
async fn drop_abilities_the_item_no_longer_offers(
    db: &DatabaseConnection,
    item: &build_item::Model,
    build_item_id: i64,
) -> Result<(), AppError> {
    let rows = build_item_spell::Entity::find()
        .filter(BuildItemSpellColumn::BuildItemId.eq(build_item_id))
        .all(db)
        .await?;

    for row in rows {
        if validate_ability_choice(item, &row.kind, row.slot_index, &row.spell_id).is_err() {
            build_item_spell::Entity::delete_by_id(row.id)
                .exec(db)
                .await?;
        }
    }
    Ok(())
}

/// Service for executing business logic operations related to comps.
pub struct CompService;

/// Normalizes a build or comp name for identity comparison.
///
/// Identity is the `(name, category)` pair, compared trimmed and case-insensitively so that
/// `"  pole hammer  "` cannot slip past `"Pole Hammer"`. The comparison lives here rather than in
/// a database index so it behaves identically on every supported backend regardless of collation.
fn identity_key(name: &str) -> String {
    name.trim().to_lowercase()
}

impl CompService {
    /// Creates a new instance of the `CompService`.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    // ===== Build Categories =====

    /// Lists all build categories, ordered by name.
    pub async fn list_build_categories(
        &self,
        db: &DatabaseConnection,
    ) -> Result<Vec<BuildCategoryView>, AppError> {
        let categories = build_category::Entity::find()
            .order_by_asc(BuildCategoryColumn::Name)
            .all(db)
            .await?;

        Ok(categories
            .into_iter()
            .map(|c| BuildCategoryView {
                id: c.id,
                name: c.name,
                slug: c.slug,
                description: c.description,
                created_at: c.created_at.to_rfc3339(),
            })
            .collect())
    }

    /// Creates a new build category. The slug is derived from the name.
    pub async fn create_build_category(
        &self,
        db: &DatabaseConnection,
        req: CreateBuildCategoryRequest,
    ) -> Result<BuildCategoryView, AppError> {
        let active = build_category::ActiveModel {
            name: Set(req.name.clone()),
            slug: Set(slugify(&req.name)),
            description: Set(req.description),
            ..Default::default()
        };
        let category = active.insert(db).await?;

        Ok(BuildCategoryView {
            id: category.id,
            name: category.name,
            slug: category.slug,
            description: category.description,
            created_at: category.created_at.to_rfc3339(),
        })
    }

    /// Updates a build category's name and/or description.
    pub async fn update_build_category(
        &self,
        db: &DatabaseConnection,
        id: i64,
        req: UpdateBuildCategoryRequest,
    ) -> Result<BuildCategoryView, AppError> {
        let category = build_category::Entity::find_by_id(id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Build category {id} not found")))?;

        let mut active: build_category::ActiveModel = category.into();
        if let Some(name) = req.name {
            active.name = Set(name.clone());
            active.slug = Set(slugify(&name));
        }
        if let Some(description) = req.description {
            active.description = Set(Some(description));
        }

        let updated = active.update(db).await?;

        Ok(BuildCategoryView {
            id: updated.id,
            name: updated.name,
            slug: updated.slug,
            description: updated.description,
            created_at: updated.created_at.to_rfc3339(),
        })
    }

    /// Deletes a build category. Fails with [`AppError::Conflict`] if builds reference it.
    pub async fn delete_build_category(
        &self,
        db: &DatabaseConnection,
        id: i64,
    ) -> Result<(), AppError> {
        let count = build::Entity::find()
            .filter(BuildColumn::CategoryId.eq(id))
            .count(db)
            .await?;

        if count > 0 {
            return Err(AppError::Conflict(format!(
                "Cannot delete build category {id}: {count} build(s) reference it"
            )));
        }

        build_category::Entity::delete_by_id(id).exec(db).await?;
        Ok(())
    }

    // ===== Comp Categories =====

    /// Lists all comp categories, ordered by name.
    pub async fn list_comp_categories(
        &self,
        db: &DatabaseConnection,
    ) -> Result<Vec<CompCategoryView>, AppError> {
        let categories = comp_category::Entity::find().all(db).await?;

        Ok(categories
            .into_iter()
            .map(|c| CompCategoryView {
                id: c.id,
                name: c.name,
                slug: c.slug,
                description: c.description,
                created_at: c.created_at.to_rfc3339(),
            })
            .collect())
    }

    /// Creates a new comp category. The slug is derived from the name.
    pub async fn create_comp_category(
        &self,
        db: &DatabaseConnection,
        req: CreateCompCategoryRequest,
    ) -> Result<CompCategoryView, AppError> {
        let active = comp_category::ActiveModel {
            name: Set(req.name.clone()),
            slug: Set(slugify(&req.name)),
            description: Set(req.description),
            ..Default::default()
        };
        let category = active.insert(db).await?;

        Ok(CompCategoryView {
            id: category.id,
            name: category.name,
            slug: category.slug,
            description: category.description,
            created_at: category.created_at.to_rfc3339(),
        })
    }

    /// Updates a comp category's name and/or description.
    pub async fn update_comp_category(
        &self,
        db: &DatabaseConnection,
        id: i64,
        req: UpdateCompCategoryRequest,
    ) -> Result<CompCategoryView, AppError> {
        let category = comp_category::Entity::find_by_id(id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Comp category {id} not found")))?;

        let mut active: comp_category::ActiveModel = category.into();
        if let Some(name) = req.name {
            active.name = Set(name.clone());
            active.slug = Set(slugify(&name));
        }
        if let Some(description) = req.description {
            active.description = Set(Some(description));
        }

        let updated = active.update(db).await?;

        Ok(CompCategoryView {
            id: updated.id,
            name: updated.name,
            slug: updated.slug,
            description: updated.description,
            created_at: updated.created_at.to_rfc3339(),
        })
    }

    /// Creates the next version of a comp: a copy carrying every build entry and quantity.
    ///
    /// `parent_id` comes along, so a version of a variant stays a variant of the same parent —
    /// `parent_id` says "derived from a different comp" while `version` says "the same comp,
    /// revised", and the two are independent.
    ///
    /// Entries point at specific *build versions*, not build groups, so a comp version keeps
    /// running the builds it was authored against until someone changes it.
    pub async fn create_comp_version(
        &self,
        db: &DatabaseConnection,
        id: i64,
        creator_id: i64,
    ) -> Result<CompDetail, AppError> {
        let source = comp::Entity::find_by_id(id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Comp {id} not found")))?;

        const ATTEMPTS: u8 = 5;
        for attempt in 1..=ATTEMPTS {
            let next_version = comp_version_group(db, &source.name, source.category_id)
                .await?
                .iter()
                .map(|sibling| sibling.version)
                .max()
                .unwrap_or(0)
                + 1;

            match self
                .insert_comp_version(db, &source, creator_id, next_version)
                .await
            {
                Ok(detail) => return Ok(detail),
                Err(AppError::Database(_)) if attempt < ATTEMPTS => continue,
                Err(error) => return Err(error),
            }
        }

        Err(AppError::Conflict(
            "Could not assign a version number — another version was being created at the same \
             time. Try again."
                .to_string(),
        ))
    }

    /// Inserts one comp version copy and its build entries in a single transaction.
    async fn insert_comp_version(
        &self,
        db: &DatabaseConnection,
        source: &comp::Model,
        creator_id: i64,
        version: i32,
    ) -> Result<CompDetail, AppError> {
        let txn = db.begin().await?;

        let copy = comp::ActiveModel {
            name: Set(source.name.clone()),
            description: Set(source.description.clone()),
            category_id: Set(source.category_id),
            version: Set(version),
            created_by: Set(creator_id),
            parent_id: Set(source.parent_id),
            ..Default::default()
        }
        .insert(&txn)
        .await?;

        let entries = comp_build::Entity::find()
            .filter(CompBuildColumn::CompId.eq(source.id))
            .all(&txn)
            .await?;
        for entry in entries {
            comp_build::ActiveModel {
                comp_id: Set(copy.id),
                build_id: Set(entry.build_id),
                quantity: Set(entry.quantity),
                ..Default::default()
            }
            .insert(&txn)
            .await?;
        }

        txn.commit().await?;
        self.get_comp(db, copy.id).await
    }

    /// Deletes a comp category. Fails with [`AppError::Conflict`] if comps reference it.
    pub async fn delete_comp_category(
        &self,
        db: &DatabaseConnection,
        id: i64,
    ) -> Result<(), AppError> {
        let count = comp::Entity::find()
            .filter(CompColumn::CategoryId.eq(id))
            .count(db)
            .await?;

        if count > 0 {
            return Err(AppError::Conflict(format!(
                "Cannot delete comp category {id}: {count} comp(s) reference it"
            )));
        }

        comp_category::Entity::delete_by_id(id).exec(db).await?;
        Ok(())
    }

    // ===== Builds =====

    async fn to_build_summary(
        &self,
        db: &DatabaseConnection,
        build: build::Model,
    ) -> Result<BuildSummary, AppError> {
        let role = parse_role(&build)?;

        let category = build_category::Entity::find_by_id(build.category_id)
            .one(db)
            .await?;
        let category_name = category.map(|c| c.name);

        let created_by_username = username_of(db, build.created_by).await?;

        let item_count = build_item::Entity::find()
            .filter(BuildItemColumn::BuildId.eq(build.id))
            .count(db)
            .await?;

        Ok(BuildSummary {
            id: build.id,
            name: build.name,
            description: build.description,
            role,
            category_id: build.category_id,
            version: build.version,
            category_name,
            created_by_username,
            updated_at: build.updated_at.to_rfc3339(),
            item_count,
        })
    }

    async fn to_build_detail(
        &self,
        db: &DatabaseConnection,
        build: build::Model,
    ) -> Result<BuildDetail, AppError> {
        let items = build_item::Entity::find()
            .filter(BuildItemColumn::BuildId.eq(build.id))
            .all(db)
            .await?;

        let mut item_views = Vec::with_capacity(items.len());
        for item in items {
            let slot = parse_slot(&item)?;
            let loadout = parse_loadout(&item)?;
            let spells = read_item_spells(db, item.id).await?;
            item_views.push(BuildItemView {
                loadout,
                spells,
                slot,
                openalbion_item_type: item.openalbion_item_type.clone(),
                openalbion_item_id: item.openalbion_item_id,
                openalbion_item_name: item.openalbion_item_name.clone(),
                openalbion_item_icon: item.openalbion_item_icon.clone(),
                openalbion_item_tier: item.openalbion_item_tier.clone(),
            });
        }

        // Resolve missing icon URLs by hitting the OpenAlbion catalog.
        // Items saved before the icon-normalization pipeline was wired up have
        // a null `openalbion_item_icon`; we fill it in at read time so the
        // frontend always gets a usable render.albiononline.com URL.
        self.resolve_missing_icons(&mut item_views).await?;

        let versions = build_version_group(db, &build.name, build.category_id)
            .await?
            .iter()
            .map(|sibling| BuildVersionRef {
                id: sibling.id,
                version: sibling.version,
            })
            .collect();
        let summary = self.to_build_summary(db, build).await?;

        Ok(BuildDetail {
            summary,
            items: item_views,
            versions,
        })
    }

    ///
    /// For every `BuildItemView` whose `openalbion_item_icon` is `None`, looks
    /// up the item in the bundled Albion catalog and fills in its local catalog
    /// render URL.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Database` if the local catalog cannot be read.
    async fn resolve_missing_icons(
        &self,
        item_views: &mut [BuildItemView],
    ) -> Result<(), AppError> {
        use crate::modules::openalbion::service::OpenAlbionService;

        let missing: Vec<&mut BuildItemView> = item_views
            .iter_mut()
            .filter(|v| v.openalbion_item_icon.is_none())
            .collect();
        if missing.is_empty() {
            return Ok(());
        }

        // Collect the set of (item_type, item_id) pairs we need to resolve.
        let mut needed_by_type: std::collections::HashMap<String, HashSet<i64>> =
            std::collections::HashMap::new();
        for v in &missing {
            needed_by_type
                .entry(v.openalbion_item_type.clone())
                .or_default()
                .insert(v.openalbion_item_id);
        }

        // Build an id → icon lookup from the bundled catalog in one local read.
        let catalog = OpenAlbionService::new().list_catalog().await?;
        let mut icon_map: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
        for (type_str, ids) in &needed_by_type {
            for item in &catalog {
                if item.item_type.as_deref() == Some(type_str.as_str()) && ids.contains(&item.id) {
                    if let Some(icon) = &item.icon {
                        icon_map.insert(item.id, icon.clone());
                    }
                }
            }
        }

        // Apply resolved icons back into the views.
        for v in item_views.iter_mut() {
            if v.openalbion_item_icon.is_none() {
                if let Some(icon) = icon_map.get(&v.openalbion_item_id) {
                    v.openalbion_item_icon = Some(icon.clone());
                }
            }
        }

        Ok(())
    }

    /// Lists builds with optional filtering by role, category, and name substring, paginated.
    pub async fn list_builds(
        &self,
        db: &DatabaseConnection,
        filters: BuildFilters,
        pagination: PaginationParams,
    ) -> Result<PaginatedData<BuildSummary>, AppError> {
        let limit = pagination.limit();
        let page = pagination.offset_page();

        let mut query = build::Entity::find();

        if let Some(role) = filters.role {
            query = query.filter(BuildColumn::Role.eq(role.to_string()));
        }
        if let Some(category_id) = filters.category_id {
            query = query.filter(BuildColumn::CategoryId.eq(category_id));
        }

        let search = filters.search.or(filters.q);
        if let Some(s) = search.filter(|value| !value.trim().is_empty()) {
            let pattern = format!("%{}%", s.trim());
            query = query.filter(
                Expr::expr(Func::lower(Expr::col(BuildColumn::Name))).like(pattern.to_lowercase()),
            );
        }

        let sort_column = resolve_sort_key(
            filters.sort.as_deref(),
            &[
                ("name", BuildColumn::Name),
                ("role", BuildColumn::Role),
                ("created_at", BuildColumn::CreatedAt),
            ],
            BuildColumn::CreatedAt,
        )?;
        let order = SortOrder::from_query(filters.order.as_deref());
        let query = match order {
            SortOrder::Asc => query.order_by_asc(sort_column),
            SortOrder::Desc => query.order_by_desc(sort_column),
        };

        let paginator = query.paginate(db, limit);
        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let builds = paginator.fetch_page(page).await?;

        let mut summaries = Vec::with_capacity(builds.len());
        for b in builds {
            summaries.push(self.to_build_summary(db, b).await?);
        }

        Ok(PaginatedData::new(
            summaries,
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }
    /// Refuses a build identity — the `(name, category)` pair — that another build already holds.
    ///
    /// `exclude_id` keeps a build from conflicting with itself when it is being renamed in place.
    /// Versions of the same build deliberately share the pair, so they are not a conflict here;
    /// the `(name, category_id, version)` index is what keeps two rows from claiming one version.
    async fn ensure_build_identity_free(
        &self,
        db: &DatabaseConnection,
        name: &str,
        category_id: i64,
        exclude_id: Option<i64>,
    ) -> Result<(), AppError> {
        let key = identity_key(name);
        let siblings = build::Entity::find()
            .filter(BuildColumn::CategoryId.eq(category_id))
            .all(db)
            .await?;

        let taken = siblings
            .iter()
            .any(|sibling| Some(sibling.id) != exclude_id && identity_key(&sibling.name) == key);
        if taken {
            return Err(AppError::Conflict(format!(
                "A build named {:?} already exists in this category",
                name.trim()
            )));
        }
        Ok(())
    }

    /// Refuses a group rename onto an identity another build group already holds.
    ///
    /// Every version of the build being renamed is excluded, since they are moving together.
    async fn ensure_group_identity_free(
        &self,
        db: &DatabaseConnection,
        build: &build::Model,
        name: &str,
        category_id: i64,
    ) -> Result<(), AppError> {
        let moving: std::collections::HashSet<i64> =
            build_version_group(db, &build.name, build.category_id)
                .await?
                .iter()
                .map(|sibling| sibling.id)
                .collect();
        let key = identity_key(name);
        let taken = build::Entity::find()
            .filter(BuildColumn::CategoryId.eq(category_id))
            .all(db)
            .await?
            .into_iter()
            .any(|candidate| {
                !moving.contains(&candidate.id) && identity_key(&candidate.name) == key
            });
        if taken {
            return Err(AppError::Conflict(format!(
                "A build named {:?} already exists in this category",
                name.trim()
            )));
        }
        Ok(())
    }

    /// Refuses a comp group rename onto an identity another comp group already holds.
    async fn ensure_comp_group_identity_free(
        &self,
        db: &DatabaseConnection,
        comp: &comp::Model,
        name: &str,
        category_id: i64,
    ) -> Result<(), AppError> {
        let moving: std::collections::HashSet<i64> =
            comp_version_group(db, &comp.name, comp.category_id)
                .await?
                .iter()
                .map(|sibling| sibling.id)
                .collect();
        let key = identity_key(name);
        let taken = comp::Entity::find()
            .filter(CompColumn::CategoryId.eq(category_id))
            .all(db)
            .await?
            .into_iter()
            .any(|candidate| {
                !moving.contains(&candidate.id) && identity_key(&candidate.name) == key
            });
        if taken {
            return Err(AppError::Conflict(format!(
                "A composition named {:?} already exists in this category",
                name.trim()
            )));
        }
        Ok(())
    }

    /// Refuses a comp identity — the `(name, category)` pair — that another comp already holds.
    ///
    /// See [`CompService::ensure_build_identity_free`]; the rules are identical.
    async fn ensure_comp_identity_free(
        &self,
        db: &DatabaseConnection,
        name: &str,
        category_id: i64,
        exclude_id: Option<i64>,
    ) -> Result<(), AppError> {
        let key = identity_key(name);
        let siblings = comp::Entity::find()
            .filter(CompColumn::CategoryId.eq(category_id))
            .all(db)
            .await?;

        let taken = siblings
            .iter()
            .any(|sibling| Some(sibling.id) != exclude_id && identity_key(&sibling.name) == key);
        if taken {
            return Err(AppError::Conflict(format!(
                "A composition named {:?} already exists in this category",
                name.trim()
            )));
        }
        Ok(())
    }

    /// Creates a new build with optional initial items, validating the category exists.
    pub async fn create_build(
        &self,
        db: &DatabaseConnection,
        creator_id: i64,
        req: CreateBuildRequest,
    ) -> Result<BuildDetail, AppError> {
        // Validate category exists.
        let category_exists = build_category::Entity::find_by_id(req.category_id)
            .one(db)
            .await?
            .is_some();
        if !category_exists {
            return Err(AppError::NotFound(format!(
                "Build category {} not found",
                req.category_id
            )));
        }

        self.ensure_build_identity_free(db, &req.name, req.category_id, None)
            .await?;

        let txn = db.begin().await?;

        let active = build::ActiveModel {
            name: Set(req.name.trim().to_string()),
            description: Set(req.description),
            role: Set(req.role.to_string()),
            category_id: Set(req.category_id),
            created_by: Set(creator_id),
            ..Default::default()
        };
        let inserted = active.insert(&txn).await?;

        if let Some(items) = req.items {
            let mut used_slots = HashSet::with_capacity(items.len());
            for item in items {
                let slot = item.slot.to_string();
                if !used_slots.insert(slot.clone()) {
                    return Err(AppError::Validation(format!(
                        "duplicate build item slot: {slot}"
                    )));
                }

                let active = build_item::ActiveModel {
                    build_id: Set(inserted.id),
                    // Items supplied at creation time are always the main loadout; the swap is
                    // filled in afterwards, one slot at a time.
                    loadout: Set(BuildLoadout::Main.to_string()),
                    slot: Set(slot),
                    openalbion_item_type: Set(item.openalbion_item_type),
                    openalbion_item_id: Set(item.openalbion_item_id),
                    openalbion_item_name: Set(item.openalbion_item_name),
                    openalbion_item_icon: Set(item.openalbion_item_icon),
                    openalbion_item_tier: Set(item.openalbion_item_tier),
                    ..Default::default()
                };
                active.insert(&txn).await?;
            }
        }

        txn.commit().await?;

        self.to_build_detail(db, inserted).await
    }

    /// Gets a single build's full detail, including items.
    pub async fn get_build(
        &self,
        db: &DatabaseConnection,
        id: i64,
    ) -> Result<BuildDetail, AppError> {
        let build = build::Entity::find_by_id(id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Build {id} not found")))?;

        self.to_build_detail(db, build).await
    }

    /// Updates a build's editable fields.
    pub async fn update_build(
        &self,
        db: &DatabaseConnection,
        id: i64,
        req: UpdateBuildRequest,
    ) -> Result<BuildDetail, AppError> {
        let build = build::Entity::find_by_id(id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Build {id} not found")))?;

        if let Some(category_id) = req.category_id {
            let exists = build_category::Entity::find_by_id(category_id)
                .one(db)
                .await?
                .is_some();
            if !exists {
                return Err(AppError::NotFound(format!(
                    "Build category {category_id} not found"
                )));
            }
            let _ = category_id; // used above for validation
        }

        let target_name = req
            .name
            .as_deref()
            .unwrap_or(&build.name)
            .trim()
            .to_string();
        let target_category = req.category_id.unwrap_or(build.category_id);
        let identity_changed = identity_key(&target_name) != identity_key(&build.name)
            || target_category != build.category_id;
        if identity_changed {
            self.ensure_group_identity_free(db, &build, &target_name, target_category)
                .await?;
        }

        let group = build_version_group(db, &build.name, build.category_id).await?;
        let txn = db.begin().await?;

        // Name and category are the group's identity, so a rename moves every version at once —
        // otherwise one version would split off into an identity of its own.
        if identity_changed {
            for sibling in &group {
                let mut moving: build::ActiveModel = sibling.clone().into();
                moving.name = Set(target_name.clone());
                moving.category_id = Set(target_category);
                moving.updated_at = Set(now());
                moving.update(&txn).await?;
            }
        }

        let current = build::Entity::find_by_id(build.id)
            .one(&txn)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Build {id} not found")))?;
        let mut active: build::ActiveModel = current.into();
        if let Some(description) = req.description {
            active.description = Set(Some(description));
        }
        if let Some(role) = req.role {
            active.role = Set(role.to_string());
        }
        active.updated_at = Set(now());
        let updated = active.update(&txn).await?;
        txn.commit().await?;

        self.to_build_detail(db, updated).await
    }

    /// Creates the next version of a build: a full copy that can be edited on its own.
    ///
    /// The copy carries both loadouts and every ability choice, because a version that silently
    /// dropped the swap would be worse than no version at all. Name and category are inherited —
    /// they are the group's identity, and every version shares them.
    ///
    /// The new number is `max(version) + 1` within the group. Two concurrent requests would both
    /// compute the same number, so the `(name, category_id, version)` unique index is what actually
    /// decides; the loser retries rather than failing the officer's click.
    pub async fn create_build_version(
        &self,
        db: &DatabaseConnection,
        id: i64,
        creator_id: i64,
    ) -> Result<BuildDetail, AppError> {
        let source = build::Entity::find_by_id(id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Build {id} not found")))?;

        const ATTEMPTS: u8 = 5;
        for attempt in 1..=ATTEMPTS {
            let next_version = build_version_group(db, &source.name, source.category_id)
                .await?
                .iter()
                .map(|sibling| sibling.version)
                .max()
                .unwrap_or(0)
                + 1;

            match self
                .insert_build_version(db, &source, creator_id, next_version)
                .await
            {
                Ok(detail) => return Ok(detail),
                // Another request claimed this number first; recompute and try again.
                Err(AppError::Database(_)) if attempt < ATTEMPTS => continue,
                Err(error) => return Err(error),
            }
        }

        Err(AppError::Conflict(
            "Could not assign a version number — another version was being created at the same \
             time. Try again."
                .to_string(),
        ))
    }

    /// Inserts one version copy in a single transaction, items and abilities included.
    async fn insert_build_version(
        &self,
        db: &DatabaseConnection,
        source: &build::Model,
        creator_id: i64,
        version: i32,
    ) -> Result<BuildDetail, AppError> {
        let txn = db.begin().await?;

        let copy = build::ActiveModel {
            name: Set(source.name.clone()),
            description: Set(source.description.clone()),
            role: Set(source.role.clone()),
            category_id: Set(source.category_id),
            version: Set(version),
            created_by: Set(creator_id),
            ..Default::default()
        }
        .insert(&txn)
        .await?;

        let items = build_item::Entity::find()
            .filter(BuildItemColumn::BuildId.eq(source.id))
            .all(&txn)
            .await?;

        for item in items {
            let copied_item = build_item::ActiveModel {
                build_id: Set(copy.id),
                loadout: Set(item.loadout.clone()),
                slot: Set(item.slot.clone()),
                openalbion_item_type: Set(item.openalbion_item_type.clone()),
                openalbion_item_id: Set(item.openalbion_item_id),
                openalbion_item_name: Set(item.openalbion_item_name.clone()),
                openalbion_item_icon: Set(item.openalbion_item_icon.clone()),
                openalbion_item_tier: Set(item.openalbion_item_tier.clone()),
                ..Default::default()
            }
            .insert(&txn)
            .await?;

            let chosen = build_item_spell::Entity::find()
                .filter(BuildItemSpellColumn::BuildItemId.eq(item.id))
                .all(&txn)
                .await?;
            for spell in chosen {
                build_item_spell::ActiveModel {
                    build_item_id: Set(copied_item.id),
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
        self.get_build(db, copy.id).await
    }

    /// Deletes a build. Fails with [`AppError::Conflict`] if any comp references it.
    ///
    /// `comp_builds.build_id`, `event_participations.{primary,secondary}_build_id`, and
    /// `event_roster_roles.build_id` are all `RESTRICT` FKs — checked here first so the
    /// caller gets the specific blocking comps/events back instead of a raw constraint error.
    pub async fn delete_build(&self, db: &DatabaseConnection, id: i64) -> Result<(), AppError> {
        let blocking_comps = comp_build::Entity::find()
            .filter(CompBuildColumn::BuildId.eq(id))
            .find_also_related(comp::Entity)
            .all(db)
            .await?;

        let mut references: Vec<BlockingReference> = blocking_comps
            .into_iter()
            .filter_map(|(_, comp)| comp)
            .map(|c| BlockingReference {
                resource: "comp".to_string(),
                id: c.id,
                label: c.name,
            })
            .collect();

        let mut blocking_event_ids: HashSet<i64> = HashSet::new();
        for participation in event_participation::Entity::find()
            .filter(
                EventParticipationColumn::PrimaryBuildId
                    .eq(id)
                    .or(EventParticipationColumn::SecondaryBuildId.eq(id)),
            )
            .all(db)
            .await?
        {
            blocking_event_ids.insert(participation.event_id);
        }
        for roster_role in event_roster_role::Entity::find()
            .filter(EventRosterRoleColumn::BuildId.eq(id))
            .all(db)
            .await?
        {
            blocking_event_ids.insert(roster_role.event_id);
        }

        if !blocking_event_ids.is_empty() {
            references.extend(
                event::Entity::find()
                    .filter(event::Column::Id.is_in(blocking_event_ids))
                    .all(db)
                    .await?
                    .into_iter()
                    .map(|e| BlockingReference {
                        resource: "event".to_string(),
                        id: e.id,
                        label: e.title,
                    }),
            );
        }

        if !references.is_empty() {
            return Err(AppError::ConflictWithReferences {
                message: format!(
                    "Cannot delete build {id}: {} comp(s)/event(s) still use it",
                    references.len()
                ),
                references,
            });
        }

        build::Entity::delete_by_id(id).exec(db).await?;
        Ok(())
    }

    /// Upserts (insert-or-update) the item in a specific slot of a build.
    pub async fn upsert_build_item(
        &self,
        db: &DatabaseConnection,
        build_id: i64,
        loadout: BuildLoadout,
        slot: BuildSlot,
        req: UpsertBuildItemRequest,
    ) -> Result<BuildDetail, AppError> {
        // Ensure build exists.
        let _ = build::Entity::find_by_id(build_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Build {build_id} not found")))?;

        let existing = build_item::Entity::find()
            .filter(BuildItemColumn::BuildId.eq(build_id))
            .filter(BuildItemColumn::Loadout.eq(loadout.to_string()))
            .filter(BuildItemColumn::Slot.eq(slot.to_string()))
            .one(db)
            .await?;

        if let Some(model) = existing {
            let item_id = model.id;
            let mut active: build_item::ActiveModel = model.into();
            active.openalbion_item_type = Set(req.openalbion_item_type);
            active.openalbion_item_id = Set(req.openalbion_item_id);
            active.openalbion_item_name = Set(req.openalbion_item_name);
            active.openalbion_item_icon = Set(req.openalbion_item_icon);
            active.openalbion_item_tier = Set(req.openalbion_item_tier);
            let updated = active.update(db).await?;
            drop_abilities_the_item_no_longer_offers(db, &updated, item_id).await?;
        } else {
            let active = build_item::ActiveModel {
                build_id: Set(build_id),
                loadout: Set(loadout.to_string()),
                slot: Set(slot.to_string()),
                openalbion_item_type: Set(req.openalbion_item_type),
                openalbion_item_id: Set(req.openalbion_item_id),
                openalbion_item_name: Set(req.openalbion_item_name),
                openalbion_item_icon: Set(req.openalbion_item_icon),
                openalbion_item_tier: Set(req.openalbion_item_tier),
                ..Default::default()
            };
            active.insert(db).await?;
        }

        self.get_build(db, build_id).await
    }

    /// Replaces the abilities chosen on one equipped item.
    ///
    /// The whole selection is sent at once so the result is atomic: a slot the request omits is
    /// cleared. Every choice is validated against what that item actually offers, so a stale client
    /// cannot persist a spell the weapon does not have.
    pub async fn set_build_item_spells(
        &self,
        db: &DatabaseConnection,
        build_id: i64,
        loadout: BuildLoadout,
        slot: BuildSlot,
        req: BuildItemSpells,
    ) -> Result<BuildDetail, AppError> {
        let item = build_item::Entity::find()
            .filter(BuildItemColumn::BuildId.eq(build_id))
            .filter(BuildItemColumn::Loadout.eq(loadout.to_string()))
            .filter(BuildItemColumn::Slot.eq(slot.to_string()))
            .one(db)
            .await?
            .ok_or_else(|| {
                AppError::NotFound(format!(
                    "Build {build_id} has no item in the {loadout} {slot} slot"
                ))
            })?;

        let mut chosen: Vec<(&str, i32, String)> = Vec::new();
        for (kind, entries) in [(ACTIVE_KIND, &req.active), (PASSIVE_KIND, &req.passive)] {
            for (raw_index, spell_id) in entries {
                let slot_index: i32 = raw_index.parse().map_err(|_| {
                    AppError::Validation(format!("{kind} slot {raw_index:?} is not a slot number"))
                })?;
                validate_ability_choice(&item, kind, slot_index, spell_id)?;
                chosen.push((kind, slot_index, spell_id.clone()));
            }
        }

        let txn = db.begin().await?;
        build_item_spell::Entity::delete_many()
            .filter(BuildItemSpellColumn::BuildItemId.eq(item.id))
            .exec(&txn)
            .await?;
        for (kind, slot_index, spell_id) in chosen {
            build_item_spell::ActiveModel {
                build_item_id: Set(item.id),
                kind: Set(kind.to_string()),
                slot_index: Set(slot_index),
                spell_id: Set(spell_id),
                ..Default::default()
            }
            .insert(&txn)
            .await?;
        }
        txn.commit().await?;

        self.get_build(db, build_id).await
    }

    /// Removes the item from a specific slot of a build. No-op if the slot is already empty.
    pub async fn remove_build_item(
        &self,
        db: &DatabaseConnection,
        build_id: i64,
        loadout: BuildLoadout,
        slot: BuildSlot,
    ) -> Result<(), AppError> {
        build_item::Entity::delete_many()
            .filter(BuildItemColumn::BuildId.eq(build_id))
            .filter(BuildItemColumn::Loadout.eq(loadout.to_string()))
            .filter(BuildItemColumn::Slot.eq(slot.to_string()))
            .exec(db)
            .await?;
        Ok(())
    }

    // ===== Comps =====

    async fn to_comp_summary(
        &self,
        db: &DatabaseConnection,
        comp: comp::Model,
    ) -> Result<CompSummary, AppError> {
        let category = comp_category::Entity::find_by_id(comp.category_id)
            .one(db)
            .await?;
        let category_name = category.map(|c| c.name);

        let created_by_username = username_of(db, comp.created_by).await?;

        let comp_builds = comp_build::Entity::find()
            .filter(CompBuildColumn::CompId.eq(comp.id))
            .all(db)
            .await?;
        let build_count = comp_builds.len() as u64;
        let total_quantity: i64 = comp_builds.iter().map(|cb| i64::from(cb.quantity)).sum();

        Ok(CompSummary {
            id: comp.id,
            name: comp.name,
            description: comp.description,
            category_id: comp.category_id,
            version: comp.version,
            category_name,
            created_by_username,
            created_at: comp.created_at.to_rfc3339(),
            build_count,
            total_quantity,
            parent_id: comp.parent_id,
        })
    }

    async fn to_comp_detail(
        &self,
        db: &DatabaseConnection,
        comp: comp::Model,
    ) -> Result<CompDetail, AppError> {
        let comp_builds = comp_build::Entity::find()
            .filter(CompBuildColumn::CompId.eq(comp.id))
            .all(db)
            .await?;

        let mut views = Vec::with_capacity(comp_builds.len());
        for cb in comp_builds {
            let build = build::Entity::find_by_id(cb.build_id)
                .one(db)
                .await?
                .ok_or_else(|| {
                    AppError::Internal(format!(
                        "Build {} referenced by comp_build {} no longer exists",
                        cb.build_id, cb.id
                    ))
                })?;
            let summary = self.to_build_summary(db, build).await?;
            views.push(CompBuildView {
                build_id: cb.build_id,
                build: summary,
                quantity: cb.quantity,
            });
        }

        let versions = comp_version_group(db, &comp.name, comp.category_id)
            .await?
            .iter()
            .map(|sibling| BuildVersionRef {
                id: sibling.id,
                version: sibling.version,
            })
            .collect();
        let summary = self.to_comp_summary(db, comp).await?;

        Ok(CompDetail {
            summary,
            builds: views,
            versions,
        })
    }

    /// Lists comps with optional filtering by category and name substring, paginated.
    pub async fn list_comps(
        &self,
        db: &DatabaseConnection,
        filters: CompFilters,
        pagination: PaginationParams,
    ) -> Result<PaginatedData<CompSummary>, AppError> {
        let limit = pagination.limit();
        let page = pagination.offset_page();

        let mut query = comp::Entity::find();

        if let Some(category_id) = filters.category_id {
            query = query.filter(CompColumn::CategoryId.eq(category_id));
        }

        let search = filters.search.or(filters.q);
        if let Some(s) = search.filter(|value| !value.trim().is_empty()) {
            let pattern = format!("%{}%", s.trim());
            query = query.filter(
                Expr::expr(Func::lower(Expr::col(CompColumn::Name))).like(pattern.to_lowercase()),
            );
        }

        if let Some(date_from) = filters.date_from {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&date_from) {
                query = query.filter(CompColumn::CreatedAt.gte(dt));
            }
        }

        if let Some(date_to) = filters.date_to {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&date_to) {
                query = query.filter(CompColumn::CreatedAt.lte(dt));
            }
        }

        let sort_column = resolve_sort_key(
            filters.sort.as_deref(),
            &[
                ("name", CompColumn::Name),
                ("created_at", CompColumn::CreatedAt),
                ("category", CompColumn::CategoryId),
            ],
            CompColumn::CreatedAt,
        )?;
        let order = SortOrder::from_query(filters.order.as_deref());
        let query = match order {
            SortOrder::Asc => query.order_by_asc(sort_column),
            SortOrder::Desc => query.order_by_desc(sort_column),
        };

        let paginator = query.paginate(db, limit);
        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let comps = paginator.fetch_page(page).await?;

        let mut summaries = Vec::with_capacity(comps.len());
        for c in comps {
            summaries.push(self.to_comp_summary(db, c).await?);
        }

        Ok(PaginatedData::new(
            summaries,
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }

    /// Creates a comp. When a parent is supplied, `builds` contains only the additions to the
    /// parent's snapshot; the persisted child contains the complete merged snapshot.
    pub async fn create_comp(
        &self,
        db: &DatabaseConnection,
        creator_id: i64,
        req: CreateCompRequest,
    ) -> Result<CompDetail, AppError> {
        let CreateCompRequest {
            name,
            description,
            category_id,
            builds,
            parent_id,
        } = req;

        let category_exists = comp_category::Entity::find_by_id(category_id)
            .one(db)
            .await?
            .is_some();
        if !category_exists {
            return Err(AppError::NotFound(format!(
                "Comp category {category_id} not found"
            )));
        }
        if builds.iter().any(|build| build.quantity < 1) {
            return Err(AppError::Validation("quantity must be >= 1".to_string()));
        }
        self.ensure_comp_identity_free(db, &name, category_id, None)
            .await?;

        let mut snapshot = BTreeMap::<i64, i32>::new();
        let parent_capacity = if let Some(parent_id) = parent_id {
            let parent = comp::Entity::find_by_id(parent_id)
                .one(db)
                .await?
                .ok_or_else(|| AppError::NotFound(format!("Parent comp {parent_id} not found")))?;
            let parent_builds = comp_build::Entity::find()
                .filter(CompBuildColumn::CompId.eq(parent.id))
                .all(db)
                .await?;
            for parent_build in parent_builds {
                snapshot.insert(parent_build.build_id, parent_build.quantity);
            }
            snapshot.values().map(|quantity| i64::from(*quantity)).sum()
        } else {
            0
        };

        for addition in builds {
            let build_exists = build::Entity::find_by_id(addition.build_id)
                .one(db)
                .await?
                .is_some();
            if !build_exists {
                return Err(AppError::NotFound(format!(
                    "Build {} not found",
                    addition.build_id
                )));
            }
            let quantity = snapshot.entry(addition.build_id).or_default();
            *quantity = quantity.checked_add(addition.quantity).ok_or_else(|| {
                AppError::Validation(format!(
                    "quantity for build {} exceeds the supported limit",
                    addition.build_id
                ))
            })?;
        }

        let total_capacity: i64 = snapshot.values().map(|quantity| i64::from(*quantity)).sum();
        if parent_id.is_some() && total_capacity <= parent_capacity {
            return Err(AppError::Validation(
                "an expansion comp must have a capacity greater than its parent".to_string(),
            ));
        }

        let txn = db.begin().await?;
        let inserted = comp::ActiveModel {
            name: Set(name.trim().to_string()),
            description: Set(description),
            category_id: Set(category_id),
            created_by: Set(creator_id),
            parent_id: Set(parent_id),
            ..Default::default()
        }
        .insert(&txn)
        .await?;

        for (build_id, quantity) in snapshot {
            comp_build::ActiveModel {
                comp_id: Set(inserted.id),
                build_id: Set(build_id),
                quantity: Set(quantity),
                ..Default::default()
            }
            .insert(&txn)
            .await?;
        }

        txn.commit().await?;
        self.to_comp_detail(db, inserted).await
    }

    /// Gets a single comp's full detail, including its builds.
    pub async fn get_comp(&self, db: &DatabaseConnection, id: i64) -> Result<CompDetail, AppError> {
        let comp = comp::Entity::find_by_id(id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Comp {id} not found")))?;

        self.to_comp_detail(db, comp).await
    }

    /// Updates a comp's editable fields.
    pub async fn update_comp(
        &self,
        db: &DatabaseConnection,
        id: i64,
        req: UpdateCompRequest,
    ) -> Result<CompDetail, AppError> {
        let comp = comp::Entity::find_by_id(id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Comp {id} not found")))?;

        if let Some(category_id) = req.category_id {
            let exists = comp_category::Entity::find_by_id(category_id)
                .one(db)
                .await?
                .is_some();
            if !exists {
                return Err(AppError::NotFound(format!(
                    "Comp category {category_id} not found"
                )));
            }
        }

        let target_name = req.name.as_deref().unwrap_or(&comp.name).trim().to_string();
        let target_category = req.category_id.unwrap_or(comp.category_id);
        let identity_changed = identity_key(&target_name) != identity_key(&comp.name)
            || target_category != comp.category_id;
        if identity_changed {
            self.ensure_comp_group_identity_free(db, &comp, &target_name, target_category)
                .await?;

            // Name and category identify the group, so every version moves together.
            let group = comp_version_group(db, &comp.name, comp.category_id).await?;
            let txn = db.begin().await?;
            for sibling in &group {
                let mut moving: comp::ActiveModel = sibling.clone().into();
                moving.name = Set(target_name.clone());
                moving.category_id = Set(target_category);
                moving.updated_at = Set(now());
                moving.update(&txn).await?;
            }
            txn.commit().await?;
        }

        let comp = comp::Entity::find_by_id(id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Comp {id} not found")))?;
        let mut active: comp::ActiveModel = comp.into();
        if let Some(description) = req.description {
            active.description = Set(Some(description));
        }
        if let Some(parent_id) = req.parent_id {
            if let Some(parent_id) = parent_id {
                self.validate_expansion_parent(db, id, parent_id).await?;
                active.parent_id = Set(Some(parent_id));
            } else {
                active.parent_id = Set(None);
            }
        }
        active.updated_at = Set(now());

        let updated = active.update(db).await?;

        self.to_comp_detail(db, updated).await
    }

    /// Returns the total number of concrete slots in a comp snapshot.
    async fn get_comp_capacity(
        &self,
        db: &DatabaseConnection,
        comp_id: i64,
    ) -> Result<i64, AppError> {
        Ok(comp_build::Entity::find()
            .filter(CompBuildColumn::CompId.eq(comp_id))
            .all(db)
            .await?
            .iter()
            .map(|build| i64::from(build.quantity))
            .sum())
    }

    /// Re-checks the "expansion capacity strictly increases down the chain" invariant
    /// around `comp_id` after one of its builds is about to change to
    /// `prospective_capacity` total slots.
    ///
    /// `create_comp`/`validate_expansion_parent` only enforce this at comp-creation or
    /// re-parenting time; a build added/edited/removed later on a comp that already sits
    /// in an expansion chain must not silently break the invariant those checks set up.
    /// Checks both directions: `comp_id` must still exceed its own parent's capacity
    /// (if any), and every comp that expands from `comp_id` must still exceed
    /// `prospective_capacity`.
    async fn check_expansion_capacity_invariant(
        &self,
        db: &DatabaseConnection,
        comp_id: i64,
        prospective_capacity: i64,
    ) -> Result<(), AppError> {
        let comp = comp::Entity::find_by_id(comp_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Comp {comp_id} not found")))?;

        if let Some(parent_id) = comp.parent_id {
            let parent_capacity = self.get_comp_capacity(db, parent_id).await?;
            if prospective_capacity <= parent_capacity {
                return Err(AppError::Validation(
                    "an expansion comp must have a capacity greater than its parent".to_string(),
                ));
            }
        }

        let children = comp::Entity::find()
            .filter(CompColumn::ParentId.eq(comp_id))
            .all(db)
            .await?;
        for child in children {
            let child_capacity = self.get_comp_capacity(db, child.id).await?;
            if child_capacity <= prospective_capacity {
                return Err(AppError::Validation(format!(
                    "comp {comp_id} still has expansion comp '{}' below it; that comp must keep a capacity greater than {comp_id}'s",
                    child.name
                )));
            }
        }

        Ok(())
    }

    /// Verifies that assigning `parent_id` keeps the chain acyclic and strictly increasing.
    async fn validate_expansion_parent(
        &self,
        db: &DatabaseConnection,
        comp_id: i64,
        parent_id: i64,
    ) -> Result<(), AppError> {
        if parent_id == comp_id {
            return Err(AppError::Validation(
                "a comp cannot be its own parent".to_string(),
            ));
        }

        let parent = comp::Entity::find_by_id(parent_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Parent comp {parent_id} not found")))?;
        let child_capacity = self.get_comp_capacity(db, comp_id).await?;
        let parent_capacity = self.get_comp_capacity(db, parent.id).await?;
        if child_capacity <= parent_capacity {
            return Err(AppError::Validation(
                "an expansion comp must have a capacity greater than its parent".to_string(),
            ));
        }

        let mut current_id = parent_id;
        let mut visited = HashSet::new();
        loop {
            if !visited.insert(current_id) {
                return Err(AppError::Validation(
                    "the parent comp chain contains a cycle".to_string(),
                ));
            }
            if current_id == comp_id {
                return Err(AppError::Validation(
                    "a comp cannot be assigned beneath one of its descendants".to_string(),
                ));
            }

            let current = comp::Entity::find_by_id(current_id)
                .one(db)
                .await?
                .ok_or_else(|| AppError::NotFound(format!("Parent comp {current_id} not found")))?;
            let Some(next_parent_id) = current.parent_id else {
                return Ok(());
            };
            current_id = next_parent_id;
        }
    }

    /// Deletes a comp. Cascades to `comp_builds` via FK.
    ///
    /// `events.comp_id` is a `RESTRICT` FK, so a comp still linked to any
    /// event can't be deleted at the database level — checked here first so
    /// the caller gets the specific blocking events back instead of a raw
    /// constraint-violation error. Comps that reference this one as their
    /// `parent_id` (expansion children/variants) are checked the same way so
    /// they aren't silently orphaned or cascade-deleted.
    pub async fn delete_comp(&self, db: &DatabaseConnection, id: i64) -> Result<(), AppError> {
        let blocking_events = event::Entity::find()
            .filter(event::Column::CompId.eq(id))
            .all(db)
            .await?;

        if !blocking_events.is_empty() {
            let count = blocking_events.len();
            return Err(AppError::ConflictWithReferences {
                message: format!("Cannot delete comp {id}: {count} event(s) still use it"),
                references: blocking_events
                    .into_iter()
                    .map(|e| BlockingReference {
                        resource: "event".to_string(),
                        id: e.id,
                        label: e.title,
                    })
                    .collect(),
            });
        }

        let blocking_children = comp::Entity::find()
            .filter(CompColumn::ParentId.eq(id))
            .all(db)
            .await?;

        if !blocking_children.is_empty() {
            let count = blocking_children.len();
            return Err(AppError::ConflictWithReferences {
                message: format!("Cannot delete comp {id}: {count} comp(s) expand from it"),
                references: blocking_children
                    .into_iter()
                    .map(|c| BlockingReference {
                        resource: "comp".to_string(),
                        id: c.id,
                        label: c.name,
                    })
                    .collect(),
            });
        }

        comp::Entity::delete_by_id(id).exec(db).await?;
        Ok(())
    }

    /// Adds a build to a comp, or — if the (comp, build) pair already exists — sets its
    /// quantity to the new value (upsert semantics on the unique pair).
    pub async fn add_comp_build(
        &self,
        db: &DatabaseConnection,
        comp_id: i64,
        req: AddCompBuildRequest,
    ) -> Result<CompDetail, AppError> {
        if req.quantity < 1 {
            return Err(AppError::Validation("quantity must be >= 1".to_string()));
        }

        // Ensure comp exists.
        let _ = comp::Entity::find_by_id(comp_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Comp {comp_id} not found")))?;

        // Ensure build exists.
        let _ = build::Entity::find_by_id(req.build_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Build {} not found", req.build_id)))?;

        let existing = comp_build::Entity::find()
            .filter(CompBuildColumn::CompId.eq(comp_id))
            .filter(CompBuildColumn::BuildId.eq(req.build_id))
            .one(db)
            .await?;

        let current_capacity = self.get_comp_capacity(db, comp_id).await?;
        let old_quantity = existing.as_ref().map_or(0, |model| i64::from(model.quantity));
        let prospective_capacity = current_capacity - old_quantity + i64::from(req.quantity);
        self.check_expansion_capacity_invariant(db, comp_id, prospective_capacity)
            .await?;

        if let Some(model) = existing {
            let mut active: comp_build::ActiveModel = model.into();
            active.quantity = Set(req.quantity);
            active.update(db).await?;
        } else {
            let active = comp_build::ActiveModel {
                comp_id: Set(comp_id),
                build_id: Set(req.build_id),
                quantity: Set(req.quantity),
                ..Default::default()
            };
            active.insert(db).await?;
        }

        let comp = comp::Entity::find_by_id(comp_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Comp {comp_id} not found")))?;

        self.to_comp_detail(db, comp).await
    }

    /// Updates the quantity of an existing comp↔build pairing.
    pub async fn update_comp_build_quantity(
        &self,
        db: &DatabaseConnection,
        comp_id: i64,
        build_id: i64,
        req: UpdateCompBuildQuantityRequest,
    ) -> Result<CompDetail, AppError> {
        if req.quantity < 1 {
            return Err(AppError::Validation("quantity must be >= 1".to_string()));
        }

        let cb = comp_build::Entity::find()
            .filter(CompBuildColumn::CompId.eq(comp_id))
            .filter(CompBuildColumn::BuildId.eq(build_id))
            .one(db)
            .await?
            .ok_or_else(|| {
                AppError::NotFound(format!("Build {build_id} is not part of comp {comp_id}"))
            })?;

        let current_capacity = self.get_comp_capacity(db, comp_id).await?;
        let prospective_capacity =
            current_capacity - i64::from(cb.quantity) + i64::from(req.quantity);
        self.check_expansion_capacity_invariant(db, comp_id, prospective_capacity)
            .await?;

        let mut active: comp_build::ActiveModel = cb.into();
        active.quantity = Set(req.quantity);
        active.update(db).await?;

        let comp = comp::Entity::find_by_id(comp_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Comp {comp_id} not found")))?;

        self.to_comp_detail(db, comp).await
    }

    /// Removes a build from a comp.
    pub async fn remove_comp_build(
        &self,
        db: &DatabaseConnection,
        comp_id: i64,
        build_id: i64,
    ) -> Result<(), AppError> {
        let existing = comp_build::Entity::find()
            .filter(CompBuildColumn::CompId.eq(comp_id))
            .filter(CompBuildColumn::BuildId.eq(build_id))
            .one(db)
            .await?;
        let Some(existing) = existing else {
            return Ok(());
        };

        let current_capacity = self.get_comp_capacity(db, comp_id).await?;
        let prospective_capacity = current_capacity - i64::from(existing.quantity);
        self.check_expansion_capacity_invariant(db, comp_id, prospective_capacity)
            .await?;

        comp_build::Entity::delete_many()
            .filter(CompBuildColumn::CompId.eq(comp_id))
            .filter(CompBuildColumn::BuildId.eq(build_id))
            .exec(db)
            .await?;
        Ok(())
    }
}

impl Default for CompService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::users::entities::ActiveModel as UserActiveModel;
    use crate::pagination::PaginationParams;
    use sea_orm::Database;

    use super::super::entities::{
        build::ActiveModel as BuildActiveModel,
        build_category::ActiveModel as BuildCategoryActiveModel,
        comp::ActiveModel as CompActiveModel,
        comp_category::ActiveModel as CompCategoryActiveModel,
    };

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("Failed to connect to test database");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("Failed to run database migrations");
        db
    }

    async fn insert_user(db: &DatabaseConnection, username: &str, email: &str) -> i64 {
        UserActiveModel {
            username: Set(username.to_string()),
            email: Set(email.to_string()),
            role: Set("User".to_string()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("Failed to insert user")
        .id
    }

    async fn insert_build_category(db: &DatabaseConnection, name: &str) -> i64 {
        BuildCategoryActiveModel {
            name: Set(name.to_string()),
            slug: Set(name.to_lowercase()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("Failed to insert build category")
        .id
    }

    async fn insert_comp_category(db: &DatabaseConnection, name: &str) -> i64 {
        CompCategoryActiveModel {
            name: Set(name.to_string()),
            slug: Set(name.to_lowercase()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("Failed to insert comp category")
        .id
    }

    async fn insert_build(
        db: &DatabaseConnection,
        name: &str,
        role: &str,
        category_id: i64,
        created_by: i64,
    ) -> i64 {
        BuildActiveModel {
            name: Set(name.to_string()),
            role: Set(role.to_string()),
            category_id: Set(category_id),
            created_by: Set(created_by),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("Failed to insert build")
        .id
    }

    async fn insert_comp(
        db: &DatabaseConnection,
        name: &str,
        category_id: i64,
        created_by: i64,
    ) -> i64 {
        CompActiveModel {
            name: Set(name.to_string()),
            category_id: Set(category_id),
            created_by: Set(created_by),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("Failed to insert comp")
        .id
    }

    fn build_request(name: &str, category_id: i64) -> CreateBuildRequest {
        CreateBuildRequest {
            name: name.to_string(),
            description: None,
            role: BuildRole::Dps,
            category_id,
            items: None,
        }
    }

    fn comp_request(name: &str, category_id: i64) -> CreateCompRequest {
        CreateCompRequest {
            name: name.to_string(),
            description: None,
            category_id,
            builds: Vec::new(),
            parent_id: None,
        }
    }

    fn expect_conflict(error: AppError) -> String {
        match error {
            AppError::Conflict(message) => message,
            other => panic!("expected conflict, got {other:?}"),
        }
    }

    fn expect_conflict_with_references(error: AppError) -> Vec<BlockingReference> {
        match error {
            AppError::ConflictWithReferences { references, .. } => references,
            other => panic!("expected conflict with references, got {other:?}"),
        }
    }

    async fn seed_build(db: &DatabaseConnection) -> (CompService, i64) {
        let user = insert_user(db, "admin", "admin@example.com").await;
        let category = insert_build_category(db, "Crystal").await;
        let service = CompService::new();
        let build = service
            .create_build(db, user, build_request("Pole Hammer", category))
            .await
            .expect("build should be created");
        (service, build.summary.id)
    }

    fn weapon(name: &str) -> UpsertBuildItemRequest {
        UpsertBuildItemRequest {
            openalbion_item_type: "weapon".to_string(),
            openalbion_item_id: 1,
            openalbion_item_name: name.to_string(),
            openalbion_item_icon: None,
            openalbion_item_tier: None,
        }
    }

    fn item_named(detail: &BuildDetail, loadout: BuildLoadout, slot: BuildSlot) -> Option<String> {
        detail
            .items
            .iter()
            .find(|item| item.loadout == loadout && item.slot == slot)
            .map(|item| item.openalbion_item_name.clone())
    }

    #[tokio::test]
    async fn build_items_default_to_the_main_loadout() {
        let db = seed_db().await;
        let (service, build_id) = seed_build(&db).await;

        let detail = service
            .upsert_build_item(
                &db,
                build_id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                weapon("Polehammer"),
            )
            .await
            .expect("main weapon should be stored");

        assert_eq!(
            item_named(&detail, BuildLoadout::Main, BuildSlot::Weapon).as_deref(),
            Some("Polehammer")
        );
    }

    #[tokio::test]
    async fn a_swap_item_does_not_overwrite_the_main_loadout() {
        let db = seed_db().await;
        let (service, build_id) = seed_build(&db).await;

        service
            .upsert_build_item(
                &db,
                build_id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                weapon("Polehammer"),
            )
            .await
            .expect("main weapon should be stored");
        let detail = service
            .upsert_build_item(
                &db,
                build_id,
                BuildLoadout::Swap,
                BuildSlot::Weapon,
                weapon("Realmbreaker"),
            )
            .await
            .expect("swap weapon should be stored");

        assert_eq!(
            item_named(&detail, BuildLoadout::Main, BuildSlot::Weapon).as_deref(),
            Some("Polehammer"),
            "the swap must not clobber the main loadout"
        );
        assert_eq!(
            item_named(&detail, BuildLoadout::Swap, BuildSlot::Weapon).as_deref(),
            Some("Realmbreaker")
        );
    }

    #[tokio::test]
    async fn removing_a_swap_item_leaves_the_main_loadout_alone() {
        let db = seed_db().await;
        let (service, build_id) = seed_build(&db).await;

        service
            .upsert_build_item(
                &db,
                build_id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                weapon("Polehammer"),
            )
            .await
            .expect("main weapon should be stored");
        service
            .upsert_build_item(
                &db,
                build_id,
                BuildLoadout::Swap,
                BuildSlot::Weapon,
                weapon("Realmbreaker"),
            )
            .await
            .expect("swap weapon should be stored");

        service
            .remove_build_item(&db, build_id, BuildLoadout::Swap, BuildSlot::Weapon)
            .await
            .expect("swap weapon should be removable");

        let detail = service.get_build(&db, build_id).await.unwrap();
        assert_eq!(
            item_named(&detail, BuildLoadout::Main, BuildSlot::Weapon).as_deref(),
            Some("Polehammer")
        );
        assert!(item_named(&detail, BuildLoadout::Swap, BuildSlot::Weapon).is_none());
    }

    #[tokio::test]
    async fn deleting_a_build_removes_both_loadouts() {
        let db = seed_db().await;
        let (service, build_id) = seed_build(&db).await;

        for loadout in [BuildLoadout::Main, BuildLoadout::Swap] {
            service
                .upsert_build_item(
                    &db,
                    build_id,
                    loadout,
                    BuildSlot::Weapon,
                    weapon("Polehammer"),
                )
                .await
                .expect("weapon should be stored");
        }

        service
            .delete_build(&db, build_id)
            .await
            .expect("build should be deletable");

        let remaining = build_item::Entity::find()
            .filter(BuildItemColumn::BuildId.eq(build_id))
            .count(&db)
            .await
            .unwrap();
        assert_eq!(
            remaining, 0,
            "deleting a build must cascade to both loadouts"
        );
    }

    #[test]
    fn build_loadout_round_trips_and_rejects_anything_else() {
        for loadout in [BuildLoadout::Main, BuildLoadout::Swap] {
            assert_eq!(
                BuildLoadout::from_str(loadout.as_str()).unwrap(),
                loadout,
                "{loadout} should round-trip through its string form"
            );
        }
        assert!(BuildLoadout::from_str("spare").is_err());
        assert!(BuildLoadout::from_str("MAIN").is_err());
        assert!(BuildLoadout::from_str("").is_err());
    }

    #[test]
    fn an_absent_loadout_parameter_means_the_main_loadout() {
        assert_eq!(BuildLoadout::default(), BuildLoadout::Main);
    }

    /// A real catalog weapon, so ability validation runs against the bundled dataset.
    fn broadsword() -> UpsertBuildItemRequest {
        UpsertBuildItemRequest {
            openalbion_item_type: "weapon".to_string(),
            openalbion_item_id: 1,
            openalbion_item_name: "Broadsword".to_string(),
            openalbion_item_icon: Some(
                "https://render.albiononline.com/v1/item/T8_MAIN_SWORD.png?quality=1&size=64"
                    .to_string(),
            ),
            openalbion_item_tier: Some("8".to_string()),
        }
    }

    fn holy_staff() -> UpsertBuildItemRequest {
        UpsertBuildItemRequest {
            openalbion_item_type: "weapon".to_string(),
            openalbion_item_id: 2,
            openalbion_item_name: "Great Holy Staff".to_string(),
            openalbion_item_icon: Some(
                "https://render.albiononline.com/v1/item/T8_2H_HOLYSTAFF.png?quality=1&size=64"
                    .to_string(),
            ),
            openalbion_item_tier: Some("8".to_string()),
        }
    }

    fn spells(active: &[(&str, &str)], passive: &[(&str, &str)]) -> BuildItemSpells {
        BuildItemSpells {
            active: active
                .iter()
                .map(|(slot, id)| ((*slot).to_string(), (*id).to_string()))
                .collect(),
            passive: passive
                .iter()
                .map(|(slot, id)| ((*slot).to_string(), (*id).to_string()))
                .collect(),
        }
    }

    fn spells_on(detail: &BuildDetail, loadout: BuildLoadout, slot: BuildSlot) -> BuildItemSpells {
        detail
            .items
            .iter()
            .find(|item| item.loadout == loadout && item.slot == slot)
            .map(|item| item.spells.clone())
            .unwrap_or_default()
    }

    async fn build_with_broadsword(db: &DatabaseConnection) -> (CompService, i64) {
        let (service, build_id) = seed_build(db).await;
        service
            .upsert_build_item(
                db,
                build_id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                broadsword(),
            )
            .await
            .expect("weapon should be stored");
        (service, build_id)
    }

    #[tokio::test]
    async fn an_officer_chooses_the_weapons_abilities() {
        let db = seed_db().await;
        let (service, build_id) = build_with_broadsword(&db).await;

        let detail = service
            .set_build_item_spells(
                &db,
                build_id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                spells(
                    &[("1", "HEROICSTRIKE2"), ("3", "MIGHTYBLOW")],
                    &[("1", "PASSIVE_BLEEDCHANCE")],
                ),
            )
            .await
            .expect("abilities the weapon offers should be accepted");

        let stored = spells_on(&detail, BuildLoadout::Main, BuildSlot::Weapon);
        assert_eq!(
            stored.active.get("1").map(String::as_str),
            Some("HEROICSTRIKE2")
        );
        assert_eq!(
            stored.active.get("3").map(String::as_str),
            Some("MIGHTYBLOW")
        );
        assert_eq!(
            stored.passive.get("1").map(String::as_str),
            Some("PASSIVE_BLEEDCHANCE")
        );
        assert!(
            stored.active.get("2").is_none(),
            "an unfilled slot stays empty"
        );
    }

    #[tokio::test]
    async fn an_ability_the_weapon_does_not_offer_is_refused() {
        let db = seed_db().await;
        let (service, build_id) = build_with_broadsword(&db).await;

        // Generous Heal is a Holy Staff spell, not a Broadsword one.
        let error = service
            .set_build_item_spells(
                &db,
                build_id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                spells(&[("1", "GENEROUSHEAL")], &[]),
            )
            .await
            .unwrap_err();
        match error {
            AppError::Validation(message) => assert!(
                message.contains("GENEROUSHEAL"),
                "the message should name the refused spell, got {message:?}"
            ),
            other => panic!("expected validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_ability_in_a_slot_the_weapon_does_not_have_is_refused() {
        let db = seed_db().await;
        let (service, build_id) = build_with_broadsword(&db).await;

        // A weapon has three active slots, so slot 4 does not exist.
        assert!(
            service
                .set_build_item_spells(
                    &db,
                    build_id,
                    BuildLoadout::Main,
                    BuildSlot::Weapon,
                    spells(&[("4", "HEROICSTRIKE2")], &[]),
                )
                .await
                .is_err()
        );
        // Nor does passive slot 2 on a weapon, which has one.
        assert!(
            service
                .set_build_item_spells(
                    &db,
                    build_id,
                    BuildLoadout::Main,
                    BuildSlot::Weapon,
                    spells(&[], &[("2", "PASSIVE_BLEEDCHANCE")]),
                )
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn omitting_a_slot_clears_the_ability_that_was_there() {
        let db = seed_db().await;
        let (service, build_id) = build_with_broadsword(&db).await;

        service
            .set_build_item_spells(
                &db,
                build_id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                spells(&[("1", "HEROICSTRIKE2"), ("3", "MIGHTYBLOW")], &[]),
            )
            .await
            .unwrap();
        let detail = service
            .set_build_item_spells(
                &db,
                build_id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                spells(&[("1", "HEROICSTRIKE2")], &[]),
            )
            .await
            .unwrap();

        let stored = spells_on(&detail, BuildLoadout::Main, BuildSlot::Weapon);
        assert_eq!(stored.active.len(), 1, "the omitted slot should be cleared");
        assert_eq!(
            stored.active.get("1").map(String::as_str),
            Some("HEROICSTRIKE2")
        );
    }

    #[tokio::test]
    async fn changing_the_weapon_drops_abilities_the_new_one_cannot_cast() {
        let db = seed_db().await;
        let (service, build_id) = build_with_broadsword(&db).await;
        service
            .set_build_item_spells(
                &db,
                build_id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                spells(&[("1", "HEROICSTRIKE2")], &[("1", "PASSIVE_BLEEDCHANCE")]),
            )
            .await
            .unwrap();

        let detail = service
            .upsert_build_item(
                &db,
                build_id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                holy_staff(),
            )
            .await
            .expect("the weapon should be replaceable");

        let stored = spells_on(&detail, BuildLoadout::Main, BuildSlot::Weapon);
        assert!(
            stored.active.is_empty() && stored.passive.is_empty(),
            "a Holy Staff cannot cast Broadsword abilities, so they must be cleared: {stored:?}"
        );
    }

    #[tokio::test]
    async fn re_tiering_the_same_weapon_keeps_its_abilities() {
        let db = seed_db().await;
        let (service, build_id) = build_with_broadsword(&db).await;
        service
            .set_build_item_spells(
                &db,
                build_id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                spells(&[("1", "HEROICSTRIKE2")], &[]),
            )
            .await
            .unwrap();

        let mut t4 = broadsword();
        t4.openalbion_item_tier = Some("4".to_string());
        t4.openalbion_item_icon = Some(
            "https://render.albiononline.com/v1/item/T4_MAIN_SWORD.png?quality=1&size=64"
                .to_string(),
        );
        let detail = service
            .upsert_build_item(&db, build_id, BuildLoadout::Main, BuildSlot::Weapon, t4)
            .await
            .unwrap();

        let stored = spells_on(&detail, BuildLoadout::Main, BuildSlot::Weapon);
        assert_eq!(
            stored.active.get("1").map(String::as_str),
            Some("HEROICSTRIKE2"),
            "every tier of one weapon offers the same spells"
        );
    }

    #[tokio::test]
    async fn the_main_loadout_and_the_swap_keep_separate_abilities() {
        let db = seed_db().await;
        let (service, build_id) = build_with_broadsword(&db).await;
        service
            .upsert_build_item(
                &db,
                build_id,
                BuildLoadout::Swap,
                BuildSlot::Weapon,
                broadsword(),
            )
            .await
            .unwrap();

        service
            .set_build_item_spells(
                &db,
                build_id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                spells(&[("1", "HEROICSTRIKE2")], &[]),
            )
            .await
            .unwrap();
        let detail = service
            .set_build_item_spells(
                &db,
                build_id,
                BuildLoadout::Swap,
                BuildSlot::Weapon,
                spells(&[("1", "CLEAVE")], &[]),
            )
            .await
            .unwrap();

        assert_eq!(
            spells_on(&detail, BuildLoadout::Main, BuildSlot::Weapon)
                .active
                .get("1")
                .map(String::as_str),
            Some("HEROICSTRIKE2")
        );
        assert_eq!(
            spells_on(&detail, BuildLoadout::Swap, BuildSlot::Weapon)
                .active
                .get("1")
                .map(String::as_str),
            Some("CLEAVE")
        );
    }

    #[tokio::test]
    async fn an_empty_slot_cannot_carry_abilities() {
        let db = seed_db().await;
        let (service, build_id) = seed_build(&db).await;

        let error = service
            .set_build_item_spells(
                &db,
                build_id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                spells(&[("1", "HEROICSTRIKE2")], &[]),
            )
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::NotFound(_)), "got {error:?}");
    }

    async fn fully_equipped_build(db: &DatabaseConnection) -> (CompService, i64) {
        let (service, build_id) = seed_build(db).await;
        for loadout in [BuildLoadout::Main, BuildLoadout::Swap] {
            service
                .upsert_build_item(db, build_id, loadout, BuildSlot::Weapon, broadsword())
                .await
                .expect("weapon should be stored");
        }
        service
            .set_build_item_spells(
                db,
                build_id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                spells(&[("1", "HEROICSTRIKE2")], &[("1", "PASSIVE_BLEEDCHANCE")]),
            )
            .await
            .expect("main abilities should be stored");
        service
            .set_build_item_spells(
                db,
                build_id,
                BuildLoadout::Swap,
                BuildSlot::Weapon,
                spells(&[("1", "CLEAVE")], &[]),
            )
            .await
            .expect("swap abilities should be stored");
        (service, build_id)
    }

    #[tokio::test]
    async fn a_new_version_copies_every_item_field_in_both_loadouts() {
        let db = seed_db().await;
        let (service, build_id) = fully_equipped_build(&db).await;
        let user = insert_user(&db, "officer", "officer@example.com").await;

        let copy = service
            .create_build_version(&db, build_id, user)
            .await
            .expect("a version should be creatable");

        for loadout in [BuildLoadout::Main, BuildLoadout::Swap] {
            let source = build_item::Entity::find()
                .filter(BuildItemColumn::BuildId.eq(build_id))
                .filter(BuildItemColumn::Loadout.eq(loadout.to_string()))
                .one(&db)
                .await
                .unwrap()
                .expect("the source item should exist");
            let copied = build_item::Entity::find()
                .filter(BuildItemColumn::BuildId.eq(copy.summary.id))
                .filter(BuildItemColumn::Loadout.eq(loadout.to_string()))
                .one(&db)
                .await
                .unwrap()
                .unwrap_or_else(|| panic!("the {loadout} item should have been copied"));

            // Destructured field by field on purpose: adding a column to `build_items` without
            // teaching the copy about it must fail to compile here rather than silently drop data.
            let build_item::Model {
                id: _,
                build_id: _,
                created_at: _,
                loadout: copied_loadout,
                slot: copied_slot,
                openalbion_item_type: copied_type,
                openalbion_item_id: copied_item_id,
                openalbion_item_name: copied_name,
                openalbion_item_icon: copied_icon,
                openalbion_item_tier: copied_tier,
            } = copied;
            assert_eq!(copied_loadout, source.loadout);
            assert_eq!(copied_slot, source.slot);
            assert_eq!(copied_type, source.openalbion_item_type);
            assert_eq!(copied_item_id, source.openalbion_item_id);
            assert_eq!(copied_name, source.openalbion_item_name);
            assert_eq!(copied_icon, source.openalbion_item_icon);
            assert_eq!(copied_tier, source.openalbion_item_tier);
        }
    }

    #[tokio::test]
    async fn a_new_version_copies_the_ability_choices_of_each_loadout() {
        let db = seed_db().await;
        let (service, build_id) = fully_equipped_build(&db).await;
        let user = insert_user(&db, "officer", "officer@example.com").await;

        let copy = service
            .create_build_version(&db, build_id, user)
            .await
            .unwrap();

        let main = spells_on(&copy, BuildLoadout::Main, BuildSlot::Weapon);
        assert_eq!(
            main.active.get("1").map(String::as_str),
            Some("HEROICSTRIKE2")
        );
        assert_eq!(
            main.passive.get("1").map(String::as_str),
            Some("PASSIVE_BLEEDCHANCE")
        );
        assert_eq!(
            spells_on(&copy, BuildLoadout::Swap, BuildSlot::Weapon)
                .active
                .get("1")
                .map(String::as_str),
            Some("CLEAVE"),
            "the swap's own abilities must survive the copy"
        );
    }

    #[tokio::test]
    async fn versions_are_numbered_contiguously_within_their_group() {
        let db = seed_db().await;
        let (service, build_id) = seed_build(&db).await;
        let user = insert_user(&db, "officer", "officer@example.com").await;

        let second = service
            .create_build_version(&db, build_id, user)
            .await
            .unwrap();
        let third = service
            .create_build_version(&db, second.summary.id, user)
            .await
            .unwrap();

        assert_eq!(second.summary.version, 2);
        assert_eq!(third.summary.version, 3);
    }

    #[tokio::test]
    async fn version_numbering_does_not_leak_across_groups() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let crystal = insert_build_category(&db, "Crystal").await;
        let kite = insert_build_category(&db, "Kite").await;
        let service = CompService::new();

        let crystal_build = service
            .create_build(&db, user, build_request("Pole Hammer", crystal))
            .await
            .unwrap();
        service
            .create_build_version(&db, crystal_build.summary.id, user)
            .await
            .unwrap();
        service
            .create_build_version(&db, crystal_build.summary.id, user)
            .await
            .unwrap();

        let kite_build = service
            .create_build(&db, user, build_request("Pole Hammer", kite))
            .await
            .unwrap();
        let kite_second = service
            .create_build_version(&db, kite_build.summary.id, user)
            .await
            .unwrap();

        assert_eq!(
            kite_second.summary.version, 2,
            "another category's versions must not push this group's numbering along"
        );
    }

    #[tokio::test]
    async fn editing_one_version_leaves_the_others_untouched() {
        let db = seed_db().await;
        let (service, build_id) = fully_equipped_build(&db).await;
        let user = insert_user(&db, "officer", "officer@example.com").await;
        let second = service
            .create_build_version(&db, build_id, user)
            .await
            .unwrap();

        service
            .set_build_item_spells(
                &db,
                second.summary.id,
                BuildLoadout::Main,
                BuildSlot::Weapon,
                spells(&[("1", "CLEAVE")], &[]),
            )
            .await
            .unwrap();
        service
            .upsert_build_item(
                &db,
                second.summary.id,
                BuildLoadout::Main,
                BuildSlot::Head,
                broadsword(),
            )
            .await
            .unwrap();

        let original = service.get_build(&db, build_id).await.unwrap();
        assert_eq!(
            spells_on(&original, BuildLoadout::Main, BuildSlot::Weapon)
                .active
                .get("1")
                .map(String::as_str),
            Some("HEROICSTRIKE2"),
            "v1's abilities must not follow v2's edit"
        );
        assert!(
            !original
                .items
                .iter()
                .any(|item| item.slot == BuildSlot::Head),
            "v1 must not gain the item added to v2"
        );
    }

    #[tokio::test]
    async fn a_build_detail_lists_every_version_in_its_group() {
        let db = seed_db().await;
        let (service, build_id) = seed_build(&db).await;
        let user = insert_user(&db, "officer", "officer@example.com").await;
        let second = service
            .create_build_version(&db, build_id, user)
            .await
            .unwrap();

        let detail = service.get_build(&db, build_id).await.unwrap();
        assert_eq!(
            detail
                .versions
                .iter()
                .map(|entry| (entry.id, entry.version))
                .collect::<Vec<_>>(),
            vec![(build_id, 1), (second.summary.id, 2)],
            "the switcher needs every sibling, in version order"
        );
    }

    #[tokio::test]
    async fn deleting_a_version_leaves_its_siblings_intact() {
        let db = seed_db().await;
        let (service, build_id) = fully_equipped_build(&db).await;
        let user = insert_user(&db, "officer", "officer@example.com").await;
        let second = service
            .create_build_version(&db, build_id, user)
            .await
            .unwrap();

        service.delete_build(&db, second.summary.id).await.unwrap();

        let original = service
            .get_build(&db, build_id)
            .await
            .expect("v1 must survive v2's deletion");
        assert_eq!(original.items.len(), 2, "v1 keeps both loadouts");
        assert_eq!(original.versions.len(), 1);
    }

    #[tokio::test]
    async fn deleting_the_only_version_removes_the_build() {
        let db = seed_db().await;
        let (service, build_id) = seed_build(&db).await;

        service.delete_build(&db, build_id).await.unwrap();

        assert!(service.get_build(&db, build_id).await.is_err());
    }

    #[tokio::test]
    async fn renaming_moves_every_version_in_the_group() {
        let db = seed_db().await;
        let (service, build_id) = seed_build(&db).await;
        let user = insert_user(&db, "officer", "officer@example.com").await;
        let second = service
            .create_build_version(&db, build_id, user)
            .await
            .unwrap();

        service
            .update_build(
                &db,
                second.summary.id,
                UpdateBuildRequest {
                    name: Some("Great Axe".to_string()),
                    description: None,
                    role: None,
                    category_id: None,
                },
            )
            .await
            .expect("a rename should succeed");

        let original = service.get_build(&db, build_id).await.unwrap();
        assert_eq!(
            original.summary.name, "Great Axe",
            "a rename identifies the whole group, so every version moves together"
        );
        assert_eq!(original.summary.version, 1, "versions keep their numbers");
    }

    #[tokio::test]
    async fn renaming_a_group_onto_a_taken_identity_is_refused() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let crystal = insert_build_category(&db, "Crystal").await;
        let service = CompService::new();

        let hammer = service
            .create_build(&db, user, build_request("Pole Hammer", crystal))
            .await
            .unwrap();
        service
            .create_build_version(&db, hammer.summary.id, user)
            .await
            .unwrap();
        service
            .create_build(&db, user, build_request("Great Axe", crystal))
            .await
            .unwrap();

        expect_conflict(
            service
                .update_build(
                    &db,
                    hammer.summary.id,
                    UpdateBuildRequest {
                        name: Some("Great Axe".to_string()),
                        description: None,
                        role: None,
                        category_id: None,
                    },
                )
                .await
                .unwrap_err(),
        );

        let unchanged = service.get_build(&db, hammer.summary.id).await.unwrap();
        assert_eq!(unchanged.summary.name, "Pole Hammer");
        assert_eq!(
            unchanged.versions.len(),
            2,
            "no version was left half-renamed"
        );
    }

    #[tokio::test]
    async fn a_version_a_comp_uses_cannot_be_deleted() {
        let db = seed_db().await;
        let (service, build_id) = seed_build(&db).await;
        let user = insert_user(&db, "officer", "officer@example.com").await;
        let second = service
            .create_build_version(&db, build_id, user)
            .await
            .unwrap();
        let zvz = insert_comp_category(&db, "ZvZ").await;
        let comp = service
            .create_comp(&db, user, comp_request("Standard", zvz))
            .await
            .unwrap();
        service
            .add_comp_build(
                &db,
                comp.summary.id,
                AddCompBuildRequest {
                    build_id: second.summary.id,
                    quantity: 1,
                },
            )
            .await
            .unwrap();

        let references = expect_conflict_with_references(
            service
                .delete_build(&db, second.summary.id)
                .await
                .unwrap_err(),
        );
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].resource, "comp");
        assert_eq!(references[0].label, "Standard");

        service
            .delete_build(&db, build_id)
            .await
            .expect("the unreferenced version is still deletable");
    }

    #[tokio::test]
    async fn a_comp_an_event_uses_cannot_be_deleted() {
        let db = seed_db().await;
        let user = insert_user(&db, "officer", "officer@example.com").await;
        let zvz = insert_comp_category(&db, "ZvZ").await;
        let service = CompService::new();
        let comp = service
            .create_comp(&db, user, comp_request("Roaming", zvz))
            .await
            .unwrap();

        event::ActiveModel {
            title: Set("Roaming per i Draghi".to_string()),
            comp_id: Set(comp.summary.id),
            created_by: Set(user),
            event_date_utc: Set(now()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("failed to insert the event");

        let references = expect_conflict_with_references(
            service.delete_comp(&db, comp.summary.id).await.unwrap_err(),
        );
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].resource, "event");
        assert_eq!(references[0].label, "Roaming per i Draghi");
    }

    #[tokio::test]
    async fn an_expansion_comp_inherits_its_parent_snapshot_and_merges_additions() {
        let db = seed_db().await;
        let user = insert_user(&db, "officer", "officer@example.com").await;
        let build_category = insert_build_category(&db, "ZvZ builds").await;
        let comp_category = insert_comp_category(&db, "ZvZ comps").await;
        let service = CompService::new();
        let tank = service
            .create_build(&db, user, build_request("Tank", build_category))
            .await
            .expect("tank build should be created");
        let healer = service
            .create_build(&db, user, build_request("Healer", build_category))
            .await
            .expect("healer build should be created");
        let dps = service
            .create_build(&db, user, build_request("DPS", build_category))
            .await
            .expect("dps build should be created");

        let base = service
            .create_comp(
                &db,
                user,
                CreateCompRequest {
                    name: "10-man".to_string(),
                    description: None,
                    category_id: comp_category,
                    builds: vec![
                        AddCompBuildRequest {
                            build_id: tank.summary.id,
                            quantity: 2,
                        },
                        AddCompBuildRequest {
                            build_id: healer.summary.id,
                            quantity: 8,
                        },
                    ],
                    parent_id: None,
                },
            )
            .await
            .expect("base comp should be created");

        let expansion = service
            .create_comp(
                &db,
                user,
                CreateCompRequest {
                    name: "15-man".to_string(),
                    description: None,
                    category_id: comp_category,
                    builds: vec![
                        AddCompBuildRequest {
                            build_id: tank.summary.id,
                            quantity: 1,
                        },
                        AddCompBuildRequest {
                            build_id: dps.summary.id,
                            quantity: 4,
                        },
                    ],
                    parent_id: Some(base.summary.id),
                },
            )
            .await
            .expect("a larger expansion should be created");

        let mut snapshot: Vec<(i64, i32)> = expansion
            .builds
            .iter()
            .map(|entry| (entry.build_id, entry.quantity))
            .collect();
        snapshot.sort_unstable();
        let mut expected = vec![
            (tank.summary.id, 3),
            (healer.summary.id, 8),
            (dps.summary.id, 4),
        ];
        expected.sort_unstable();

        assert_eq!(snapshot, expected);
        assert_eq!(expansion.summary.total_quantity, 15);
    }

    #[tokio::test]
    async fn an_expansion_cannot_keep_or_reduce_its_parent_capacity() {
        let db = seed_db().await;
        let user = insert_user(&db, "officer", "officer@example.com").await;
        let build_category = insert_build_category(&db, "ZvZ builds").await;
        let comp_category = insert_comp_category(&db, "ZvZ comps").await;
        let service = CompService::new();
        let build = service
            .create_build(&db, user, build_request("Tank", build_category))
            .await
            .expect("build should be created");
        let base = service
            .create_comp(
                &db,
                user,
                CreateCompRequest {
                    name: "10-man".to_string(),
                    description: None,
                    category_id: comp_category,
                    builds: vec![AddCompBuildRequest {
                        build_id: build.summary.id,
                        quantity: 10,
                    }],
                    parent_id: None,
                },
            )
            .await
            .expect("base comp should be created");

        assert!(matches!(
            service
                .create_comp(
                    &db,
                    user,
                    CreateCompRequest {
                        name: "Not an expansion".to_string(),
                        description: None,
                        category_id: comp_category,
                        builds: Vec::new(),
                        parent_id: Some(base.summary.id),
                    },
                )
                .await,
            Err(AppError::Validation(message)) if message.contains("greater")
        ));
    }

    #[tokio::test]
    async fn a_comp_cannot_be_its_own_parent() {
        let db = seed_db().await;
        let user = insert_user(&db, "officer", "officer@example.com").await;
        let comp_category = insert_comp_category(&db, "ZvZ comps").await;
        let service = CompService::new();
        let comp = service
            .create_comp(&db, user, comp_request("10-man", comp_category))
            .await
            .expect("comp should be created");

        assert!(matches!(
            service
                .update_comp(
                    &db,
                    comp.summary.id,
                    UpdateCompRequest {
                        name: None,
                        description: None,
                        category_id: None,
                        parent_id: Some(Some(comp.summary.id)),
                    },
                )
                .await,
            Err(AppError::Validation(message)) if message.contains("own parent")
        ));
    }

    #[tokio::test]
    async fn a_comp_version_copies_every_build_entry_with_its_quantity() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let crystal = insert_build_category(&db, "Crystal").await;
        let zvz = insert_comp_category(&db, "ZvZ").await;
        let service = CompService::new();
        let hammer = service
            .create_build(&db, user, build_request("Pole Hammer", crystal))
            .await
            .unwrap();
        let axe = service
            .create_build(&db, user, build_request("Great Axe", crystal))
            .await
            .unwrap();
        let comp = service
            .create_comp(&db, user, comp_request("Standard", zvz))
            .await
            .unwrap();
        for (build, quantity) in [(&hammer, 5), (&axe, 3)] {
            service
                .add_comp_build(
                    &db,
                    comp.summary.id,
                    AddCompBuildRequest {
                        build_id: build.summary.id,
                        quantity,
                    },
                )
                .await
                .unwrap();
        }

        let copy = service
            .create_comp_version(&db, comp.summary.id, user)
            .await
            .expect("a comp version should be creatable");

        let mut copied: Vec<(i64, i32)> = copy
            .builds
            .iter()
            .map(|entry| (entry.build_id, entry.quantity))
            .collect();
        copied.sort();
        let mut expected = vec![(hammer.summary.id, 5), (axe.summary.id, 3)];
        expected.sort();
        assert_eq!(copied, expected);
        assert_eq!(copy.summary.version, 2);
    }

    #[tokio::test]
    async fn a_comp_version_keeps_the_parent_it_was_derived_from() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let build_category = insert_build_category(&db, "Crystal").await;
        let zvz = insert_comp_category(&db, "ZvZ").await;
        let service = CompService::new();
        let build = service
            .create_build(&db, user, build_request("Pole Hammer", build_category))
            .await
            .unwrap();
        let parent = service
            .create_comp(&db, user, comp_request("Standard", zvz))
            .await
            .unwrap();
        let variant = service
            .create_comp(
                &db,
                user,
                CreateCompRequest {
                    builds: vec![AddCompBuildRequest {
                        build_id: build.summary.id,
                        quantity: 1,
                    }],
                    parent_id: Some(parent.summary.id),
                    ..comp_request("Bomb", zvz)
                },
            )
            .await
            .unwrap();

        let copy = service
            .create_comp_version(&db, variant.summary.id, user)
            .await
            .unwrap();

        assert_eq!(
            copy.summary.parent_id,
            Some(parent.summary.id),
            "a version of a variant is still a variant of the same parent"
        );
    }

    #[tokio::test]
    async fn editing_one_comp_version_leaves_the_others_untouched() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let crystal = insert_build_category(&db, "Crystal").await;
        let zvz = insert_comp_category(&db, "ZvZ").await;
        let service = CompService::new();
        let hammer = service
            .create_build(&db, user, build_request("Pole Hammer", crystal))
            .await
            .unwrap();
        let comp = service
            .create_comp(&db, user, comp_request("Standard", zvz))
            .await
            .unwrap();
        service
            .add_comp_build(
                &db,
                comp.summary.id,
                AddCompBuildRequest {
                    build_id: hammer.summary.id,
                    quantity: 5,
                },
            )
            .await
            .unwrap();
        let second = service
            .create_comp_version(&db, comp.summary.id, user)
            .await
            .unwrap();

        service
            .update_comp_build_quantity(
                &db,
                second.summary.id,
                hammer.summary.id,
                UpdateCompBuildQuantityRequest { quantity: 9 },
            )
            .await
            .unwrap();

        let original = service.get_comp(&db, comp.summary.id).await.unwrap();
        assert_eq!(
            original.builds[0].quantity, 5,
            "v1's quantities must not follow v2's edit"
        );
    }

    #[tokio::test]
    async fn a_comp_detail_lists_every_version_in_its_group() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let zvz = insert_comp_category(&db, "ZvZ").await;
        let service = CompService::new();
        let comp = service
            .create_comp(&db, user, comp_request("Standard", zvz))
            .await
            .unwrap();
        let second = service
            .create_comp_version(&db, comp.summary.id, user)
            .await
            .unwrap();

        let detail = service.get_comp(&db, comp.summary.id).await.unwrap();
        assert_eq!(
            detail
                .versions
                .iter()
                .map(|entry| (entry.id, entry.version))
                .collect::<Vec<_>>(),
            vec![(comp.summary.id, 1), (second.summary.id, 2)]
        );
    }

    #[tokio::test]
    async fn renaming_moves_every_comp_version_in_the_group() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let zvz = insert_comp_category(&db, "ZvZ").await;
        let service = CompService::new();
        let comp = service
            .create_comp(&db, user, comp_request("Standard", zvz))
            .await
            .unwrap();
        let second = service
            .create_comp_version(&db, comp.summary.id, user)
            .await
            .unwrap();

        service
            .update_comp(
                &db,
                second.summary.id,
                UpdateCompRequest {
                    name: Some("Bomb".to_string()),
                    description: None,
                    category_id: None,
                    parent_id: None,
                },
            )
            .await
            .unwrap();

        assert_eq!(
            service
                .get_comp(&db, comp.summary.id)
                .await
                .unwrap()
                .summary
                .name,
            "Bomb"
        );
    }

    #[tokio::test]
    async fn deleting_a_comp_version_leaves_its_siblings_intact() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let zvz = insert_comp_category(&db, "ZvZ").await;
        let service = CompService::new();
        let comp = service
            .create_comp(&db, user, comp_request("Standard", zvz))
            .await
            .unwrap();
        let second = service
            .create_comp_version(&db, comp.summary.id, user)
            .await
            .unwrap();

        service.delete_comp(&db, second.summary.id).await.unwrap();

        let original = service
            .get_comp(&db, comp.summary.id)
            .await
            .expect("v1 must survive v2's deletion");
        assert_eq!(original.versions.len(), 1);
    }

    #[tokio::test]
    async fn deleting_the_only_comp_version_removes_the_comp() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let zvz = insert_comp_category(&db, "ZvZ").await;
        let service = CompService::new();
        let comp = service
            .create_comp(&db, user, comp_request("Standard", zvz))
            .await
            .unwrap();

        service.delete_comp(&db, comp.summary.id).await.unwrap();

        assert!(service.get_comp(&db, comp.summary.id).await.is_err());
    }

    #[tokio::test]
    async fn a_build_created_before_versioning_reads_back_as_version_one() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let category = insert_build_category(&db, "Crystal").await;
        // `insert_build` writes the row without naming `version`, exactly as a row written before
        // the column existed reads back through the migration's default.
        let legacy = insert_build(&db, "Pole Hammer", "dps", category, user).await;
        let legacy_comp = insert_comp(
            &db,
            "Standard",
            insert_comp_category(&db, "ZvZ").await,
            user,
        )
        .await;
        let service = CompService::new();

        assert_eq!(
            service
                .get_build(&db, legacy)
                .await
                .unwrap()
                .summary
                .version,
            1
        );
        assert_eq!(
            service
                .get_comp(&db, legacy_comp)
                .await
                .unwrap()
                .summary
                .version,
            1
        );
    }

    #[tokio::test]
    async fn create_build_rejects_a_duplicate_name_in_the_same_category() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let crystal = insert_build_category(&db, "Crystal").await;
        let service = CompService::new();

        service
            .create_build(&db, user, build_request("Pole Hammer", crystal))
            .await
            .expect("first build should be created");

        let message = expect_conflict(
            service
                .create_build(&db, user, build_request("Pole Hammer", crystal))
                .await
                .unwrap_err(),
        );
        assert!(
            message.contains("Pole Hammer"),
            "conflict should name the clashing build, got {message:?}"
        );
    }

    #[tokio::test]
    async fn create_build_allows_the_same_name_in_another_category() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let crystal = insert_build_category(&db, "Crystal").await;
        let kite = insert_build_category(&db, "Kite").await;
        let service = CompService::new();

        service
            .create_build(&db, user, build_request("Pole Hammer", crystal))
            .await
            .expect("crystal build should be created");
        service
            .create_build(&db, user, build_request("Pole Hammer", kite))
            .await
            .expect("kite build should be created: identity is name plus category");
    }

    #[tokio::test]
    async fn create_build_identity_ignores_case_and_surrounding_whitespace() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let crystal = insert_build_category(&db, "Crystal").await;
        let service = CompService::new();

        service
            .create_build(&db, user, build_request("Pole Hammer", crystal))
            .await
            .expect("first build should be created");

        expect_conflict(
            service
                .create_build(&db, user, build_request("  pole hammer  ", crystal))
                .await
                .unwrap_err(),
        );
    }

    #[tokio::test]
    async fn create_build_stores_the_trimmed_name() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let crystal = insert_build_category(&db, "Crystal").await;
        let service = CompService::new();

        let created = service
            .create_build(&db, user, build_request("  Pole Hammer  ", crystal))
            .await
            .expect("build should be created");

        assert_eq!(created.summary.name, "Pole Hammer");
    }

    #[tokio::test]
    async fn update_build_stores_the_trimmed_name() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let crystal = insert_build_category(&db, "Crystal").await;
        let service = CompService::new();

        let created = service
            .create_build(&db, user, build_request("Pole Hammer", crystal))
            .await
            .expect("build should be created");

        let updated = service
            .update_build(
                &db,
                created.summary.id,
                UpdateBuildRequest {
                    name: Some("  Great Axe  ".to_string()),
                    description: None,
                    role: None,
                    category_id: None,
                },
            )
            .await
            .expect("rename should succeed");
        assert_eq!(updated.summary.name, "Great Axe");
    }

    #[tokio::test]
    async fn create_comp_stores_the_trimmed_name() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let zvz = insert_comp_category(&db, "ZvZ").await;
        let service = CompService::new();

        let created = service
            .create_comp(&db, user, comp_request("  Standard  ", zvz))
            .await
            .expect("comp should be created");

        assert_eq!(created.summary.name, "Standard");
    }

    #[tokio::test]
    async fn update_comp_stores_the_trimmed_name() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let zvz = insert_comp_category(&db, "ZvZ").await;
        let service = CompService::new();

        let created = service
            .create_comp(&db, user, comp_request("Standard", zvz))
            .await
            .expect("comp should be created");

        let updated = service
            .update_comp(
                &db,
                created.summary.id,
                UpdateCompRequest {
                    name: Some("  Bomb  ".to_string()),
                    description: None,
                    category_id: None,
                    parent_id: None,
                },
            )
            .await
            .expect("rename should succeed");
        assert_eq!(updated.summary.name, "Bomb");
    }

    #[tokio::test]
    async fn update_comp_rejects_a_category_move_onto_an_existing_identity() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let zvz = insert_comp_category(&db, "ZvZ").await;
        let hellgate = insert_comp_category(&db, "Hellgate").await;
        let service = CompService::new();

        service
            .create_comp(&db, user, comp_request("Standard", zvz))
            .await
            .expect("zvz comp should be created");
        let hg = service
            .create_comp(&db, user, comp_request("Standard", hellgate))
            .await
            .expect("hellgate comp should be created");

        expect_conflict(
            service
                .update_comp(
                    &db,
                    hg.summary.id,
                    UpdateCompRequest {
                        name: None,
                        description: None,
                        category_id: Some(zvz),
                        parent_id: None,
                    },
                )
                .await
                .unwrap_err(),
        );
    }

    #[tokio::test]
    async fn update_comp_lets_a_comp_keep_its_own_name() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let zvz = insert_comp_category(&db, "ZvZ").await;
        let service = CompService::new();

        let created = service
            .create_comp(&db, user, comp_request("Standard", zvz))
            .await
            .expect("comp should be created");

        service
            .update_comp(
                &db,
                created.summary.id,
                UpdateCompRequest {
                    name: Some("Standard".to_string()),
                    description: Some("Main ZvZ comp".to_string()),
                    category_id: None,
                    parent_id: None,
                },
            )
            .await
            .expect("a comp must not conflict with itself");
    }

    #[tokio::test]
    async fn update_build_rejects_a_rename_onto_an_existing_identity() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let crystal = insert_build_category(&db, "Crystal").await;
        let service = CompService::new();

        service
            .create_build(&db, user, build_request("Pole Hammer", crystal))
            .await
            .expect("first build should be created");
        let second = service
            .create_build(&db, user, build_request("Great Axe", crystal))
            .await
            .expect("second build should be created");

        expect_conflict(
            service
                .update_build(
                    &db,
                    second.summary.id,
                    UpdateBuildRequest {
                        name: Some("Pole Hammer".to_string()),
                        description: None,
                        role: None,
                        category_id: None,
                    },
                )
                .await
                .unwrap_err(),
        );

        let unchanged = service
            .get_build(&db, second.summary.id)
            .await
            .expect("second build should still exist");
        assert_eq!(unchanged.summary.name, "Great Axe");
    }

    #[tokio::test]
    async fn update_build_lets_a_build_keep_its_own_name() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let crystal = insert_build_category(&db, "Crystal").await;
        let service = CompService::new();

        let created = service
            .create_build(&db, user, build_request("Pole Hammer", crystal))
            .await
            .expect("build should be created");

        let updated = service
            .update_build(
                &db,
                created.summary.id,
                UpdateBuildRequest {
                    name: Some("Pole Hammer".to_string()),
                    description: Some("Crystal opener".to_string()),
                    role: None,
                    category_id: None,
                },
            )
            .await
            .expect("a build must not conflict with itself");
        assert_eq!(
            updated.summary.description.as_deref(),
            Some("Crystal opener")
        );
    }

    #[tokio::test]
    async fn update_build_rejects_a_category_move_onto_an_existing_identity() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let crystal = insert_build_category(&db, "Crystal").await;
        let kite = insert_build_category(&db, "Kite").await;
        let service = CompService::new();

        service
            .create_build(&db, user, build_request("Pole Hammer", crystal))
            .await
            .expect("crystal build should be created");
        let kite_build = service
            .create_build(&db, user, build_request("Pole Hammer", kite))
            .await
            .expect("kite build should be created");

        expect_conflict(
            service
                .update_build(
                    &db,
                    kite_build.summary.id,
                    UpdateBuildRequest {
                        name: None,
                        description: None,
                        role: None,
                        category_id: Some(crystal),
                    },
                )
                .await
                .unwrap_err(),
        );
    }

    #[tokio::test]
    async fn create_comp_rejects_a_duplicate_name_in_the_same_category() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let zvz = insert_comp_category(&db, "ZvZ").await;
        let service = CompService::new();

        service
            .create_comp(&db, user, comp_request("Standard", zvz))
            .await
            .expect("first comp should be created");

        expect_conflict(
            service
                .create_comp(&db, user, comp_request("standard", zvz))
                .await
                .unwrap_err(),
        );
    }

    #[tokio::test]
    async fn create_comp_allows_the_same_name_in_another_category() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let zvz = insert_comp_category(&db, "ZvZ").await;
        let hellgate = insert_comp_category(&db, "Hellgate").await;
        let service = CompService::new();

        service
            .create_comp(&db, user, comp_request("Standard", zvz))
            .await
            .expect("zvz comp should be created");
        service
            .create_comp(&db, user, comp_request("Standard", hellgate))
            .await
            .expect("hellgate comp should be created");
    }

    #[tokio::test]
    async fn update_comp_rejects_a_rename_onto_an_existing_identity() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let zvz = insert_comp_category(&db, "ZvZ").await;
        let service = CompService::new();

        service
            .create_comp(&db, user, comp_request("Standard", zvz))
            .await
            .expect("first comp should be created");
        let second = service
            .create_comp(&db, user, comp_request("Bomb", zvz))
            .await
            .expect("second comp should be created");

        expect_conflict(
            service
                .update_comp(
                    &db,
                    second.summary.id,
                    UpdateCompRequest {
                        name: Some("Standard".to_string()),
                        description: None,
                        category_id: None,
                        parent_id: None,
                    },
                )
                .await
                .unwrap_err(),
        );

        let unchanged = service
            .get_comp(&db, second.summary.id)
            .await
            .expect("second comp should still exist");
        assert_eq!(unchanged.summary.name, "Bomb");
    }

    #[tokio::test]
    async fn new_builds_and_comps_start_at_version_one() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let crystal = insert_build_category(&db, "Crystal").await;
        let zvz = insert_comp_category(&db, "ZvZ").await;
        let service = CompService::new();

        let build = service
            .create_build(&db, user, build_request("Pole Hammer", crystal))
            .await
            .expect("build should be created");
        let comp = service
            .create_comp(&db, user, comp_request("Standard", zvz))
            .await
            .expect("comp should be created");

        assert_eq!(build.summary.version, 1);
        assert_eq!(comp.summary.version, 1);
    }

    #[tokio::test]
    async fn list_comps_sorts_by_name_and_rejects_unknown_sort() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let cat = insert_comp_category(&db, "ZvZ").await;
        insert_comp(&db, "Alpha", cat, user).await;
        insert_comp(&db, "Zebra", cat, user).await;
        let service = CompService::new();
        let pagination = PaginationParams {
            page: None,
            limit: None,
        };

        let sorted = service
            .list_comps(
                &db,
                CompFilters {
                    sort: Some("name".to_string()),
                    order: Some("asc".to_string()),
                    ..Default::default()
                },
                pagination.clone(),
            )
            .await
            .unwrap();
        let names: Vec<_> = sorted.items.iter().map(|comp| comp.name.as_str()).collect();
        assert_eq!(names, vec!["Alpha", "Zebra"]);

        let error = service
            .list_comps(
                &db,
                CompFilters {
                    sort: Some("fame".to_string()),
                    ..Default::default()
                },
                pagination,
            )
            .await
            .unwrap_err();
        match error {
            AppError::Validation(message) => assert!(message.contains("fame")),
            other => panic!("expected validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn list_builds_sorts_by_name_and_rejects_unknown_sort() {
        let db = seed_db().await;
        let user = insert_user(&db, "admin", "admin@example.com").await;
        let cat = insert_build_category(&db, "Weapons").await;
        insert_build(&db, "Alpha", "dps", cat, user).await;
        insert_build(&db, "Zebra", "tank", cat, user).await;
        let service = CompService::new();
        let pagination = PaginationParams {
            page: None,
            limit: None,
        };

        let sorted = service
            .list_builds(
                &db,
                BuildFilters {
                    sort: Some("name".to_string()),
                    order: Some("asc".to_string()),
                    ..Default::default()
                },
                pagination.clone(),
            )
            .await
            .unwrap();
        let names: Vec<_> = sorted
            .items
            .iter()
            .map(|build| build.name.as_str())
            .collect();
        assert_eq!(names, vec!["Alpha", "Zebra"]);

        let error = service
            .list_builds(
                &db,
                BuildFilters {
                    sort: Some("fame".to_string()),
                    ..Default::default()
                },
                pagination,
            )
            .await
            .unwrap_err();
        match error {
            AppError::Validation(message) => assert!(message.contains("fame")),
            other => panic!("expected validation, got {other:?}"),
        }
    }
}
