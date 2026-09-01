//! Ensures roster assignments can exist only for active event participants.

use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use sea_orm_migration::prelude::*;

/// Adds a composite foreign key from a roster assignment to its event participation.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        if db.get_database_backend() == DatabaseBackend::Sqlite {
            db.execute_unprepared(
                "CREATE TABLE event_roster_assignments_participation_tmp (\
                    event_id INTEGER NOT NULL, \
                    user_id INTEGER NOT NULL, \
                    seat_key TEXT NOT NULL, \
                    assigned_by INTEGER NOT NULL, \
                    assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, \
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, \
                    PRIMARY KEY (event_id, user_id), \
                    UNIQUE (event_id, seat_key), \
                    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE, \
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, \
                    FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE RESTRICT, \
                    FOREIGN KEY (event_id, user_id) REFERENCES event_participations(event_id, user_id) ON DELETE CASCADE\
                )",
            )
            .await?;
            db.execute_unprepared(
                "INSERT INTO event_roster_assignments_participation_tmp \
                    (event_id, user_id, seat_key, assigned_by, assigned_at, updated_at) \
                 SELECT assignment.event_id, assignment.user_id, assignment.seat_key, assignment.assigned_by, assignment.assigned_at, assignment.updated_at \
                 FROM event_roster_assignments assignment \
                 INNER JOIN event_participations participation \
                   ON participation.event_id = assignment.event_id AND participation.user_id = assignment.user_id",
            )
            .await?;
            db.execute_unprepared("DROP TABLE event_roster_assignments")
                .await?;
            db.execute_unprepared(
                "ALTER TABLE event_roster_assignments_participation_tmp RENAME TO event_roster_assignments",
            )
            .await?;
            db.execute_unprepared(
                "CREATE INDEX idx_event_roster_assignments_event_seat \
                 ON event_roster_assignments(event_id, seat_key)",
            )
            .await?;
            return Ok(());
        }

        db.execute_unprepared(
            "DELETE FROM event_roster_assignments assignment \
             WHERE NOT EXISTS (\
                 SELECT 1 FROM event_participations participation \
                 WHERE participation.event_id = assignment.event_id \
                   AND participation.user_id = assignment.user_id\
             )",
        )
        .await?;
        db.execute(Statement::from_string(
            db.get_database_backend(),
            "ALTER TABLE event_roster_assignments \
             ADD CONSTRAINT fk_event_roster_assignments_participation \
             FOREIGN KEY (event_id, user_id) \
             REFERENCES event_participations(event_id, user_id) ON DELETE CASCADE",
        ))
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        if db.get_database_backend() == DatabaseBackend::Sqlite {
            return Ok(());
        }

        db.execute(Statement::from_string(
            db.get_database_backend(),
            "ALTER TABLE event_roster_assignments \
             DROP CONSTRAINT fk_event_roster_assignments_participation",
        ))
        .await?;
        Ok(())
    }
}
