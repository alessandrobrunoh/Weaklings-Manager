//! Only administrators may change other people's events, builds and comps.
//!
//! `events.manage`, `comps.builds.manage` and `comps.comps.manage` are the override that lets a
//! role act on rows somebody else created; the plain `.edit` / `.delete` permissions cover the
//! holder's own rows only (author-or-manage, decision D-09). The earlier seeds handed the
//! override to the Officer role as well (`events.manage` since the first events migration,
//! the comps ones from `m20261109_000001`, which kept every editor at its old reach). The
//! rule is now "creator or administrator", so Officer loses the override. It keeps
//! `.view`/`.create`/`.edit`/`.delete`, i.e. full control of what it creates itself.
//!
//! Only the baseline Officer role is touched. A role an owner created or edited by hand that
//! holds `.manage` was given it on purpose and keeps it.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "DELETE FROM role_permissions \
                 WHERE permission IN ('events.manage', 'comps.builds.manage', 'comps.comps.manage') \
                   AND role_id IN (SELECT id FROM roles WHERE name = 'Officer')",
            )
            .await?;
        Ok(())
    }

    /// Does nothing: restoring the override on rollback would silently widen the Officer role.
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

    async fn grants(db: &DatabaseConnection, role_id: &str) -> Vec<String> {
        db.query_all(Statement::from_string(
            db.get_database_backend(),
            format!(
                "SELECT permission FROM role_permissions WHERE role_id = '{role_id}' \
                 ORDER BY permission"
            ),
        ))
        .await
        .expect("grants query")
        .iter()
        .map(|row| row.try_get_by_index::<String>(0).expect("permission"))
        .collect()
    }

    #[tokio::test]
    async fn officer_keeps_its_own_rows_but_loses_the_override() {
        let db = Database::connect("sqlite::memory:").await.expect("db");
        let steps = crate::migration::Migrator::migrations()
            .iter()
            .position(|migration| migration.name() == Migration.name())
            .expect("migration must be registered");
        crate::migration::Migrator::up(&db, Some(steps as u32))
            .await
            .expect("preceding migrations");

        for role in ["Officer", "custom-lead"] {
            exec(
                &db,
                &format!("INSERT INTO roles (id, name, priority) VALUES ('{role}', '{role}', 1)"),
            )
            .await;
            for permission in [
                "events.view",
                "events.create",
                "events.edit",
                "events.delete",
                "events.manage",
                "comps.builds.edit",
                "comps.builds.manage",
                "comps.comps.edit",
                "comps.comps.manage",
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
        }

        crate::migration::Migrator::up(&db, Some(1))
            .await
            .expect("this migration");

        assert_eq!(
            grants(&db, "Officer").await,
            [
                "comps.builds.edit",
                "comps.comps.edit",
                "events.create",
                "events.delete",
                "events.edit",
                "events.view",
            ],
            "Officer keeps full control of its own rows and loses only the override"
        );
        assert_eq!(
            grants(&db, "custom-lead").await.len(),
            9,
            "a role an owner configured by hand is not touched"
        );
    }

    #[tokio::test]
    async fn admin_still_holds_the_override_on_a_fresh_database() {
        let db = Database::connect("sqlite::memory:").await.expect("db");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("all migrations");
        let admin = db
            .query_all(Statement::from_string(
                db.get_database_backend(),
                "SELECT rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id \
                 WHERE r.name = 'Admin'"
                    .to_string(),
            ))
            .await
            .expect("admin grants");
        let granted: Vec<String> = admin
            .iter()
            .map(|row| row.try_get_by_index::<String>(0).expect("permission"))
            .collect();
        for permission in ["events.manage", "comps.builds.manage", "comps.comps.manage"] {
            assert!(
                granted.iter().any(|g| g == permission),
                "Admin lacks {permission}"
            );
        }
    }
}
