//! Drops the outboxes of the copy-based event sharing model.
//!
//! An event shared between a guild and its alliance is now one event, owned by the tenant that
//! created it; the other tenant holds a link that is re-addressed to the origin on every
//! request. Nothing copies a comp's builds into another tenant or forwards a signup to a copy
//! any more, so the two tables that carried that work have no reader and no writer:
//!
//! * `event_fanout_assets` mapped a source comp and its builds to the copies made for a target.
//! * `event_participation_forwards` queued self-service joins and leaves for a copy's roster.
//!
//! Pending rows are dropped with the tables. The signups they would have delivered are already
//! on the origin event, which is the only roster there is; copies made before this migration are
//! converted into links by `events::links::convert_legacy_copies` at startup.
//!
//! `event_sync_links`, the fanout jobs and targets and `event_participant_attributions` stay:
//! they now describe where each link lives and which guild a participant is credited to.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "DROP TABLE IF EXISTS event_participation_forwards;
                 DROP TABLE IF EXISTS event_fanout_assets;",
            )
            .await?;
        Ok(())
    }

    /// Irreversible: the dropped rows were work in flight for a model that no longer exists.
    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}
