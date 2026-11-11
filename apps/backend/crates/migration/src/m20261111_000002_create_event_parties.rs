//! Gives every organized event an ordered list of parties, each with its own comp.
//!
//! Creates `event_parties`, adds `event_roster_roles.party_id`, and backfills existing data so
//! the roster keeps working: every organized event gets one party holding the event's comp, its
//! extra roster roles join that party, and every stored seat key `build:{B}:{n}` becomes
//! `party:{P}:build:{B}:{n}` with `P` the event's first party.
//!
//! The backfill uses only statements both PostgreSQL and SQLite accept (`CAST`, `||`, correlated
//! subqueries), because the test suite runs the migrations on SQLite.

use sea_orm::DatabaseBackend;
use sea_orm_migration::prelude::*;

use super::m20260710_000007_create_comps_table::Comps;
use super::m20260711_000002_create_events_table::Events;

/// Migration for the `event_parties` table and the party seat-key format.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(EventParties::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(EventParties::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(EventParties::EventId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(EventParties::Position).integer().not_null())
                    .col(ColumnDef::new(EventParties::Name).string_len(64))
                    .col(
                        ColumnDef::new(EventParties::CompId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EventParties::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_event_parties_event_id")
                            .from(EventParties::Table, EventParties::EventId)
                            .to(Events::Table, Events::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_event_parties_comp_id")
                            .from(EventParties::Table, EventParties::CompId)
                            .to(Comps::Table, Comps::Id)
                            .on_delete(ForeignKeyAction::Restrict),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_event_parties_event_position_unique")
                    .table(EventParties::Table)
                    .col(EventParties::EventId)
                    .col(EventParties::Position)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(EventRosterRoles::Table)
                    .add_column(ColumnDef::new(EventRosterRoles::PartyId).big_integer())
                    .to_owned(),
            )
            .await?;

        // SQLite cannot add a foreign key to an existing table, so the constraint is
        // PostgreSQL-only. On SQLite (the test suite) the application deletes a party's roles.
        if manager.get_database_backend() == DatabaseBackend::Postgres {
            manager
                .create_foreign_key(
                    ForeignKey::create()
                        .name("fk_event_roster_roles_party_id")
                        .from(EventRosterRoles::Table, EventRosterRoles::PartyId)
                        .to(EventParties::Table, EventParties::Id)
                        .on_delete(ForeignKeyAction::Cascade)
                        .to_owned(),
                )
                .await?;
        }

        let db = manager.get_connection();
        // 1. One party per organized event, holding the event's comp.
        db.execute_unprepared(
            "INSERT INTO event_parties (event_id, position, name, comp_id) \
             SELECT id, 1, NULL, comp_id FROM events WHERE comp_id IS NOT NULL",
        )
        .await?;
        // 2. Existing extra roles extend the first party.
        db.execute_unprepared(
            "UPDATE event_roster_roles SET party_id = ( \
                 SELECT p.id FROM event_parties p \
                 WHERE p.event_id = event_roster_roles.event_id AND p.position = 1)",
        )
        .await?;
        // 3. Seat keys gain the party prefix. Only old-format keys of events that have a first
        //    party are rewritten, which also makes the statement safe to repeat.
        db.execute_unprepared(
            "UPDATE event_roster_assignments SET seat_key = 'party:' || ( \
                 SELECT CAST(p.id AS TEXT) FROM event_parties p \
                 WHERE p.event_id = event_roster_assignments.event_id AND p.position = 1) \
                 || ':' || seat_key \
             WHERE seat_key LIKE 'build:%' \
               AND EXISTS ( \
                 SELECT 1 FROM event_parties p \
                 WHERE p.event_id = event_roster_assignments.event_id AND p.position = 1)",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        // Only the first party's seats exist in the old format; assignments to later parties
        // cannot be represented and are dropped.
        db.execute_unprepared(
            "DELETE FROM event_roster_assignments \
             WHERE seat_key LIKE 'party:%' \
               AND NOT EXISTS ( \
                 SELECT 1 FROM event_parties p \
                 WHERE p.event_id = event_roster_assignments.event_id AND p.position = 1 \
                   AND event_roster_assignments.seat_key \
                       LIKE 'party:' || CAST(p.id AS TEXT) || ':build:%')",
        )
        .await?;
        db.execute_unprepared(
            "UPDATE event_roster_assignments \
             SET seat_key = SUBSTR(seat_key, INSTR(seat_key, ':build:') + 1) \
             WHERE seat_key LIKE 'party:%'",
        )
        .await?;

        if manager.get_database_backend() == DatabaseBackend::Postgres {
            manager
                .drop_foreign_key(
                    ForeignKey::drop()
                        .name("fk_event_roster_roles_party_id")
                        .table(EventRosterRoles::Table)
                        .to_owned(),
                )
                .await?;
        }
        manager
            .alter_table(
                Table::alter()
                    .table(EventRosterRoles::Table)
                    .drop_column(EventRosterRoles::PartyId)
                    .to_owned(),
            )
            .await?;
        manager
            .drop_table(Table::drop().table(EventParties::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum EventParties {
    Table,
    Id,
    EventId,
    Position,
    Name,
    CompId,
    CreatedAt,
}

#[derive(DeriveIden)]
enum EventRosterRoles {
    Table,
    PartyId,
}

#[cfg(test)]
mod tests {
    use crate::Migrator;
    use sea_orm::{ConnectionTrait, Database, DatabaseConnection, Statement};
    use sea_orm_migration::MigratorTrait;

    async fn text(db: &DatabaseConnection, sql: &str) -> String {
        db.query_one(Statement::from_string(
            db.get_database_backend(),
            sql.to_string(),
        ))
        .await
        .expect("query")
        .expect("row")
        .try_get_by_index::<String>(0)
        .expect("text column")
    }

    #[tokio::test]
    async fn existing_events_get_a_first_party_and_party_prefixed_seat_keys() {
        let db = Database::connect("sqlite::memory:").await.expect("sqlite");
        let before = Migrator::migrations()
            .iter()
            .position(|migration| migration.name() == "m20261111_000002_create_event_parties")
            .expect("event parties migration is registered");
        Migrator::up(&db, Some(before as u32))
            .await
            .expect("up to before event parties");

        // The fixture only needs rows, not valid foreign keys.
        db.execute_unprepared("PRAGMA foreign_keys = OFF")
            .await
            .expect("fk off");
        db.execute_unprepared(
            "INSERT INTO events (id, title, comp_id, created_by, event_date_utc) VALUES \
               (1, 'Organized', 7, 1, '2026-11-11 10:00:00+00:00'), \
               (2, 'Other', 8, 1, '2026-11-11 10:00:00+00:00')",
        )
        .await
        .expect("seed events");
        db.execute_unprepared(
            "INSERT INTO event_roster_roles (id, event_id, build_id) VALUES (1, 1, 30)",
        )
        .await
        .expect("seed extra role");
        db.execute_unprepared(
            "INSERT INTO event_roster_assignments \
               (event_id, user_id, seat_key, assigned_by) VALUES \
               (1, 10, 'build:30:1', 1), (1, 11, 'build:31:2', 1), (2, 12, 'build:30:1', 1)",
        )
        .await
        .expect("seed assignments");

        Migrator::up(&db, None).await.expect("remaining migrations");

        assert_eq!(
            text(&db, "SELECT CAST(COUNT(*) AS TEXT) FROM event_parties").await,
            "2"
        );
        assert_eq!(
            text(
                &db,
                "SELECT position || '|' || comp_id FROM event_parties WHERE event_id = 1"
            )
            .await,
            "1|7"
        );
        let first_party = text(
            &db,
            "SELECT CAST(id AS TEXT) FROM event_parties WHERE event_id = 1",
        )
        .await;
        let second_party = text(
            &db,
            "SELECT CAST(id AS TEXT) FROM event_parties WHERE event_id = 2",
        )
        .await;
        assert_eq!(
            text(
                &db,
                "SELECT CAST(party_id AS TEXT) FROM event_roster_roles WHERE id = 1"
            )
            .await,
            first_party
        );
        for (user, party, key) in [
            (10, &first_party, "build:30:1"),
            (11, &first_party, "build:31:2"),
            (12, &second_party, "build:30:1"),
        ] {
            assert_eq!(
                text(
                    &db,
                    &format!("SELECT seat_key FROM event_roster_assignments WHERE user_id = {user}")
                )
                .await,
                format!("party:{party}:{key}")
            );
        }
    }
}
