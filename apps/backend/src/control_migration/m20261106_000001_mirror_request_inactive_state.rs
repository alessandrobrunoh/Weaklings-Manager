//! Records mirror requests skipped because the source event is no longer live.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE event_mirror_requests \
                 DROP CONSTRAINT IF EXISTS event_mirror_requests_state_check;
                 ALTER TABLE event_mirror_requests \
                 ADD CONSTRAINT event_mirror_requests_state_check \
                 CHECK (state IN ('pending', 'processing', 'complete', 'failed', 'inactive'));",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "UPDATE event_mirror_requests SET state='failed' WHERE state='inactive';
                 ALTER TABLE event_mirror_requests \
                 DROP CONSTRAINT IF EXISTS event_mirror_requests_state_check;
                 ALTER TABLE event_mirror_requests \
                 ADD CONSTRAINT event_mirror_requests_state_check \
                 CHECK (state IN ('pending', 'processing', 'complete', 'failed'));",
            )
            .await?;
        Ok(())
    }
}
