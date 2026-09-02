//! Allows an event participant to use the virtual `Fill` role without selecting a build.

use sea_orm_migration::prelude::*;

/// Makes `event_participations.primary_build_id` nullable while retaining its foreign key.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if manager.get_database_backend() == sea_orm::DatabaseBackend::Sqlite {
            let db = manager.get_connection();
            db.execute_unprepared(
                "CREATE TABLE event_participations_fill_tmp (\
                    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, \
                    event_id INTEGER NOT NULL, \
                    user_id INTEGER NOT NULL, \
                    primary_build_id INTEGER, \
                    secondary_build_id INTEGER, \
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, \
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, \
                    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE, \
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, \
                    FOREIGN KEY (primary_build_id) REFERENCES builds(id) ON DELETE RESTRICT, \
                    FOREIGN KEY (secondary_build_id) REFERENCES builds(id) ON DELETE RESTRICT\
                )",
            )
            .await?;
            db.execute_unprepared(
                "INSERT INTO event_participations_fill_tmp \
                    (id, event_id, user_id, primary_build_id, secondary_build_id, created_at, updated_at) \
                 SELECT id, event_id, user_id, primary_build_id, secondary_build_id, created_at, updated_at \
                 FROM event_participations",
            )
            .await?;
            db.execute_unprepared("DROP TABLE event_participations")
                .await?;
            db.execute_unprepared(
                "ALTER TABLE event_participations_fill_tmp RENAME TO event_participations",
            )
            .await?;
            db.execute_unprepared(
                "CREATE UNIQUE INDEX idx_event_participations_event_id_user_id_unique \
                 ON event_participations(event_id, user_id)",
            )
            .await?;
            db.execute_unprepared(
                "CREATE INDEX idx_event_participations_event_id \
                 ON event_participations(event_id)",
            )
            .await?;
            return Ok(());
        }

        manager
            .alter_table(
                Table::alter()
                    .table(EventParticipations::Table)
                    // `.null()` is what emits `DROP NOT NULL`; without it sea-query only
                    // writes the `ALTER COLUMN ... TYPE bigint` half and the original
                    // NOT NULL constraint survives, rejecting every Fill signup.
                    .modify_column(
                        ColumnDef::new(EventParticipations::PrimaryBuildId)
                            .big_integer()
                            .null(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Migration(
            "cannot restore NOT NULL while Fill participations exist".to_string(),
        ))
    }
}

#[derive(DeriveIden)]
enum EventParticipations {
    Table,
    PrimaryBuildId,
}
