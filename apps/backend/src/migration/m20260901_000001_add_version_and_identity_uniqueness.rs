//! Migration script to give builds and comps a `version` column and a unique identity.
//!
//! A build or comp is identified by its name *and* its category, so "Pole Hammer | Crystal" and
//! "Pole Hammer | Kite" are two different builds. Versions of the same build share that pair, so
//! the uniqueness is on the triple `(name, category_id, version)`: a second, unrelated build with
//! the same name and category would collide at version 1.
//!
//! Neither table had any uniqueness before this migration, so existing rows may already violate
//! the new rule. The pre-flight below refuses to run and names the offending rows rather than
//! renaming production data on the operator's behalf. Detection uses the same trimmed,
//! case-insensitive comparison the service applies, which is stricter than the index itself — a
//! row pair that differs only in case would pass the index but be un-editable afterwards.

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, Statement};

/// Migration step to add versioning and identity uniqueness to builds and comps.
#[derive(DeriveMigrationName)]
pub struct Migration;

/// One table's identity columns, so builds and comps share the same code path.
struct IdentityTarget {
    table: &'static str,
    index_name: &'static str,
}

const TARGETS: [IdentityTarget; 2] = [
    IdentityTarget {
        table: "builds",
        index_name: "idx_builds_name_category_version_unique",
    },
    IdentityTarget {
        table: "comps",
        index_name: "idx_comps_name_category_version_unique",
    },
];

/// Fails the migration when a table already holds rows that the new identity rule forbids.
async fn assert_no_duplicate_identities(
    manager: &SchemaManager<'_>,
    table: &str,
) -> Result<(), DbErr> {
    let db = manager.get_connection();
    let backend = manager.get_database_backend();
    let rows = db
        .query_all(Statement::from_string(
            backend,
            format!("SELECT id, name, category_id FROM {table}"),
        ))
        .await?;

    let mut seen: std::collections::HashMap<(String, i64), i64> = std::collections::HashMap::new();
    let mut clashes: Vec<String> = Vec::new();
    for row in rows {
        let id: i64 = row.try_get_by_index(0)?;
        let name: String = row.try_get_by_index(1)?;
        let category_id: i64 = row.try_get_by_index(2)?;
        let key = (name.trim().to_lowercase(), category_id);
        if let Some(first) = seen.get(&key) {
            clashes.push(format!("#{first} and #{id} both named {name:?}"));
        } else {
            seen.insert(key, id);
        }
    }

    if clashes.is_empty() {
        return Ok(());
    }

    Err(DbErr::Custom(format!(
        "cannot make {table} unique by (name, category): {} duplicate identit(y/ies) already \
         exist — {}. Rename or delete them, then re-run the migration.",
        clashes.len(),
        clashes.join("; ")
    )))
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Check both tables before altering either, so a failure leaves nothing half-applied.
        for target in &TARGETS {
            assert_no_duplicate_identities(manager, target.table).await?;
        }

        for target in &TARGETS {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new(target.table))
                        .add_column(
                            ColumnDef::new(Alias::new("version"))
                                .integer()
                                .not_null()
                                .default(1),
                        )
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .name(target.index_name)
                        .table(Alias::new(target.table))
                        .col(Alias::new("name"))
                        .col(Alias::new("category_id"))
                        .col(Alias::new("version"))
                        .unique()
                        .to_owned(),
                )
                .await?;
        }

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for target in &TARGETS {
            manager
                .drop_index(
                    Index::drop()
                        .name(target.index_name)
                        .table(Alias::new(target.table))
                        .to_owned(),
                )
                .await?;

            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new(target.table))
                        .drop_column(Alias::new("version"))
                        .to_owned(),
                )
                .await?;
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{Database, DatabaseConnection};
    use sea_orm_migration::{MigrationName, MigratorTrait};

    /// Brings a fresh database up to the migration immediately before this one.
    ///
    /// The stopping point is found by name rather than by assuming this is the last registered
    /// migration, so adding a later one does not silently turn these tests into no-ops.
    async fn db_before_this_migration() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("failed to connect to the test database");
        let all = crate::migration::Migrator::migrations();
        let steps = all
            .iter()
            .position(|migration| migration.name() == Migration.name())
            .expect("this migration must be registered in the migrator");
        crate::migration::Migrator::up(&db, Some(steps as u32))
            .await
            .expect("failed to run the preceding migrations");

        // `builds` has foreign keys onto users and build_categories.
        for statement in [
            "INSERT INTO users (id, username, email, role, created_at) VALUES (1, 'admin', \
             'admin@example.com', 'Admin', '2026-09-01T00:00:00+00:00')",
            "INSERT INTO build_categories (id, name, slug, created_at) VALUES (1, 'Crystal', \
             'crystal', '2026-09-01T00:00:00+00:00')",
            "INSERT INTO build_categories (id, name, slug, created_at) VALUES (2, 'Kite', \
             'kite', '2026-09-01T00:00:00+00:00')",
        ] {
            let backend = db.get_database_backend();
            db.execute(Statement::from_string(backend, statement.to_string()))
                .await
                .expect("failed to seed the migration test fixtures");
        }

        db
    }

    async fn insert_build(db: &DatabaseConnection, id: i64, name: &str, category_id: i64) {
        let backend = db.get_database_backend();
        db.execute(Statement::from_string(
            backend,
            format!(
                "INSERT INTO builds (id, name, role, category_id, created_by, created_at, \
                 updated_at) VALUES ({id}, '{name}', 'dps', {category_id}, 1, \
                 '2026-09-01T00:00:00+00:00', '2026-09-01T00:00:00+00:00')"
            ),
        ))
        .await
        .expect("failed to insert the fixture build");
    }

    #[tokio::test]
    async fn applies_cleanly_when_no_duplicate_identity_exists() {
        let db = db_before_this_migration().await;
        insert_build(&db, 1, "Pole Hammer", 1).await;
        insert_build(&db, 2, "Pole Hammer", 2).await;
        insert_build(&db, 3, "Great Axe", 1).await;

        crate::migration::Migrator::up(&db, Some(1))
            .await
            .expect("distinct identities must not block the migration");
    }

    #[tokio::test]
    async fn refuses_to_run_and_names_the_rows_when_an_identity_is_already_duplicated() {
        let db = db_before_this_migration().await;
        insert_build(&db, 1, "Pole Hammer", 1).await;
        insert_build(&db, 2, "Pole Hammer", 1).await;

        let error = crate::migration::Migrator::up(&db, Some(1))
            .await
            .expect_err("a duplicate identity must stop the migration");

        let message = error.to_string();
        assert!(
            message.contains("#1"),
            "should name the first row: {message}"
        );
        assert!(
            message.contains("#2"),
            "should name the second row: {message}"
        );
        assert!(
            message.contains("Pole Hammer"),
            "should name the clashing build: {message}"
        );
    }

    #[tokio::test]
    async fn refuses_rows_that_differ_only_by_case_or_padding() {
        let db = db_before_this_migration().await;
        insert_build(&db, 1, "Pole Hammer", 1).await;
        insert_build(&db, 2, "  pole hammer  ", 1).await;

        crate::migration::Migrator::up(&db, Some(1))
            .await
            .expect_err("identity comparison must be trimmed and case-insensitive");
    }
}
