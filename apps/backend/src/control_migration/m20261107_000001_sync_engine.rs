//! Control-plane tables of the sync engine: links, the one job queue, the
//! one-time import markers and the membership columns the engine reads.
//!
//! Postgres only (control migrations are never run on SQLite). The SQLite
//! test fixture in `testkit` mirrors these tables for queue-logic tests.

use sea_orm_migration::prelude::*;

/// Creates `sync_links`, `sync_jobs`, `sync_legacy_import` and adds the
/// membership columns (`left_reason`, `left_by`, `sync_state`).
#[derive(DeriveMigrationName)]
pub struct Migration;

const UP: &[&str] = &[
    "CREATE TABLE sync_links (
        kind              text   NOT NULL,
        origin_tenant_id  text   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        origin_id         bigint NOT NULL,
        target_tenant_id  text   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        target_id         bigint,
        state             text   NOT NULL DEFAULT 'active' CHECK (state IN ('active','detached')),
        detach_reason     text   CHECK (detach_reason IN ('left','expelled','origin_deleted','scope_off','target_missing')),
        synced_version    bigint NOT NULL DEFAULT 0,
        content_hash      text,
        last_synced_at    timestamptz,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (kind, origin_tenant_id, origin_id, target_tenant_id)
    )",
    "CREATE UNIQUE INDEX sync_links_target_uq ON sync_links (kind, target_tenant_id, target_id) WHERE target_id IS NOT NULL",
    "CREATE INDEX sync_links_target_idx ON sync_links (target_tenant_id, state)",
    "CREATE INDEX sync_links_pair_idx ON sync_links (origin_tenant_id, target_tenant_id) WHERE state = 'active'",
    "CREATE TABLE sync_jobs (
        id               uuid PRIMARY KEY,
        seq              bigint GENERATED ALWAYS AS IDENTITY,
        kind             text   NOT NULL,
        op               text   NOT NULL CHECK (op IN ('upsert','delete','archive','command','scan','effect','reconcile')),
        flow             text   NOT NULL CHECK (flow IN ('to_copy','to_origin','effect')),
        origin_tenant_id text   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        origin_id        bigint NOT NULL,
        target_tenant_id text   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        subject          text   NOT NULL DEFAULT '',
        origin_version   bigint NOT NULL,
        ordering_key     text   NOT NULL,
        dedupe_key       text   NOT NULL UNIQUE,
        payload          jsonb  NOT NULL DEFAULT '{}',
        priority         smallint NOT NULL DEFAULT 5,
        state            text   NOT NULL DEFAULT 'pending'
                         CHECK (state IN ('pending','processing','retry','done','exhausted','blocked','inactive','superseded','cancelled','paused')),
        attempts         int    NOT NULL DEFAULT 0,
        max_attempts     int    NOT NULL DEFAULT 12,
        error_class      text   CHECK (error_class IN ('retryable','permanent','blocked')),
        last_error       text,
        result           jsonb,
        next_attempt_at  timestamptz NOT NULL DEFAULT now(),
        lease_until      timestamptz,
        lease_token      uuid,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        completed_at     timestamptz
    )",
    "CREATE UNIQUE INDEX sync_jobs_coalesce_uq ON sync_jobs (kind, origin_tenant_id, origin_id, target_tenant_id, subject)
        WHERE op IN ('upsert','delete','archive') AND state IN ('pending','retry')",
    "CREATE INDEX sync_jobs_due_idx ON sync_jobs (priority, next_attempt_at, seq)
        WHERE state IN ('pending','retry','processing')",
    "CREATE INDEX sync_jobs_order_idx ON sync_jobs (ordering_key, seq)
        WHERE state IN ('pending','retry','processing')",
    "CREATE INDEX sync_jobs_entity_idx ON sync_jobs (origin_tenant_id, kind, origin_id)",
    "CREATE INDEX sync_jobs_target_idx ON sync_jobs (target_tenant_id, state)",
    "CREATE TABLE sync_legacy_import (name text PRIMARY KEY, done_at timestamptz NOT NULL DEFAULT now())",
    "ALTER TABLE alliance_memberships ADD COLUMN left_reason text CHECK (left_reason IN ('left','expelled','reset'))",
    "ALTER TABLE alliance_memberships ADD COLUMN left_by text",
    "ALTER TABLE alliance_memberships ADD COLUMN sync_state text NOT NULL DEFAULT 'ready'
        CHECK (sync_state IN ('ready','backfilling','detaching','detached'))",
];

const DOWN: &[&str] = &[
    "ALTER TABLE alliance_memberships DROP COLUMN IF EXISTS sync_state",
    "ALTER TABLE alliance_memberships DROP COLUMN IF EXISTS left_by",
    "ALTER TABLE alliance_memberships DROP COLUMN IF EXISTS left_reason",
    "DROP TABLE IF EXISTS sync_legacy_import",
    "DROP TABLE IF EXISTS sync_jobs",
    "DROP TABLE IF EXISTS sync_links",
];

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for statement in UP {
            manager
                .get_connection()
                .execute_unprepared(statement)
                .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for statement in DOWN {
            manager
                .get_connection()
                .execute_unprepared(statement)
                .await?;
        }
        Ok(())
    }
}
