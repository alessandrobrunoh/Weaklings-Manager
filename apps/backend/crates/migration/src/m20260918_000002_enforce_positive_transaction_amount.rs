//! Reserve the migration version without changing legacy transaction semantics.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Negative amounts are still used by existing bank donation flows.
        // This migration must remain a no-op so legacy tenants can boot and
        // retain their balances without rewriting historical transactions.
        let _ = manager;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let _ = manager;
        Ok(())
    }
}
