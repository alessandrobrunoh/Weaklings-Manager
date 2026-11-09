//! Server-side browser sessions, so logout and "log out everywhere" can revoke a cookie.

use sea_orm_migration::prelude::*;

/// Creates `auth_sessions`: one row per browser login, looked up by primary key on every
/// authenticated request and revoked on logout.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "CREATE TABLE auth_sessions (
                id TEXT PRIMARY KEY,
                discord_id TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                expires_at TIMESTAMPTZ NOT NULL,
                revoked_at TIMESTAMPTZ
            )",
        )
        .await?;
        // "Revoke every session of this user" and the opportunistic purge.
        db.execute_unprepared(
            "CREATE INDEX ix_auth_sessions_discord ON auth_sessions (discord_id)",
        )
        .await?;
        db.execute_unprepared(
            "CREATE INDEX ix_auth_sessions_expires ON auth_sessions (expires_at)",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE IF EXISTS auth_sessions")
            .await?;
        Ok(())
    }
}
