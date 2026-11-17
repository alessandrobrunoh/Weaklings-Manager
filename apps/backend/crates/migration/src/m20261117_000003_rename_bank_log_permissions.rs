//! Gives the Albion bank log its own permission area.
//!
//! The bank log permissions were keyed `bank.log.view` and `bank.log.manage`, so the permission
//! matrix listed them inside the "bank" group. They become `banklog.view` and `banklog.manage`,
//! a group of their own, and every role that held the old keys keeps the same access.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const RENAMES: [(&str, &str); 2] = [
    ("bank.log.view", "banklog.view"),
    ("bank.log.manage", "banklog.manage"),
];

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        for (old, new) in RENAMES {
            // A role that already holds the new key keeps it; the old row would otherwise
            // collide with it on the (role_id, permission) key.
            db.execute_unprepared(&format!(
                "DELETE FROM role_permissions \
                 WHERE permission = '{old}' \
                   AND role_id IN (SELECT role_id FROM role_permissions \
                                   WHERE permission = '{new}')"
            ))
            .await?;
            db.execute_unprepared(&format!(
                "UPDATE role_permissions SET permission = '{new}' WHERE permission = '{old}'"
            ))
            .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        for (old, new) in RENAMES {
            db.execute_unprepared(&format!(
                "UPDATE role_permissions SET permission = '{old}' WHERE permission = '{new}'"
            ))
            .await?;
        }
        Ok(())
    }
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

    async fn permissions(db: &DatabaseConnection, role: &str) -> Vec<String> {
        db.query_all(Statement::from_string(
            db.get_database_backend(),
            format!(
                "SELECT permission FROM role_permissions WHERE role_id = '{role}' \
                 AND permission LIKE '%log%' ORDER BY permission"
            ),
        ))
        .await
        .expect("permissions query")
        .iter()
        .map(|row| row.try_get_by_index::<String>(0).expect("permission"))
        .collect()
    }

    #[tokio::test]
    async fn moves_the_bank_log_grants_to_their_own_keys() {
        let db = Database::connect("sqlite::memory:").await.expect("db");
        let steps = crate::Migrator::migrations()
            .iter()
            .position(|migration| migration.name() == Migration.name())
            .expect("migration must be registered");
        crate::Migrator::up(&db, Some(steps as u32))
            .await
            .expect("preceding migrations");

        for role in ["old-only", "both"] {
            exec(
                &db,
                &format!("INSERT INTO roles (id, name, priority) VALUES ('{role}', '{role}', 1)"),
            )
            .await;
        }
        for (role, permission) in [
            ("old-only", "bank.log.view"),
            ("old-only", "bank.log.manage"),
            ("both", "bank.log.view"),
            ("both", "banklog.view"),
        ] {
            exec(
                &db,
                &format!(
                    "INSERT INTO role_permissions (role_id, permission) \
                     VALUES ('{role}', '{permission}')"
                ),
            )
            .await;
        }

        crate::Migrator::up(&db, Some(1)).await.expect("this migration");

        assert_eq!(permissions(&db, "old-only").await, ["banklog.manage", "banklog.view"]);
        assert_eq!(permissions(&db, "both").await, ["banklog.view"]);
    }
}
