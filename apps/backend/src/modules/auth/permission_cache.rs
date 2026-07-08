//! In-memory cache of the role→permission mapping, loaded from the
//! `role_permissions` table and shared across requests via an Axum `Extension`.
//!
//! The cache is read on every authorized request, so reads are cheap (a `HashMap`
//! lookup behind an `RwLock` read guard). To apply a DB change at runtime, call
//! [`Permissions::reload`] (exposed as `POST /api/admin/permissions/reload`).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use sea_orm::{DatabaseConnection, EntityTrait};
use tokio::sync::RwLock;

use super::entities::{role, role_permission};
use super::permissions::Permission;

/// Immutable snapshot of the role→permission mapping, keyed by role **name**
/// (the same string Discord stores in the session cookie's `roles` array).
#[derive(Debug, Default, Clone)]
pub struct PermissionCache {
    inner: HashMap<String, HashSet<Permission>>,
}

impl PermissionCache {
    /// Returns `true` if `role` has been granted `perm`.
    #[must_use]
    pub fn role_has(&self, role: &str, perm: Permission) -> bool {
        self.inner.get(role).is_some_and(|set| set.contains(&perm))
    }

    /// Load a fresh snapshot from the database.
    ///
    /// Joins `role_permissions` to `roles` so the cache is keyed by role name
    /// (what the session cookie carries) rather than by Discord role id.
    ///
    /// Unknown permission strings in the DB are silently skipped — see
    /// [`Permission::from_str`].
    ///
    /// # Errors
    ///
    /// Propagates `sea_orm::DbErr` if either query fails.
    pub async fn load(db: &DatabaseConnection) -> Result<Self, sea_orm::DbErr> {
        let roles = role::Entity::find().all(db).await?;
        let mappings = role_permission::Entity::find().all(db).await?;

        let id_to_name: HashMap<_, _> = roles
            .iter()
            .map(|r| (r.id.clone(), r.name.clone()))
            .collect();

        let mut inner: HashMap<String, HashSet<Permission>> = HashMap::new();
        for m in &mappings {
            let Some(name) = id_to_name.get(&m.role_id) else {
                continue;
            };
            let Some(p) = Permission::from_str(&m.permission) else {
                continue;
            };
            inner.entry(name.clone()).or_default().insert(p);
        }

        Ok(Self { inner })
    }
}

/// Shared, reloadable handle to the [`PermissionCache`].
///
/// Cheap to clone (inner is `Arc`); inject as `axum::Extension<Permissions>`.
#[derive(Clone)]
pub struct Permissions(Arc<RwLock<PermissionCache>>);

impl Permissions {
    /// Build a handle wrapping an empty cache. Call [`Self::reload`] before use.
    #[must_use]
    pub fn new_empty() -> Self {
        Self(Arc::new(RwLock::new(PermissionCache::default())))
    }

    /// Replace the in-memory snapshot with a fresh one read from the database.
    ///
    /// # Errors
    ///
    /// Propagates `sea_orm::DbErr` if the load fails (the existing cache is left
    /// untouched in that case).
    pub async fn reload(&self, db: &DatabaseConnection) -> Result<(), sea_orm::DbErr> {
        let fresh = PermissionCache::load(db).await?;
        *self.0.write().await = fresh;
        Ok(())
    }

    /// Returns `true` if any of `user_roles` grants `perm`.
    ///
    /// `is_superadmin` short-circuits to `true` so callers don't need a special
    /// case for the configured super-admin Discord id.
    pub async fn check(&self, is_superadmin: bool, user_roles: &[String], perm: Permission) -> bool {
        if is_superadmin {
            return true;
        }
        let cache = self.0.read().await;
        user_roles.iter().any(|r| cache.role_has(r, perm))
    }

    /// Like [`Self::check`] but returns `AppError::Forbidden` when denied.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Forbidden` with the missing permission's stable key.
    pub async fn require(
        &self,
        is_superadmin: bool,
        user_roles: &[String],
        perm: Permission,
    ) -> Result<(), crate::errors::AppError> {
        if self.check(is_superadmin, user_roles, perm).await {
            Ok(())
        } else {
            Err(crate::errors::AppError::Forbidden(format!(
                "Missing permission: {}",
                perm.as_str()
            )))
        }
    }
}
