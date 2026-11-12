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

use super::permissions::Permission;
use backend_entities::auth::{role, role_permission};

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
        self.inner.get(role).is_some_and(|permissions| {
            permissions.contains(&perm)
                || (permissions.contains(&Permission::EventsManage)
                    && matches!(
                        perm,
                        Permission::EventsView
                            | Permission::EventsCreate
                            | Permission::EventsEdit
                            | Permission::EventsDelete
                    ))
                || (permissions.contains(&Permission::SplitsManage)
                    && matches!(
                        perm,
                        Permission::SplitsView
                            | Permission::SplitsCreate
                            | Permission::SplitsEdit
                            | Permission::SplitsDelete
                    ))
                // `manage` is the "does everything, on anyone's rows" grant: it covers the
                // own-rows view/create/edit/delete permissions of the same resource.
                || (permissions.contains(&Permission::CompsBuildsManage)
                    && matches!(
                        perm,
                        Permission::CompsBuildsView
                            | Permission::CompsBuildsCreate
                            | Permission::CompsBuildsEdit
                            | Permission::CompsBuildsDelete
                    ))
                || (permissions.contains(&Permission::CompsCompsManage)
                    && matches!(
                        perm,
                        Permission::CompsCompsView
                            | Permission::CompsCompsCreate
                            | Permission::CompsCompsEdit
                            | Permission::CompsCompsDelete
                    ))
        })
    }

    /// A copy of this snapshot in which no role holds `events.manage`.
    ///
    /// The granular event permissions that `events.manage` implies are granted explicitly
    /// first, so a role keeps everything it could do on its own events and only loses the
    /// right to manage other people's.
    #[must_use]
    pub fn without_events_manage(&self) -> Self {
        let mut inner = self.inner.clone();
        for permissions in inner.values_mut() {
            if permissions.remove(&Permission::EventsManage) {
                permissions.extend([
                    Permission::EventsView,
                    Permission::EventsCreate,
                    Permission::EventsEdit,
                    Permission::EventsDelete,
                ]);
            }
        }
        Self { inner }
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

    /// A detached handle over this snapshot in which no role holds `events.manage` (see
    /// [`PermissionCache::without_events_manage`]). It does not follow later reloads, so it is
    /// meant for the duration of one request.
    pub async fn without_events_manage(&self) -> Self {
        let snapshot = self.0.read().await.without_events_manage();
        Self(Arc::new(RwLock::new(snapshot)))
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

    /// Returns the stable permission keys granted to the current session.
    ///
    /// Super-admin receives every known permission so clients can render by capability instead of
    /// mirroring backend role rules. Regular users receive the union of permissions granted by all
    /// their roles in the `role_permissions` table.
    pub async fn granted_permissions(
        &self,
        is_superadmin: bool,
        user_roles: &[String],
    ) -> Vec<String> {
        if is_superadmin {
            return Permission::all()
                .iter()
                .map(|permission| permission.as_str().to_string())
                .collect();
        }

        let cache = self.0.read().await;
        let mut permission_keys: Vec<String> = Permission::all()
            .iter()
            .filter(|permission| {
                user_roles
                    .iter()
                    .any(|role| cache.role_has(role, **permission))
            })
            .map(|permission| permission.as_str().to_string())
            .collect();
        permission_keys.sort();
        permission_keys
    }

    /// Returns `true` if any of `user_roles` grants `perm`.
    ///
    /// `is_superadmin` short-circuits to `true` so callers don't need a special
    /// case for the configured super-admin Discord id.
    pub async fn check(
        &self,
        is_superadmin: bool,
        user_roles: &[String],
        perm: Permission,
    ) -> bool {
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
    ) -> Result<(), backend_core::errors::AppError> {
        if self.check(is_superadmin, user_roles, perm).await {
            Ok(())
        } else {
            Err(backend_core::errors::AppError::Forbidden(format!(
                "Missing permission: {}",
                perm.as_str()
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PermissionCache;
    use crate::auth::Permission;
    use std::collections::{HashMap, HashSet};

    #[test]
    fn legacy_events_manage_grant_covers_granular_event_permissions() {
        let cache = PermissionCache {
            inner: HashMap::from([(
                "Legacy event manager".to_string(),
                HashSet::from([Permission::EventsManage]),
            )]),
        };

        for permission in [
            Permission::EventsView,
            Permission::EventsCreate,
            Permission::EventsEdit,
            Permission::EventsDelete,
        ] {
            assert!(cache.role_has("Legacy event manager", permission));
        }
        assert!(!cache.role_has("Member", Permission::EventsEdit));
    }

    #[test]
    fn dropping_events_manage_keeps_the_granular_event_permissions() {
        let cache = PermissionCache {
            inner: HashMap::from([
                (
                    "Officer".to_string(),
                    HashSet::from([Permission::EventsManage, Permission::CompsCompsView]),
                ),
                (
                    "Member".to_string(),
                    HashSet::from([Permission::EventsView]),
                ),
            ]),
        };

        let reduced = cache.without_events_manage();
        assert!(!reduced.role_has("Officer", Permission::EventsManage));
        for permission in [
            Permission::EventsView,
            Permission::EventsCreate,
            Permission::EventsEdit,
            Permission::EventsDelete,
            Permission::CompsCompsView,
        ] {
            assert!(reduced.role_has("Officer", permission), "{permission:?}");
        }
        assert!(reduced.role_has("Member", Permission::EventsView));
        assert!(
            cache.role_has("Officer", Permission::EventsManage),
            "the original snapshot is untouched"
        );
    }

    #[test]
    fn splits_manage_grant_covers_granular_split_permissions() {
        let cache = PermissionCache {
            inner: HashMap::from([
                (
                    "Split manager".to_string(),
                    HashSet::from([Permission::SplitsManage]),
                ),
                (
                    "Split editor".to_string(),
                    HashSet::from([Permission::SplitsEdit]),
                ),
            ]),
        };

        for permission in [
            Permission::SplitsView,
            Permission::SplitsCreate,
            Permission::SplitsEdit,
            Permission::SplitsDelete,
        ] {
            assert!(cache.role_has("Split manager", permission));
        }
        // The implication is one way: a plain `splits.edit` holder gets no manage rights.
        assert!(cache.role_has("Split editor", Permission::SplitsEdit));
        assert!(!cache.role_has("Split editor", Permission::SplitsDelete));
        assert!(!cache.role_has("Split editor", Permission::SplitsManage));
    }

    #[test]
    fn comps_and_builds_manage_cover_their_own_resource_only() {
        let cache = PermissionCache {
            inner: HashMap::from([
                (
                    "Comp manager".to_string(),
                    HashSet::from([Permission::CompsCompsManage]),
                ),
                (
                    "Build manager".to_string(),
                    HashSet::from([Permission::CompsBuildsManage]),
                ),
                (
                    "Build author".to_string(),
                    HashSet::from([Permission::CompsBuildsEdit]),
                ),
            ]),
        };

        for permission in [
            Permission::CompsCompsView,
            Permission::CompsCompsCreate,
            Permission::CompsCompsEdit,
            Permission::CompsCompsDelete,
        ] {
            assert!(cache.role_has("Comp manager", permission));
            assert!(!cache.role_has("Build manager", permission));
        }
        for permission in [
            Permission::CompsBuildsView,
            Permission::CompsBuildsCreate,
            Permission::CompsBuildsEdit,
            Permission::CompsBuildsDelete,
        ] {
            assert!(cache.role_has("Build manager", permission));
            assert!(!cache.role_has("Comp manager", permission));
        }
        // One way: an author-level `edit` never grants `manage` or `delete`.
        assert!(cache.role_has("Build author", Permission::CompsBuildsEdit));
        assert!(!cache.role_has("Build author", Permission::CompsBuildsDelete));
        assert!(!cache.role_has("Build author", Permission::CompsBuildsManage));
    }
}
