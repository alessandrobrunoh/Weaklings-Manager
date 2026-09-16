//! Scopes build and comp identity uniqueness to the creator.
//!
//! Until this migration, `(name, category_id, version)` was unique across the whole tenant, so two
//! officers could not both keep an active "Heavy Mace" in the same category. Identity is now
//! `(created_by, name, category_id, version)`: homonyms from different users stay active, and the
//! same user still cannot claim one identity twice.
//!
//! Pre-flight uses the same trimmed, case-insensitive comparison the service applies, and only
//! fails when *one* creator already holds a duplicate. Two users sharing a name is allowed and
//! must not block the migration.

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, Statement};

/// Migration step to make build/comp identity unique per creator rather than per tenant.
#[derive(DeriveMigrationName)]
pub struct Migration;

struct IdentityTarget {
    table: &'static str,
    old_index: &'static str,
    new_index: &'static str,
}

const TARGETS: [IdentityTarget; 2] = [
    IdentityTarget {
        table: "builds",
        old_index: "idx_builds_name_category_version_unique",
        new_index: "idx_builds_creator_name_category_version_unique",
    },
    IdentityTarget {
        table: "comps",
        old_index: "idx_comps_name_category_version_unique",
        new_index: "idx_comps_creator_name_category_version_unique",
    },
];

/// Fails the migration when one creator already holds two rows of the same identity.
async fn assert_no_duplicate_identities_for_the_same_creator(
    manager: &SchemaManager<'_>,
    table: &str,
) -> Result<(), DbErr> {
    let db = manager.get_connection();
    let backend = manager.get_database_backend();
    let rows = db
        .query_all(Statement::from_string(
            backend,
            format!("SELECT id, created_by, name, category_id, version FROM {table}"),
        ))
        .await?;

    let mut seen: std::collections::HashMap<(i64, String, i64, i32), i64> =
        std::collections::HashMap::new();
    let mut clashes: Vec<String> = Vec::new();
    for row in rows {
        let id: i64 = row.try_get_by_index(0)?;
        let created_by: i64 = row.try_get_by_index(1)?;
        let name: String = row.try_get_by_index(2)?;
        let category_id: i64 = row.try_get_by_index(3)?;
        let version: i32 = row.try_get_by_index(4)?;
        let key = (created_by, name.trim().to_lowercase(), category_id, version);
        if let Some(first) = seen.get(&key) {
            clashes.push(format!(
                "#{first} and #{id} both named {name:?} by user {created_by}"
            ));
        } else {
            seen.insert(key, id);
        }
    }

    if clashes.is_empty() {
        return Ok(());
    }

    Err(DbErr::Custom(format!(
        "cannot make {table} unique by (created_by, name, category, version): {} duplicate \
         identit(y/ies) already exist for the same creator — {}. Rename or delete them, then \
         re-run the migration.",
        clashes.len(),
        clashes.join("; ")
    )))
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for target in &TARGETS {
            assert_no_duplicate_identities_for_the_same_creator(manager, target.table).await?;
        }

        for target in &TARGETS {
            manager
                .drop_index(
                    Index::drop()
                        .name(target.old_index)
                        .table(Alias::new(target.table))
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .name(target.new_index)
                        .table(Alias::new(target.table))
                        .col(Alias::new("created_by"))
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
                        .name(target.new_index)
                        .table(Alias::new(target.table))
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .name(target.old_index)
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{Database, DatabaseConnection};
    use sea_orm_migration::{MigrationName, MigratorTrait};

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

        for statement in [
            "INSERT INTO users (id, username, email, role, created_at) VALUES (1, 'alice', \
             'alice@example.com', 'Admin', '2026-09-10T00:00:00+00:00')",
            "INSERT INTO users (id, username, email, role, created_at) VALUES (2, 'bob', \
             'bob@example.com', 'User', '2026-09-10T00:00:00+00:00')",
            "INSERT INTO build_categories (id, name, slug, created_at) VALUES (1, 'Tank', \
             'tank', '2026-09-10T00:00:00+00:00')",
            "INSERT INTO comp_categories (id, name, slug, created_at) VALUES (1, 'ZvZ', \
             'zvz', '2026-09-10T00:00:00+00:00')",
        ] {
            let backend = db.get_database_backend();
            db.execute(Statement::from_string(backend, statement.to_string()))
                .await
                .expect("failed to seed the migration test fixtures");
        }

        db
    }

    async fn insert_build(
        db: &DatabaseConnection,
        id: i64,
        name: &str,
        created_by: i64,
        version: i32,
    ) {
        let backend = db.get_database_backend();
        db.execute(Statement::from_string(
            backend,
            format!(
                "INSERT INTO builds (id, name, role, category_id, created_by, created_at, \
                 updated_at, version) VALUES ({id}, '{name}', 'tank', 1, {created_by}, \
                 '2026-09-10T00:00:00+00:00', '2026-09-10T00:00:00+00:00', {version})"
            ),
        ))
        .await
        .expect("failed to insert the fixture build");
    }

    #[tokio::test]
    async fn applies_when_two_users_share_a_name() {
        let db = db_before_this_migration().await;
        // The outgoing unique index is case-sensitive, so a case-variant homonym from another
        // user is the state this migration must start accepting.
        insert_build(&db, 1, "Heavy Mace", 1, 1).await;
        insert_build(&db, 2, "heavy mace", 2, 1).await;

        crate::migration::Migrator::up(&db, Some(1))
            .await
            .expect("homonyms from different creators must not block the migration");
    }

    #[tokio::test]
    async fn applies_when_the_same_creator_has_two_versions() {
        let db = db_before_this_migration().await;
        insert_build(&db, 1, "Heavy Mace", 1, 1).await;
        insert_build(&db, 2, "Heavy Mace", 1, 2).await;

        crate::migration::Migrator::up(&db, Some(1))
            .await
            .expect("versions of one identity must not block the migration");
    }

    #[tokio::test]
    async fn refuses_when_the_same_creator_already_has_a_duplicate_identity() {
        let db = db_before_this_migration().await;
        insert_build(&db, 1, "Heavy Mace", 1, 1).await;
        insert_build(&db, 2, "  heavy mace  ", 1, 1).await;

        let error = crate::migration::Migrator::up(&db, Some(1))
            .await
            .expect_err("a same-creator duplicate must stop the migration");

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
            message.contains("user 1"),
            "should name the colliding creator: {message}"
        );
    }

    #[tokio::test]
    async fn after_applying_two_creators_may_share_an_exact_name() {
        let db = db_before_this_migration().await;
        insert_build(&db, 1, "Heavy Mace", 1, 1).await;

        crate::migration::Migrator::up(&db, Some(1))
            .await
            .expect("migration should apply");

        insert_build(&db, 2, "Heavy Mace", 2, 1).await;
    }
}
