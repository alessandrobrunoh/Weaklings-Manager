//! Terminal `exhausted` state for the event fanout outbox.
//!
//! A target that used up its attempts is parked here instead of being retried
//! forever. The job state mirrors it once no target can make progress.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE event_fanout_targets \
                 ADD COLUMN IF NOT EXISTS exhausted_at TIMESTAMPTZ;
                 ALTER TABLE event_fanout_targets \
                 DROP CONSTRAINT IF EXISTS event_fanout_targets_state_check;
                 ALTER TABLE event_fanout_targets \
                 ADD CONSTRAINT event_fanout_targets_state_check \
                 CHECK (state IN ('pending', 'processing', 'complete', 'failed', 'inactive', 'exhausted'));
                 ALTER TABLE event_fanout_jobs \
                 DROP CONSTRAINT IF EXISTS event_fanout_jobs_state_check;
                 ALTER TABLE event_fanout_jobs \
                 ADD CONSTRAINT event_fanout_jobs_state_check \
                 CHECK (state IN ('pending', 'processing', 'complete', 'failed', 'exhausted'));
                 CREATE INDEX IF NOT EXISTS idx_event_fanout_targets_exhausted \
                 ON event_fanout_targets (exhausted_at DESC, job_id, tenant_id) \
                 WHERE state = 'exhausted';",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "DROP INDEX IF EXISTS idx_event_fanout_targets_exhausted;
                 UPDATE event_fanout_targets SET state='failed' WHERE state='exhausted';
                 UPDATE event_fanout_jobs SET state='failed' WHERE state='exhausted';
                 ALTER TABLE event_fanout_targets \
                 DROP CONSTRAINT IF EXISTS event_fanout_targets_state_check;
                 ALTER TABLE event_fanout_targets \
                 ADD CONSTRAINT event_fanout_targets_state_check \
                 CHECK (state IN ('pending', 'processing', 'complete', 'failed', 'inactive'));
                 ALTER TABLE event_fanout_jobs \
                 DROP CONSTRAINT IF EXISTS event_fanout_jobs_state_check;
                 ALTER TABLE event_fanout_jobs \
                 ADD CONSTRAINT event_fanout_jobs_state_check \
                 CHECK (state IN ('pending', 'processing', 'complete', 'failed'));
                 ALTER TABLE event_fanout_targets DROP COLUMN IF EXISTS exhausted_at;",
            )
            .await?;
        Ok(())
    }
}
