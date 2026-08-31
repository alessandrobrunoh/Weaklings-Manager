//! Persistence and DTOs for Albion Online combat specializations.

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// A persisted combat specialization level for one Albion item node.
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "user_specializations")]
pub struct Model {
    /// Database row identifier.
    #[sea_orm(primary_key)]
    pub id: i64,
    /// Internal user owning this specialization.
    pub user_id: i64,
    /// Stable frontend/catalog key, for example `weapon:42`.
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

/// Public specialization row returned to the frontend.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct UserSpecializationView {
    /// Stable item key.
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
    /// Stable item key, such as `weapon:42` or `armor:101`.
    pub node_key: String,
    /// Current catalog display name.
    pub node_name: String,
    /// Must be `weapon` or `armor`.
    pub category: String,
    /// Inclusive level range 0..=120.
    pub level: i32,
}

/// Batch update request for one user's specialization rows.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateSpecializationsRequest {
    /// Rows to upsert; omitted rows are left unchanged.
    pub specializations: Vec<UserSpecializationInput>,
}
