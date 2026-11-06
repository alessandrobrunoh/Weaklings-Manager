//! Tenant-side tables of the sync engine: the outbox written inside domain
//! transactions, the copy truth (`sync_copies`) and the command inbox.
//!
//! Runs on Postgres and on the SQLite test fixture; only the id column differs.

use sea_orm_migration::prelude::*;

/// Creates `sync_outbox`, `sync_copies` and `sync_inbox`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let id_column = match manager.get_database_backend() {
            sea_orm::DbBackend::Postgres => "BIGSERIAL PRIMARY KEY",
            _ => "INTEGER PRIMARY KEY AUTOINCREMENT",
        };
        db.execute_unprepared(&format!(
            "CREATE TABLE sync_outbox (
                id           {id_column},
                kind         TEXT   NOT NULL,
                entity_id    BIGINT NOT NULL,
                op           TEXT   NOT NULL,
                command      JSON   NULL,
                ordering_key TEXT   NULL,
                not_before   TIMESTAMPTZ NULL,
                created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                relayed_at   TIMESTAMPTZ NULL,
                relay_error  TEXT NULL
            )"
        ))
        .await?;
        db.execute_unprepared(
            "CREATE INDEX sync_outbox_pending_idx ON sync_outbox (id) WHERE relayed_at IS NULL",
        )
        .await?;
        db.execute_unprepared(
            "CREATE INDEX sync_outbox_entity_idx ON sync_outbox (kind, entity_id) WHERE relayed_at IS NULL",
        )
        .await?;
        db.execute_unprepared(
            "CREATE TABLE sync_copies (
                kind             TEXT   NOT NULL,
                local_id         BIGINT NOT NULL,
                origin_tenant_id TEXT   NOT NULL,
                origin_id        BIGINT NOT NULL,
                origin_version   BIGINT NOT NULL DEFAULT 0,
                origin_epoch     BIGINT NOT NULL DEFAULT 0,
                read_only        BOOLEAN NOT NULL DEFAULT TRUE,
                state            TEXT   NOT NULL DEFAULT 'active',
                content_hash     TEXT   NULL,
                deliver_discord  BOOLEAN NOT NULL DEFAULT TRUE,
                applied_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (kind, local_id),
                UNIQUE (kind, origin_tenant_id, origin_id)
            )",
        )
        .await?;
        db.execute_unprepared(
            "CREATE TABLE sync_inbox (
                ordering_key   TEXT PRIMARY KEY,
                last_issued_at TIMESTAMPTZ NOT NULL,
                last_seq       BIGINT NOT NULL
            )",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP TABLE IF EXISTS sync_inbox")
            .await?;
        db.execute_unprepared("DROP TABLE IF EXISTS sync_copies")
            .await?;
        db.execute_unprepared("DROP TABLE IF EXISTS sync_outbox")
            .await?;
        Ok(())
    }
}
