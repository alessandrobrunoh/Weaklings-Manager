//! Adds a standalone index on `event_battles.albionbb_battle_id`.

use sea_orm_migration::prelude::*;

use super::m20260713_000002_create_event_battles::EventBattles;

/// Index name, shared with the query-plan test that checks the planner uses it.
pub const INDEX_NAME: &str = "idx_event_battles_albionbb_battle_id";

/// `find_linked_event` and the intel/matchup joins filter by battle id alone. The only
/// existing index is the unique `(event_id, albionbb_battle_id)`, whose leading column
/// a battle-only filter cannot use, so those lookups scanned the whole table.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_index(
                Index::create()
                    .name(INDEX_NAME)
                    .table(EventBattles::Table)
                    .col(EventBattles::AlbionbbBattleId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .name(INDEX_NAME)
                    .table(EventBattles::Table)
                    .to_owned(),
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
    use sea_orm_migration::MigratorTrait;

    use super::INDEX_NAME;

    /// The planner must answer a battle-id-only lookup from the new index instead of
    /// scanning `event_battles`. SQLite runs here; the Postgres twin lives in
    /// `battles::service` and skips without `TEST_DATABASE_URL`.
    #[tokio::test]
    async fn battle_id_lookup_uses_the_index() {
        let db = Database::connect("sqlite::memory:").await.expect("sqlite");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("tenant migrations");

        let rows = db
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "EXPLAIN QUERY PLAN SELECT id FROM event_battles \
                 WHERE albionbb_battle_id = 'battle-1'"
                    .to_owned(),
            ))
            .await
            .expect("explain");
        let plan: Vec<String> = rows
            .iter()
            .map(|row| row.try_get_by_index::<String>(3).expect("detail"))
            .collect();
        let plan = plan.join(" | ");

        assert!(
            plan.contains(INDEX_NAME),
            "expected the planner to use {INDEX_NAME}, got: {plan}"
        );
        assert!(!plan.contains("SCAN event_battles"), "full scan in: {plan}");
    }

    /// Postgres twin of the SQLite plan test. Skipped without `TEST_DATABASE_URL`.
    /// `enable_seqscan` is switched off for the transaction only: a freshly created,
    /// empty table would otherwise be scanned no matter which indexes exist.
    #[tokio::test]
    async fn postgres_battle_id_lookup_can_use_the_index() {
        use crate::postgres::test_support::{try_admin_db, unique_schema};
        use crate::postgres::{connect_tenant_pool, drop_schema, ensure_schema};
        use sea_orm::TransactionTrait;

        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("tidx");
        ensure_schema(&admin, &schema).await.expect("schema");
        let db = connect_tenant_pool(&url, &schema)
            .await
            .expect("tenant pool");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("tenant migrations");

        let txn = db.begin().await.expect("begin");
        txn.execute_unprepared("SET LOCAL enable_seqscan = off")
            .await
            .expect("set");
        let rows = txn
            .query_all(Statement::from_string(
                DbBackend::Postgres,
                "EXPLAIN SELECT id FROM event_battles WHERE albionbb_battle_id = 'battle-1'"
                    .to_owned(),
            ))
            .await
            .expect("explain");
        let plan: Vec<String> = rows
            .iter()
            .map(|row| row.try_get_by_index::<String>(0).expect("plan line"))
            .collect();
        txn.rollback().await.expect("rollback");
        drop_schema(&admin, &schema).await.expect("cleanup");

        let plan = plan.join("\n");
        assert!(
            plan.contains(INDEX_NAME),
            "expected {INDEX_NAME} in: {plan}"
        );
    }
}
