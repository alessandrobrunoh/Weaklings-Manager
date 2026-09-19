//! Keep the persisted ledger canonical: direction is represented by the
//! transaction endpoints, while the stored amount is always positive.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE transactions
                 ADD CONSTRAINT transactions_amount_positive CHECK (amount > 0)",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE transactions
                 DROP CONSTRAINT IF EXISTS transactions_amount_positive",
            )
            .await?;
        Ok(())
    }
}
