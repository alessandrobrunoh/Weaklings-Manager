//! Removes the members' Destiny Board levels.
//!
//! The only member-skill system left is the declared weapons (`user_weapons`), so the
//! `user_specializations` table is dropped together with its data. The permission that used to
//! gate editing another member's specializations now gates officer weapon locks: roles holding
//! `users.specializations.manage` are moved to `users.weapons.manage`.
//!
//! `combat.calibration.view` goes too: the calibration report scored each member's stored
//! levels against observed battles, so it disappears with them, and its grants are deleted.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const OLD_PERMISSION: &str = "users.specializations.manage";
const NEW_PERMISSION: &str = "users.weapons.manage";
const CALIBRATION_PERMISSION: &str = "combat.calibration.view";

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(UserSpecializations::Table)
                    .if_exists()
                    .to_owned(),
            )
            .await?;

        // A role that somehow holds both keys keeps the new one; the old row would otherwise
        // collide with it on the (role_id, permission) key.
        let db = manager.get_connection();
        db.execute_unprepared(&format!(
            "DELETE FROM role_permissions \
             WHERE permission = '{OLD_PERMISSION}' \
               AND role_id IN (SELECT role_id FROM role_permissions \
                               WHERE permission = '{NEW_PERMISSION}')"
        ))
        .await?;
        db.execute_unprepared(&format!(
            "UPDATE role_permissions SET permission = '{NEW_PERMISSION}' \
             WHERE permission = '{OLD_PERMISSION}'"
        ))
        .await?;
        db.execute_unprepared(&format!(
            "DELETE FROM role_permissions WHERE permission = '{CALIBRATION_PERMISSION}'"
        ))
        .await?;
        Ok(())
    }

    /// Does nothing: the dropped levels cannot be recovered, and the earlier migrations that
    /// created the table and the old permission key are not re-run on a rollback either.
    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}

#[derive(DeriveIden)]
enum UserSpecializations {
    Table,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{ConnectionTrait, Database, DatabaseConnection, Statement};
    use sea_orm_migration::{MigrationName, MigratorTrait};

    async fn exec(db: &DatabaseConnection, sql: &str) {
        db.execute_unprepared(sql)
            .await
            .unwrap_or_else(|error| panic!("{sql}: {error}"));
    }

    async fn permissions(db: &DatabaseConnection, filter: &str) -> Vec<String> {
        db.query_all(Statement::from_string(
            db.get_database_backend(),
            format!(
                "SELECT rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id \
                 WHERE {filter} ORDER BY rp.permission"
            ),
        ))
        .await
        .expect("permissions query")
        .iter()
        .map(|row| row.try_get_by_index::<String>(0).expect("permission"))
        .collect()
    }

    async fn table_exists(db: &DatabaseConnection, name: &str) -> bool {
        db.query_one(Statement::from_string(
            db.get_database_backend(),
            format!("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '{name}'"),
        ))
        .await
        .expect("sqlite_master query")
        .is_some()
    }

    #[tokio::test]
    async fn drops_the_levels_table_and_renames_the_permission_in_stored_roles() {
        let db = Database::connect("sqlite::memory:").await.expect("db");
        let steps = crate::Migrator::migrations()
            .iter()
            .position(|migration| migration.name() == Migration.name())
            .expect("migration must be registered");
        crate::Migrator::up(&db, Some(steps as u32))
            .await
            .expect("preceding migrations");
        assert!(table_exists(&db, "user_specializations").await);

        for role in ["old-only", "both", "unrelated"] {
            exec(
                &db,
                &format!("INSERT INTO roles (id, name, priority) VALUES ('{role}', '{role}', 1)"),
            )
            .await;
        }
        for (role, permission) in [
            ("old-only", "users.specializations.manage"),
            ("old-only", "events.view"),
            ("both", "users.specializations.manage"),
            ("both", "users.weapons.manage"),
            ("unrelated", "events.view"),
            ("unrelated", "combat.calibration.view"),
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

        crate::Migrator::up(&db, Some(1))
            .await
            .expect("this migration");

        assert!(!table_exists(&db, "user_specializations").await);
        assert_eq!(
            permissions(&db, "r.id = 'old-only'").await,
            ["events.view", "users.weapons.manage"]
        );
        assert_eq!(
            permissions(&db, "r.id = 'both'").await,
            ["users.weapons.manage"]
        );
        assert_eq!(
            permissions(&db, "r.id = 'unrelated'").await,
            ["events.view"],
            "the removed calibration permission is dropped, nothing else is touched"
        );
    }

    #[tokio::test]
    async fn a_fresh_database_has_no_levels_table_and_admin_holds_the_new_permission() {
        let db = Database::connect("sqlite::memory:").await.expect("db");
        crate::Migrator::up(&db, None)
            .await
            .expect("all migrations");
        assert!(!table_exists(&db, "user_specializations").await);

        let admin = permissions(&db, "r.name = 'Admin'").await;
        assert!(admin.iter().any(|p| p == "users.weapons.manage"));
        assert!(!admin.iter().any(|p| p == "users.specializations.manage"));
        assert!(!admin.iter().any(|p| p == "combat.calibration.view"));
    }
}
