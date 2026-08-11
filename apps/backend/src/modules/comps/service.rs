//! Comp service logic module.
//!
//! Provides CRUD operations for build categories, comp categories, builds (with per-slot
//! items sourced from OpenAlbion), and comps (compositions that group builds with a quantity).

use std::collections::HashSet;
use std::str::FromStr;

use sea_orm::prelude::DateTimeWithTimeZone;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, TransactionTrait,
};

use crate::errors::AppError;
use crate::pagination::{PaginatedData, PaginationParams};

use super::entities::{build, build_category, build_item, comp, comp_build, comp_category};
use super::entities::{
    build::Column as BuildColumn, build_category::Column as BuildCategoryColumn,
    build_item::Column as BuildItemColumn, comp::Column as CompColumn,
    comp_build::Column as CompBuildColumn,
};
use super::models::{
    AddCompBuildRequest, BuildCategoryView, BuildDetail, BuildFilters, BuildItemView, BuildSummary,
    CompBuildView, CompCategoryView, CompDetail, CompFilters, CompSummary,
    CreateBuildCategoryRequest, CreateBuildRequest, CreateCompCategoryRequest, CreateCompRequest,
    UpdateBuildCategoryRequest, UpdateBuildRequest, UpdateCompBuildQuantityRequest,
    UpdateCompCategoryRequest, UpdateCompRequest, UpsertBuildItemRequest,
};
use super::status::{BuildRole, BuildSlot};

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

/// Resolves a user's display name by id, returning `"Unknown"` if the user no longer exists.
async fn username_of(db: &DatabaseConnection, user_id: i64) -> Result<String, AppError> {
    crate::modules::users::display_name::resolve_by_id(db, user_id).await
}

/// Service for executing business logic operations related to comps.
pub struct CompService;

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
            role,
            category_id: build.category_id,
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
            item_views.push(BuildItemView {
                slot,
                openalbion_item_type: item.openalbion_item_type,
                openalbion_item_id: item.openalbion_item_id,
                openalbion_item_name: item.openalbion_item_name,
                openalbion_item_icon: item.openalbion_item_icon,
                openalbion_item_tier: item.openalbion_item_tier,
            });
        }

        let summary = self.to_build_summary(db, build).await?;

        Ok(BuildDetail {
            summary,
            items: item_views,
        })
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

        let mut query = build::Entity::find().order_by_desc(BuildColumn::UpdatedAt);

        if let Some(role) = filters.role {
            query = query.filter(BuildColumn::Role.eq(role.to_string()));
        }
        if let Some(category_id) = filters.category_id {
            query = query.filter(BuildColumn::CategoryId.eq(category_id));
        }

        let total_items = query.clone().count(db).await?;

        // Name filter is applied locally (case-insensitive contains) since it's a simple
        // substring search — keeps the DB query portable across SQLite/Postgres.
        let mut builds = query.offset(page * limit).limit(limit).all(db).await?;

        if let Some(q) = filters.q.as_deref().filter(|q| !q.trim().is_empty()) {
            let needle = q.to_lowercase();
            builds.retain(|b| b.name.to_lowercase().contains(&needle));
        }

        let total_pages = if limit == 0 {
            0
        } else {
            total_items.div_ceil(limit)
        };

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

        let txn = db.begin().await?;

        let active = build::ActiveModel {
            name: Set(req.name),
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

        let mut active: build::ActiveModel = build.into();
        if let Some(name) = req.name {
            active.name = Set(name);
        }
        if let Some(description) = req.description {
            active.description = Set(Some(description));
        }
        if let Some(role) = req.role {
            active.role = Set(role.to_string());
        }
        if let Some(category_id) = req.category_id {
            active.category_id = Set(category_id);
        }
        active.updated_at = Set(now());

        let updated = active.update(db).await?;

        self.to_build_detail(db, updated).await
    }

    /// Deletes a build. Fails with [`AppError::Conflict`] if any comp references it.
    pub async fn delete_build(&self, db: &DatabaseConnection, id: i64) -> Result<(), AppError> {
        let count = comp_build::Entity::find()
            .filter(CompBuildColumn::BuildId.eq(id))
            .count(db)
            .await?;

        if count > 0 {
            return Err(AppError::Conflict(format!(
                "Cannot delete build {id}: referenced by {count} comp(s)"
            )));
        }

        build::Entity::delete_by_id(id).exec(db).await?;
        Ok(())
    }

    /// Upserts (insert-or-update) the item in a specific slot of a build.
    pub async fn upsert_build_item(
        &self,
        db: &DatabaseConnection,
        build_id: i64,
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
            .filter(BuildItemColumn::Slot.eq(slot.to_string()))
            .one(db)
            .await?;

        if let Some(model) = existing {
            let mut active: build_item::ActiveModel = model.into();
            active.openalbion_item_type = Set(req.openalbion_item_type);
            active.openalbion_item_id = Set(req.openalbion_item_id);
            active.openalbion_item_name = Set(req.openalbion_item_name);
            active.openalbion_item_icon = Set(req.openalbion_item_icon);
            active.openalbion_item_tier = Set(req.openalbion_item_tier);
            active.update(db).await?;
        } else {
            let active = build_item::ActiveModel {
                build_id: Set(build_id),
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

    /// Removes the item from a specific slot of a build. No-op if the slot is already empty.
    pub async fn remove_build_item(
        &self,
        db: &DatabaseConnection,
        build_id: i64,
        slot: BuildSlot,
    ) -> Result<(), AppError> {
        build_item::Entity::delete_many()
            .filter(BuildItemColumn::BuildId.eq(build_id))
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
            category_id: comp.category_id,
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

        let summary = self.to_comp_summary(db, comp).await?;

        Ok(CompDetail {
            summary,
            builds: views,
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

        let mut query = comp::Entity::find().order_by_desc(CompColumn::CreatedAt);

        if let Some(category_id) = filters.category_id {
            query = query.filter(CompColumn::CategoryId.eq(category_id));
        }

        let total_items = query.clone().count(db).await?;

        let mut comps = query.offset(page * limit).limit(limit).all(db).await?;

        if let Some(q) = filters.q.as_deref().filter(|q| !q.trim().is_empty()) {
            let needle = q.to_lowercase();
            comps.retain(|c| c.name.to_lowercase().contains(&needle));
        }

        let total_pages = if limit == 0 {
            0
        } else {
            total_items.div_ceil(limit)
        };

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

    /// Creates a new comp with its initial set of builds, validating the category and all
    /// build references exist, and that every quantity is positive.
    pub async fn create_comp(
        &self,
        db: &DatabaseConnection,
        creator_id: i64,
        req: CreateCompRequest,
    ) -> Result<CompDetail, AppError> {
        // Validate category exists.
        let category_exists = comp_category::Entity::find_by_id(req.category_id)
            .one(db)
            .await?
            .is_some();
        if !category_exists {
            return Err(AppError::NotFound(format!(
                "Comp category {} not found",
                req.category_id
            )));
        }

        // Validate quantities.
        if req.builds.iter().any(|b| b.quantity < 1) {
            return Err(AppError::Validation("quantity must be >= 1".to_string()));
        }

        let txn = db.begin().await?;

        let active = comp::ActiveModel {
            name: Set(req.name),
            description: Set(req.description),
            category_id: Set(req.category_id),
            created_by: Set(creator_id),
            parent_id: Set(req.parent_id),
            ..Default::default()
        };
        let inserted = active.insert(&txn).await?;

        for b in &req.builds {
            // Validate build exists.
            let exists = build::Entity::find_by_id(b.build_id)
                .one(&txn)
                .await?
                .is_some();
            if !exists {
                return Err(AppError::NotFound(format!(
                    "Build {} not found",
                    b.build_id
                )));
            }

            let active = comp_build::ActiveModel {
                comp_id: Set(inserted.id),
                build_id: Set(b.build_id),
                quantity: Set(b.quantity),
                ..Default::default()
            };
            active.insert(&txn).await?;
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

        let mut active: comp::ActiveModel = comp.into();
        if let Some(name) = req.name {
            active.name = Set(name);
        }
        if let Some(description) = req.description {
            active.description = Set(Some(description));
        }
        if let Some(category_id) = req.category_id {
            active.category_id = Set(category_id);
        }
        if let Some(parent_id) = req.parent_id {
            active.parent_id = Set(Some(parent_id));
        }
        active.updated_at = Set(now());

        let updated = active.update(db).await?;

        self.to_comp_detail(db, updated).await
    }

    /// Deletes a comp. Cascades to `comp_builds` via FK.
    pub async fn delete_comp(&self, db: &DatabaseConnection, id: i64) -> Result<(), AppError> {
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
