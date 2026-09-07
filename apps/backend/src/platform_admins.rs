//! In-memory set of Discord ids that hold a platform-level role.
//!
//! Distinct from per-tenant `roles`: a platform admin is an admin on every
//! tenant. Reloaded from `platform_role_assignments`, always including the
//! deployment's bootstrap admin (`SUPER_ADMIN_DISCORD_ID`) — without it a fresh
//! install has an empty assignments table and nobody who can populate it.

use std::collections::HashSet;
use std::sync::{Arc, RwLock};

use sea_orm::{ConnectionTrait, DatabaseConnection, Statement};

/// Shared, reloadable set of platform-admin Discord ids.
#[derive(Clone)]
pub struct PlatformAdmins {
    ids: Arc<RwLock<HashSet<String>>>,
    /// Always a platform admin, whatever the control-plane says.
    bootstrap: Option<String>,
}

impl PlatformAdmins {
    /// Set holding only `bootstrap`. Call [`Self::reload`] before serving traffic.
    #[must_use]
    pub fn new(bootstrap: Option<&str>) -> Self {
        let bootstrap = bootstrap
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned);
        let mut ids = HashSet::new();
        if let Some(id) = &bootstrap {
            ids.insert(id.clone());
        }
        Self {
            ids: Arc::new(RwLock::new(ids)),
            bootstrap,
        }
    }

    /// Empty set with no bootstrap admin.
    #[cfg(test)]
    #[must_use]
    pub fn new_empty() -> Self {
        Self::new(None)
    }

    /// Replace the in-memory set from the control-plane.
    ///
    /// The bootstrap admin is unioned back in on every reload: it is held by the
    /// cache itself rather than passed per call, so a reload triggered by a
    /// platform-role change cannot quietly drop it until the next restart.
    ///
    /// # Errors
    ///
    /// Returns a database error if the assignments table cannot be read.
    pub async fn reload(&self, control_db: &DatabaseConnection) -> Result<(), sea_orm::DbErr> {
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
        if let Some(id) = &self.bootstrap {
            ids.insert(id.clone());
        }
        *self
            .ids
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = ids;
        Ok(())
    }

    /// Whether `discord_id` currently holds a platform role.
    #[must_use]
    pub fn contains(&self, discord_id: &str) -> bool {
        self.ids
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(discord_id)
    }

    /// Test-only: put `discord_id` in the set without a database.
    #[cfg(test)]
    pub fn insert_for_test(&self, discord_id: impl Into<String>) {
        self.ids
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

    #[test]
    fn the_bootstrap_admin_is_present_before_any_reload() {
        assert!(PlatformAdmins::new(Some("boot-1")).contains("boot-1"));
        // Blank means "no bootstrap admin", not an admin with an empty id.
        assert!(!PlatformAdmins::new(Some("  ")).contains(""));
    }
}
