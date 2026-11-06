//! Schema, migration and cross-backend invariant tests of the Discord delivery tables.
//!
//! SQLite tests run in every `cargo test`. The PostgreSQL concurrency and crash tests
//! need `TEST_DATABASE_URL` and skip without it (see `postgres::test_support`).

use chrono::{DateTime, Duration, Utc};
use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};
use sea_orm_migration::{MigrationName, MigratorTrait};

use super::kinds::{Cause, EffectKind};
use super::outbox::{self, Completion, Effect, EmitOutcome, OutboxState};
use crate::errors::AppError;

const TABLES: [&str; 4] = [
    "discord_bindings",
    "discord_outbox",
    "discord_delivery_state",
    "event_voice_presence",
];

async fn sqlite() -> DatabaseConnection {
    let db = Database::connect("sqlite::memory:")
        .await
        .expect("connect sqlite");
    crate::migration::Migrator::up(&db, None)
        .await
        .expect("tenant migrations");
    db
}

async fn names_in_sqlite(db: &DatabaseConnection, kind: &str) -> Vec<String> {
    db.query_all(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "SELECT name FROM sqlite_master WHERE type = $1 ORDER BY name",
        [kind.into()],
    ))
    .await
    .expect("sqlite_master")
    .iter()
    .map(|row| row.try_get::<String>("", "name").expect("name"))
    .collect()
}

fn total_migrations() -> usize {
    crate::migration::Migrator::migrations().len()
}

/// Number of migrations from this slice's first one to the end of the tenant list. Later slices
/// append their own migrations after it, so the count is derived from the migration name.
fn slice_migrations() -> usize {
    let start = crate::migration::Migrator::migrations()
        .iter()
        .position(|migration| migration.name() == "m20261107_000001_create_discord_delivery")
        .expect("discord delivery migration is registered");
    total_migrations() - start
}

#[tokio::test]
async fn migrations_create_the_delivery_tables_and_indexes() {
    let db = sqlite().await;
    let tables = names_in_sqlite(&db, "table").await;
    for table in TABLES {
        assert!(
            tables.iter().any(|name| name == table),
            "missing table {table}"
        );
    }
    let indexes = names_in_sqlite(&db, "index").await;
    for index in [
        "uq_outbox_once",
        "uq_outbox_coalesce",
        "ix_outbox_claim",
        "uq_discord_bindings_thread",
        "ix_events_sched",
    ] {
        assert!(
            indexes.iter().any(|name| name == index),
            "missing index {index}"
        );
    }
}

#[tokio::test]
async fn slice_migrations_go_down_and_up_again_on_sqlite() {
    let db = sqlite().await;
    crate::migration::Migrator::down(&db, Some(slice_migrations() as u32))
        .await
        .expect("down");
    let tables = names_in_sqlite(&db, "table").await;
    for table in TABLES {
        assert!(
            !tables.iter().any(|name| name == table),
            "{table} survived down"
        );
    }
    let columns = event_columns(&db).await;
    assert!(!columns.iter().any(|name| name == "mass_notified_at"));
    assert!(!columns.iter().any(|name| name == "reminder_notified_at"));

    crate::migration::Migrator::up(&db, None)
        .await
        .expect("up again");
    let tables = names_in_sqlite(&db, "table").await;
    for table in TABLES {
        assert!(
            tables.iter().any(|name| name == table),
            "{table} missing after up"
        );
    }
    let columns = event_columns(&db).await;
    assert!(columns.iter().any(|name| name == "mass_notified_at"));
    assert!(columns.iter().any(|name| name == "reminder_notified_at"));
}

async fn event_columns(db: &DatabaseConnection) -> Vec<String> {
    db.query_all(Statement::from_string(
        DbBackend::Sqlite,
        "SELECT name FROM pragma_table_info('events')".to_owned(),
    ))
    .await
    .expect("table info")
    .iter()
    .map(|row| row.try_get::<String>("", "name").expect("name"))
    .collect()
}

async fn insert_event(
    db: &DatabaseConnection,
    organizer: i64,
    title: &str,
    status: &str,
    mass: &str,
    start: &str,
) {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "INSERT INTO events (title, created_by, event_date_utc, mass_time_utc, \
         start_time_utc, status) VALUES ($1, $2, $3, $4, $5, $6)",
        [
            title.into(),
            organizer.into(),
            start.into(),
            mass.into(),
            start.into(),
            status.into(),
        ],
    ))
    .await
    .expect("insert event");
}

#[tokio::test]
async fn backfill_stamps_only_past_due_non_terminal_events() {
    let db = Database::connect("sqlite::memory:").await.expect("connect");
    // Stop one step short of the slice so the events can be inserted on the old schema.
    crate::migration::Migrator::up(&db, Some((total_migrations() - slice_migrations()) as u32))
        .await
        .expect("pre-slice migrations");
    let organizer = crate::modules::sync::test_support::insert_user(&db, "organizer").await;
    let soon = (Utc::now() + Duration::minutes(20))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    insert_event(
        &db,
        organizer,
        "past-scheduled",
        "scheduled",
        "2020-01-01 10:00:00",
        "2020-01-01 10:30:00",
    )
    .await;
    insert_event(
        &db,
        organizer,
        "future",
        "scheduled",
        "2099-01-01 10:00:00",
        "2099-01-01 10:30:00",
    )
    .await;
    insert_event(
        &db,
        organizer,
        "terminal",
        "stopped",
        "2020-01-01 10:00:00",
        "2020-01-01 10:30:00",
    )
    .await;
    // Mass still ahead, but the one-hour reminder window already opened.
    insert_event(
        &db,
        organizer,
        "reminder-window",
        "live",
        "2099-01-01 10:00:00",
        &soon,
    )
    .await;

    crate::migration::Migrator::up(&db, None)
        .await
        .expect("slice migrations");

    let stamps = db
        .query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT title, mass_notified_at IS NOT NULL AS mass, \
             reminder_notified_at IS NOT NULL AS reminder FROM events ORDER BY title"
                .to_owned(),
        ))
        .await
        .expect("select stamps");
    let got: Vec<(String, bool, bool)> = stamps
        .iter()
        .map(|row| {
            (
                row.try_get("", "title").expect("title"),
                row.try_get::<i64>("", "mass").expect("mass") == 1,
                row.try_get::<i64>("", "reminder").expect("reminder") == 1,
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            ("future".to_owned(), false, false),
            ("past-scheduled".to_owned(), true, true),
            ("reminder-window".to_owned(), false, true),
            ("terminal".to_owned(), false, false),
        ]
    );
}

fn at(seconds: i64) -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp(1_800_000_000 + seconds, 0).expect("timestamp")
}

/// Shared by SQLite and PostgreSQL: a leased item whose holder dies is reclaimed, the new
/// holder sees `recovering`, and the dead holder's token is fenced out.
async fn crash_recovery_scenario(db: &impl ConnectionTrait) {
    let id = match outbox::emit(
        db,
        at(0),
        Cause::Scheduler,
        None,
        Effect {
            key_suffix: Some("1".to_owned()),
            ..Effect::new(EffectKind::EventMass, 77)
        },
    )
    .await
    .expect("emit")
    {
        EmitOutcome::Inserted(id) => id,
        other => panic!("unexpected {other:?}"),
    };
    let dead = outbox::claim_due(db, at(0), "bot-old", Duration::seconds(90), 1)
        .await
        .expect("claim")
        .remove(0);
    assert_eq!(dead.row.attempts, 1);

    // Lease expiry, then a new instance takes over.
    outbox::reclaim_expired(db, at(91)).await.expect("reclaim");
    let alive = outbox::claim_due(db, at(91), "bot-new", Duration::seconds(90), 1)
        .await
        .expect("claim after crash")
        .remove(0);
    assert!(alive.row.recovering);
    assert_eq!(alive.row.attempts, 2);

    let stale = outbox::ack(
        db,
        at(92),
        id,
        dead.fence.token(),
        Completion::Done { result: None },
    )
    .await;
    assert!(
        matches!(stale, Err(AppError::Conflict(_))),
        "dead holder must get lease_lost"
    );

    let state = outbox::ack(
        db,
        at(93),
        id,
        alive.fence.token(),
        Completion::Done { result: None },
    )
    .await
    .expect("live holder acks");
    assert_eq!(state, OutboxState::Done);
    let row = outbox::get(db, id).await.expect("get").expect("row");
    assert!(!row.recovering, "a clean ack clears the recovery flag");
}

#[tokio::test]
async fn crash_recovery_fences_the_dead_holder_on_sqlite() {
    let db = sqlite().await;
    crash_recovery_scenario(&db).await;
}

/// Eight concurrent claimers over 200 due rows: every row is leased exactly once.
#[tokio::test]
async fn postgres_claims_are_disjoint_under_concurrency() {
    use crate::postgres::test_support::TenantSchema;
    let Some(schema) = TenantSchema::try_new("discord_claim").await else {
        return;
    };
    let db = schema.db.clone();
    for entity in 1..=200_i64 {
        outbox::emit(
            &db,
            at(0),
            Cause::Web,
            None,
            Effect {
                key_suffix: Some(entity.to_string()),
                ..Effect::new(EffectKind::DmSend, entity)
            },
        )
        .await
        .expect("seed");
    }
    let mut tasks = Vec::new();
    for worker in 0..8 {
        let db = db.clone();
        tasks.push(tokio::spawn(async move {
            let mut taken = Vec::new();
            loop {
                let batch = outbox::claim_due(
                    &db,
                    at(0),
                    &format!("bot-{worker}"),
                    Duration::seconds(90),
                    5,
                )
                .await
                .expect("claim");
                if batch.is_empty() {
                    break;
                }
                taken.extend(batch.into_iter().map(|claimed| claimed.row.id));
            }
            taken
        }));
    }
    let mut all = Vec::new();
    for task in tasks {
        all.extend(task.await.expect("worker"));
    }
    all.sort_unstable();
    let unique = {
        let mut copy = all.clone();
        copy.dedup();
        copy
    };
    assert_eq!(all.len(), 200, "no row lost");
    assert_eq!(unique.len(), 200, "no row duplicated");
    schema.cleanup().await;
}

#[tokio::test]
async fn postgres_crash_recovery_fences_the_dead_holder() {
    use crate::postgres::test_support::TenantSchema;
    let Some(schema) = TenantSchema::try_new("discord_crash").await else {
        return;
    };
    crash_recovery_scenario(&schema.db).await;
    schema.cleanup().await;
}
