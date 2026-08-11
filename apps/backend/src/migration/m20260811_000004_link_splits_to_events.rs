//! Links loot splits to event sessions.
//!
//! A nullable foreign key keeps split creation flexible: members can create a
//! normal split, or attach it to an event when the loot came from that activity.

use sea_orm_migration::prelude::*;

use super::m20260709_000001_create_splits_table::Splits;
use super::m20260711_000002_create_events_table::Events;

/// Migration step for the optional `splits.event_id` relationship.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Splits::Table)
                    .add_column(ColumnDef::new(SplitEventLink::EventId).big_integer())
                    .to_owned(),
            )
            .await?;

        manager
            .create_foreign_key(
                ForeignKey::create()
                    .name("fk_splits_event_id")
                    .from(Splits::Table, SplitEventLink::EventId)
                    .to(Events::Table, Events::Id)
                    .on_delete(ForeignKeyAction::SetNull)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_splits_event_id")
                    .table(Splits::Table)
                    .col(SplitEventLink::EventId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .name("idx_splits_event_id")
                    .table(Splits::Table)
                    .to_owned(),
            )
            .await?;

        manager
            .drop_foreign_key(
                ForeignKey::drop()
                    .name("fk_splits_event_id")
                    .table(Splits::Table)
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Splits::Table)
                    .drop_column(SplitEventLink::EventId)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
pub enum SplitEventLink {
    EventId,
}
