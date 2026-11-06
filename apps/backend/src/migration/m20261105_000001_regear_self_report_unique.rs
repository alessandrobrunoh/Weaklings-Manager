//! Makes the self-service regear duplicate guard a database invariant.
//!
//! `RegearService::create_self_service_request` used to check `has_active_self_report` outside
//! any lock and nothing in the schema backed it, so two parallel POSTs could create two active
//! self-reported requests for one event (two payouts). A partial unique index on
//! `(event_id, user_id)` for pending/approved self-reports closes that race: the loser's insert
//! fails and the service maps it to a conflict.
//!
//! Data check: surplus *pending* duplicates (an approved sibling exists, or an older pending one)
//! are rejected first so the index can be built over real data. Approved duplicates are paid
//! history and are never touched; if any remain the index is built over `pending` rows only (still
//! closing the concurrent-submit race) and the situation is logged, instead of failing tenant
//! start-up.

use sea_orm::{ConnectionTrait, Statement};
use sea_orm_migration::prelude::*;

const INDEX: &str = "idx_regear_deaths_self_report_active";

/// Migration step adding the self-report uniqueness index.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let backend = manager.get_database_backend();

        db.execute_unprepared(
            "UPDATE regear_deaths SET status = 'rejected', \
                officer_note = 'Auto-rejected: duplicate self-reported request', \
                updated_at = CURRENT_TIMESTAMP \
             WHERE source = 'self_reported' AND status = 'pending' AND EXISTS (\
                SELECT 1 FROM regear_deaths o \
                WHERE o.source = 'self_reported' \
                  AND o.event_id = regear_deaths.event_id \
                  AND o.user_id = regear_deaths.user_id \
                  AND o.id <> regear_deaths.id \
                  AND (o.status = 'approved' OR (o.status = 'pending' AND o.id < regear_deaths.id)))",
        )
        .await?;

        let remaining = db
            .query_one(Statement::from_string(
                backend,
                "SELECT COUNT(*) FROM (\
                    SELECT 1 FROM regear_deaths \
                    WHERE source = 'self_reported' AND status IN ('pending', 'approved') \
                    GROUP BY event_id, user_id HAVING COUNT(*) > 1) dup"
                    .to_owned(),
            ))
            .await?
            .map(|row| row.try_get_by_index::<i64>(0))
            .transpose()?
            .unwrap_or(0);

        let statuses = if remaining == 0 {
            "('pending', 'approved')"
        } else {
            tracing::error!(
                duplicate_groups = remaining,
                "regear_deaths holds approved duplicate self-reported requests; \
                 the uniqueness index only covers pending rows until they are resolved"
            );
            "('pending')"
        };
        db.execute_unprepared(&format!(
            "CREATE UNIQUE INDEX IF NOT EXISTS {INDEX} ON regear_deaths (event_id, user_id) \
             WHERE source = 'self_reported' AND status IN {statuses}"
        ))
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(&format!("DROP INDEX IF EXISTS {INDEX}"))
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::Database;
    use sea_orm_migration::MigratorTrait;

    async fn rows(db: &sea_orm::DatabaseConnection) -> Vec<(i64, String)> {
        db.query_all(Statement::from_string(
            db.get_database_backend(),
            "SELECT id, status FROM regear_deaths ORDER BY id".to_owned(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get_by_index::<i64>(0).unwrap(),
                row.try_get_by_index::<String>(1).unwrap(),
            )
        })
        .collect()
    }

    async fn insert(db: &sea_orm::DatabaseConnection, event: i64, user: i64, status: &str) {
        db.execute_unprepared(&format!(
            "INSERT INTO regear_deaths (event_id, user_id, killed_at, player_name, guild_id, \
                loadout_json, status, source) \
             VALUES ({event}, {user}, CURRENT_TIMESTAMP, 'p', 'g', '{{}}', '{status}', 'self_reported')"
        ))
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn up_rejects_surplus_pending_duplicates_and_keeps_paid_history() {
        let db = Database::connect("sqlite::memory:").await.unwrap();
        crate::migration::Migrator::up(&db, None).await.unwrap();
        let manager = SchemaManager::new(&db);
        Migration.down(&manager).await.unwrap();

        // event 1: approved + two pendings -> both pendings rejected
        insert(&db, 1, 1, "approved").await; // id 1
        insert(&db, 1, 1, "pending").await; // id 2
        insert(&db, 1, 1, "pending").await; // id 3
        // event 2: two pendings -> the older one wins
        insert(&db, 2, 1, "pending").await; // id 4
        insert(&db, 2, 1, "pending").await; // id 5
        // event 3: unrelated rows stay as they are
        insert(&db, 3, 1, "pending").await; // id 6
        insert(&db, 3, 2, "pending").await; // id 7
        insert(&db, 3, 1, "rejected").await; // id 8

        Migration.up(&manager).await.unwrap();

        let statuses: Vec<_> = rows(&db).await.into_iter().map(|(_, s)| s).collect();
        assert_eq!(
            statuses,
            [
                "approved", "rejected", "rejected", "pending", "rejected", "pending", "pending",
                "rejected"
            ]
        );
        // The index now enforces the invariant.
        let dup = db
            .execute_unprepared(
                "INSERT INTO regear_deaths (event_id, user_id, killed_at, player_name, guild_id, \
                    loadout_json, status, source) \
                 VALUES (3, 1, CURRENT_TIMESTAMP, 'p', 'g', '{}', 'pending', 'self_reported')",
            )
            .await;
        assert!(dup.is_err());
    }

    #[tokio::test]
    async fn up_falls_back_to_pending_only_index_when_paid_duplicates_exist() {
        let db = Database::connect("sqlite::memory:").await.unwrap();
        crate::migration::Migrator::up(&db, None).await.unwrap();
        let manager = SchemaManager::new(&db);
        Migration.down(&manager).await.unwrap();

        insert(&db, 1, 1, "approved").await;
        insert(&db, 1, 1, "approved").await;

        Migration
            .up(&manager)
            .await
            .expect("must not brick tenant start-up");
        assert_eq!(rows(&db).await.len(), 2, "paid history untouched");
        insert(&db, 1, 1, "pending").await;
        let dup = db
            .execute_unprepared(
                "INSERT INTO regear_deaths (event_id, user_id, killed_at, player_name, guild_id, \
                    loadout_json, status, source) \
                 VALUES (1, 1, CURRENT_TIMESTAMP, 'p', 'g', '{}', 'pending', 'self_reported')",
            )
            .await;
        assert!(dup.is_err(), "concurrent pending submits are still blocked");
    }
}
