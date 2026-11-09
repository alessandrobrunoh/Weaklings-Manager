//! Keeps existing roles at their current power under author-or-manage (D-09).
//!
//! Until now `comps.{builds,comps}.edit` and `.delete` let a role change anyone's rows. They now
//! apply to the caller's own rows only, and `comps.{builds,comps}.manage` carries the old
//! "anyone's" power. So every role that holds `.edit` or `.delete` for a resource also receives
//! that resource's `.manage`: nobody gains or loses access on deploy. Owners can then remove
//! `.manage` from a role to narrow it to its own rows. `.create` alone does not imply `.manage`:
//! it never allowed touching an existing row, except creating a new version of someone else's
//! build/comp, which is now an author-or-manage action.
//!
//! `created_by` is `NOT NULL` on `builds` and `comps`, so no row lacks an author and no
//! backfill is needed; rows written by a user other than the caller (including legacy rows
//! attributed to the first user) can only be changed by that user or by a `manage` holder.

use sea_orm_migration::prelude::*;

/// Grants `.manage` to every role that holds the resource's `.edit` or `.delete`.
#[derive(DeriveMigrationName)]
pub struct Migration;

const RESOURCES: [&str; 2] = ["comps.builds", "comps.comps"];

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for resource in RESOURCES {
            manager
                .get_connection()
                .execute_unprepared(&format!(
                    "INSERT INTO role_permissions (role_id, permission) \
                     SELECT DISTINCT role_id, '{resource}.manage' FROM role_permissions \
                     WHERE permission IN ('{resource}.edit', '{resource}.delete') \
                     ON CONFLICT DO NOTHING"
                ))
                .await?;
        }
        Ok(())
    }

    /// Does nothing: `.manage` may have been granted deliberately (Admin and Officer held it
    /// before this migration), so revoking it on rollback could remove power it never added.
    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{ConnectionTrait, Database, DatabaseConnection, Statement};
    use sea_orm_migration::{MigrationName, MigratorTrait};

    async fn exec(db: &DatabaseConnection, sql: &str) {
        db.execute(Statement::from_string(
            db.get_database_backend(),
            sql.to_string(),
        ))
        .await
        .unwrap_or_else(|error| panic!("{sql}: {error}"));
    }

    async fn grants_by_name(db: &DatabaseConnection, role_name: &str) -> Vec<String> {
        let rows = db
            .query_all(Statement::from_string(
                db.get_database_backend(),
                format!(
                    "SELECT rp.permission FROM role_permissions rp \
                     JOIN roles r ON r.id = rp.role_id WHERE r.name = '{role_name}' \
                     ORDER BY rp.permission"
                ),
            ))
            .await
            .expect("grants by name query");
        rows.iter()
            .map(|row| row.try_get_by_index::<String>(0).expect("permission"))
            .collect()
    }

    async fn grants(db: &DatabaseConnection, role: &str) -> Vec<String> {
        let rows = db
            .query_all(Statement::from_string(
                db.get_database_backend(),
                format!(
                    "SELECT permission FROM role_permissions WHERE role_id = '{role}' \
                     ORDER BY permission"
                ),
            ))
            .await
            .expect("grants query");
        rows.iter()
            .map(|row| row.try_get_by_index::<String>(0).expect("permission"))
            .collect()
    }

    #[tokio::test]
    async fn editors_and_deleters_keep_their_reach_through_manage() {
        let db = Database::connect("sqlite::memory:").await.expect("db");
        let all = crate::migration::Migrator::migrations();
        let steps = all
            .iter()
            .position(|migration| migration.name() == Migration.name())
            .expect("migration must be registered");
        crate::migration::Migrator::up(&db, Some(steps as u32))
            .await
            .expect("preceding migrations");

        for role in [
            "editor",
            "deleter",
            "creator",
            "viewer",
            "comps-only-editor",
        ] {
            exec(
                &db,
                &format!("INSERT INTO roles (id, name, priority) VALUES ('{role}', '{role}', 1)"),
            )
            .await;
        }
        for (role, permission) in [
            ("editor", "comps.builds.edit"),
            ("deleter", "comps.comps.delete"),
            ("creator", "comps.builds.create"),
            ("creator", "comps.comps.create"),
            ("viewer", "comps.builds.view"),
            ("comps-only-editor", "comps.comps.edit"),
        ] {
            exec(
                &db,
                &format!(
                    "INSERT INTO role_permissions (role_id, permission) VALUES ('{role}', \
                     '{permission}')"
                ),
            )
            .await;
        }

        crate::migration::Migrator::up(&db, Some(1))
            .await
            .expect("this migration");

        // Edit/delete holders gain `manage` for their own resource only.
        assert_eq!(
            grants(&db, "editor").await,
            ["comps.builds.edit", "comps.builds.manage"]
        );
        assert_eq!(
            grants(&db, "deleter").await,
            ["comps.comps.delete", "comps.comps.manage"]
        );
        assert_eq!(
            grants(&db, "comps-only-editor").await,
            ["comps.comps.edit", "comps.comps.manage"]
        );
        // Create-only and view-only roles gain nothing.
        assert_eq!(
            grants(&db, "creator").await,
            ["comps.builds.create", "comps.comps.create"]
        );
        assert_eq!(grants(&db, "viewer").await, ["comps.builds.view"]);

        // Re-running the statements is idempotent.
        exec(
            &db,
            "INSERT INTO role_permissions (role_id, permission) SELECT DISTINCT role_id, \
             'comps.builds.manage' FROM role_permissions WHERE permission IN \
             ('comps.builds.edit', 'comps.builds.delete') ON CONFLICT DO NOTHING",
        )
        .await;
        assert_eq!(
            grants(&db, "editor").await,
            ["comps.builds.edit", "comps.builds.manage"]
        );
    }

    #[tokio::test]
    async fn admin_ends_up_with_manage_for_both_resources() {
        let db = Database::connect("sqlite::memory:").await.expect("db");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("all migrations");
        // A freshly migrated database seeds only Admin, Moderator and User; Officer exists only on
        // tenants that created it. The seeded roles are keyed by id, so look them up by name.
        for role in ["Admin"] {
            let granted = grants_by_name(&db, role).await;
            for permission in [
                "comps.builds.manage",
                "comps.comps.manage",
                "comps.builds.edit",
                "comps.comps.delete",
            ] {
                assert!(
                    granted.iter().any(|g| g == permission),
                    "{role} lacks {permission}"
                );
            }
        }
    }
}
