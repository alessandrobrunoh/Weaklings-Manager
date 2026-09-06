//! In-memory set of Discord ids that hold a platform-level role.
//!
//! Distinct from per-tenant `roles`: a platform admin is an admin on every
//! tenant. Reloaded from `platform_role_assignments` (plus the deployment
//! `SUPER_ADMIN_DISCORD_ID` fallback until that env var is removed).

use std::collections::HashSet;
use std::sync::{Arc, RwLock};

use sea_orm::{ConnectionTrait, DatabaseConnection, Statement};

/// Shared, reloadable set of platform-admin Discord ids.
#[derive(Clone)]
pub struct PlatformAdmins(Arc<RwLock<HashSet<String>>>);

impl PlatformAdmins {
    /// Empty set. Call [`Self::reload`] before serving traffic.
    #[must_use]
    pub fn new_empty() -> Self {
        Self(Arc::new(RwLock::new(HashSet::new())))
    }

    /// Replace the in-memory set from the control-plane.
    ///
    /// `fallback` is unioned in so a deployment that has not yet run
    /// `backfill_tenant_one` still treats `SUPER_ADMIN_DISCORD_ID` as a
    /// platform admin.
    ///
    /// # Errors
    ///
    /// Returns a database error if the assignments table cannot be read.
    pub async fn reload(
        &self,
        control_db: &DatabaseConnection,
        fallback: Option<&str>,
    ) -> Result<(), sea_orm::DbErr> {
        let rows = control_db
            .query_all(Statement::from_string(
                control_db.get_database_backend(),
                "SELECT discord_id FROM platform_role_assignments".to_owned(),
            ))
            .await?;
        let mut ids = HashSet::new();
        for row in rows {
            ids.insert(row.try_get_by_index::<String>(0)?);
        }
        if let Some(id) = fallback.map(str::trim).filter(|id| !id.is_empty()) {
            ids.insert(id.to_owned());
        }
        *self
            .0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = ids;
        Ok(())
    }

    /// Whether `discord_id` currently holds a platform role.
    #[must_use]
    pub fn contains(&self, discord_id: &str) -> bool {
        self.0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(discord_id)
    }

    /// Test-only: put `discord_id` in the set without a database.
    #[cfg(test)]
    pub fn insert_for_test(&self, discord_id: impl Into<String>) {
        self.0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(discord_id.into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contains_is_false_on_empty_and_true_after_manual_insert() {
        let admins = PlatformAdmins::new_empty();
        assert!(!admins.contains("123"));
        admins.insert_for_test("123");
        assert!(admins.contains("123"));
        assert!(!admins.contains("999"));
    }
}
