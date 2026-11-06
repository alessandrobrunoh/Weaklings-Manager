//! Tenant-side Discord delivery schema: bindings, outbox, delivery state, voice presence.
//!
//! Schema only (slice DO-1). No row is seeded here: the legacy poller state and the
//! split / giveaway / VOD / voice columns are imported by `discord_delivery::seed_from_legacy`
//! at the mode flip (DO-6), so the import reads fresh data instead of a frozen snapshot.

use sea_orm::{ConnectionTrait, DbBackend};
use sea_orm_migration::prelude::*;

/// Column types that differ between PostgreSQL and SQLite. Everything else is portable SQL.
struct Dialect {
    pk: &'static str,
    ts: &'static str,
    uuid: &'static str,
}

impl Dialect {
    fn for_backend(backend: DbBackend) -> Self {
        match backend {
            DbBackend::Sqlite => Self {
                pk: "INTEGER PRIMARY KEY AUTOINCREMENT",
                ts: "TEXT",
                uuid: "TEXT",
            },
            _ => Self {
                pk: "BIGSERIAL PRIMARY KEY",
                ts: "TIMESTAMPTZ",
                uuid: "UUID",
            },
        }
    }
}

fn create_statements(d: &Dialect) -> Vec<String> {
    let Dialect { pk, ts, uuid } = d;
    vec![
        format!(
            "CREATE TABLE discord_bindings (
                id {pk},
                entity_type VARCHAR(24) NOT NULL,
                entity_id BIGINT NOT NULL,
                slot VARCHAR(32) NOT NULL DEFAULT '',
                state VARCHAR(16) NOT NULL DEFAULT 'active'
                    CHECK (state IN ('creating','active','closed','deleted')),
                channel_id VARCHAR(32),
                message_id VARCHAR(32),
                thread_id VARCHAR(32),
                card_message_id VARCHAR(32),
                extra TEXT NOT NULL DEFAULT '{{}}',
                applied_fingerprint VARCHAR(80),
                applied_at {ts},
                nonce VARCHAR(40),
                creating_since {ts},
                last_error TEXT,
                created_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (entity_type, entity_id, slot)
            )"
        ),
        format!(
            "CREATE TABLE discord_outbox (
                id {pk},
                kind VARCHAR(32) NOT NULL,
                entity_type VARCHAR(24) NOT NULL,
                entity_id BIGINT NOT NULL,
                payload TEXT NOT NULL DEFAULT '{{}}',
                fingerprint VARCHAR(80),
                cause VARCHAR(32) NOT NULL,
                actor_user_id BIGINT,
                state VARCHAR(12) NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending','leased','done','skipped','failed','ambiguous','superseded')),
                priority SMALLINT NOT NULL DEFAULT 50,
                available_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                expires_at {ts},
                coalesce_key VARCHAR(80),
                once_key VARCHAR(80),
                attempts INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 8,
                lease_token {uuid},
                lease_until {ts},
                leased_by VARCHAR(64),
                recovering BOOLEAN NOT NULL DEFAULT FALSE,
                last_error TEXT,
                last_error_class VARCHAR(16),
                last_error_code VARCHAR(32),
                result TEXT,
                created_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                done_at {ts}
            )"
        ),
        format!(
            "CREATE TABLE discord_delivery_state (
                id SMALLINT PRIMARY KEY CHECK (id = 1),
                cutover_at {ts},
                imported_at {ts},
                import_source VARCHAR(64),
                battle_floor_id BIGINT NOT NULL DEFAULT 0,
                last_reconcile_at {ts}
            )"
        ),
        format!(
            "CREATE TABLE event_voice_presence (
                event_id BIGINT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
                channel_id VARCHAR(32) NOT NULL,
                occupants INTEGER NOT NULL,
                seen_occupied BOOLEAN NOT NULL DEFAULT FALSE,
                empty_since {ts},
                last_observed_at {ts} NOT NULL
            )"
        ),
    ]
}

/// Partial and plain indexes. `CREATE ... INDEX ... WHERE` is valid on both backends.
const INDEXES: [&str; 7] = [
    "CREATE UNIQUE INDEX uq_discord_bindings_thread ON discord_bindings (thread_id) WHERE thread_id IS NOT NULL",
    "CREATE INDEX ix_discord_bindings_state ON discord_bindings (entity_type, state)",
    "CREATE UNIQUE INDEX uq_outbox_once ON discord_outbox (once_key) WHERE once_key IS NOT NULL",
    "CREATE UNIQUE INDEX uq_outbox_coalesce ON discord_outbox (coalesce_key) WHERE coalesce_key IS NOT NULL AND state = 'pending'",
    "CREATE INDEX ix_outbox_claim ON discord_outbox (priority DESC, id) WHERE state IN ('pending','leased')",
    "CREATE INDEX ix_outbox_entity ON discord_outbox (entity_type, entity_id, id)",
    "CREATE INDEX ix_outbox_lease ON discord_outbox (lease_until) WHERE state = 'leased'",
];

const TABLES: [&str; 4] = [
    "event_voice_presence",
    "discord_delivery_state",
    "discord_outbox",
    "discord_bindings",
];

/// Creates the per-tenant Discord delivery tables (DO-S1).
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let dialect = Dialect::for_backend(db.get_database_backend());
        for sql in create_statements(&dialect) {
            db.execute_unprepared(&sql).await?;
        }
        for sql in INDEXES {
            db.execute_unprepared(sql).await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        for table in TABLES {
            db.execute_unprepared(&format!("DROP TABLE IF EXISTS {table}"))
                .await?;
        }
        Ok(())
    }
}
