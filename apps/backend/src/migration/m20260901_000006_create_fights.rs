//! Creates the canonical Fight tables.
//!
//! A Fight represents one real engagement and may contain one or more AlbionBB
//! battle records. Existing event links are backfilled during this migration;
//! malformed IDs and cross-event conflicts are retained in an issue table for
//! officer reconciliation rather than silently discarded.

use std::collections::HashMap;

use sea_orm::DbBackend;
use sea_orm::prelude::DateTimeWithTimeZone;
use sea_orm_migration::prelude::*;

use super::m20260711_000002_create_events_table::Events;
use super::m20260713_000002_create_event_battles::EventBattles;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Fights::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Fights::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Fights::EventId).big_integer())
                    .col(
                        ColumnDef::new(Fights::StartedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(ColumnDef::new(Fights::EndedAt).timestamp_with_time_zone())
                    .col(
                        ColumnDef::new(Fights::GroupingMethod)
                            .string_len(16)
                            .not_null()
                            .default("seeded"),
                    )
                    .col(
                        ColumnDef::new(Fights::GroupingConfidence)
                            .double()
                            .not_null()
                            .default(0.0),
                    )
                    .col(
                        ColumnDef::new(Fights::GroupingVersion)
                            .string_len(16)
                            .not_null()
                            .default("1"),
                    )
                    .col(
                        ColumnDef::new(Fights::NeedsReview)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(
                        ColumnDef::new(Fights::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(Fights::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(Fights::Table, Fights::EventId)
                            .to(Events::Table, Events::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_fights_event_started")
                    .table(Fights::Table)
                    .col(Fights::EventId)
                    .col(Fights::StartedAt)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(FightBattles::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(FightBattles::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(FightBattles::FightId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(FightBattles::BattleId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(FightBattles::SequenceNumber)
                            .integer()
                            .not_null()
                            .default(1),
                    )
                    .col(
                        ColumnDef::new(FightBattles::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(FightBattles::Table, FightBattles::FightId)
                            .to(Fights::Table, Fights::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_fight_battles_battle_unique")
                    .table(FightBattles::Table)
                    .col(FightBattles::BattleId)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_fight_battles_fight_sequence_unique")
                    .table(FightBattles::Table)
                    .col(FightBattles::FightId)
                    .col(FightBattles::SequenceNumber)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(FightBackfillIssues::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(FightBackfillIssues::EventBattleId)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(FightBackfillIssues::AlbionbbBattleId)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(FightBackfillIssues::Reason)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(FightBackfillIssues::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(
                                FightBackfillIssues::Table,
                                FightBackfillIssues::EventBattleId,
                            )
                            .to(EventBattles::Table, EventBattles::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        backfill_event_fights(manager).await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(FightBackfillIssues::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(FightBattles::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(Fights::Table).to_owned())
            .await
    }
}

/// Converts legacy event links into one seeded Fight each. The query builder
/// keeps the SQL portable across SQLite tests and PostgreSQL deployments.
async fn backfill_event_fights(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    let db = manager.get_connection();
    let backend = manager.get_database_backend();
    let rows = db
        .query_all(
            backend.build(
                &Query::select()
                    .columns([
                        EventBattles::Id,
                        EventBattles::EventId,
                        EventBattles::AlbionbbBattleId,
                        EventBattles::BattleStartedAt,
                    ])
                    .from(EventBattles::Table)
                    .order_by(EventBattles::Id, Order::Asc)
                    .to_owned(),
            ),
        )
        .await?;
    let mut assigned_battles = HashMap::<i64, i64>::new();

    for row in rows {
        let event_battle_id: i64 = row.try_get_by_index(0)?;
        let event_id: i64 = row.try_get_by_index(1)?;
        let battle_id_text: String = row.try_get_by_index(2)?;
        let started_at: DateTimeWithTimeZone = row.try_get_by_index(3)?;
        let battle_id = match battle_id_text.parse::<i64>() {
            Ok(battle_id) => battle_id,
            Err(_) => {
                record_backfill_issue(
                    db,
                    backend,
                    event_battle_id,
                    &battle_id_text,
                    "invalid AlbionBB battle ID",
                )
                .await?;
                continue;
            }
        };

        if let Some(previous_event_id) = assigned_battles.get(&battle_id) {
            record_backfill_issue(
                db,
                backend,
                event_battle_id,
                &battle_id_text,
                &format!("battle already assigned to event {previous_event_id}"),
            )
            .await?;
            continue;
        }

        db.execute(
            backend.build(
                &Query::insert()
                    .into_table(Fights::Table)
                    .columns([Fights::EventId, Fights::StartedAt, Fights::GroupingMethod])
                    .values_panic([event_id.into(), started_at.into(), "seeded".into()])
                    .to_owned(),
            ),
        )
        .await?;
        let fight_id: i64 = db
            .query_one(
                backend.build(
                    &Query::select()
                        .column(Fights::Id)
                        .from(Fights::Table)
                        .and_where(Expr::col(Fights::EventId).eq(event_id))
                        .and_where(Expr::col(Fights::StartedAt).eq(started_at))
                        .order_by(Fights::Id, Order::Desc)
                        .limit(1)
                        .to_owned(),
                ),
            )
            .await?
            .ok_or_else(|| DbErr::Custom("inserted fight could not be loaded".to_string()))?
            .try_get_by_index(0)?;
        db.execute(
            backend.build(
                &Query::insert()
                    .into_table(FightBattles::Table)
                    .columns([
                        FightBattles::FightId,
                        FightBattles::BattleId,
                        FightBattles::SequenceNumber,
                    ])
                    .values_panic([fight_id.into(), battle_id.into(), 1.into()])
                    .to_owned(),
            ),
        )
        .await?;
        assigned_battles.insert(battle_id, event_id);
    }

    Ok(())
}

async fn record_backfill_issue(
    db: &SchemaManagerConnection<'_>,
    backend: DbBackend,
    event_battle_id: i64,
    battle_id: &str,
    reason: &str,
) -> Result<(), DbErr> {
    db.execute(
        backend.build(
            &Query::insert()
                .into_table(FightBackfillIssues::Table)
                .columns([
                    FightBackfillIssues::EventBattleId,
                    FightBackfillIssues::AlbionbbBattleId,
                    FightBackfillIssues::Reason,
                ])
                .values_panic([event_battle_id.into(), battle_id.into(), reason.into()])
                .to_owned(),
        ),
    )
    .await?;
    Ok(())
}

#[derive(DeriveIden)]
enum Fights {
    Table,
    Id,
    EventId,
    StartedAt,
    EndedAt,
    GroupingMethod,
    GroupingConfidence,
    GroupingVersion,
    NeedsReview,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum FightBattles {
    Table,
    Id,
    FightId,
    BattleId,
    SequenceNumber,
    CreatedAt,
}

#[derive(DeriveIden)]
enum FightBackfillIssues {
    Table,
    EventBattleId,
    AlbionbbBattleId,
    Reason,
    CreatedAt,
}
