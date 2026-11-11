//! Author-or-manage authorization for builds and comps (decision D-09).
//!
//! `comps.{builds,comps}.edit` and `.delete` only apply to rows the caller authored;
//! `comps.{builds,comps}.manage` lets the holder edit and delete anyone's. The same rule
//! covers everything that changes an existing row: update, delete, archive/unarchive,
//! item/slot/spell edits, comp build entries, and new versions (a version is written into
//! the source author's version group, so it is an edit of that group).

use sea_orm::{DatabaseConnection, EntityTrait};

use crate::errors::AppError;
use crate::modules::auth::{Permission, Permissions, UserContext};

use crate::modules::comps::entities::{build, comp};

/// Which authored resource a guard applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Authored {
    Build,
    Comp,
}

impl Authored {
    const fn manage_permission(self) -> Permission {
        match self {
            Self::Build => Permission::CompsBuildsManage,
            Self::Comp => Permission::CompsCompsManage,
        }
    }

    const fn noun(self) -> &'static str {
        match self {
            Self::Build => "build",
            Self::Comp => "comp",
        }
    }

    async fn author_id(self, db: &DatabaseConnection, id: i64) -> Result<i64, AppError> {
        let author = match self {
            Self::Build => build::Entity::find_by_id(id)
                .one(db)
                .await?
                .map(|row| row.created_by),
            Self::Comp => comp::Entity::find_by_id(id)
                .one(db)
                .await?
                .map(|row| row.created_by),
        };
        author.ok_or_else(|| AppError::NotFound(format!("{} {id} not found", self.noun())))
    }
}

/// Allows the request when the caller holds the resource's `manage` permission, or holds
/// `own_permission` and authored the row.
///
/// `manage` is checked first, so a manager gets the handler's own 404 for a missing row.
///
/// # Errors
///
/// - `AppError::Forbidden` when the caller lacks `own_permission` and `manage`, or holds only
///   `own_permission` and is not the author.
/// - `AppError::NotFound` when the row does not exist and the caller is not a manager.
pub(crate) async fn require_author_or_manage(
    user: &UserContext,
    perms: &Permissions,
    db: &DatabaseConnection,
    authored: Authored,
    id: i64,
    own_permission: Permission,
) -> Result<(), AppError> {
    let manage = authored.manage_permission();
    if user.has_permission(perms, manage).await {
        return Ok(());
    }
    user.require(perms, own_permission).await?;

    if authored.author_id(db, id).await? == user.user_id {
        return Ok(());
    }
    Err(AppError::Forbidden(format!(
        "Only the author of this {} or users with {} may change it; copy it to make your own",
        authored.noun(),
        manage.as_str()
    )))
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use sea_orm::{ConnectionTrait, Statement};

    /// Owner of build 10 and comp 20.
    pub(crate) const AUTHOR: i64 = 1;
    pub(crate) const OTHER: i64 = 2;
    pub(crate) const NOBODY: i64 = 3;

    pub(crate) async fn fixture(
        role_grants: &[(&str, &[&str])],
    ) -> (DatabaseConnection, Permissions) {
        let db = crate::testkit::migrated_sqlite().await;
        let backend = db.get_database_backend();
        let mut statements = vec![
            "INSERT INTO users (id, username, email, role, created_at) VALUES (1, 'author', 'a@x', \
             'User', '2026-11-09T00:00:00+00:00'), (2, 'other', 'o@x', 'User', \
             '2026-11-09T00:00:00+00:00'), (3, 'nobody', 'n@x', 'User', \
             '2026-11-09T00:00:00+00:00')"
                .to_string(),
            "INSERT INTO build_categories (id, name, slug, created_at) VALUES (1, 'Tank', 'tank', \
             '2026-11-09T00:00:00+00:00')"
                .to_string(),
            "INSERT INTO comp_categories (id, name, slug, created_at) VALUES (1, 'ZvZ', 'zvz', \
             '2026-11-09T00:00:00+00:00')"
                .to_string(),
            "INSERT INTO builds (id, name, role, category_id, created_by, created_at, updated_at) \
             VALUES (10, 'Mace', 'tank', 1, 1, '2026-11-09T00:00:00+00:00', \
             '2026-11-09T00:00:00+00:00')"
                .to_string(),
            "INSERT INTO comps (id, name, category_id, created_by, created_at, updated_at) VALUES \
             (20, 'Zerg', 1, 1, '2026-11-09T00:00:00+00:00', '2026-11-09T00:00:00+00:00')"
                .to_string(),
        ];
        for (role, permissions) in role_grants {
            statements.push(format!(
                "INSERT INTO roles (id, name, priority) VALUES ('{role}', '{role}', 1)"
            ));
            for permission in *permissions {
                statements.push(format!(
                    "INSERT INTO role_permissions (role_id, permission) VALUES ('{role}', \
                     '{permission}')"
                ));
            }
        }
        for statement in statements {
            db.execute(Statement::from_string(backend, statement.clone()))
                .await
                .unwrap_or_else(|error| panic!("fixture statement failed: {statement}: {error}"));
        }
        let perms = Permissions::new_empty();
        perms.reload(&db).await.expect("permission cache");
        (db, perms)
    }

    pub(crate) fn caller(user_id: i64, role: &str) -> UserContext {
        UserContext {
            id: format!("discord-{user_id}"),
            username: format!("user{user_id}"),
            email: None,
            avatar: None,
            roles: vec![role.to_string()],
            highest_role: role.to_string(),
            user_id,
            super_admin_id: None,
            is_tenant_owner: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{AUTHOR, NOBODY, OTHER, caller, fixture};
    use super::*;

    async fn allowed(
        user: &UserContext,
        perms: &Permissions,
        db: &DatabaseConnection,
        authored: Authored,
        id: i64,
        own: Permission,
    ) -> Result<(), AppError> {
        require_author_or_manage(user, perms, db, authored, id, own).await
    }

    #[tokio::test]
    async fn author_with_edit_and_delete_changes_only_own_rows() {
        let (db, perms) = fixture(&[(
            "Member",
            &[
                "comps.builds.edit",
                "comps.builds.delete",
                "comps.comps.edit",
                "comps.comps.delete",
            ],
        )])
        .await;
        let author = caller(AUTHOR, "Member");
        let other = caller(OTHER, "Member");

        for (authored, id, edit, delete) in [
            (
                Authored::Build,
                10,
                Permission::CompsBuildsEdit,
                Permission::CompsBuildsDelete,
            ),
            (
                Authored::Comp,
                20,
                Permission::CompsCompsEdit,
                Permission::CompsCompsDelete,
            ),
        ] {
            assert!(
                allowed(&author, &perms, &db, authored, id, edit)
                    .await
                    .is_ok()
            );
            assert!(
                allowed(&author, &perms, &db, authored, id, delete)
                    .await
                    .is_ok()
            );
            assert!(matches!(
                allowed(&other, &perms, &db, authored, id, edit).await,
                Err(AppError::Forbidden(_))
            ));
            assert!(matches!(
                allowed(&other, &perms, &db, authored, id, delete).await,
                Err(AppError::Forbidden(_))
            ));
        }
    }

    #[tokio::test]
    async fn author_needs_the_specific_permission_for_the_action() {
        let (db, perms) =
            fixture(&[("Editor", &["comps.builds.edit", "comps.comps.delete"])]).await;
        let author = caller(AUTHOR, "Editor");

        assert!(
            allowed(
                &author,
                &perms,
                &db,
                Authored::Build,
                10,
                Permission::CompsBuildsEdit
            )
            .await
            .is_ok()
        );
        // Authored the build but holds no `comps.builds.delete`.
        assert!(matches!(
            allowed(
                &author,
                &perms,
                &db,
                Authored::Build,
                10,
                Permission::CompsBuildsDelete
            )
            .await,
            Err(AppError::Forbidden(_))
        ));
        // Authored the comp but holds no `comps.comps.edit`.
        assert!(matches!(
            allowed(
                &author,
                &perms,
                &db,
                Authored::Comp,
                20,
                Permission::CompsCompsEdit
            )
            .await,
            Err(AppError::Forbidden(_))
        ));
    }

    #[tokio::test]
    async fn manage_changes_anyones_rows_and_is_scoped_to_its_resource() {
        let (db, perms) = fixture(&[
            ("Build manager", &["comps.builds.manage"]),
            ("Comp manager", &["comps.comps.manage"]),
        ])
        .await;
        let build_manager = caller(OTHER, "Build manager");
        let comp_manager = caller(OTHER, "Comp manager");

        for own in [Permission::CompsBuildsEdit, Permission::CompsBuildsDelete] {
            assert!(
                allowed(&build_manager, &perms, &db, Authored::Build, 10, own)
                    .await
                    .is_ok()
            );
            assert!(matches!(
                allowed(&comp_manager, &perms, &db, Authored::Build, 10, own).await,
                Err(AppError::Forbidden(_))
            ));
        }
        for own in [Permission::CompsCompsEdit, Permission::CompsCompsDelete] {
            assert!(
                allowed(&comp_manager, &perms, &db, Authored::Comp, 20, own)
                    .await
                    .is_ok()
            );
            assert!(matches!(
                allowed(&build_manager, &perms, &db, Authored::Comp, 20, own).await,
                Err(AppError::Forbidden(_))
            ));
        }
    }

    #[tokio::test]
    async fn caller_without_any_grant_is_refused_even_on_their_own_row() {
        let (db, perms) = fixture(&[("Viewer", &["comps.builds.view", "comps.comps.view"])]).await;
        let author = caller(AUTHOR, "Viewer");
        let nobody = caller(NOBODY, "Viewer");

        for user in [&author, &nobody] {
            assert!(matches!(
                allowed(
                    user,
                    &perms,
                    &db,
                    Authored::Build,
                    10,
                    Permission::CompsBuildsEdit
                )
                .await,
                Err(AppError::Forbidden(_))
            ));
            assert!(matches!(
                allowed(
                    user,
                    &perms,
                    &db,
                    Authored::Comp,
                    20,
                    Permission::CompsCompsDelete
                )
                .await,
                Err(AppError::Forbidden(_))
            ));
        }
    }

    #[tokio::test]
    async fn rows_authored_by_someone_else_or_a_system_user_need_manage() {
        // `created_by` is NOT NULL, so a row never lacks an author; rows written by a user who
        // is not the caller (including a migration/system user) behave like any other row.
        let (db, perms) = fixture(&[
            ("Member", &["comps.builds.edit", "comps.comps.edit"]),
            ("Manager", &["comps.builds.manage", "comps.comps.manage"]),
        ])
        .await;
        let member = caller(NOBODY, "Member");
        let manager = caller(NOBODY, "Manager");

        assert!(matches!(
            allowed(
                &member,
                &perms,
                &db,
                Authored::Build,
                10,
                Permission::CompsBuildsEdit
            )
            .await,
            Err(AppError::Forbidden(_))
        ));
        assert!(
            allowed(
                &manager,
                &perms,
                &db,
                Authored::Build,
                10,
                Permission::CompsBuildsEdit
            )
            .await
            .is_ok()
        );
    }

    #[tokio::test]
    async fn missing_row_is_not_found_for_an_author_role_and_deferred_for_a_manager() {
        let (db, perms) = fixture(&[
            ("Member", &["comps.builds.edit"]),
            ("Manager", &["comps.builds.manage"]),
        ])
        .await;
        assert!(matches!(
            allowed(
                &caller(AUTHOR, "Member"),
                &perms,
                &db,
                Authored::Build,
                999,
                Permission::CompsBuildsEdit
            )
            .await,
            Err(AppError::NotFound(_))
        ));
        // A manager passes the guard; the handler's own lookup reports the 404.
        assert!(
            allowed(
                &caller(AUTHOR, "Manager"),
                &perms,
                &db,
                Authored::Build,
                999,
                Permission::CompsBuildsEdit
            )
            .await
            .is_ok()
        );
    }

    #[tokio::test]
    async fn tenant_owner_bypasses_the_guard() {
        let (db, perms) = fixture(&[]).await;
        let mut owner = caller(NOBODY, "None");
        owner.is_tenant_owner = true;
        assert!(
            allowed(
                &owner,
                &perms,
                &db,
                Authored::Comp,
                20,
                Permission::CompsCompsDelete
            )
            .await
            .is_ok()
        );
    }
}
