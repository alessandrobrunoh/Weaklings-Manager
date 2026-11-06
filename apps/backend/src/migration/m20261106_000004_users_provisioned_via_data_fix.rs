//! Marks legacy fan-out users and rewrites their synthetic email addresses (MS-S2 data fix).

use sea_orm_migration::prelude::*;

/// Rows created by the old event and alliance fan-out used four fake email patterns. They are
/// sync-provisioned, not web logins, and their placeholder address becomes the snowflake-derived
/// `<discord_id>@discord.invalid` wherever that address is still free. The rewrite is skipped on
/// collision so no row is ever merged or lost.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "UPDATE users SET provisioned_via = 'sync'
             WHERE email LIKE '%@discord.invalid'
                OR email LIKE '%@alliance.local'
                OR email LIKE '%@event-sync.invalid'
                OR email LIKE '%@example.invalid'",
        )
        .await?;
        db.execute_unprepared(
            "UPDATE users SET email = discord_id || '@discord.invalid'
             WHERE discord_id IS NOT NULL
               AND discord_id <> ''
               AND (email LIKE '%@alliance.local'
                    OR email LIKE '%@event-sync.invalid'
                    OR email LIKE '%@example.invalid')
               AND NOT EXISTS (
                   SELECT 1 FROM users AS other
                   WHERE other.email = users.discord_id || '@discord.invalid'
               )",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // The rewritten addresses are the canonical ones; nothing to restore.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::migration::Migrator;
    use sea_orm::{ConnectionTrait, Database, DatabaseConnection, Statement};
    use sea_orm_migration::MigratorTrait;

    async fn query_one_text(db: &DatabaseConnection, sql: &str) -> String {
        use sea_orm::QueryResult;
        let row: QueryResult = db
            .query_one(Statement::from_string(
                db.get_database_backend(),
                sql.to_string(),
            ))
            .await
            .expect("query")
            .expect("row");
        row.try_get_by_index::<String>(0).expect("text column")
    }

    #[tokio::test]
    async fn legacy_fan_out_rows_are_marked_and_their_placeholder_addresses_rewritten() {
        let db = Database::connect("sqlite::memory:").await.expect("sqlite");
        // Stop before the two member-lifecycle migrations (they are the last tenant steps).
        let total = Migrator::migrations().len() as u32;
        Migrator::up(&db, Some(total - 2))
            .await
            .expect("up to before lifecycle");

        db.execute_unprepared(
            "INSERT INTO users (username, email, role, discord_id) VALUES
               ('alice', 'a@alliance.local', 'User', '101'),
               ('bob', '202@discord.invalid', 'User', '202'),
               ('carol', 'c@example.invalid', 'User', '303'),
               ('dave', '303@discord.invalid', 'User', '999'),
               ('eve', 'real@example.com', 'Officer', '404')",
        )
        .await
        .expect("seed legacy rows");

        Migrator::up(&db, None).await.expect("remaining migrations");

        let row = |discord: &str| {
            format!(
                "SELECT email || '|' || provisioned_via FROM users WHERE discord_id = '{discord}'"
            )
        };
        // Synthetic address rewritten to the snowflake-derived placeholder, marked as synced.
        assert_eq!(
            query_one_text(&db, &row("101")).await,
            "101@discord.invalid|sync"
        );
        // Already canonical: only the provenance changes.
        assert_eq!(
            query_one_text(&db, &row("202")).await,
            "202@discord.invalid|sync"
        );
        // Placeholder already held by another row: left alone rather than merged.
        assert_eq!(
            query_one_text(&db, &row("303")).await,
            "c@example.invalid|sync"
        );
        // A real web login keeps its address and its provenance.
        assert_eq!(
            query_one_text(&db, &row("404")).await,
            "real@example.com|web"
        );
    }
}
