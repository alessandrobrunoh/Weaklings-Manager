//! Persistence and DTOs for Albion Online combat specializations.

use std::collections::HashMap;

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::errors::AppError;

/// A persisted combat specialization level for one Albion item node.
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "user_specializations")]
pub struct Model {
    /// Database row identifier.
    #[sea_orm(primary_key)]
    pub id: i64,
    /// Internal user owning this specialization.
    pub user_id: i64,
    /// Stable frontend/catalog key, for example `weapon:T8_2H_BOW`.
    pub node_key: String,
    /// Display name copied from the catalog at save time.
    pub node_name: String,
    /// Combat branch: `weapon` or `armor`.
    pub category: String,
    /// Albion specialization level, inclusive range 0..=120.
    pub level: i32,
    /// Last update timestamp.
    pub updated_at: DateTimeWithTimeZone,
    /// User that last edited the row.
    pub updated_by_user_id: Option<i64>,
}

#[derive(Copy, Clone, Debug, DeriveRelation, EnumIter)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// Converts legacy tier-specific keys into the canonical specialization key.
///
/// For example, `weapon:T8_MAIN_NATURESTAFF` becomes `weapon:MAIN_NATURESTAFF`.
pub fn canonical_node_key(node_key: &str) -> String {
    let Some((category, identifier)) = node_key.trim().split_once(':') else {
        return node_key.trim().to_string();
    };
    let identifier = identifier.trim().to_ascii_uppercase();
    let identifier = identifier
        .strip_prefix("T1_")
        .or_else(|| identifier.strip_prefix("T2_"))
        .or_else(|| identifier.strip_prefix("T3_"))
        .or_else(|| identifier.strip_prefix("T4_"))
        .or_else(|| identifier.strip_prefix("T5_"))
        .or_else(|| identifier.strip_prefix("T6_"))
        .or_else(|| identifier.strip_prefix("T7_"))
        .or_else(|| identifier.strip_prefix("T8_"))
        .unwrap_or(&identifier);
    format!("{}:{}", category.trim().to_ascii_lowercase(), identifier)
}

/// Loads the canonical specialization levels of several users at once.
///
/// Returns `user_id -> node_key -> level`, with keys already run through [`canonical_node_key`]
/// and the highest level kept when two legacy tier-specific rows collapse onto the same key.
///
/// Extracted because three callers need exactly this and one of them used to skip it: the roster
/// endpoint built its participants with an empty map, so the specialization badge next to every
/// bench member rendered zero regardless of what the player had trained.
///
/// # Errors
///
/// Returns [`AppError::Database`] when the query fails.
pub async fn load_levels_for_users<C: ConnectionTrait>(
    db: &C,
    user_ids: &[i64],
) -> Result<HashMap<i64, HashMap<String, i32>>, AppError> {
    if user_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = Entity::find()
        .filter(Column::UserId.is_in(user_ids.to_vec()))
        .all(db)
        .await
        .map_err(AppError::Database)?;

    let mut by_user: HashMap<i64, HashMap<String, i32>> = HashMap::new();
    for row in rows {
        by_user
            .entry(row.user_id)
            .or_default()
            .entry(canonical_node_key(&row.node_key))
            .and_modify(|level| *level = (*level).max(row.level))
            .or_insert(row.level);
    }
    Ok(by_user)
}

/// Public specialization row returned to the frontend.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct UserSpecializationView {
    /// Stable item key, based on the manual catalog identifier.
    pub node_key: String,
    /// Item display name.
    pub node_name: String,
    /// Combat category.
    pub category: String,
    /// Current level from 0 to 120.
    pub level: i32,
    /// Last update timestamp in RFC3339 form.
    pub updated_at: String,
}

impl From<Model> for UserSpecializationView {
    fn from(model: Model) -> Self {
        Self {
            node_key: model.node_key,
            node_name: model.node_name,
            category: model.category,
            level: model.level,
            updated_at: model.updated_at.to_rfc3339(),
        }
    }
}

/// One specialization to create or update.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UserSpecializationInput {
    /// Stable node key. `weapon:T8_2H_BOW` / `armor:T8_ARMOR_PLATE_SET1` name a catalog item;
    /// `mastery:COMBAT_HAMMERS` names a Destiny Board family node directly.
    pub node_key: String,
    /// Current catalog display name.
    pub node_name: String,
    /// `weapon`, `armor`, or `mastery` for a family-level node.
    pub category: String,
    /// Inclusive level range: 0..=120 for `weapon`/`armor`, 0..=100 for `mastery`.
    pub level: i32,
}

/// Batch update request for one user's specialization rows.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateSpecializationsRequest {
    /// Rows to upsert; omitted rows are left unchanged.
    pub specializations: Vec<UserSpecializationInput>,
}
